import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { localDay } from "../src/parser.js";
import { runService } from "../src/service.js";
import { Store } from "../src/store.js";
import { StoreMeter } from "../src/usage.js";
import type { Config, ConversationPort, Draft, ExtractRequest, Route, Runtime, TurnContext, Understanding } from "../src/contracts.js";
import { config, enroll, epoch, FakeTransport, jevConfig, member, message, messageFrom, owner, page, reminders } from "./helpers.js";

type Answer<T> = T | ((context: TurnContext, signal: AbortSignal) => Promise<T>);
class FakeConversation implements ConversationPort {
  understandings: Array<Answer<Understanding | null>> = []; faith: Array<Answer<number | null>> = [];
  extractions: unknown[] = []; phrases: Array<Answer<string | null>> = []; phrased: TurnContext[] = [];
  understood: TurnContext[] = []; proposals: string[] = []; extracts: ExtractRequest[] = []; drafts: Draft[] = []; signals: AbortSignal[] = [];
  async understand(context: TurnContext, signal: AbortSignal) {
    this.understood.push(context); this.signals.push(signal);
    const next = this.understandings.shift();
    return typeof next === "function" ? next(context, signal) : next ?? null;
  }
  async faithful(context: TurnContext, proposed: string, signal: AbortSignal) {
    this.proposals.push(proposed);
    const next = this.faith.length ? this.faith.shift()! : 0.95;
    return typeof next === "function" ? next(context, signal) : next;
  }
  async extract(_context: TurnContext, request: ExtractRequest) { this.extracts.push(request); return this.extractions.shift() ?? null; }
  async phrase(draft: Draft, context: TurnContext, signal: AbortSignal) {
    this.drafts.push(draft); this.phrased.push(context);
    const next = this.phrases.shift();
    return typeof next === "function" ? next(context, signal) : next ?? null;
  }
}
const routeOf = (option: string): Route => ["runtime", "continue", "clarify", "chat", "status", "pause", "resume", "cancel"].includes(option)
  ? { kind: option } as Route : { kind: "action", pluginId: option };
const understood = (option: string, confidence = 0.95, extra: Partial<Understanding> = {}): Understanding => ({ model: "jev-test",
  catalogVersion: "v", route: routeOf(option), confidence, probabilities: { [option]: confidence }, multiAction: false, outbound: 0.02, ...extra });
const extraction = (overrides: Record<string, unknown>) => ({ action: "remind", title: null, task_id: null, when: null,
  snooze_minutes: null, missing: [], ...overrides });
const inAnHour = { kind: "in", amount: 1, unit: "hours", day: null, hour: null, minute: null };
const responder = { provider: "openrouter", model: "test/model", timeoutMs: 1000, dailyLimit: 10 } as const;
const conversational: Config = { ...config, contacts: [owner, member], jev: jevConfig, responder };

function setup(t: { after(fn: () => void): void }, cfg: Config = conversational, path = ":memory:") {
  const store = new Store(path); t.after(() => store.close());
  for (const contact of cfg.contacts) enroll(store, contact);
  const transport = new FakeTransport(); const conversation = new FakeConversation(); let now = epoch;
  const engine = new Engine(cfg, store, transport, { clock: () => now, conversation });
  return { store, transport, engine, conversation, advance: (ms: number) => { now += ms; } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const texts = (store: Store, contactId = "owner") => store.outbox(contactId).map(x => x.text);

test("engine commands and grammar matches stay model-free and immediate", t => {
  const { engine, store, conversation } = setup(t);
  engine.acceptPage("owner", page([message("note buy milk"), message("list", 2), message("status", 3)]));
  assert.equal(conversation.understood.length, 0);
  assert.equal(store.hasPendingMessages("owner"), false);
  assert.deepEqual(store.outbox().map(x => x.status), ["pending", "pending", "pending"]);
  assert.match(texts(store)[0]!, /Saved locally #1: buy milk/);
});

test("natural language waits for understanding, then commits the plugin's change with a drafted reply", async t => {
  const { engine, store, transport, conversation } = setup(t);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ title: "call mom", when: inAnHour }));
  conversation.phrases.push("Sure, I'll remind you to call mom today at 10 AM (#1).");
  engine.acceptPage("owner", page([message("can you remind me to call mom in an hour?")]));
  assert.deepEqual([reminders(store).length, store.outbox().length, store.tasks().length], [0, 0, 0]);
  assert.equal(store.hasPendingMessages("owner"), true);
  assert.equal(store.enrollment("owner")?.cursor, 1);
  await engine.processPending();
  assert.equal(reminders(store)[0]?.title, "call mom");
  assert.equal(conversation.understood[0]?.text, "can you remind me to call mom in an hour?");
  assert.deepEqual(conversation.proposals, ["remind you about “call mom” today (Mon, Sep 28) at 10:00 AM"]);
  const draft = conversation.drafts[0]!;
  assert.equal(draft.kind, "result"); assert.match(draft.template, /^Saved locally #1: call mom\. I'll remind you/);
  assert.deepEqual([draft.times, draft.mentions], [[epoch + 3_600_000], ["#1"]]);
  await engine.tick();
  assert.deepEqual(transport.sent, ["Sure, I'll remind you to call mom today at 10 AM (#1)."]);
  assert.equal(store.hasPendingMessages(), false);
});

test("a grammar clarification goes to understanding instead of asking for a whole new request", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ title: "call mom", missing: ["time"] }));
  engine.acceptPage("owner", page([message("remind me to call mom")]));
  assert.equal(store.outbox().length, 0);
  await engine.processPending();
  assert.deepEqual(texts(store), ["When should I remind you?"]);
  assert.deepEqual([conversation.drafts.length, store.outbox()[0]?.status], [0, "pending"], "questions are sent as code wrote them");
  assert.equal(reminders(store).length, 0);
});

