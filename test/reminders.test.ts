import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { decodeProposal, EXTRACT_SCHEMA, reminders as plugin, type Reminder } from "../src/plugins/reminders.js";
import { Store } from "../src/store.js";
import type { ExtractRequest, PluginContext } from "../src/contracts.js";
import { config, enroll, epoch, FakeTransport, message, owner, page, reminders } from "./helpers.js";

const timezone = "America/Los_Angeles";
const match = (text: string, at = epoch) => plugin.match(text, { contact: owner, time: at, timezone, conversational: false });
const clarifies = (value: unknown) => typeof value === "object" && value !== null && "clarify" in value;

function setup(t: { after(fn: () => void): void }, path = ":memory:") {
  const store = new Store(path); enroll(store);
  const transport = new FakeTransport();
  let now = epoch;
  const engine = new Engine(config, store, transport, { clock: () => now });
  t.after(() => store.close());
  return { store, transport, engine, advance: (ms: number) => { now += ms; } };
}

test("reminder controls are whole-message grammar", () => {
  assert.deepEqual(match(" DONE #12 "), { kind: "done", id: 12 });
  assert.deepEqual(match("snooze 20 minutes"), { kind: "snooze", id: null, minutes: 20 });
  assert.deepEqual(match("snooze #2 10m"), { kind: "snooze", id: 2, minutes: 10 });
  assert.deepEqual(match("list"), { kind: "list" });
  assert.deepEqual(match("note buy bread and milk"), { kind: "note", title: "buy bread and milk" });
  assert.deepEqual(match("remember the milk"), { kind: "note", title: "the milk" });
  for (const text of ["status", "pause all", 'Someone said: "pause all"', "find return instructions for this order"])
    assert.equal(match(text), null, text);
});

test("relative reminders use original message time, not catch-up time", () => {
  assert.deepEqual(match("remind me to stretch in 20 minutes"), { kind: "remind", title: "stretch", dueAt: epoch + 20 * 60_000 });
});

test("calendar reminders resolve in the configured timezone", () => {
  assert.deepEqual(match("Remind me to call the dentist tomorrow at 10 am"),
    { kind: "remind", title: "call the dentist", dueAt: Date.parse("2026-09-29T17:00:00Z") });
  assert.deepEqual(match("remind me to stretch on 2026-10-01 at 14:00"),
    { kind: "remind", title: "stretch", dueAt: Date.parse("2026-10-01T21:00:00Z") });
});

test("nonexistent and ambiguous DST times require clarification", () => {
  assert.ok(clarifies(match("remind me to leave on 2027-03-14 at 2:30 am")));
  assert.ok(clarifies(match("remind me to leave on 2026-11-01 at 1:30 am")));
});

test("calendar-day offsets do not silently move a reminder through a DST gap or fold", () => {
  assert.ok(clarifies(match("remind me to leave in 1 day", Date.parse("2027-03-13T10:30:00Z"))));
  assert.ok(clarifies(match("remind me to leave in 1 day", Date.parse("2026-10-31T08:30:00Z"))));
});

test("clarification demonstrates a supported complete replacement command", () => {
  const result = match("remind me to call tomorrow at 10") as { clarify: string };
  assert.match(result.clarify, /remind me to .* tomorrow at 10 am/);
});

test("unclear times and invalid dates do not silently become reminders", () => {
  for (const text of ["remind me to call tomorrow at 10", "remind me to call on 2026-02-30 at 10 am",
    "remind me to call in 0 minutes", "remind me to call tomorrow at 25:00"])
    assert.ok(clarifies(match(text)), text);
});

test("interpret accepts polite phrasing and otherwise asks one focused question", async () => {
  const ctx = { contact: owner, time: epoch, timezone, conversational: false, extract: null } as unknown as PluginContext;
  assert.deepEqual(await plugin.interpret!("Can you please remind me to call mom in 2 hours?", ctx),
    { kind: "remind", title: "call mom", dueAt: epoch + 2 * 60 * 60_000 });
  assert.deepEqual(await plugin.interpret!("Note buy stamps, please.", ctx), { kind: "note", title: "buy stamps" });
  assert.match((await plugin.interpret!("remind me about the dentist sometime", ctx) as { clarify: string }).clarify, /date and time/);
  assert.ok(clarifies(await plugin.interpret!("what should I cook tonight", ctx)));
});

