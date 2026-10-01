import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversation, gate, REPLY_SCHEMA } from "../src/conversation.js";
import type { Draft, Judge, LanguageModel, ModelRequest, Route, RouteCatalog, TurnContext, Understander, Understanding } from "../src/contracts.js";
import { epoch, owner } from "./helpers.js";

const tz = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const signal = new AbortController().signal;
const thresholds = { act: 0.8, clarify: 0.5, verify: 0.6 };
const routes = { reminders: 0.8 };
const catalog: RouteCatalog = { version: "catalog-test", options: [
  { id: "reminders", criteria: "Reminders.", route: { kind: "action", pluginId: "reminders" }, label: "save or change a reminder" },
  ...(["runtime", "continue", "clarify", "chat", "status", "pause", "resume", "cancel"] as const)
    .map(kind => ({ id: kind, criteria: `${kind}.`, route: { kind } as Route })),
] };
const context = (overrides: Partial<TurnContext> = {}): TurnContext => ({ contact: owner, text: "hi", sentAt: epoch, now: epoch, timezone: tz, catalog,
  summary: [], jobs: [], turns: [], paused: "none", ...overrides });

function understanding(option: string, confidence = 0.95, extra: Partial<Understanding> = {}): Understanding {
  const route = catalog.options.find(o => o.id === option)!.route;
  const probabilities = Object.fromEntries(catalog.options.map(o => [o.id, o.id === option ? confidence : (1 - confidence) / (catalog.options.length - 1)]));
  return { model: "jev-test", catalogVersion: catalog.version, route, confidence, probabilities, multiAction: false, outbound: 0.02, ...extra };
}
class FakeModel implements LanguageModel {
  requests: ModelRequest[] = [];
  constructor(public replies: unknown[] = []) {}
  async generate(request: ModelRequest) {
    this.requests.push(request); const next = this.replies.shift();
    return next === undefined || next === null ? null : { model: "llm-test", json: next, usage: { input: 1, output: 1 } };
  }
  close() {}
}
class FakeJudge implements Judge {
  proposals: string[] = []; replies: string[] = []; committed: Array<string | null> = [];
  constructor(public faith: number | null = 0.95, public claims: number | null = 0.02) {}
  async faithful(_c: TurnContext, proposed: string) { this.proposals.push(proposed); return this.faith; }
  async claimsAction(reply: string, committed: string | null) { this.replies.push(reply); this.committed.push(committed); return this.claims; }
}
function build(model = new FakeModel(), judge = new FakeJudge(), u: Understanding | null = null) {
  const understander: Understander & { calls: TurnContext[] } = { calls: [], async understand(c) { this.calls.push(c); return u; } };
  return { conversation: new Conversation({ understander, judge, model }), model, judge, understander };
}
const draft = (overrides: Partial<Draft>): Draft => ({ kind: "result", template: "", times: [], mentions: [], ...overrides });

test("the gate keeps outbound, compound, unsure, and job-like messages as jobs", () => {
  for (const u of [understanding("reminders", 0.99, { outbound: 0.9 }), understanding("reminders", 0.99, { multiAction: true }),
    understanding("reminders", 0.3), understanding("runtime", 0.9), understanding("continue", 0.7), understanding("chat", 0.4)])
    assert.deepEqual(gate(u, thresholds, routes), { kind: "job" }, `${u.route.kind} ${u.confidence}`);
  assert.deepEqual(gate(understanding("reminders"), thresholds, {}), { kind: "job" }, "a plugin route that is not enabled");
});

test("the gate asks, answers, or prepares a change by confidence", () => {
  const mixed = { ...Object.fromEntries(catalog.options.map(o => [o.id, 0])), reminders: 0.6, clarify: 0.25, pause: 0.15 };
  assert.deepEqual(gate(understanding("reminders", 0.6, { probabilities: mixed }), thresholds, routes), { kind: "ask", options: ["reminders", "pause"] });
  assert.deepEqual(gate(understanding("reminders", 0.85), thresholds, { reminders: 0.9 }).kind, "ask");
  assert.deepEqual(gate(understanding("clarify", 0.9), thresholds, routes), { kind: "ask", options: [] });
  assert.deepEqual(gate(understanding("chat", 0.6), thresholds, routes), { kind: "chat" });
  assert.deepEqual(gate(understanding("status", 0.6), thresholds, routes), { kind: "status" });
  assert.deepEqual(gate(understanding("pause", 0.7), thresholds, routes).kind, "ask");
  for (const option of ["reminders", "pause", "resume", "cancel", "continue"])
    assert.deepEqual(gate(understanding(option, 0.9), thresholds, routes), { kind: "act", option });
});

