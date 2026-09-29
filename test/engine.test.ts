import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { reminders as remindersPlugin } from "../src/plugins/reminders.js";
import { Store } from "../src/store.js";
import type { ActionPlugin, Config, Contact, PluginContext, PluginManifest } from "../src/contracts.js";
import { config, enroll, epoch, FakeTransport, member, message, messageFrom, owner, page, reminders } from "./helpers.js";

type PluginParts = Partial<Omit<ActionPlugin, "manifest">> & { manifest?: Partial<PluginManifest> };
function fakePlugin(id: string, parts: PluginParts = {}): ActionPlugin {
  const { manifest, ...rest } = parts;
  return {
    manifest: { id, version: "1.0.0", stateVersion: 1, capabilities: ["storage", "schedule"], roles: ["owner", "member"],
      criteria: `Requests for ${id}.`, examples: [`${id} something`], ...manifest },
    schema: { run: { title: { type: "string", maxLength: 100 } } },
    migrate: () => {},
    match: text => text.startsWith(`${id} `) ? { kind: "run", title: text.slice(id.length + 1) } : null,
    handle: (command, ctx) => { ctx.state.set(`item:${ctx.state.nextId("item")}`, command.title); ctx.reply(`${id} ran ${String(command.title)}`); },
    ...rest,
  };
}

function setup(t: { after(fn: () => void): void }, plugins: ActionPlugin[] = [], contacts: Contact[] = [owner]) {
  const store = new Store(":memory:"); t.after(() => store.close());
  const ids = plugins.map(p => p.manifest.id);
  const configured = contacts.map(c => ({ ...c, plugins: [...c.plugins, ...ids] }));
  for (const contact of configured) enroll(store, contact);
  const transport = new FakeTransport(); let now = epoch;
  const engine = new Engine({ ...config, contacts: configured }, store, transport,
    { plugins: [remindersPlugin, ...plugins], clock: () => now });
  return { store, transport, engine, advance: (ms: number) => { now += ms; } };
}

test("groups, foreign handles, foreign chats and echoes never enter personal state", t => {
  const { store, engine } = setup(t);
  engine.acceptPage("owner", page([
    message("secret", 1, { sender: "stranger@example.com" }),
    message("secret", 2, { isGroup: true }),
    message("secret", 3, { isFromMe: true }),
    message("secret", 4, { chatGuid: "iMessage;+;group" }),
    message("secret", 5, { chatId: 99 }),
  ]));
  assert.deepEqual(store.counts(), { inbox: 0, tasks: 0, state: 0, timers: 0, uncertain: 0 });
  assert.equal(store.enrollment("owner")?.cursor, 5);
});

test("invalid page rolls back message effects and cursor together", t => {
  const { store, engine } = setup(t);
  assert.throws(() => engine.acceptPage("owner", page([message("note buy milk", 2)], 1)));
  assert.equal(reminders(store).length, 0);
  assert.equal(store.enrollment("owner")?.cursor, 0);
});

test("never implicitly enroll or execute historical messages before the watermark", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const engine = new Engine(config, store, new FakeTransport(), { clock: () => epoch });
  assert.throws(() => engine.acceptPage("owner", page([message("note old task")])), /enroll/i);
  enroll(store, owner, 100);
  engine.acceptPage("owner", page([message("note old task", 1)], 100));
  assert.equal(reminders(store).length, 0);
  assert.throws(() => enroll(store, owner, 0));
});

test("uncertain sends are retained without automatic retry", async t => {
  const { engine, store, transport, advance } = setup(t);
  transport.outcomes.push({ status: "uncertain", reason: "timeout" });
  engine.acceptPage("owner", page([message("note buy milk")]));
  await engine.tick(); advance(1_000_000); await engine.tick();
  assert.equal(transport.sent.length, 1);
  assert.equal(store.outbox()[0]?.status, "uncertain");
});

test("unexpected transport exceptions are uncertain, never safe retries", async t => {
  const { engine, store, transport } = setup(t);
  transport.send = async () => { throw new Error("lost response"); };
  engine.acceptPage("owner", page([message("note buy milk")]));
  await engine.tick();
  assert.equal(store.outbox()[0]?.status, "uncertain");
});