test("later messages queue behind a pending one and keep their order", async t => {
  const { engine, store, transport, conversation } = setup(t);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ action: "note", title: "buy milk" }));
  engine.acceptPage("owner", page([message("could you jot down buy milk"), message("done #1", 2)]));
  assert.equal(store.outbox().length, 0);
  await engine.processPending();
  assert.equal(conversation.understood.length, 1);
  assert.equal(reminders(store)[0]?.status, "completed");
  await engine.tick();
  assert.match(transport.sent[0]!, /Saved locally #1: buy milk/);
  assert.match(transport.sent[1]!, /Completed #1/);
});

test("contacts are understood independently; one contact's pending message never holds another's", async t => {
  const { engine, store, transport, conversation } = setup(t);
  let release!: (value: Understanding | null) => void;
  conversation.understandings.push(() => new Promise(resolve => { release = resolve; }), understood("chat"));
  conversation.phrases.push("Hi Sam!");
  engine.acceptPage("owner", page([message("can you hold on a sec")]));
  engine.acceptPage("sam", page([messageFrom(member, "hey there", 2), messageFrom(member, "note water plants", 3)]));
  const processing = engine.processPending();
  while (!release) await tick();
  while (store.hasPendingMessages("sam")) await tick();
  await engine.tick();
  assert.deepEqual(transport.sent.slice(0, 2), ["Hi Sam!", "Saved locally #1: water plants."]);
  assert.equal(store.hasPendingMessages("owner"), true);
  release(understood("chat")); await processing;
  assert.equal(store.hasPendingMessages(), false);
});

test("a drafting reply holds the contact's later replies; recovery releases the committed template", async t => {
  for (const recover of [false, true]) {
    const { engine, store, transport, conversation } = setup(t);
    let release: ((text: string | null) => void) | undefined;
    conversation.understandings.push(understood("reminders"));
    conversation.extractions.push(extraction({ action: "note", title: "buy milk" }));
    conversation.phrases.push(() => new Promise(resolve => { release = resolve; }));
    engine.acceptPage("owner", page([message("jot down buy milk please")]));
    const processing = engine.processPending();
    while (!release) await tick();
    assert.equal(store.outbox()[0]?.status, "drafting");
    assert.match(store.outbox()[0]!.text, /Saved locally #1/);
    engine.acceptPage("owner", page([message("list", 2)]));
    await engine.tick();
    assert.deepEqual(transport.sent, [], `recover=${recover}`);
    if (recover) store.recoverInFlight();
    release("Noted: buy milk (#1).");
    await processing; await engine.tick();
    assert.equal(transport.sent[0], recover ? "Saved locally #1: buy milk." : "Noted: buy milk (#1).");
    assert.match(transport.sent[1]!, /1 active tasks/);
  }
});

test("a failed understanding falls back to the model-free path with a template reply", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(null);
  engine.acceptPage("owner", page([message("research a new laptop for me")]));
  await engine.processPending();
  assert.equal(store.tasks()[0]?.text, "research a new laptop for me");
  assert.match(texts(store)[0]!, /Saved job #1/);
  assert.equal(store.outbox()[0]?.status, "pending");
  assert.equal(conversation.drafts.length, 0);
  assert.equal(store.unroutedTasks().length, 1, "routing may still classify it later");
});

test("model attempts are bounded across interrupted runs", async t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-pending-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { engine, store, conversation } = setup(t, conversational, join(dir, "state.sqlite"));
  engine.acceptPage("owner", page([message("research laptops")]));
  assert.equal(store.claimPendingMessage("owner")?.attempts, 1);
  assert.equal(store.claimPendingMessage("owner")?.attempts, 2);
  await engine.processPending();
  assert.equal(conversation.understood.length, 0);
  assert.equal(store.tasks().length, 1);
});

