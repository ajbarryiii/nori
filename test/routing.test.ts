import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import type { ActionPlugin, Config, IntentRouter, Route, RoutingDecision } from "../src/contracts.js";
import { reminders as remindersPlugin } from "../src/plugins/reminders.js";
import { config, enroll, epoch, FakeTransport, member, message, messageFrom, owner, page, reminders } from "./helpers.js";

const jev = { model: "jev-test", timeoutMs: 100, dailyLimit: 100, routes: { reminders: 0.9 }, thresholds: { act: 0.8, clarify: 0.5, verify: 0.6 } };
const active: Config = { ...config, contacts: [owner, member], jev };
const decide = (route: Route, confidence = 1, multiAction = false): RoutingDecision =>
  ({ model: "jev-test", catalogVersion: "test", route, confidence, probabilities: {}, multiAction });
const routeFor = (label: string): Route => label === "runtime" || label === "continue" || label === "clarify"
  ? { kind: label } : { kind: "action", pluginId: label };
const always = (decision: RoutingDecision | null): IntentRouter => ({ classify: async () => decision });

function setup(t: { after(fn: () => void): void }, cfg: Config = active, path = ":memory:") {
  const store = new Store(path); t.after(() => store.close());
  for (const contact of cfg.contacts) enroll(store, contact);
  const transport = new FakeTransport(); let now = epoch;
  const engine = new Engine(cfg, store, transport, { clock: () => now });
  return { store, transport, engine, advance: (ms: number) => { now += ms; } };
}

test("the catalog is generated from each contact's permitted plugins", t => {
  const { engine } = setup(t, { ...active, contacts: [owner, member, { ...member, id: "kim", handles: ["kim@example.com"],
    conversation: { chatId: 44, chatGuid: "iMessage;-;kim@example.com" }, plugins: [] }] });
  const ids = (id: string) => engine.host.catalog(engine.activeContacts().find(c => c.id === id)!).options.map(o => o.id);
  assert.deepEqual(ids("owner"), ["reminders", "runtime", "continue", "clarify"]);
  assert.deepEqual(ids("sam"), ["reminders", "continue", "clarify"]);
  assert.deepEqual(ids("kim"), ["continue", "clarify"]);
  const [a, b] = engine.activeContacts().map(c => engine.host.catalog(c).version);
  assert.equal(engine.host.catalog(owner).version, a); assert.notEqual(a, b);
});

test("labeled fixtures: commands and grammars bypass Jev; enabled routes act; others stay queued", async t => {
  type Fixture = { text: string; label: string; grammar?: boolean; multiAction?: boolean; outcome?: string };
  const fixtures = JSON.parse(readFileSync(resolve("test/fixtures/routing.json"), "utf8")) as Fixture[];
  for (const [i, fixture] of fixtures.entries()) {
    const { store, engine } = setup(t);
    engine.acceptPage("owner", page([message(fixture.text, i + 1)]));
    const calls: string[] = [];
    await engine.routeTasks({ classify: async text => {
      calls.push(text); return decide(routeFor(fixture.label), 1, fixture.multiAction ?? false);
    } });
    if (fixture.grammar) {
      assert.deepEqual([store.tasks().length, calls.length], [0, 0], fixture.text);
      continue;
    }
    assert.deepEqual(calls, [fixture.text]);
    assert.deepEqual(store.tasks().map(x => [x.text, x.state]), [[fixture.text, fixture.outcome]], fixture.text);
    assert.deepEqual(store.tasks()[0]?.route?.route, routeFor(fixture.label));
  }
});

test("Jev remains advisory in shadow mode and is not called for commands", async t => {
  const { engine, store } = setup(t, { ...active, jev: null });
  engine.acceptPage("owner", page([message("note buy milk"), message("Can you remind me to call mom in 2 hours?", 2)]));
  let calls = 0;
  await engine.routeTasks({ classify: async () => { calls++; return decide({ kind: "action", pluginId: "reminders" }); } });
  assert.equal(calls, 1);
  assert.equal(store.tasks()[0]?.state, "queued");
  assert.deepEqual(store.tasks()[0]?.route?.route, { kind: "action", pluginId: "reminders" });
  assert.equal(reminders(store).length, 1);
});