test("process recovery marks an interrupted send uncertain", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("note buy milk")]));
  assert.ok(store.claimOutgoing(epoch, () => true));
  store.recoverInFlight();
  assert.equal(store.outbox()[0]?.status, "uncertain");
  assert.equal(store.claimOutgoing(epoch, () => true), null);
});

test("complex work stays queued intact and can be cancelled without a model", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("research a replacement for my laptop"), message("find flights to Denver", 2)]));
  assert.deepEqual(store.tasks().map(x => [x.number, x.text, x.state]),
    [[1, "research a replacement for my laptop", "queued"], [2, "find flights to Denver", "queued"]]);
  assert.match(store.outbox()[0]!.text, /Saved job #1/);
  engine.acceptPage("owner", page([message("cancel job #1", 3), message("cancel #2", 4)]));
  assert.deepEqual(store.tasks().map(x => x.state), ["cancelled", "cancelled"]);
});

test("compound and quoted requests bypass plugin grammars and stay whole", t => {
  const { engine, store } = setup(t);
  const texts = ["note buy milk; remind me to call in 5 minutes", "remind me to call tomorrow at 10 am and also email Sam",
    'Someone said: "pause all"'];
  engine.acceptPage("owner", page(texts.map((text, i) => message(text, i + 1))));
  assert.deepEqual(store.tasks().map(x => x.text), texts);
  assert.equal(reminders(store).length, 0);
  assert.equal(store.setting("pause:owner"), null);
});

test("a thrown plugin error fails only that dispatch and retains the request", t => {
  const boom = fakePlugin("boom", { handle: (_command, ctx) => { ctx.state.set("partial", true); ctx.reply("half"); throw new Error("secret text"); } });
  const { engine, store } = setup(t, [boom]);
  engine.acceptPage("owner", page([message("boom now"), message("note buy milk", 2)]));
  assert.equal(store.stateGet("boom", "owner", "partial"), null);
  assert.deepEqual(store.tasks().map(x => [x.text, x.failure]), [["boom now", "boom: handler error"]]);
  assert.doesNotMatch(JSON.stringify(store.tasks()), /secret text/);
  assert.deepEqual(store.outbox().map(x => x.text.split(".")[0]), ["Something went wrong with that request", "Saved locally #1: buy milk"]);
  assert.equal(store.unroutedTasks().length, 0);
});

test("commands that fail their schema never reach handle", t => {
  let handled = 0;
  const bad = fakePlugin("bad", { handle: () => { handled++; },
    match: text => text === "bad extra" ? { kind: "run", title: "x", extra: 1 } : text === "bad kind" ? { kind: "other" }
      : text === "bad type" ? { kind: "run", title: 7 } : null });
  const { engine, store } = setup(t, [bad]);
  engine.acceptPage("owner", page([message("bad extra"), message("bad kind", 2), message("bad type", 3)]));
  assert.equal(handled, 0);
  assert.deepEqual(store.tasks().map(x => x.failure), ["bad: invalid command", "bad: invalid command", "bad: invalid command"]);
});