test("an abort during understanding leaves the message pending for a retry", async t => {
  const { engine, store, conversation } = setup(t);
  const controller = new AbortController();
  conversation.understandings.push(async () => { controller.abort(); return understood("reminders"); });
  engine.acceptPage("owner", page([message("remind me about the thing later")]));
  await engine.processPending(() => !controller.signal.aborted, controller.signal);
  assert.equal(conversation.signals[0], controller.signal);
  assert.equal(store.hasPendingMessages("owner"), true);
  assert.deepEqual([store.tasks().length, store.outbox().length, conversation.extracts.length], [0, 0, 0]);
});

test("a contact's due reminders wait while one of their messages is being understood", async t => {
  const { engine, store, transport, conversation, advance } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute")]));
  engine.acceptPage("sam", page([messageFrom(member, "remind me to drink water in 1 minute", 2)]));
  await engine.tick(); advance(60_000);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ action: "done", task_id: 1 }));
  engine.acceptPage("owner", page([message("finished stretching!", 3)]));
  await engine.tick();
  const reminderTexts = () => transport.sent.filter(x => x.startsWith("Reminder"));
  assert.deepEqual(reminderTexts(), ["Reminder: drink water (#1). Tell me when it's done, or ask me to snooze it."]);
  await engine.processPending(); await engine.tick();
  assert.equal(reminders(store)[0]?.status, "completed");
  assert.equal(reminderTexts().length, 1);
});

test("models see the contact's delivered conversation, tracked items, and open jobs", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(null);
  engine.acceptPage("owner", page([message("note buy milk"), message("note call dentist", 2), message("research laptops", 3)]));
  await engine.processPending(); await engine.tick();
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ action: "done", task_id: 2 }));
  engine.acceptPage("owner", page([message("the dentist one is done", 4)]));
  await engine.processPending();
  assert.equal(reminders(store)[1]?.status, "completed");
  const seen = conversation.understood[1]!;
  assert.deepEqual(seen.turns.map(x => x.from), ["contact", "nori", "contact", "nori", "contact", "nori"]);
  assert.match(seen.turns[1]!.text, /Saved locally #1/);
  assert.ok(seen.summary.includes("#2: call dentist"));
  assert.deepEqual(seen.jobs, [{ number: 1, text: "research laptops", state: "queued" }]);
  assert.equal(seen.contact.id, "owner");
  assert.deepEqual(seen.catalog.options.map(o => o.id), ["reminders", "runtime", "continue", "clarify", "chat", "status", "pause", "resume", "cancel"]);
  assert.match(conversation.extracts[0]!.data, /#1 buy milk/); assert.match(conversation.extracts[0]!.data, /#2 call dentist/);
});

test("the gate keeps outbound and unsure messages as jobs with their decision recorded", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("reminders", 0.99, { outbound: 0.9 }), understood("chat", 0.3));
  engine.acceptPage("owner", page([message("text Sam that I'm running late"), message("hmm the thing", 2)]));
  await engine.processPending();
  assert.deepEqual(store.tasks().map(x => [x.text, x.route?.route.kind]), [["text Sam that I'm running late", "action"], ["hmm the thing", "chat"]]);
  assert.equal(store.unroutedTasks().length, 0);
  assert.deepEqual(conversation.drafts.map(x => [x.kind, x.mentions]), [["result", ["#1"]], ["result", ["#2"]]]);
  assert.match(conversation.drafts[0]!.template, /Saved job #1/);
  assert.equal(conversation.extracts.length, 0);
});

test("a plugin route that is not enabled keeps the message as a job", async t => {
  const { engine, store, conversation } = setup(t, { ...conversational, jev: { ...jevConfig, routes: {} } });
  conversation.understandings.push(understood("reminders"));
  engine.acceptPage("owner", page([message("can you remind me to call mom in an hour?")]));
  await engine.processPending();
  assert.deepEqual([reminders(store).length, store.tasks().length, conversation.extracts.length], [0, 1, 0]);
});

test("chat, unclear, and unsure messages change nothing and get one reply", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("chat"), understood("clarify"),
    understood("reminders", 0.6, { probabilities: { reminders: 0.6, pause: 0.3, clarify: 0.1 } }));
  conversation.phrases.push("Morning! Hope today's gentle on you.");
  engine.acceptPage("owner", page([message("good morning!"), message("the blue one", 2), message("hold the thing about later", 3)]));
  await engine.processPending();
  assert.deepEqual(texts(store), ["Morning! Hope today's gentle on you.",
    "I'm not sure what you'd like me to do. Could you say it another way?",
    "Do you want me to save or change a reminder, or pause reminder messages?"]);
  assert.deepEqual(conversation.drafts.map(x => x.kind), ["chat"]);
  assert.deepEqual([store.tasks().length, reminders(store).length, store.setting("pause:owner")], [0, 0, null]);
});