test("owner capture and its acknowledgement survive duplicate ingestion", async t => {
  const { store, engine, transport } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute")]));
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute")]));
  assert.equal(reminders(store).length, 1);
  assert.equal(store.outbox().length, 1);
  await engine.tick();
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]!, /Saved locally #1/);
  assert.equal(store.enrollment("owner")?.cursor, 1);
});

test("durable reminder state resumes after the store reopens", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const first = new Store(path); enroll(first);
  new Engine(config, first, new FakeTransport(), { clock: () => epoch }).acceptPage("owner", page([message("note buy milk")]));
  first.close();
  const second = new Store(path); t.after(() => second.close());
  assert.equal(reminders(second)[0]?.title, "buy milk");
  assert.equal(second.enrollment("owner")?.cursor, 1);
  assert.equal(second.outbox()[0]?.status, "pending");
});

test("one due reminder is sent once, and done prevents later reminders", async t => {
  const { engine, store, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute")]));
  await engine.tick(); advance(60_000); await engine.tick(); await engine.tick();
  assert.equal(transport.sent.length, 2);
  assert.match(transport.sent[1]!, /^Reminder #1: stretch/);
  engine.acceptPage("owner", page([message("done", 2)]));
  await engine.tick(); advance(60_000); await engine.tick();
  assert.equal(reminders(store)[0]?.status, "completed");
  assert.equal(transport.sent.length, 3);
});

test("completion cancels a pending notification before retry", async t => {
  const { engine, store, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute")]));
  await engine.tick();
  transport.outcomes.push({ status: "not_started", reason: "not connected" });
  advance(60_000); await engine.tick();
  engine.acceptPage("owner", page([message("done #1", 2)]));
  advance(120_000); await engine.tick();
  assert.equal(store.outbox().filter(x => x.kind === "timer")[0]?.status, "cancelled");
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("pause all holds requested reminders; controls still work", async t => {
  const { engine, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute"), message("pause all", 2)]));
  await engine.tick(); advance(60_000); await engine.tick();
  assert.equal(transport.sent.length, 2);
  engine.acceptPage("owner", page([message("resume", 3)])); await engine.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("quiet hours hold reminder messages but not replies", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  const transport = new FakeTransport(); let now = Date.parse("2026-09-29T05:00:00Z");
  const engine = new Engine({ ...config, quietHours: { start: 22, end: 8 } }, store, transport, { clock: () => now });
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute", 1, { sentAt: now })]));
  now += 60_000; await engine.tick();
  assert.deepEqual(transport.sent.map(x => x.split(":")[0]), ["Saved locally #1"]);
  now = Date.parse("2026-09-29T15:30:00Z"); await engine.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("snooze preserves deadline and invalidates the old notification", async t => {
  const { engine, store, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute"), message("snooze 20m", 2)]));
  const reminder = reminders(store)[0]!;
  assert.equal(reminder.dueAt, epoch + 60_000);
  assert.equal(reminder.nextAt, epoch + 20 * 60_000);
  advance(60_000); await engine.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 0);
  advance(19 * 60_000); await engine.tick(); await engine.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("ambiguous done changes no reminders", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("note buy milk"), message("note call dentist", 2), message("done", 3)]));
  assert.equal(reminders(store).filter(x => x.status === "active").length, 2);
  assert.match(store.outbox().at(-1)!.text, /Which/);
});

test("list shows only active reminders", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("note buy milk"), message("remind me to stretch in 20 minutes", 2),
    message("done #1", 3), message("list", 4)]));
  const reply = store.outbox().at(-1)!.text;
  assert.match(reply, /#2: stretch/);
  assert.doesNotMatch(reply, /buy milk/);
});

test("catch-up snoozes use the command timestamp and can already be due", async t => {
  const { engine, store, transport, advance } = setup(t);
  advance(60 * 60_000);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute"),
    message("snooze #1 20m", 2, { sentAt: epoch + 5 * 60_000 })]));
  assert.equal(reminders(store)[0]?.dueAt, epoch + 60_000);
  assert.equal(reminders(store)[0]?.nextAt, epoch + 25 * 60_000);
  await engine.tick();
  assert.equal(transport.sent.filter(text => text.startsWith("Reminder")).length, 1);
});

test("list stays within one message even with very long notes", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([1, 2, 3].map(n => message(`note ${String(n).repeat(3400)}`, n)).concat(message("list", 4))));
  const reply = store.outbox().at(-1)!.text;
  assert.match(reply, /^3 active tasks:/);
  assert.ok(reply.length <= 2000);
  assert.equal(store.tasks().length, 0);
});

