import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { reminders as remindersPlugin } from "../src/plugins/reminders.js";
import { Store } from "../src/store.js";
import type { ActionPlugin, Config, Contact, IntentRouter, Runtime, RuntimeConfig, RuntimeEvents, RuntimeTool, Task,
  TurnOutcome } from "../src/contracts.js";
import { config, enroll, epoch, FakeTransport, member, message, messageFrom, owner, page, reminders } from "./helpers.js";

type Turn = (events: RuntimeEvents, input: string) => Promise<TurnOutcome>;
class FakeRuntime implements Runtime {
  manifest = { id: "codex", computerUse: "unverified" as const, ownerOnly: true };
  turns: Turn[] = [];
  calls: Array<{ kind: "start" | "resume"; task: number; input: string; tools: string[]; threadId: string | null }> = [];
  cancelled: number[] = [];
  onCancel: (() => void) | null = null;
  async start(task: Task, tools: readonly RuntimeTool[], events: RuntimeEvents) { return this.run("start", task, task.text, tools, events); }
  async resume(task: Task, input: string, tools: readonly RuntimeTool[], events: RuntimeEvents) { return this.run("resume", task, input, tools, events); }
  private async run(kind: "start" | "resume", task: Task, input: string, tools: readonly RuntimeTool[], events: RuntimeEvents) {
    this.calls.push({ kind, task: task.id, input, tools: tools.map(t => t.name), threadId: task.threadId });
    events.started({ threadId: task.threadId ?? `thread-${task.id}`, turnId: `turn-${this.calls.length}` });
    const turn = this.turns.shift() ?? (async () => ({ status: "completed", message: "Done.", evidence: ["checked"] }) as TurnOutcome);
    return turn(events, input);
  }
  async cancel(taskId: number) { this.cancelled.push(taskId); this.onCancel?.(); }
  close() {}
}

/** A turn that stays active until the test finishes it or the engine cancels it. */
function held(fake: FakeRuntime) {
  let finish!: (outcome: TurnOutcome) => void; let events: RuntimeEvents | undefined;
  const done = new Promise<TurnOutcome>(resolve => { finish = resolve; });
  fake.turns.push(async e => { events = e; fake.onCancel = () => finish({ status: "interrupted" }); return done; });
  return { finish: (outcome: TurnOutcome) => finish(outcome), events: () => events! };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const runtimeConfig: RuntimeConfig = { codexPath: "/usr/local/bin/codex", model: null, workspaceDir: "/tmp/nori-work",
  budget: { minutes: 30, turns: 3, toolCalls: 2, tokens: 1000 }, daily: { tasks: 5, tokens: 5000 }, approvalMinutes: 60 };
const withRuntime: Config = { ...config, contacts: [owner, member], runtime: runtimeConfig };

function setup(t: { after(fn: () => void): void }, cfg: Config = withRuntime, plugins: ActionPlugin[] = [remindersPlugin]) {
  const store = new Store(":memory:"); t.after(() => store.close());
  for (const contact of cfg.contacts) enroll(store, contact);
  const transport = new FakeTransport(); const runtime = new FakeRuntime(); let now = epoch;
  const engine = new Engine(cfg, store, transport, { clock: () => now, runtime, plugins });
  const texts = (contact: Contact = owner) => store.outbox(contact.id).map(x => x.text);
  return { store, transport, engine, runtime, texts, advance: (ms: number) => { now += ms; } };
}
/** Starts a turn and lets it reach its first await. Wrapped so awaiting this does not wait for the turn to end. */
async function started(engine: Engine) { const done = engine.runTasks(); await flush(); return { done }; }

test("the owner's unmatched request runs in the runtime with one acknowledgement and one result", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a replacement for my laptop")]));
  assert.match(texts()[0]!, /^Got it — job #1\. I'll message you when it's done/);
  await engine.routeTasks(null);
  assert.equal(store.tasks()[0]?.state, "routed");
  runtime.turns.push(async () => ({ status: "completed", message: "The X1 Carbon fits best.", evidence: ["Compared three reviews"] }));
  await engine.runTasks();
  assert.deepEqual(runtime.calls.map(c => [c.kind, c.input, c.threadId]), [["start", "research a replacement for my laptop", null]]);
  assert.deepEqual(runtime.calls[0]?.tools, ["reminders_remind", "reminders_note", "reminders_list", "reminders_done", "reminders_snooze"]);
  const task = store.tasks()[0]!;
  assert.deepEqual([task.state, task.threadId, task.outcome, task.evidence, task.usage.turns],
    ["completed", "thread-1", "The X1 Carbon fits best.", ["Compared three reviews"], 1]);
  assert.deepEqual(texts().slice(1), ["Job #1 is done. The X1 Carbon fits best."]);
});

test("a plugin's delegated task runs in the runtime without Jev", async t => {
  const handoff: ActionPlugin = {
    manifest: { id: "handoff", version: "1.0.0", stateVersion: 1, capabilities: [], roles: ["owner", "member"], criteria: "Hand off.", examples: [] },
    schema: { run: { text: { type: "string", maxLength: 200 } } }, migrate: () => {},
    match: text => text.startsWith("handoff ") ? { kind: "run", text: text.slice(8) } : null,
    handle: (command, ctx) => { ctx.reply(`Queued #${ctx.delegate(String(command.text), "codex")}.`); },
  };
  const cfg = { ...withRuntime, contacts: [owner, member].map(c => ({ ...c, plugins: ["reminders", "handoff"] })) };
  const { engine, store, runtime } = setup(t, cfg, [remindersPlugin, handoff]);
  engine.acceptPage("owner", page([message("handoff compare three laptops")]));
  engine.acceptPage("sam", page([messageFrom(member, "handoff compare phones", 2)]));
  let calls = 0;
  await engine.routeTasks({ classify: async () => { calls++; return null; } });
  assert.equal(calls, 0);
  assert.deepEqual(store.tasks().map(x => [x.contactId, x.state]), [["owner", "routed"], ["sam", "queued"]]);
  await engine.runTasks();
  assert.deepEqual(runtime.calls.map(c => c.input), ["compare three laptops"]);
});

test("members never reach an owner-only runtime", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("sam", page([messageFrom(member, "research a phone")]));
  assert.match(texts(member)[0]!, /^Saved job #1\. It is queued; Codex jobs are for the owner only\./);
  await engine.routeTasks(null); await engine.runTasks();
  assert.equal(store.tasks("sam")[0]?.state, "queued");
  assert.deepEqual(runtime.calls, []);
});

test("a runtime question waits for the contact, and the next reply resumes the same thread", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  runtime.turns.push(async () => ({ status: "needs_input", message: "What is your budget?" }));
  await engine.runTasks();
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.waitingFor], ["waiting_contact", { kind: "question" }]);
  assert.match(texts().at(-1)!, /^Job #1 asks: What is your budget\?/);
  engine.acceptPage("owner", page([message("about $1500", 2)]));
  assert.equal(store.tasks().length, 1);
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.input], ["routed", "about $1500"]);
  assert.equal(texts().at(-1), "Thanks — continuing job #1.");
  await engine.runTasks();
  assert.deepEqual(runtime.calls.map(c => [c.kind, c.input, c.threadId]),
    [["start", "research a laptop", null], ["resume", "about $1500", "thread-1"]]);
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.input], ["completed", null]);
});