test("every change needs the agreement check; a failed or unavailable check asks to confirm", async t => {
  for (const faith of [0.3, null]) {
    const { engine, store, conversation } = setup(t);
    conversation.understandings.push(understood("pause"));
    conversation.faith.push(faith);
    engine.acceptPage("owner", page([message("can you stop the reminders for a bit")]));
    await engine.processPending();
    assert.equal(store.setting("pause:owner"), null);
    assert.deepEqual(texts(store), ["Did you mean: pause all reminder messages until you say resume? Say yes, or tell me what to change."]);
    assert.equal(conversation.drafts.length, 0, "a confirmation is never rephrased");
  }
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ title: "call mom", when: inAnHour }));
  conversation.faith.push(0.2);
  engine.acceptPage("owner", page([message("call mom in an hour")]));
  await engine.processPending();
  assert.equal(reminders(store).length, 0);
  assert.deepEqual(texts(store), ["Did you mean: remind you about “call mom” today (Mon, Sep 28) at 10:00 AM? Say yes, or tell me what to change."]);
});

test("pause, resume, status, and cancel work conversationally after the agreement check", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(null, null, understood("pause"), understood("resume"), understood("status"), understood("cancel"));
  conversation.extractions.push({ job: 2 });
  engine.acceptPage("owner", page(["research laptops", "find a plumber", "hold my reminders for now", "ok start them again",
    "what's on my plate?", "never mind the plumber"].map((text, i) => message(text, i + 1))));
  // Each call handles a bounded batch per contact; the service calls it on every poll.
  while (store.hasPendingMessages()) await engine.processPending();
  assert.deepEqual(conversation.proposals, ["pause all reminder messages until you say resume", "resume reminder messages now",
    "cancel job #2 (“find a plumber”)"]);
  assert.equal(store.setting("pause:owner"), "none");
  assert.deepEqual(store.tasks().map(x => x.state), ["queued", "cancelled"]);
  assert.deepEqual(conversation.drafts.map(x => [x.kind, x.mentions]), [["result", ["resume"]], ["result", []], ["answer", ["#1", "#2"]],
    ["result", ["#2"]]]);
  assert.match(conversation.extracts[0]!.data, /#1 research laptops\n#2 find a plumber/);
  assert.match(texts(store).at(-1)!, /^Cancelled job #2\./);
});

test("a cancel with one open job needs no extraction; with none, nothing is asked of the models", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("cancel"), null, understood("cancel"));
  engine.acceptPage("owner", page([message("cancel that")]));
  await engine.processPending();
  assert.deepEqual(texts(store), ["You have no open jobs to cancel."]);
  engine.acceptPage("owner", page([message("research laptops", 2), message("never mind", 3)]));
  await engine.processPending();
  assert.deepEqual([conversation.extracts.length, store.tasks()[0]?.state], [0, "cancelled"]);
  assert.deepEqual(conversation.proposals, ["cancel job #1 (“research laptops”)"]);
});

test("an unusable extraction keeps the message as a job; the next message is handled normally", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("reminders"), understood("reminders"));
  conversation.extractions.push(null, extraction({ title: "x", when: inAnHour }));
  conversation.faith.push(0.95);
  engine.acceptPage("owner", page([message("remind me about the thing"), message("remind me about x in an hour", 2)]));
  await engine.processPending();
  assert.deepEqual(store.tasks().map(x => [x.text, x.failure]), [["remind me about the thing", null]]);
  assert.equal(reminders(store)[0]?.title, "x");
});