test("asynchronous handlers are refused and rolled back", async t => {
  const slow = fakePlugin("slow", { handle: (async (_command: unknown, ctx: PluginContext) => {
    ctx.state.set("early", 1); await Promise.resolve(); throw new Error("late");
  }) as unknown as ActionPlugin["handle"] });
  const { engine, store } = setup(t, [slow]);
  engine.acceptPage("owner", page([message("slow run")]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.stateGet("slow", "owner", "early"), null);
  assert.equal(store.tasks()[0]?.failure, "slow: handler error");
});

test("a plugin context cannot be used after its dispatch", t => {
  let saved: PluginContext | undefined;
  const leaky = fakePlugin("leaky", { handle: (_command, ctx) => { saved = ctx; ctx.reply("ok"); } });
  const { engine, store } = setup(t, [leaky]);
  engine.acceptPage("owner", page([message("leaky run")]));
  assert.throws(() => saved!.reply("later"));
  assert.throws(() => saved!.state.get("anything"));
  assert.equal(store.outbox().length, 1);
});

test("capabilities gate storage and timers", t => {
  const stateless = fakePlugin("stateless", { manifest: { capabilities: [] },
    handle: (_command, ctx) => { ctx.schedule("k", epoch, {}); } });
  const { engine, store } = setup(t, [stateless]);
  engine.acceptPage("owner", page([message("stateless run")]));
  assert.equal(store.timers().length, 0);
  assert.equal(store.tasks()[0]?.failure, "stateless: handler error");
});

test("plugins match in registry order and the first whole-message match wins", t => {
  const calls: string[] = [];
  const first = fakePlugin("first", { match: text => { calls.push("first"); return text === "shared" ? { kind: "run", title: "a" } : null; } });
  const second = fakePlugin("second", { match: text => { calls.push("second"); return text === "shared" ? { kind: "run", title: "b" } : null; } });
  const { engine, store } = setup(t, [first, second]);
  engine.acceptPage("owner", page([message("shared")]));
  assert.deepEqual(calls, ["first"]);
  assert.equal(store.outbox()[0]?.text, "first ran a");
});

test("a plugin runs only when the allowlist names it and its manifest permits the role", t => {
  const ownerOnly = fakePlugin("private", { manifest: { roles: ["owner"] } });
  const { engine, store } = setup(t, [ownerOnly], [owner, member]);
  engine.acceptPage("sam", page([messageFrom(member, "private run", 1)]));
  assert.equal(store.stateList("private", "sam", "").length, 0);
  assert.equal(store.tasks("sam")[0]?.text, "private run");
  const store2 = new Store(":memory:"); t.after(() => store2.close());
  const noReminders = { ...owner, plugins: [] };
  enroll(store2, noReminders);
  new Engine({ ...config, contacts: [noReminders] }, store2, new FakeTransport(), { clock: () => epoch })
    .acceptPage("owner", page([message("note buy milk")]));
  assert.equal(reminders(store2).length, 0);
  assert.equal(store2.tasks()[0]?.text, "note buy milk");
});

test("timers fire once, rescheduling replaces the pending fire, and unpermitted plugins do not fire", async t => {
  const fired: string[] = [];
  const timed = fakePlugin("timed", {
    handle: (command, ctx) => { ctx.schedule("only", ctx.time + Number(command.title) * 60_000, { minutes: command.title }); },
    onTimer: (timer, ctx) => { fired.push(JSON.stringify(timer.payload)); ctx.reply("fired"); },
  });
  const { engine, store, advance, transport } = setup(t, [timed]);
  engine.acceptPage("owner", page([message("timed 1"), message("timed 5", 2)]));
  advance(60_000); await engine.tick();
  assert.deepEqual(fired, []);
  advance(4 * 60_000); await engine.tick(); await engine.tick();
  assert.deepEqual(fired, ['{"minutes":"5"}']);
  assert.equal(transport.sent.filter(x => x === "fired").length, 1);
  engine.acceptPage("owner", page([message("timed 1", 3)]));
  const revoked = new Engine({ ...config, contacts: [owner] }, store, transport, { plugins: [remindersPlugin, timed], clock: () => epoch + 60 * 60_000 });
  await revoked.tick();
  assert.equal(fired.length, 1);
  assert.equal(store.timers()[0]?.status, "pending");
});

test("a timer cancelled or rescheduled by an earlier fire in the same batch does not fire stale", async t => {
  const fired: string[] = [];
  const chain = fakePlugin("chain", {
    handle: (_command, ctx) => { for (const key of ["a", "b", "c"]) ctx.schedule(key, ctx.time + 60_000, { key }); },
    onTimer: (timer, ctx) => {
      fired.push(timer.key);
      if (timer.key === "a") { ctx.schedule("b", ctx.time + 60 * 60_000, { key: "b", later: true }); ctx.cancelTimer("c"); }
      ctx.reply(`fired ${timer.key}`);
    },
  });
  const { engine, store, advance, transport } = setup(t, [chain]);
  engine.acceptPage("owner", page([message("chain go")]));
  advance(60_000); await engine.tick();
  assert.deepEqual(fired, ["a"]);
  assert.deepEqual(store.timers().map(x => [x.key, x.status]), [["a", "fired"], ["b", "pending"], ["c", "cancelled"]]);
  advance(60 * 60_000); await engine.tick();
  assert.deepEqual(fired, ["a", "b"]);
  assert.deepEqual(transport.sent, ["fired a", "fired b"]);
});

test("delegate creates a durable task for the contact that bypasses Jev", t => {
  const handoff = fakePlugin("handoff", { handle: (command, ctx) => { ctx.reply(`Queued #${ctx.delegate(String(command.title), "codex")}`); } });
  const { engine, store } = setup(t, [handoff]);
  engine.acceptPage("owner", page([message("research first"), message("handoff compare three laptops", 2)]));
  assert.deepEqual(store.tasks().map(x => [x.number, x.text, x.hint]), [[1, "research first", null], [2, "compare three laptops", "codex"]]);
  assert.equal(store.outbox()[1]?.text, "Queued #2");
  assert.deepEqual(store.unroutedTasks().map(x => x.number), [1]);
});

test("plugin state migrations run once and newer state is refused", t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  const froms: number[] = [];
  const v2 = fakePlugin("migrating", { manifest: { stateVersion: 2 }, migrate: (db, from) => { froms.push(from); db.set("owner", "seed", from); } });
  const contacts = [{ ...owner, plugins: ["reminders", "migrating"] }];
  new Engine({ ...config, contacts }, store, new FakeTransport(), { plugins: [remindersPlugin, v2] });
  new Engine({ ...config, contacts }, store, new FakeTransport(), { plugins: [remindersPlugin, v2] });
  assert.deepEqual(froms, [0]);
  assert.equal(store.stateGet("migrating", "owner", "seed"), 0);
  const v1 = fakePlugin("migrating", { manifest: { stateVersion: 1 } });
  assert.throws(() => new Engine({ ...config, contacts }, store, new FakeTransport(), { plugins: [remindersPlugin, v1] }), /newer/);
});