test("with several questions waiting, an unaddressed reply asks which job it is for", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop"), message("research a phone", 2)]));
  await engine.routeTasks(null);
  runtime.turns.push(async () => ({ status: "needs_input", message: "Budget?" }), async () => ({ status: "needs_input", message: "Carrier?" }));
  await engine.runTasks(); await engine.runTasks();
  engine.acceptPage("owner", page([message("the cheaper one", 3)]));
  assert.equal(store.tasks().length, 2);
  assert.match(texts().at(-1)!, /Which job is that for\? Reply ‘#1 …’ or ‘#2 …’/);
  engine.acceptPage("owner", page([message("#2 Verizon", 4)]));
  assert.deepEqual(store.tasks().map(x => [x.state, x.input]), [["waiting_contact", null], ["routed", "Verizon"]]);
});

test("follow-ups sent before a job starts are part of its first turn", async t => {
  const { engine, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  engine.acceptPage("owner", page([message("#1 under $1500", 2)]));
  assert.equal(texts().at(-1), "Added to job #1.");
  await engine.runTasks();
  assert.deepEqual(runtime.calls.map(c => [c.kind, c.input]), [["start", "research a laptop\nunder $1500"]]);
});

test("follow-ups for a running job are queued for its next turn", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  const turn = held(runtime);
  const { done: run } = await started(engine);
  assert.equal(store.tasks()[0]?.state, "running");
  engine.acceptPage("owner", page([message("#1 prefer ThinkPads", 2), message("#1 under 3 pounds", 3), message("#9 hello", 4)]));
  assert.deepEqual(texts().slice(-3), ["Added to job #1.", "Added to job #1.", "No open job #9."]);
  turn.finish({ status: "completed", message: "Shortlist ready.", evidence: ["Checked specs"] });
  await run;
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.input], ["routed", "prefer ThinkPads\nunder 3 pounds"]);
  assert.equal(texts().at(-1), "Job #1 is done. Shortlist ready.");
  await engine.runTasks();
  assert.deepEqual(runtime.calls.at(-1)?.input, "prefer ThinkPads\nunder 3 pounds");
});