test("conversational reminders and help avoid command syntax", async t => {
  const { engine, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute"), message("help", 2)]));
  advance(60_000); await engine.tick();
  assert.equal(transport.sent.find(x => x.startsWith("Reminder")), "Reminder: stretch (#1). Tell me when it's done, or ask me to snooze it.");
  assert.doesNotMatch(transport.sent[1]!, /‘snooze #1 20m’/);
  assert.match(transport.sent[1]!, /own words/);
});

test("status says when today's model limit is reached", t => {
  const { engine, store } = setup(t);
  const meter = new StoreMeter(store, { timezone: config.timezone, limits: { jev: 100, openrouter: 10 }, clock: () => epoch });
  engine.acceptPage("owner", page([message("status")]));
  assert.doesNotMatch(texts(store)[0]!, /model limit/i);
  for (let n = 0; n < 10; n++) assert.equal(meter.reserve("openrouter"), true);
  engine.acceptPage("owner", page([message("status", 2)]));
  assert.match(texts(store)[1]!, /model limit/i);
});

test("leftover pending messages keep their order after conversational mode is turned off", async t => {
  const { store, engine } = setup(t);
  engine.acceptPage("owner", page([message("research laptops for me")]));
  const plain = new Engine({ ...conversational, jev: null, responder: null }, store, new FakeTransport(), { clock: () => epoch });
  plain.acceptPage("owner", page([message("pause all", 2)]));
  assert.equal(store.setting("pause:owner"), null);
  await plain.processPending();
  assert.equal(store.tasks()[0]?.text, "research laptops for me");
  assert.equal(store.setting("pause:owner"), "all");
  assert.deepEqual(texts(store).map(x => x.slice(0, 12)), ["Saved job #1", "All Nori rem"]);
});

test("conversation turns time Nori's messages by delivery, so held reminders stay in view", t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  store.enqueue({ key: "timer:1:0:0", contactId: "owner", target: owner.conversation, text: "Reminder: stretch (#1).", kind: "reply", timer: null }, epoch);
  const later = epoch + 9 * 3_600_000;
  const held = store.claimOutgoing(later, () => true)!;
  store.finishSend(held, { status: "sent", messageGuid: "out" }, later);
  assert.deepEqual(store.recentTurns("owner", later - 6 * 3_600_000, 8).map(x => [x.text, x.at]), [["Reminder: stretch (#1).", later]]);
  assert.deepEqual(store.recentTurns("sam", later - 6 * 3_600_000, 8), []);
});

test("version 2 databases migrate in place without replaying history", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-migrate-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const first = new Store(path); enroll(first); first.addMessage("owner", message("research laptops")); first.close();
  const old = new DatabaseSync(path);
  old.exec("DROP INDEX inbox_stage; ALTER TABLE inbox DROP COLUMN stage; ALTER TABLE inbox DROP COLUMN attempts; DROP TABLE usage; PRAGMA user_version=2;");
  // Schema 2 counted the day's routing calls in settings; the new limit must not start over.
  old.exec("INSERT INTO settings VALUES ('routing-calls:2026-09-28', '100')");
  old.close();
  const store = new Store(path);
  assert.equal(store.hasPendingMessages(), false);
  assert.equal(store.callsToday("2026-09-28", "jev"), 100);
  assert.equal(store.reserveCall("2026-09-28", "jev", 100), false);
  assert.equal(store.setting("routing-calls:2026-09-28"), null);
  assert.deepEqual(store.recentTurns("owner", epoch - 1, 8).map(x => [x.from, x.text]), [["contact", "research laptops"]]);
  store.close();
  const check = new DatabaseSync(path);
  try { assert.equal(Number(check.prepare("PRAGMA user_version").get()!.user_version), 3); } finally { check.close(); }
});

test("the service understands pending messages, then sends the phrased reply", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store); enroll(store, member);
  const transport = new FakeTransport(); const controller = new AbortController();
  transport.readAfter = async (conversation, cursor) => conversation.chatId === owner.conversation.chatId && cursor === 0
    ? page([message("could you remind me to stretch in an hour", 1, { sentAt: Date.now() })]) : page([], cursor);
  const conversation = new FakeConversation();
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ title: "stretch", when: inAnHour }));
  conversation.phrases.push("On it: stretch in an hour (#1).");
  let polls = 0;
  await runService({ config: conversational, store, transport, checkIdentity: () => {}, signal: controller.signal, conversation,
    wait: async () => { await tick(); await tick(); if (++polls === 4) controller.abort(); } });
  assert.deepEqual(transport.sent, ["On it: stretch in an hour (#1)."]);
  assert.equal(reminders(store)[0]?.title, "stretch");
});

test("service shutdown aborts in-flight understanding and keeps the message for restart", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store); enroll(store, member);
  const transport = new FakeTransport(); const controller = new AbortController();
  transport.readAfter = async (conversation, cursor) => conversation.chatId === owner.conversation.chatId && cursor === 0
    ? page([message("remind me about the thing")]) : page([], cursor);
  const conversation = new FakeConversation();
  let aborted = false;
  conversation.understandings.push((_context, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true });
    controller.abort();
  }));
  await runService({ config: conversational, store, transport, checkIdentity: () => {}, signal: controller.signal, conversation,
    wait: async () => { await tick(); } });
  assert.ok(aborted);
  assert.equal(store.hasPendingMessages("owner"), true);
  assert.deepEqual(transport.sent, []);
});