test("an enabled route acts through interpret, validation, and handle", async t => {
  const { engine, store, transport } = setup(t);
  engine.acceptPage("owner", page([message("Can you remind me to call mom in 2 hours?")]));
  await engine.routeTasks(always(decide({ kind: "action", pluginId: "reminders" }, 0.95)));
  assert.equal(store.tasks()[0]?.state, "completed");
  assert.deepEqual(reminders(store).map(x => [x.title, x.dueAt]), [["call mom", epoch + 2 * 60 * 60_000]]);
  await engine.tick();
  assert.match(transport.sent[0]!, /Saved job #1/);
  assert.match(transport.sent[1]!, /Saved locally #1: call mom/);
  assert.deepEqual(transport.targets, [owner.conversation, owner.conversation]);
});

test("boundary whitespace does not keep an enabled route from acting", async t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("Can you remind me to call mom in 2 hours?\n"), message("\nCan you remind me to stretch in 1 hour?", 2)]));
  await engine.routeTasks(always(decide({ kind: "action", pluginId: "reminders" }, 0.95)));
  assert.deepEqual(store.tasks().map(x => x.state), ["completed", "completed"]);
  assert.deepEqual(reminders(store).map(x => x.title), ["call mom", "stretch"]);
});

test("low confidence, multiple actions, compound text, and unpermitted routes never act", async t => {
  const texts = ["Can you remind me to call mom in 2 hours?", "Can you remind me to call mom in 2 hours; and email Sam?"];
  const cases: Array<[string, RoutingDecision, Config]> = [
    [texts[0]!, decide({ kind: "action", pluginId: "reminders" }, 0.89), active],
    [texts[0]!, decide({ kind: "action", pluginId: "reminders" }, 1, true), active],
    [texts[1]!, decide({ kind: "action", pluginId: "reminders" }, 1), active],
    [texts[0]!, decide({ kind: "action", pluginId: "reminders" }, 1), { ...active, contacts: [{ ...owner, plugins: [] }] }],
    [texts[0]!, decide({ kind: "action", pluginId: "reminders" }, 1), { ...active, jev: { ...jev, routes: {} } }],
    [texts[0]!, decide({ kind: "runtime" }, 1), active],
  ];
  for (const [text, decision, cfg] of cases) {
    const { engine, store } = setup(t, cfg);
    engine.acceptPage("owner", page([message(text)]));
    await engine.routeTasks(always(decision));
    assert.equal(store.tasks()[0]?.state, "queued", JSON.stringify(decision));
    assert.equal(reminders(store).length, 0);
    assert.equal(store.outbox().length, 1);
  }
});

test("a claimed route still acts if the lifecycle gate closes while Jev answers", async t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("Can you remind me to call mom in 2 hours?")]));
  let open = true;
  await engine.routeTasks({ classify: async () => { open = false; return decide({ kind: "action", pluginId: "reminders" }); } }, () => open);
  assert.equal(store.tasks()[0]?.state, "completed");
  assert.equal(reminders(store).length, 1);
});

test("an interpret clarification asks for a complete request and closes the job", async t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("could you remind me about the dentist sometime?")]));
  await engine.routeTasks(always(decide({ kind: "action", pluginId: "reminders" })));
  assert.deepEqual([store.tasks()[0]?.state, store.tasks()[0]?.waitingFor], ["failed", null]);
  assert.match(store.outbox().at(-1)!.text, /date and time/);
  engine.acceptPage("owner", page([message("remind me to call the dentist tomorrow at 10 am", 2), message("status", 3)]));
  assert.equal(reminders(store).length, 1);
  assert.doesNotMatch(store.outbox().at(-1)!.text, /Waiting for your reply/);
});

test("a task cancelled while its route is pending is never executed", async t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("Can you remind me to call mom in 2 hours?")]));
  await engine.routeTasks({ classify: async () => {
    engine.acceptPage("owner", page([message("cancel #1", 2)]));
    return decide({ kind: "action", pluginId: "reminders" });
  } });
  assert.equal(store.tasks()[0]?.state, "cancelled");
  assert.equal(store.tasks()[0]?.route, null);
  assert.equal(reminders(store).length, 0);
});