test("an approval round trip holds the turn until the task's own contact decides", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("check the weather service")]));
  await engine.routeTasks(null);
  let decision: boolean | undefined;
  runtime.turns.push(async events => {
    decision = await events.approval({ operation: "run a command", detail: "curl https://example.com/status" });
    return { status: "completed", message: "It is up.", evidence: ["HTTP 200"] };
  });
  const { done: run } = await started(engine);
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.waitingFor], ["waiting_contact", { kind: "approval" }]);
  assert.match(texts().at(-1)!, /^Job #1 needs your OK to run a command: curl https:\/\/example\.com\/status\nReply ‘approve A1’ or ‘deny A1’ within 60 minutes\.$/);
  engine.acceptPage("sam", page([messageFrom(member, "approve A1", 2)]));
  engine.acceptPage("owner", page([message("approve #1", 3)]));
  assert.equal(decision, undefined);
  assert.equal(texts(member).at(-1), "Approval A1 is not pending.");
  assert.equal(texts().at(-1), "Reply with the code from the request: ‘approve A1’ or ‘deny A1’.");
  engine.acceptPage("owner", page([message("approve A1", 4)]));
  await run;
  assert.equal(decision, true);
  assert.equal(texts().at(-2), "Approved A1 for job #1.");
  assert.deepEqual(store.approvals().map(x => [x.taskId, x.status]), [[store.tasks()[0]!.id, "approved"]]);
  assert.equal(store.tasks()[0]?.state, "completed");
});

test("deny, expiry, and cancellation all refuse a pending approval", async t => {
  for (const ending of ["deny", "expire", "cancel"] as const) {
    const { engine, store, runtime, texts, advance } = setup(t);
    engine.acceptPage("owner", page([message("check the weather service")]));
    await engine.routeTasks(null);
    let decision: boolean | undefined;
    runtime.turns.push(async events => {
      decision = await events.approval({ operation: "run a command", detail: "curl https://example.com" });
      return decision ? { status: "completed", message: "ok", evidence: ["x"] } : { status: "interrupted" };
    });
    const { done: run } = await started(engine);
    if (ending === "deny") engine.acceptPage("owner", page([message("deny A1", 2)]));
    if (ending === "expire") { advance(61 * 60_000); await engine.tick(); }
    if (ending === "cancel") engine.acceptPage("owner", page([message("cancel #1", 2)]));
    await run;
    assert.equal(decision, false, ending);
    assert.equal(store.approvals()[0]?.status, ending === "deny" ? "denied" : ending === "expire" ? "expired" : "denied");
    if (ending === "cancel") {
      assert.equal(store.tasks()[0]?.state, "cancelled");
      assert.equal(texts().at(-1), "Stopped job #1. Anything it already did stays done.");
    }
  }
});

test("tools expose only permitted plugins, validate arguments, deduplicate calls, and return replies as results", async t => {
  const { engine, store, runtime, texts } = setup(t, { ...withRuntime, runtime: { ...runtimeConfig, budget: { ...runtimeConfig.budget, toolCalls: 10 } } });
  engine.acceptPage("owner", page([message("sort out my errands")]));
  await engine.routeTasks(null);
  const results: Array<{ success: boolean; text: string }> = [];
  runtime.turns.push(async events => {
    results.push(await events.tool({ callId: "c1", name: "reminders_note", arguments: { title: "buy milk" } }));
    results.push(await events.tool({ callId: "c1", name: "reminders_note", arguments: { title: "buy milk" } }));
    results.push(await events.tool({ callId: "c2", name: "reminders_note", arguments: { title: "" } }));
    results.push(await events.tool({ callId: "c3", name: "reminders_explode", arguments: {} }));
    results.push(await events.tool({ callId: "c4", name: "private_run", arguments: { title: "x" } }));
    return { status: "completed", message: "Noted.", evidence: ["Saved reminder #1"] };
  });
  await engine.runTasks();
  assert.deepEqual(results.map(r => r.success), [true, true, false, false, false]);
  assert.equal(results[0]?.text, "Saved locally #1: buy milk.");
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(reminders(store).map(x => x.title), ["buy milk"]);
  assert.ok(!texts().some(x => x.startsWith("Saved locally")));
  assert.deepEqual(store.toolCalls(store.tasks()[0]!.id).map(x => [x.callId, x.success]), [["c1", true], ["c2", false], ["c3", false], ["c4", false]]);
});

test("high-impact tools need the contact's approval on every call", async t => {
  let sent = 0;
  const mailer: ActionPlugin = {
    manifest: { id: "mailer", version: "1.0.0", stateVersion: 1, capabilities: [], roles: ["owner"], criteria: "Send mail.", examples: [] },
    schema: { send: { to: { type: "string", maxLength: 100 } } }, migrate: () => {}, match: () => null,
    handle: (command, ctx) => { sent++; ctx.reply(`Sent to ${String(command.to)}.`); },
    tools: [{ kind: "send", description: "Send an email.", impact: "high" }],
  };
  const cfg = { ...withRuntime, contacts: [{ ...owner, plugins: ["reminders", "mailer"] }] };
  const { engine, runtime, texts } = setup(t, cfg, [remindersPlugin, mailer]);
  engine.acceptPage("owner", page([message("email Sam the notes")]));
  await engine.routeTasks(null);
  const results: boolean[] = [];
  runtime.turns.push(async events => {
    results.push((await events.tool({ callId: "a", name: "mailer_send", arguments: { to: "sam@example.com" } })).success);
    results.push((await events.tool({ callId: "b", name: "mailer_send", arguments: { to: "sam@example.com" } })).success);
    return { status: "completed", message: "Sent.", evidence: ["Tool confirmed"] };
  });
  const { done: run } = await started(engine);
  assert.match(texts().at(-1)!, /needs your OK to use mailer ‘send’: \{"to":"sam@example\.com"\}/);
  engine.acceptPage("owner", page([message("deny A1", 2)]));
  await flush(); await flush();
  assert.match(texts().at(-1)!, /needs your OK to use mailer ‘send’/);
  engine.acceptPage("owner", page([message("approve A2", 3)]));
  await run;
  assert.deepEqual(results, [false, true]);
  assert.equal(sent, 1);
});