test("a failure-triggered stop aborts in-flight understanding and keeps the message pending", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store); enroll(store, member);
  const transport = new FakeTransport();
  transport.readAfter = async (conversation, cursor) => conversation.chatId === owner.conversation.chatId && cursor === 0
    ? page([message("remind me about the thing")]) : page([], cursor);
  const conversation = new FakeConversation();
  let broken = false; let seen: AbortSignal | undefined;
  conversation.understandings.push((_context, signal) => new Promise(resolve => {
    seen = signal; broken = true;
    signal.addEventListener("abort", () => resolve(null), { once: true });
    setTimeout(() => resolve(null), 300);
  }));
  await assert.rejects(runService({ config: conversational, store, transport, signal: new AbortController().signal, conversation,
    checkIdentity: () => { if (broken) throw new Error("identity changed"); }, wait: async () => { await tick(); } }), /identity/);
  assert.equal(seen?.aborted, true);
  assert.equal(store.hasPendingMessages("owner"), true);
  assert.equal(store.tasks().length, 0); assert.equal(conversation.drafts.length, 0);
});

test("explicit compound markers keep a message whole as a job, whatever Jev says", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(understood("reminders", 0.99));
  engine.acceptPage("owner", page([message("remind me to call mom in an hour; add eggs to my list")]));
  await engine.processPending();
  assert.deepEqual([reminders(store).length, conversation.extracts.length], [0, 0]);
  assert.deepEqual(store.tasks().map(x => x.text), ["remind me to call mom in an hour; add eggs to my list"]);
});

test("a change whose account shifts before commit is not made, and the contact is asked again", async t => {
  const { engine, store, conversation } = setup(t);
  engine.acceptPage("owner", page([message("note stretch")]));
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ action: "snooze", task_id: 1, snooze_minutes: 20 }));
  conversation.faith.push(async () => {
    store.stateSet("reminders", "owner", "reminder:1", { ...reminders(store)[0]!, title: "stretch again" });
    return 0.95;
  });
  engine.acceptPage("owner", page([message("push that back a bit", 2)]));
  await engine.processPending();
  assert.equal(reminders(store)[0]?.nextAt, null);
  assert.equal(texts(store).at(-1), "Something changed while I was checking that, so I haven't done it. Could you say it again?");
});

/** A job asks "Which city?", then Nori asks when to remind about mom, and both questions are delivered. */
async function jobAskedThenNoriAsked(t: { after(fn: () => void): void }) {
  const built = setup(t); const { engine, store, conversation, advance } = built;
  const task = store.addTask({ contactId: "owner", sourceGuid: null, text: "plan a trip", time: epoch, hint: null, failure: null, routable: false });
  store.updateTask(task.id, { state: "waiting_contact", waitingFor: { kind: "question" } });
  store.enqueue({ key: `task:${task.id}:turn:0:question`, contactId: "owner", target: owner.conversation, text: "Job #1 asks: Which city?",
    kind: "reply", timer: null }, epoch);
  await engine.tick();
  advance(60_000);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ title: "call mom", missing: ["time"] }));
  engine.acceptPage("owner", page([message("remind me to call mom", 1, { sentAt: epoch + 60_000 })]));
  await engine.processPending(); await engine.tick();
  assert.equal(texts(store).at(-1), "When should I remind you?");
  advance(60_000);
  return { ...built, task };
}

test("an open conversational question asked after a job's question gets the answer; later replies reach the job again", async t => {
  const { engine, store, conversation, task } = await jobAskedThenNoriAsked(t);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ title: "call mom", when: { kind: "at", amount: null, unit: null, day: "tomorrow", hour: 9, minute: 0 } }));
  engine.acceptPage("owner", page([message("tomorrow at 9", 2, { sentAt: epoch + 120_000 })]));
  await engine.processPending();
  assert.equal(store.task(task.id)?.input, null);
  assert.equal(reminders(store)[0]?.title, "call mom");
  engine.acceptPage("owner", page([message("Lisbon", 3, { sentAt: epoch + 180_000 })]));
  assert.match(store.task(task.id)?.input ?? "", /Lisbon/);
});

test("the service keeps draining other contacts while one contact waits on a model", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store); enroll(store, member);
  const transport = new FakeTransport(); const controller = new AbortController();
  let polls = 0;
  transport.readAfter = async (conversation, cursor) => {
    if (conversation.chatId === owner.conversation.chatId)
      return cursor === 0 ? page([message("hold on a sec", 1, { sentAt: Date.now() })]) : page([], cursor);
    return polls >= 2 && cursor === 0 ? page([messageFrom(member, "hey there", 2, { sentAt: Date.now() })]) : page([], cursor);
  };
  const conversation = new FakeConversation();
  conversation.understandings.push((_context, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve(null), { once: true })),
    understood("chat"));
  conversation.phrases.push("Hi Sam!");
  await runService({ config: conversational, store, transport, checkIdentity: () => {}, signal: controller.signal, conversation,
    wait: async () => { await tick(); await tick(); if (++polls === 8) controller.abort(); } });
  assert.deepEqual(transport.sent, ["Hi Sam!"]);
  assert.equal(store.hasPendingMessages("owner"), true);
});