test("router failure cannot lose or fail the queued job", async t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop")]));
  await engine.routeTasks({ classify: async () => { throw new Error("offline"); } });
  assert.equal(store.tasks()[0]?.state, "queued");
  assert.equal(store.tasks()[0]?.route, null);
});

test("cancelling a job while earlier advice is pending prevents its model call", async t => {
  const { engine, store } = setup(t);
  engine.acceptPage("owner", page([message("research a laptop"), message("research a phone", 2)]));
  const calls: string[] = [];
  await engine.routeTasks({ classify: async text => {
    calls.push(text);
    engine.acceptPage("owner", page([message("cancel job #2", 3)]));
    return null;
  } });
  assert.deepEqual(calls, ["research a laptop"]);
  assert.equal(store.tasks()[1]?.state, "cancelled");
});

test("advisory attempt is durable before the model call finishes", async t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-route-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const { engine, store } = setup(t, active, path);
  engine.acceptPage("owner", page([message("research a laptop")]));
  let unclaimed: number | undefined;
  await engine.routeTasks({ classify: async () => {
    const reopened = new Store(path);
    try { unclaimed = reopened.unroutedTasks().length; } finally { reopened.close(); }
    throw new Error("Response lost after dispatch");
  } });
  assert.equal(unclaimed, 0);
  assert.equal(store.tasks()[0]?.state, "queued");
  assert.equal(store.unroutedTasks().length, 0);
});

test("the daily routing limit leaves further tasks unrouted until the next local day", async t => {
  const { engine, store, advance } = setup(t, { ...active, jev: { ...jev, dailyLimit: 1 } });
  engine.acceptPage("owner", page([message("research a laptop"), message("research a phone", 2)]));
  const calls: string[] = [];
  const router: IntentRouter = { classify: async text => { calls.push(text); return null; } };
  await engine.routeTasks(router);
  assert.deepEqual(calls, ["research a laptop"]);
  assert.deepEqual(store.unroutedTasks().map(x => x.number), [2]);
  advance(24 * 60 * 60_000); await engine.routeTasks(router);
  assert.deepEqual(calls, ["research a laptop", "research a phone"]);
});

test("each routing call carries only the sender's catalog and the configured timezone", async t => {
  const { engine } = setup(t);
  engine.acceptPage("sam", page([messageFrom(member, "research a phone", 1)]));
  const seen: Array<{ timezone: string; version: string; ids: string[] }> = [];
  await engine.routeTasks({ classify: async (_text, ctx) => {
    seen.push({ timezone: ctx.timezone, version: ctx.catalog.version, ids: ctx.catalog.options.map(o => o.id) }); return null;
  } });
  assert.deepEqual(seen, [{ timezone: config.timezone, version: engine.host.catalog(member).version, ids: ["reminders", "continue", "clarify"] }]);
});

test("plugins written as classes keep their interpret and describe hooks in catalogs", t => {
  class Notes implements ActionPlugin {
    manifest = { id: "notes", version: "1.0.0", stateVersion: 1, capabilities: [], roles: ["owner"], criteria: "Notes.", examples: [] } as const;
    schema = { add: { title: { type: "string", maxLength: 100 } } } as const;
    migrate() {}
    match() { return null; }
    async interpret() { return null; }
    describe() { return { description: "add a note", times: [] }; }
    handle() {}
  }
  const store = new Store(":memory:"); t.after(() => store.close());
  const contact = { ...owner, plugins: ["reminders", "notes"] }; enroll(store, contact);
  const engine = new Engine({ ...config, contacts: [contact] }, store, new FakeTransport(), { plugins: [remindersPlugin, new Notes()] });
  assert.ok(engine.host.catalog(contact).options.some(o => o.id === "notes"));
  assert.ok(engine.host.catalog(contact, { conversational: true }).options.some(o => o.id === "notes"));
});