test("reaching a budget pauses the task with a next-decision message, and continue grants more", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  const results: boolean[] = [];
  runtime.turns.push(async events => {
    for (const callId of ["a", "b", "c"]) results.push((await events.tool({ callId, name: "reminders_list", arguments: {} })).success);
    return { status: "interrupted" };
  });
  await engine.runTasks();
  assert.deepEqual(results, [true, true, false]);
  assert.deepEqual(runtime.cancelled, [store.tasks()[0]!.id]);
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.waitingFor], ["waiting_contact", { kind: "limit", limit: "toolCalls" }]);
  assert.equal(texts().at(-1), "Job #1 reached its tool-call limit. Reply ‘continue #1’ to allow more, or ‘cancel #1’.");
  engine.acceptPage("owner", page([message("#1 also the garage", 2)]));
  assert.equal(texts().at(-1), "Job #1 is paused. Reply ‘continue #1’ to resume it first.");
  engine.acceptPage("owner", page([message("continue #1", 3)]));
  assert.equal(texts().at(-1), "Continuing job #1.");
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.usage.allowance], ["routed", 2]);
  await engine.runTasks();
  assert.deepEqual(runtime.calls.at(-1)?.input, "Continue where you left off.");
  assert.equal(store.tasks()[0]?.state, "completed");
});

test("time, token, and turn budgets pause the task instead of failing it", async t => {
  const time = setup(t);
  time.engine.acceptPage("owner", page([message("organize everything")]));
  await time.engine.routeTasks(null);
  held(time.runtime);
  const { done: run } = await started(time.engine);
  time.advance(29 * 60_000); await time.engine.tick();
  assert.deepEqual(time.runtime.cancelled, []);
  time.advance(2 * 60_000); await time.engine.tick();
  await run;
  assert.deepEqual(time.store.tasks()[0]?.waitingFor, { kind: "limit", limit: "minutes" });

  const tokens = setup(t);
  tokens.engine.acceptPage("owner", page([message("organize everything")]));
  await tokens.engine.routeTasks(null);
  tokens.runtime.turns.push(async events => { events.usage(400); events.usage(1200); return { status: "interrupted" }; });
  await tokens.engine.runTasks();
  assert.deepEqual(tokens.store.tasks()[0]?.waitingFor, { kind: "limit", limit: "tokens" });
  assert.equal(tokens.store.tasks()[0]?.usage.tokens, 1200);

  const turns = setup(t);
  turns.engine.acceptPage("owner", page([message("organize everything")]));
  await turns.engine.routeTasks(null);
  for (let n = 0; n < 3; n++) turns.runtime.turns.push(async () => ({ status: "needs_input", message: "More?" }));
  for (let n = 0; n < 3; n++) {
    await turns.engine.runTasks();
    turns.engine.acceptPage("owner", page([message("yes", n + 2)]));
  }
  await turns.engine.runTasks();
  assert.equal(turns.runtime.calls.length, 3);
  assert.deepEqual(turns.store.tasks()[0]?.waitingFor, { kind: "limit", limit: "turns" });
});

test("approval waits do not count against the time budget", async t => {
  const { engine, store, runtime, advance } = setup(t);
  engine.acceptPage("owner", page([message("check the weather service")]));
  await engine.routeTasks(null);
  runtime.turns.push(async events => {
    await events.approval({ operation: "run a command", detail: "curl https://example.com" });
    return { status: "completed", message: "ok", evidence: ["x"] };
  });
  const { done: run } = await started(engine);
  advance(45 * 60_000); await engine.tick();
  engine.acceptPage("owner", page([message("approve A1", 2)]));
  await run;
  assert.deepEqual(runtime.cancelled, []);
  assert.equal(store.tasks()[0]?.state, "completed");
});

test("runtime turns run one at a time, and daily limits hold new tasks until the next local day", async t => {
  const { engine, store, runtime, advance } = setup(t, { ...withRuntime, runtime: { ...runtimeConfig, daily: { tasks: 1, tokens: 5000 } } });
  engine.acceptPage("owner", page([message("research a laptop"), message("research a phone", 2)]));
  await engine.routeTasks(null);
  const turn = held(runtime);
  const { done: run } = await started(engine);
  await engine.runTasks();
  assert.equal(runtime.calls.length, 1);
  turn.finish({ status: "completed", message: "ok", evidence: ["x"] }); await run;
  await engine.runTasks();
  assert.equal(runtime.calls.length, 1);
  engine.acceptPage("owner", page([message("status", 3)]));
  assert.match(store.outbox().at(-1)!.text, /Waiting to start: #2\.\nToday's Codex limit is reached; waiting jobs start tomorrow\./);
  advance(24 * 60 * 60_000); await engine.runTasks();
  assert.equal(runtime.calls.length, 2);
});

test("stop interrupts only the sender's running job", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  held(runtime);
  const { done: run } = await started(engine);
  engine.acceptPage("sam", page([messageFrom(member, "stop", 2)]));
  assert.match(texts(member).at(-1)!, /Nothing is running/);
  engine.acceptPage("owner", page([message("stop", 3)]));
  await run;
  assert.equal(store.tasks()[0]?.state, "cancelled");
  assert.deepEqual(runtime.cancelled, [store.tasks()[0]!.id]);
  assert.equal(texts().at(-1), "Stopped job #1. Anything it already did stays done.");
});