test("understanding and the agreement check pass straight through to Jev", async () => {
  const u = understanding("reminders");
  const { conversation, understander, judge } = build(new FakeModel(), new FakeJudge(0.42), u);
  const c = context({ text: "remind me to call mom" });
  assert.equal(await conversation.understand(c, signal), u);
  assert.equal(understander.calls[0], c);
  assert.equal(await conversation.faithful(c, "remind you about “call mom” today at 5:00 PM", signal), 0.42);
  assert.deepEqual(judge.proposals, ["remind you about “call mom” today at 5:00 PM"]);
});

test("extraction frames the message, conversation, and plugin data as data under a strict schema", async () => {
  const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false };
  const { conversation, model } = build(new FakeModel([{ action: "remind" }]));
  const c = context({ text: "can you remind me to call mom tomorrow morning",
    turns: [{ from: "contact", text: "hey", at: epoch - 60_000 }, { from: "nori", text: "Hi! What's up?", at: epoch - 50_000 }] });
  assert.deepEqual(await conversation.extract(c, { instructions: "Extract the reminder.", schema, data: "#4 stretch" }, signal), { action: "remind" });
  const sent = model.requests[0]!;
  assert.equal(sent.purpose, "extract"); assert.equal(sent.schema, schema);
  assert.match(sent.prompt, /Extract the reminder\./);
  assert.match(sent.prompt, /can you remind me to call mom tomorrow morning/);
  assert.match(sent.prompt, /Monday, September 28, 2026/);
  assert.match(sent.prompt, /#4 stretch/);
  assert.match(sent.prompt, /Nori \(Mon, Sep 28, 8:59 AM\): Hi! What's up\?/);
  assert.match(sent.system, /data/i);
  assert.equal(await build(new FakeModel([null])).conversation.extract(c, { instructions: "x", schema, data: "" }, signal), null);
});

test("a phrased result must keep the committed numbers and times", async () => {
  const due = at("2026-09-29T16:00:00Z");
  const saved = draft({ template: "Saved locally #3: call mom. I'll remind you Sep 29, 9:00 AM PDT.", times: [due], mentions: ["#3"] });
  const good = "Got it! I'll nudge you to call mom on Tue, Sep 29 at 9 AM (#3).";
  const built = build(new FakeModel([{ reply: good }]));
  assert.equal(await built.conversation.phrase(saved, context(), signal), good);
  const sent = built.model.requests[0]!;
  assert.equal(sent.purpose, "reply"); assert.equal(sent.schema, REPLY_SCHEMA);
  assert.match(sent.prompt, /Saved locally #3/); assert.match(sent.prompt, /9:00 AM/);
  assert.deepEqual(built.judge.committed, [saved.template]);
  for (const reply of ["Got it, I'll remind you Sep 29 at 9 AM.", "Saved #3 for Sep 29 at 10 AM.", "Saved #3 for Sep 28 at 9 AM.",
    "Saved #3 for Sep 29 at 9 AM, next to #8.", `Saved #3 Sep 29 at 9 AM. ${"blah ".repeat(200)}`, "", 42])
    assert.equal(await build(new FakeModel([{ reply }])).conversation.phrase(saved, context(), signal), null, String(reply).slice(0, 40));
  assert.equal(await build(new FakeModel([null])).conversation.phrase(saved, context(), signal), null);
});

test("results and chat keep their facts and may name only tracked items", async () => {
  const summary = ["2 active tasks.", "#1: stretch", "#2: call mom"];
  const phrase = async (d: Draft, reply: string) =>
    build(new FakeModel([{ reply }])).conversation.phrase(d, context({ summary, jobs: [{ number: 5, text: "research laptops", state: "routed" }] }), signal);
  const status = draft({ template: ["2 active tasks:", "#1: stretch", "#2: call mom"].join("\n"), mentions: ["#1", "#2"] });
  assert.equal(await phrase(status, "You have #1 stretch and #2 call mom."), "You have #1 stretch and #2 call mom.");
  assert.equal(await phrase(status, "You have #1 stretch."), null);
  const chat = draft({ kind: "chat", template: "I'm here." });
  assert.equal(await phrase(chat, "You've got #1, #2, and job #5 going."), "You've got #1, #2, and job #5 going.");
  assert.equal(await phrase(chat, "You've got #1 and #9 going."), null);
  const paused = draft({ template: "All Nori reminder messages are paused. Reply ‘resume’ to restart them.", mentions: ["resume"] });
  assert.equal(await phrase(paused, "Paused. Say resume when you want them back."), "Paused. Say resume when you want them back.");
  assert.equal(await phrase(paused, "Paused."), null);
});

test("chat replies change nothing and are screened for claimed actions", async () => {
  const reply = "Hi! Hope your morning is going okay.";
  let built = build(new FakeModel([{ reply }]), new FakeJudge(0.9, 0.1));
  const c = context({ text: "morning!", summary: ["1 active tasks.", "#1: stretch"] });
  assert.equal(await built.conversation.phrase(draft({ kind: "chat", template: "I'm here." }), c, signal), reply);
  assert.deepEqual(built.judge.replies, [reply]); assert.deepEqual(built.judge.committed, [null]);
  assert.match(built.model.requests[0]!.prompt, /morning!/); assert.match(built.model.requests[0]!.prompt, /#1: stretch/);
  assert.match(built.model.requests[0]!.prompt, /save or change a reminder/);
  for (const claims of [0.9, null]) {
    built = build(new FakeModel([{ reply: "Done, I've scheduled it." }]), new FakeJudge(0.9, claims));
    assert.equal(await built.conversation.phrase(draft({ kind: "chat", template: "I'm here." }), c, signal), null);
  }
});

test("chat is screened against nothing committed", async () => {
  for (const reply of ["Done, I've set that up for you. Anything else?", "Done, I cancelled it. No jobs are queued."]) {
    const built = build(new FakeModel([{ reply }]), new FakeJudge(0.9, 0.9));
    assert.equal(await built.conversation.phrase(draft({ kind: "chat", template: "I'm here." }), context(), signal), null, reply);
    assert.deepEqual(built.judge.committed, [null]);
  }
});

test("phrased replies state no time, date, or weekday beyond the committed ones; chat states none", async () => {
  const due = at("2026-09-29T16:00:00Z");
  const saved = draft({ template: "Saved locally #3: call mom. I'll remind you Sep 29, 9:00 AM PDT.", times: [due], mentions: ["#3"] });
  const phrase = (d: Draft, reply: string) => build(new FakeModel([{ reply }])).conversation.phrase(d, context(), signal);
  assert.equal(await phrase(saved, "Saved #3 for Tue, Sep 29 at 9 AM."), "Saved #3 for Tue, Sep 29 at 9 AM.");
  for (const reply of ["Saved #3 for Tue, Sep 29 at 9 AM; your dentist is at 4 PM.", "Saved #3 for Tue, Sep 29 at 9 AM, before Friday.",
    "Saved #3 for Tue, Sep 29 at 9 AM, two days before Oct 1.", "Saved #3 for Tue, Sep 29 at 9 AM (17:30 works too)."])
    assert.equal(await phrase(saved, reply), null, reply);
  const chat = draft({ kind: "chat", template: "I'm here." });
  assert.equal(await phrase(chat, "Hi! Hope you're doing okay."), "Hi! Hope you're doing okay.");
  assert.equal(await phrase(chat, "Have a great day, and well done for getting through the week!"), "Have a great day, and well done for getting through the week!");
  for (const reply of ["Your dentist is at 4 PM.", "Your dentist is on Oct 3.", "Hope Friday goes well!", "See you Tue.",
    "Your dentist is on 2026-10-15.", "Your dentist is tomorrow.", "Your dentist is at noon.", "It's in 2 hours.", "That's next week.",
    "Big day today!", "Your dentist is in two hours.", "Your dentist is on fri.", "Your dentist is on the 2nd of October.",
    "It's on the 3rd.", "In half an hour.", "2 October works.", "It's in 1.5 hours.", "It's in eleven hours.",
    "About an hour from now.", "Give it 90 mins.", "A two-hour wait.", "Twenty minutes to go."])
    assert.equal(await phrase(chat, reply), null, reply);
});

test("phrased replies name each time's calendar date and use no relative day, so they read the same on any day", async () => {
  // Sent Monday at 11:59 PM, written Tuesday at 12:01 AM, for a reminder on Tuesday at 9 AM; it may be read later still.
  const sentAt = at("2026-09-29T06:59:00Z"); const now = at("2026-09-29T07:01:00Z"); const due = at("2026-09-29T16:00:00Z");
  const saved = draft({ template: "Saved locally #3: call mom. I'll remind you Sep 29, 9:00 AM PDT.", times: [due], mentions: ["#3"] });
  const c = context({ sentAt, now });
  for (const reply of ["Saved #3: I'll remind you tomorrow at 9 AM.", "Saved #3: I'll remind you today at 9 AM.",
    "Saved #3: I'll remind you tomorrow (Sep 29) at 9 AM.", "Saved #3: I'll remind you Tuesday at 9 AM."])
    assert.equal(await build(new FakeModel([{ reply }])).conversation.phrase(saved, c, signal), null, reply);
  const right = build(new FakeModel([{ reply: "Saved #3: I'll remind you Tuesday, Sep 29 at 9 AM." }]));
  assert.equal(await right.conversation.phrase(saved, c, signal), "Saved #3: I'll remind you Tuesday, Sep 29 at 9 AM.");
  assert.match(right.model.requests[0]!.prompt, /"Tue, Sep 29 at 9:00 AM"/);
  assert.match(right.model.requests[0]!.prompt, /Tuesday, September 29, 2026/);
});