test("a handled answer closes the open conversational question, so the job's question gets the next reply", async t => {
  const { engine, store, task } = await jobAskedThenNoriAsked(t);
  engine.acceptPage("owner", page([message("remind me to call mom in 60 minutes", 2, { sentAt: epoch + 120_000 })]));
  assert.equal(reminders(store)[0]?.title, "call mom");
  engine.acceptPage("owner", page([message("Lisbon", 3, { sentAt: epoch + 180_000 })]));
  assert.match(store.task(task.id)?.input ?? "", /Lisbon/);
});

test("controls that stop activity apply at once behind a pending message; other commands wait their turn", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(null);
  engine.acceptPage("owner", page([message("research laptops")]));
  await engine.processPending();
  let release!: (value: Understanding | null) => void;
  conversation.understandings.push(() => new Promise(resolve => { release = resolve; }));
  engine.acceptPage("owner", page([message("thanks!", 2)]));
  const processing = engine.processPending();
  while (!release) await tick();
  engine.acceptPage("owner", page([message("cancel #1", 3), message("status", 4), message("deny A9", 5)]));
  assert.equal(store.tasks()[0]?.state, "cancelled");
  assert.deepEqual(texts(store).slice(1), ["Cancelled job #1.", "Approval A9 is not pending."]);
  assert.equal(store.messageStage("guid-4"), "pending");
  release(understood("chat")); await processing;
  while (store.hasPendingMessages()) await engine.processPending();
  assert.match(texts(store).at(-1)!, /0 queued jobs/);
});

test("replies are written with the current time, while the message keeps its own", async t => {
  const { engine, conversation, advance } = setup(t);
  conversation.understandings.push(understood("chat"));
  engine.acceptPage("owner", page([message("hey")]));
  advance(15 * 3_600_000);
  await engine.processPending();
  assert.deepEqual([conversation.phrased[0]?.sentAt, conversation.phrased[0]?.now], [epoch, epoch + 15 * 3_600_000]);
});

test("a Nori message whose send has begun is part of the conversation its answer is read with", t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  store.enqueue({ key: "reply:q", contactId: "owner", target: owner.conversation, text: "Did you mean: …? Say yes, or tell me what to change.",
    kind: "reply", timer: null }, epoch);
  store.claimOutgoing(epoch + 1_000, () => true);
  assert.deepEqual(store.recentTurns("owner", epoch - 1, 8).map(x => [x.from, x.at]), [["nori", epoch + 1_000]]);
});

test("with until, the service stops only once routing has finished and its replies are sent", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  const transport = new FakeTransport();
  transport.readAfter = async (_conversation, cursor) => cursor === 0
    ? page([message("please remind me to stretch in 2 hours", 1, { sentAt: Date.now() })]) : page([], cursor);
  let routed = false;
  const router = { classify: async () => {
    await new Promise(resolve => setTimeout(resolve, 30)); routed = true;
    return { model: "jev-test", catalogVersion: "v", route: { kind: "action", pluginId: "reminders" } as Route, confidence: 1, probabilities: {},
      multiAction: false };
  } };
  await runService({ config: { ...config, jev: { ...jevConfig, routes: { reminders: 0.9 } } }, store, transport, checkIdentity: () => {},
    signal: new AbortController().signal, router, until: () => true, wait: async () => { await tick(); } });
  assert.equal(routed, true);
  assert.equal(reminders(store)[0]?.title, "stretch");
  assert.deepEqual(transport.sent.map(x => x.slice(0, 16)), ["Saved job #1. It", "Saved locally #1"]);
});

test("a contact's job does not start while one of their messages is pending, so a follow-up reaches it first", async t => {
  const runtimeConfig = { codexPath: "/usr/local/bin/codex", model: null, workspaceDir: "/tmp/nori-work",
    budget: { minutes: 30, turns: 8, toolCalls: 40, tokens: 1_000_000 }, daily: { tasks: 5, tokens: 5_000_000 }, approvalMinutes: 60, maxJobs: 1 };
  const started: string[] = [];
  const runtime: Runtime = { manifest: { id: "codex", computerUse: "unverified", ownerOnly: true },
    start: async task => { started.push(task.text); return { status: "completed", message: "Done.", evidence: ["Checked"] }; },
    resume: async () => ({ status: "interrupted" }), cancel: async () => {}, close: async () => {}, shutdown: async () => {}, halted: null };
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  const conversation = new FakeConversation();
  const engine = new Engine({ ...conversational, contacts: [owner], runtime: runtimeConfig }, store, new FakeTransport(),
    { clock: () => epoch, conversation, runtime });
  let release!: (text: string | null) => void;
  conversation.understandings.push(understood("runtime"));
  conversation.phrases.push(() => new Promise(resolve => { release = resolve; }));
  engine.acceptPage("owner", page([message("research headphones"), message("#1 only compare wired models", 2)]));
  const processing = engine.processPending();
  while (!release) await tick();
  await engine.routeTasks(null); await engine.runTasks();
  assert.deepEqual(started, []);
  release(null); await processing;
  await engine.routeTasks(null); await engine.runTasks();
  assert.equal(started.length, 1);
  assert.match(started[0]!, /research headphones[\s\S]*only compare wired models/);
});