test("a lost connection or restart leaves the task interrupted until the contact continues", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop"), message("check the weather service", 2)]));
  await engine.routeTasks(null); await engine.routeTasks(null);
  runtime.turns.push(async () => { throw new Error("Codex app-server disconnected"); });
  await engine.runTasks();
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "interrupted" });
  assert.match(texts().at(-1)!, /^Job #1 was interrupted before it finished\. Reply ‘continue #1’ to resume it/);

  runtime.turns.push(async events => { await events.approval({ operation: "run a command", detail: "ls" }); return { status: "interrupted" }; });
  void engine.runTasks(); await flush();
  const next = new FakeRuntime();
  const restarted = new Engine(withRuntime, store, new FakeTransport(), { clock: () => epoch, runtime: next });
  restarted.recoverRuntime();
  assert.deepEqual(store.tasks().map(x => [x.state, x.waitingFor]),
    [["waiting_contact", { kind: "interrupted" }], ["waiting_contact", { kind: "interrupted" }]]);
  assert.equal(store.approvals()[0]?.status, "expired");
  assert.match(texts().at(-1)!, /^Job #2 was interrupted before it finished/);
  restarted.acceptPage("owner", page([message("continue #1", 3)]));
  await restarted.runTasks();
  assert.deepEqual(next.calls.map(c => [c.kind, c.threadId]), [["resume", "thread-1"]]);
  assert.match(next.calls[0]!.input, /interrupted before it finished\. Check what was already done/);
});

test("with a runtime, Jev picks plugin actions and everything else falls back to the runtime", async t => {
  const jev = { model: "jev-test", timeoutMs: 100, dailyLimit: 1, routes: { reminders: 0.9 } };
  const { engine, store, runtime } = setup(t, { ...withRuntime, jev });
  engine.acceptPage("owner", page([message("Can you remind me to call mom in 2 hours?"), message("what's up with my order", 2),
    message("research a phone", 3)]));
  engine.acceptPage("sam", page([messageFrom(member, "research a laptop", 4)]));
  const decisions: Record<string, ReturnType<IntentRouter["classify"]>> = {
    "Can you remind me to call mom in 2 hours?": Promise.resolve({ model: "jev-test", catalogVersion: "v", route: { kind: "action", pluginId: "reminders" },
      confidence: 0.95, probabilities: {}, multiAction: false }),
  };
  const calls: string[] = [];
  await engine.routeTasks({ classify: async text => { calls.push(text); return decisions[text] ?? null; } });
  assert.deepEqual(calls, ["Can you remind me to call mom in 2 hours?"]);
  assert.deepEqual(store.tasks().map(x => [x.contactId, x.state]),
    [["owner", "completed"], ["owner", "routed"], ["owner", "routed"], ["sam", "queued"]]);
  assert.equal(store.unroutedTasks().length, 1);
  assert.equal(reminders(store).length, 1);
  assert.deepEqual(runtime.calls, []);
});