test("boundary whitespace does not turn a simple request into a compound one", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute\n"), message("\nnote buy milk", 2)]));
  assert.deepEqual(reminders(store).map(x => x.title), ["stretch", "buy milk"]);
  assert.equal(store.tasks().length, 0);
});

// Conversational interpret: the responder names parts; code resolves them. epoch is Monday, Sep 28, 2026, 9:00 AM local.
const at = (iso: string) => Date.parse(iso);
const item = (id: number, title: string, dueAt: number | null = null): Reminder => ({ id, title, dueAt, nextAt: dueAt, status: "active" });
function talking(items: Reminder[], answer: unknown, time = epoch) {
  const requests: ExtractRequest[] = []; const replies: string[] = [];
  const state = { list: () => items, get: (key: string) => items.find(x => `reminder:${x.id}` === key) ?? null };
  const ctx = { contact: owner, time, timezone, conversational: true, state, reply: (text: string) => { replies.push(text); },
    extract: async (request: ExtractRequest) => { requests.push(request); return answer; } } as unknown as PluginContext;
  return { ctx, requests, replies };
}
const extraction = (overrides: Record<string, unknown> = {}) => ({ action: "remind", title: "call mom", task_id: null,
  when: { kind: "at", amount: null, unit: null, day: "tomorrow", hour: 9, minute: 0 }, snooze_minutes: null, missing: [], ...overrides });
const interpret = (text: string, answer: unknown, items: Reminder[] = []) => plugin.interpret!(text, talking(items, answer).ctx);

test("conversational interpret extracts details and code resolves the time", async () => {
  const { ctx, requests } = talking([item(4, "stretch", at("2026-09-28T20:00:00Z"))], extraction());
  assert.deepEqual(await plugin.interpret!("can you remind me to call mom tomorrow morning", ctx),
    { kind: "remind", title: "call mom", dueAt: at("2026-09-29T16:00:00Z") });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.schema, EXTRACT_SCHEMA);
  assert.match(requests[0]!.data, /#4 stretch \(reminder today \(Mon, Sep 28\) at 1:00 PM\)/);
  assert.match(requests[0]!.instructions, /time/);
  assert.match(requests[0]!.instructions, /earlier message.*YYYY-MM-DD/s);
});

test("polite exact grammar needs no model even when one is available", async () => {
  const { ctx, requests } = talking([], extraction());
  assert.deepEqual(await plugin.interpret!("Can you please remind me to call mom in 2 hours?", ctx),
    { kind: "remind", title: "call mom", dueAt: epoch + 2 * 60 * 60_000 });
  assert.equal(requests.length, 0);
});

test("missing or invalid details become one focused question", async () => {
  const question = async (answer: unknown, items: Reminder[] = []) => (await interpret("x", answer, items) as { clarify: string }).clarify;
  assert.equal(await question(extraction({ when: null, missing: ["time"] })), "When should I remind you?");
  assert.equal(await question(extraction({ when: { kind: "at", amount: null, unit: null, day: "today", hour: 8, minute: 0 } })), "When should I remind you?");
  assert.equal(await question(extraction({ title: null, missing: ["task"] })), "What should I remind you about?");
  assert.equal(await question(extraction({ title: "x".repeat(201) })), "What should I remind you about?");
  assert.match(await question(extraction({ action: "done", task_id: 7 }), [item(1, "a"), item(2, "b")]), /Which reminder/);
  assert.match(await question(extraction({ action: "done", task_id: null }), [item(1, "a"), item(2, "b")]), /Which reminder/);
  assert.match(await question(extraction({ action: "snooze", task_id: 1, when: null, snooze_minutes: 20_000 }), [item(1, "a")]), /When/);
  assert.match(await question(extraction({ action: "none" })), /another way/);
});