test("with until, a delivery failure still rejects instead of ending as idle", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  const transport = new FakeTransport(); transport.outcomes.push({ status: "uncertain", reason: "lost" });
  transport.readAfter = async (_conversation, cursor) => cursor === 0 ? page([message("status")]) : page([], cursor);
  await assert.rejects(runService({ config, store, transport, checkIdentity: () => {}, signal: new AbortController().signal, until: () => true,
    wait: async () => { await tick(); } }), /uncertain/i);
});

test("routing waits while a contact's message is pending, and a plugin route decided meanwhile does not act", async t => {
  const { engine, store, conversation } = setup(t);
  conversation.understandings.push(null);
  engine.acceptPage("owner", page([message("please note buy milk")]));
  await engine.processPending();
  assert.deepEqual(store.unroutedTasks().map(x => x.text), ["please note buy milk"]);
  const decision = { model: "jev-test", catalogVersion: "v", route: { kind: "action", pluginId: "reminders" } as Route, confidence: 1,
    probabilities: {}, multiAction: false };
  // While a later message is pending, the contact's tasks are not claimed at all.
  let classified = 0;
  let release!: (value: Understanding | null) => void;
  conversation.understandings.push(() => new Promise(resolve => { release = resolve; }));
  engine.acceptPage("owner", page([message("hmm hold on", 2)]));
  const holding = engine.processPending();
  while (!release) await tick();
  await engine.routeTasks({ classify: async () => { classified++; return decision; } });
  assert.equal(classified, 0);
  release(understood("chat")); await holding;
  // A cancellation that arrives while routing is deciding takes effect before the decided route can act.
  const routing = engine.routeTasks({ classify: async () => {
    engine.acceptPage("owner", page([message("cancel that please", 3)]));
    return decision;
  } });
  await routing;
  assert.equal(reminders(store).length, 0);
  assert.equal(store.tasks()[0]?.state, "queued");
  conversation.understandings.push(understood("cancel"));
  await engine.processPending();
  assert.deepEqual([store.tasks()[0]?.state, reminders(store).length], ["cancelled", 0]);
});

test("a reminder delivered after a job's question gets the plain reply; the next reply reaches the job again", async t => {
  const { engine, store, conversation, advance } = setup(t);
  const task = store.addTask({ contactId: "owner", sourceGuid: null, text: "plan a trip", time: epoch, hint: null, failure: null, routable: false });
  store.updateTask(task.id, { state: "waiting_contact", waitingFor: { kind: "question" } });
  store.enqueue({ key: `task:${task.id}:turn:0:question`, contactId: "owner", target: owner.conversation, text: "Job #1 asks: Which city?",
    kind: "reply", timer: null }, epoch);
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute")]));
  await engine.tick();
  advance(60_000); await engine.tick();
  assert.match(texts(store).at(-1)!, /^Reminder: stretch \(#1\)/);
  conversation.understandings.push(understood("reminders"));
  conversation.extractions.push(extraction({ action: "done", task_id: 1 }));
  engine.acceptPage("owner", page([message("did it", 2, { sentAt: epoch + 120_000 })]));
  await engine.processPending();
  assert.deepEqual([store.task(task.id)?.input, reminders(store)[0]?.status], [null, "completed"]);
  engine.acceptPage("owner", page([message("Lisbon", 3, { sentAt: epoch + 180_000 })]));
  assert.match(store.task(task.id)?.input ?? "", /Lisbon/);
});

test("understanding can send a reply to the one job waiting on a question, after the agreement check", async t => {
  const { engine, store, conversation, task } = await jobAskedThenNoriAsked(t);
  store.updateTask(task.id, { outcome: "Which city?" });
  conversation.understandings.push(understood("continue"));
  engine.acceptPage("owner", page([message("Lisbon", 2, { sentAt: epoch + 120_000 })]));
  await engine.processPending();
  assert.deepEqual(conversation.proposals, ["send your reply to job #1 (which asked: “Which city?”)"]);
  assert.match(store.task(task.id)?.input ?? "", /Lisbon/);
  assert.equal(store.task(task.id)?.state, "routed");
  assert.equal(store.tasks().length, 1);
});