test("status lists runtime progress for the sender only", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop"), message("research a phone", 2), message("check the weather", 3)]));
  await engine.routeTasks(null);
  runtime.turns.push(async () => ({ status: "needs_input", message: "Budget?" }));
  await engine.runTasks();
  runtime.turns.push(async events => { await events.approval({ operation: "run a command", detail: "ls" }); return { status: "interrupted" }; });
  const { done: run } = await started(engine);
  engine.acceptPage("owner", page([message("status", 4)]));
  engine.acceptPage("sam", page([messageFrom(member, "status", 5)]));
  const status = store.outbox("owner").at(-1)!.text;
  assert.match(status, /Waiting for your reply: #1\./);
  assert.match(status, /Waiting for your approval: #2\./);
  assert.match(status, /Waiting to start: #3\./);
  assert.doesNotMatch(store.outbox("sam").at(-1)!.text, /#1|#2|#3/);
  engine.acceptPage("owner", page([message("deny A1", 6)]));
  await run;
});

test("an overdue approval cannot be approved, even before the next tick expires it", async t => {
  const { engine, store, runtime, texts, advance } = setup(t);
  engine.acceptPage("owner", page([message("check the weather service")]));
  await engine.routeTasks(null);
  let decision: boolean | undefined;
  runtime.turns.push(async events => { decision = await events.approval({ operation: "run a command", detail: "curl x" }); return { status: "interrupted" }; });
  const { done } = await started(engine);
  advance(3 * 60 * 60_000);
  engine.acceptPage("owner", page([message("approve A1", 2)]));
  await done;
  assert.equal(decision, false);
  assert.equal(store.approvals()[0]?.status, "expired");
  assert.equal(texts().filter(x => x.startsWith("Job #1 was interrupted")).length, 1);
  assert.ok(texts().includes("The approval for job #1 expired, so it was refused."));
});

test("after a budget interrupt the turn gets no more approvals or tools, and the interrupt is re-sent each tick", async t => {
  const { engine, store, runtime, texts, advance } = setup(t);
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  const turn = held(runtime);
  runtime.onCancel = null;
  const { done } = await started(engine);
  runtime.onCancel = null;
  advance(31 * 60_000); await engine.tick(); await engine.tick();
  assert.equal(runtime.cancelled.length, 2);
  const approval = await turn.events().approval({ operation: "run a command", detail: "ls" });
  const tool = await turn.events().tool({ callId: "late", name: "reminders_list", arguments: {} });
  assert.deepEqual([approval, tool.success], [false, false]);
  assert.equal(store.approvals().length, 0);
  assert.ok(!texts().some(x => x.includes("needs your OK")));
  turn.finish({ status: "interrupted" }); await done;
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "limit", limit: "minutes" });
});

test("a job has at most one pending approval; the next is asked only after the first is decided", async t => {
  let sent = 0;
  const mailer: ActionPlugin = {
    manifest: { id: "mailer", version: "1.0.0", stateVersion: 1, capabilities: [], roles: ["owner"], criteria: "Send mail.", examples: [] },
    schema: { send: { to: { type: "string", maxLength: 100 } } }, migrate: () => {}, match: () => null,
    handle: (_command, ctx) => { sent++; ctx.reply("Sent."); },
    tools: [{ kind: "send", description: "Send an email.", impact: "high" }],
  };
  const cfg = { ...withRuntime, contacts: [{ ...owner, plugins: ["reminders", "mailer"] }] };
  const { engine, store, runtime, texts } = setup(t, cfg, [remindersPlugin, mailer]);
  engine.acceptPage("owner", page([message("email Sam and run a check")]));
  await engine.routeTasks(null);
  let tool: Promise<{ success: boolean }> | undefined; let command: Promise<boolean> | undefined;
  runtime.turns.push(async events => {
    tool = events.tool({ callId: "a", name: "mailer_send", arguments: { to: "sam@example.com" } });
    command = events.approval({ operation: "run a command", detail: "ls" });
    const results = [(await tool).success, await command];
    return { status: "completed", message: JSON.stringify(results), evidence: ["x"] };
  });
  const { done } = await started(engine);
  assert.equal(store.approvals().filter(x => x.status === "pending").length, 1);
  assert.equal(texts().filter(x => x.includes("needs your OK")).length, 1);
  engine.acceptPage("owner", page([message("approve A1", 2)]));
  await flush(); await flush();
  assert.equal(sent, 1);
  assert.match(texts().at(-1)!, /needs your OK to run a command: ls/);
  engine.acceptPage("owner", page([message("deny A2", 3)]));
  await done;
  assert.equal(texts().at(-1), "Job #1 is done. [true,false]");
});

test("an approval too long to show in full is refused without asking", async t => {
  const { engine, store, runtime, texts } = setup(t);
  engine.acceptPage("owner", page([message("check the weather service")]));
  await engine.routeTasks(null);
  let decision: boolean | undefined;
  runtime.turns.push(async events => { decision = await events.approval({ operation: "run a command", detail: `curl ${"x".repeat(2000)}` }); return { status: "completed", message: "ok", evidence: ["x"] }; });
  await engine.runTasks();
  assert.equal(decision, false);
  assert.equal(store.approvals().length, 0);
  assert.ok(!texts().some(x => x.includes("needs your OK")));
});

test("a question always waits for the contact; input sent during the turn goes with the answer", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  const turn = held(runtime);
  const { done } = await started(engine);
  engine.acceptPage("owner", page([message("#1 prefer ThinkPads", 2)]));
  turn.finish({ status: "needs_input", message: "What is your budget?" }); await done;
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.waitingFor], ["waiting_contact", { kind: "question" }]);
  engine.acceptPage("owner", page([message("about $1500", 3)]));
  assert.equal(store.tasks().length, 1);
  await engine.runTasks();
  assert.equal(runtime.calls.at(-1)?.input, "prefer ThinkPads\nabout $1500");
});

test("a delegated task without a hint still runs, and a completed outcome without evidence is not done", async t => {
  const handoff: ActionPlugin = {
    manifest: { id: "handoff", version: "1.0.0", stateVersion: 1, capabilities: [], roles: ["owner"], criteria: "Hand off.", examples: [] },
    schema: { run: { text: { type: "string", maxLength: 200 } } }, migrate: () => {},
    match: text => text.startsWith("handoff ") ? { kind: "run", text: text.slice(8) } : null,
    handle: (command, ctx) => { ctx.delegate(String(command.text)); ctx.reply("Handed off."); },
  };
  const cfg = { ...withRuntime, contacts: [{ ...owner, plugins: ["reminders", "handoff"] }] };
  const { engine, store, runtime, texts } = setup(t, cfg, [remindersPlugin, handoff]);
  engine.acceptPage("owner", page([message("handoff compare phones")]));
  await engine.routeTasks(null);
  runtime.turns.push(async () => ({ status: "completed", message: "Pick the Pixel.", evidence: [] }));
  await engine.runTasks();
  assert.deepEqual(runtime.calls.map(c => c.input), ["compare phones"]);
  assert.equal(store.tasks()[0]?.state, "failed");
  assert.equal(texts().at(-1), "Job #1 couldn't be finished: Pick the Pixel. (It reported no checks, so it is not marked done.)");
});