test("manifests, allowlists, and Jev routes are checked when the engine starts", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const start = (cfg: Config, plugins: ActionPlugin[] = [remindersPlugin]) => new Engine(cfg, store, new FakeTransport(), { plugins });
  assert.throws(() => start({ ...config, contacts: [{ ...owner, plugins: ["missing"] }] }), /missing/);
  assert.throws(() => start({ ...config, jev: { model: "jev-test", timeoutMs: 100, dailyLimit: 10, routes: { missing: 0.9 } } }), /missing/);
  assert.throws(() => start(config, [remindersPlugin, fakePlugin("runtime")]), /reserved/);
  assert.throws(() => start(config, [remindersPlugin, fakePlugin("Bad Id")]), /id/);
  assert.throws(() => start(config, [remindersPlugin, remindersPlugin]), /duplicate/i);
  const plain = { ...config, contacts: [{ ...owner, plugins: ["reminders", "plain"] }],
    jev: { model: "jev-test", timeoutMs: 100, dailyLimit: 10, routes: { plain: 0.9 } } };
  assert.throws(() => start(plain, [remindersPlugin, fakePlugin("plain")]), /interpret/);
});

test("help lists permitted plugin examples and stop reports that nothing is running", t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("help"), message("stop", 2)]));
  assert.match(store.outbox()[0]!.text, /remind me to call tomorrow at 10 am/);
  assert.match(store.outbox()[1]!.text, /Nothing is running/);
  assert.equal(store.tasks().length, 0);
});

test("a fired timer's queued message is held while its plugin is not permitted", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  const transport = new FakeTransport(); let now = epoch;
  const engine = new Engine(config, store, transport, { clock: () => now });
  engine.acceptPage("owner", page([message("remind me to stretch in 1 minute"), message("pause all", 2)]));
  now += 60_000; await engine.tick();
  const revoked = new Engine({ ...config, contacts: [{ ...owner, plugins: [] }] }, store, transport, { clock: () => now });
  revoked.acceptPage("owner", page([message("resume", 3)]));
  await revoked.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 0);
  await engine.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("a message withdrawn while it is being sent is not retried", t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store);
  store.enqueue({ key: "approval:1", contactId: "owner", target: owner.conversation, text: "Approve?", kind: "reply", timer: null }, epoch);
  const item = store.claimOutgoing(epoch, () => true)!;
  store.cancelOutbox("approval:1");
  store.finishSend(item, { status: "not_started", reason: "offline" }, epoch);
  assert.equal(store.outbox()[0]?.status, "cancelled");
  assert.equal(store.claimOutgoing(epoch + 3_600_000, () => true), null);
});