test("references, snoozes, notes, and lists resolve against the contact's active reminders", async () => {
  const items = [item(1, "stretch", epoch), item(2, "call mom")];
  assert.deepEqual(await interpret("done with the call", extraction({ action: "done", task_id: 2 }), items), { kind: "done", id: 2 });
  assert.deepEqual(await interpret("finished it", extraction({ action: "done" }), [item(1, "stretch")]), { kind: "done", id: 1 });
  assert.deepEqual(await interpret("later", extraction({ action: "snooze", task_id: 1, when: null, snooze_minutes: 20 }), items),
    { kind: "snooze", id: 1, minutes: 20 });
  assert.deepEqual(await interpret("push it to 1", extraction({ action: "snooze", task_id: 1,
    when: { kind: "at", amount: null, unit: null, day: "today", hour: 13, minute: 0 } }), items), { kind: "snooze", id: 1, minutes: 240 });
  assert.deepEqual(await interpret("jot down milk", extraction({ action: "note", title: " buy milk ", when: null })), { kind: "note", title: "buy milk" });
  assert.deepEqual(await interpret("what's on there", extraction({ action: "list", title: null, when: null })), { kind: "list" });
});

test("unusable extractions return null so the engine falls back", async () => {
  for (const answer of [null, "not json", [], { ...extraction(), action: "delete" }, { ...extraction(), missing: "time" }, { ...extraction(), title: 4 }])
    assert.equal(await interpret("remind me about the thing", answer), null, JSON.stringify(answer));
});

test("proposal decoding keeps only well-typed fields", () => {
  assert.deepEqual(decodeProposal(extraction({ title: "  ", task_id: -2, missing: ["time", "bogus"] })), { action: "remind", title: null,
    taskId: null, when: { kind: "at", day: "tomorrow", hour: 9, minute: 0 }, snoozeMinutes: null, missing: ["time"] });
  assert.deepEqual(decodeProposal(extraction({ when: { kind: "in", amount: 20, unit: "minutes", day: null, hour: null, minute: null } }))?.when,
    { kind: "in", amount: 20, unit: "minutes" });
  assert.equal(decodeProposal(extraction({ when: { kind: "in", amount: null, unit: "minutes", day: null, hour: null, minute: null } }))?.when, null);
});

test("describe gives the code-written account a contact can confirm", () => {
  const { ctx } = talking([item(1, "stretch", epoch), item(2, "call mom")], null);
  const due = at("2026-09-29T17:00:00Z");
  assert.deepEqual(plugin.describe!({ kind: "remind", title: "call mom", dueAt: due }, ctx),
    { description: "remind you about “call mom” tomorrow (Tue, Sep 29) at 10:00 AM", times: [due] });
  assert.deepEqual(plugin.describe!({ kind: "note", title: "buy milk" }, ctx), { description: "save the note “buy milk”", times: [] });
  assert.deepEqual(plugin.describe!({ kind: "done", id: 2 }, ctx), { description: "mark #2 “call mom” as done", times: [] });
  assert.deepEqual(plugin.describe!({ kind: "snooze", id: 1, minutes: 20 }, ctx),
    { description: "snooze #1 “stretch” until today (Mon, Sep 28) at 9:20 AM", times: [epoch + 20 * 60_000] });
  assert.deepEqual(plugin.describe!({ kind: "done", id: null }, ctx), { description: "ask which reminder you mean", times: [] });
  assert.deepEqual(plugin.describe!({ kind: "list" }, ctx), { description: "show your active reminders", times: [] });
});

test("conversational reminder messages invite a plain answer instead of command syntax", () => {
  const { ctx, replies } = talking([item(1, "stretch", epoch)], null);
  plugin.onTimer!({ key: "reminder:1", at: epoch, payload: { id: 1 } }, ctx);
  assert.equal(replies[0], "Reminder: stretch (#1). Tell me when it's done, or ask me to snooze it.");
});

test("an implicit reminder reference is bound to one reminder or becomes a question", async () => {
  const one = talking([item(1, "stretch", epoch)], extraction());
  assert.deepEqual(await plugin.interpret!("could you snooze 20m?", one.ctx), { kind: "snooze", id: 1, minutes: 20 });
  assert.deepEqual(await plugin.interpret!("done, thanks", one.ctx), { kind: "done", id: 1 });
  assert.equal(one.requests.length, 0);
  const two = talking([item(1, "stretch", epoch), item(2, "call mom")], extraction());
  assert.match((await plugin.interpret!("could you snooze 20m?", two.ctx) as { clarify: string }).clarify, /Which reminder/);
  assert.deepEqual(await plugin.interpret!("snooze #2 10m please", two.ctx), { kind: "snooze", id: 2, minutes: 10 });
});