test("an approval code covers only its own request, and prompts that can no longer be answered are withdrawn", async t => {
  const { engine, store, runtime, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("check the weather service")]));
  await engine.routeTasks(null);
  const decisions: boolean[] = [];
  runtime.turns.push(async events => {
    decisions.push(await events.approval({ operation: "run a command", detail: "ls" }));
    decisions.push(await events.approval({ operation: "run a command", detail: "rm notes.txt" }));
    return { status: "completed", message: "ok", evidence: ["x"] };
  });
  const { done } = await started(engine);
  transport.outcomes.push({ status: "not_started", reason: "offline" }, { status: "not_started", reason: "offline" });
  await engine.tick();
  advance(61 * 60_000); engine.maintain(); await flush();
  assert.deepEqual(decisions, [false]);
  assert.equal(store.outbox().find(x => x.text.includes("A1"))?.status, "cancelled");
  engine.acceptPage("owner", page([message("approve A1", 2)]));
  await flush();
  assert.deepEqual(store.approvals().map(x => x.status), ["expired", "pending"]);
  engine.acceptPage("owner", page([message("deny A2", 3)]));
  await done;
  assert.deepEqual(decisions, [false, false]);
});

test("a failed plugin dispatch stays queued for review instead of falling back to the runtime", async t => {
  const jev = { model: "jev-test", timeoutMs: 100, dailyLimit: 10, routes: { reminders: 0.9 } };
  const { engine, store, runtime } = setup(t, { ...withRuntime, jev });
  engine.acceptPage("owner", page([message(`please note ${"x".repeat(4001)}`)]));
  await engine.routeTasks({ classify: async () => ({ model: "jev-test", catalogVersion: "v", route: { kind: "action", pluginId: "reminders" },
    confidence: 1, probabilities: {}, multiAction: false }) });
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.failure], ["queued", "reminders: invalid command"]);
  await engine.routeTasks(null); await engine.runTasks();
  assert.deepEqual(runtime.calls, []);
});

test("the runtime's own tool actions count against the tool-call budget", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  runtime.turns.push(async events => { events.activity(); events.activity(); events.activity(); return { status: "interrupted" }; });
  await engine.runTasks();
  assert.equal(store.tasks()[0]?.usage.toolCalls, 3);
  assert.deepEqual(runtime.cancelled, [store.tasks()[0]!.id]);
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "limit", limit: "toolCalls" });
});

test("budgets and approval expiry are enforced while a send is still in flight", async t => {
  const { engine, store, runtime, transport, advance } = setup(t);
  transport.send = () => new Promise(() => {});
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  held(runtime);
  const { done } = await started(engine);
  void engine.tick(); await flush();
  advance(31 * 60_000);
  engine.maintain();
  await done;
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "limit", limit: "minutes" });
});

test("a cancel whose interrupt fails closes the runtime, and a cancelled turn is interrupted again each poll", async t => {
  const { engine, store, runtime } = setup(t);
  let closed = 0;
  runtime.close = () => { closed++; };
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  held(runtime); runtime.onCancel = null;
  const { done } = await started(engine);
  runtime.onCancel = null;
  runtime.cancel = async taskId => { runtime.cancelled.push(taskId); throw new Error("interrupt timed out"); };
  engine.acceptPage("owner", page([message("cancel #1", 2)]));
  await flush(); await flush();
  assert.equal(closed, 1);
  engine.maintain(); await flush();
  assert.equal(runtime.cancelled.length, 2);
  assert.equal(store.tasks()[0]?.state, "cancelled");
  void done;
});

test("a request stays with the task until the runtime accepts its turn", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  engine.acceptPage("owner", page([message("#1 under $1500", 2)]));
  runtime.turns.push(async () => { throw new Error("turn/start timed out"); });
  runtime.start = async (task, _tools, events) => { runtime.calls.push({ kind: "start", task: task.id, input: task.text, tools: [], threadId: null });
    events.started({ threadId: "thread-1", turnId: null }); throw new Error("turn/start timed out"); };
  await engine.runTasks();
  assert.deepEqual([store.tasks()[0]?.threadId, store.tasks()[0]?.input], ["thread-1", "research a laptop\nunder $1500"]);
  engine.acceptPage("owner", page([message("continue #1", 3)]));
  await engine.runTasks();
  assert.match(runtime.calls.at(-1)!.input, /interrupted before it finished[\s\S]*research a laptop\nunder \$1500$/);
  assert.equal(store.tasks()[0]?.input, null);
});

test("an exhausted budget holds even if the turn ends with a question, and is checked before any turn starts", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  runtime.turns.push(async events => { events.usage(1001); return { status: "needs_input", message: "Which room first?" }; });
  await engine.runTasks();
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "limit", limit: "tokens" });
  store.updateTask(store.tasks()[0]!.id, { state: "routed", waitingFor: null, input: "kitchen" });
  await engine.runTasks();
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "limit", limit: "tokens" });
});

test("concurrent high-impact tool calls are charged against the budget when they run, not when they were asked", async t => {
  let sent = 0;
  const mailer: ActionPlugin = {
    manifest: { id: "mailer", version: "1.0.0", stateVersion: 1, capabilities: [], roles: ["owner"], criteria: "Send mail.", examples: [] },
    schema: { send: { to: { type: "string", maxLength: 100 } } }, migrate: () => {}, match: () => null,
    handle: (_command, ctx) => { sent++; ctx.reply("Sent."); },
    tools: [{ kind: "send", description: "Send an email.", impact: "high" }],
  };
  const cfg = { ...withRuntime, contacts: [{ ...owner, plugins: ["reminders", "mailer"] }] };
  const { engine, runtime } = setup(t, cfg, [remindersPlugin, mailer]);
  engine.acceptPage("owner", page([message("email everyone")]));
  await engine.routeTasks(null);
  let results: boolean[] = [];
  runtime.turns.push(async events => {
    results = (await Promise.all(["a", "b", "c"].map(callId => events.tool({ callId, name: "mailer_send", arguments: { to: `${callId}@example.com` } }))))
      .map(r => r.success);
    return { status: "interrupted" };
  });
  const { done } = await started(engine);
  for (const [n, code] of ["A1", "A2", "A3"].entries()) { engine.acceptPage("owner", page([message(`approve ${code}`, n + 2)])); await flush(); await flush(); }
  await done;
  assert.equal(sent, 2);
  assert.deepEqual(results, [true, true, false]);
});

test("accepted input is removed once, so a follow-up that repeats it survives", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks(null);
  const turn = held(runtime);
  const { done } = await started(engine);
  engine.acceptPage("owner", page([message("#1 research a laptop with a better display", 2)]));
  turn.finish({ status: "completed", message: "ok", evidence: ["x"] }); await done;
  assert.equal(store.tasks()[0]?.input, "research a laptop with a better display");
});

test("unsent approval prompts are withdrawn when the turn ends or Nori restarts", async t => {
  for (const ending of ["disconnect", "restart"] as const) {
    const { engine, store, runtime, transport } = setup(t);
    engine.acceptPage("owner", page([message("check the weather service")]));
    await engine.routeTasks(null);
    let fail!: (error: Error) => void;
    runtime.turns.push(events => new Promise((_resolve, reject) => { fail = reject; void events.approval({ operation: "run a command", detail: "ls" }); }));
    const { done } = await started(engine);
    transport.outcomes.push({ status: "not_started", reason: "offline" }, { status: "not_started", reason: "offline" });
    await engine.tick();
    if (ending === "disconnect") { fail(new Error("disconnected")); await done; }
    else new Engine(withRuntime, store, new FakeTransport(), { clock: () => epoch, runtime: new FakeRuntime() }).recoverRuntime();
    assert.equal(store.outbox().find(x => x.text.includes("needs your OK"))?.status, "cancelled", ending);
  }
});

test("a fresh job blocked by the daily limit does not stall jobs that resume existing threads", async t => {
  const { engine, store, runtime } = setup(t, { ...withRuntime, runtime: { ...runtimeConfig, daily: { tasks: 2, tokens: 5000 } } });
  engine.acceptPage("owner", page([message("research a laptop"), message("research a phone", 2)]));
  await engine.routeTasks(null);
  const start = runtime.start.bind(runtime);
  runtime.start = async (task, tools, events) => { if (task.number === 1) throw new Error("turn/start timed out"); return start(task, tools, events); };
  await engine.runTasks();
  runtime.turns.push(async () => ({ status: "needs_input", message: "Carrier?" }));
  await engine.runTasks();
  engine.acceptPage("owner", page([message("continue #1", 3), message("#2 Verizon", 4)]));
  assert.deepEqual(store.tasks().map(x => [x.state, x.threadId]), [["routed", null], ["routed", "thread-2"]]);
  await engine.runTasks();
  assert.deepEqual(runtime.calls.at(-1), { kind: "resume", task: store.tasks()[1]!.id, input: "Verizon", tools: runtime.calls.at(-1)!.tools, threadId: "thread-2" });
});

test("reaching the token limit exactly still requires continue", async t => {
  const { engine, store, runtime } = setup(t);
  engine.acceptPage("owner", page([message("organize everything")]));
  await engine.routeTasks(null);
  runtime.turns.push(async events => { events.usage(1000); return { status: "needs_input", message: "Which room?" }; });
  await engine.runTasks();
  engine.acceptPage("owner", page([message("kitchen", 2)]));
  await engine.runTasks();
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(store.tasks()[0]?.waitingFor, { kind: "limit", limit: "tokens" });
});
