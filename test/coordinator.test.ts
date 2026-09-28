import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import { config, epoch, FakeTransport, message, page } from "./helpers.js";
import type { IntentRouter } from "../src/contracts.js";

function setup(t: { after(fn: () => void): void }, path = ":memory:") {
  const store = new Store(path);
  store.enroll("test-db", 0);
  const transport = new FakeTransport();
  let now = epoch;
  const core = new Coordinator(config, store, transport, () => now);
  t.after(() => store.close());
  return { store, transport, core, advance: (ms: number) => { now += ms; } };
}

test("owner capture and its acknowledgement survive duplicate ingestion", async t => {
  const { store, core, transport } = setup(t);
  core.acceptPage(page([message("remind me to stretch in 1 minute")]));
  core.acceptPage(page([message("remind me to stretch in 1 minute")]));
  assert.equal(store.reminders().length, 1);
  assert.equal(store.outbox().length, 1);
  await core.tick();
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]!, /Saved locally/);
  assert.equal(store.cursor(), 1);
});

test("groups, foreign handles, foreign chats and echoes never enter personal state", t => {
  const { store, core } = setup(t);
  const messages = [
    message("secret", 1, { sender: "stranger@example.com" }),
    message("secret", 2, { isGroup: true }),
    message("secret", 3, { isFromMe: true }),
    message("secret", 4, { chatGuid: "iMessage;+;group" }),
    message("secret", 5, { chatId: 99 }),
  ];
  core.acceptPage(page(messages));
  assert.deepEqual(store.counts(), { inbox: 0, reminders: 0, jobs: 0, uncertain: 0 });
  assert.equal(store.cursor(), 5);
});

test("invalid page rolls back message effects and cursor together", t => {
  const { store, core } = setup(t);
  assert.throws(() => core.acceptPage(page([message("note buy milk", 2)], 1)));
  assert.equal(store.reminders().length, 0);
  assert.equal(store.cursor(), 0);
});

test("never implicitly enroll or execute historical messages before the watermark", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const core = new Coordinator(config, store, new FakeTransport(), () => epoch);
  assert.throws(() => core.acceptPage(page([message("note old task")])));
  store.enroll("test-db", 100);
  core.acceptPage(page([message("note old task", 1)], 100));
  assert.equal(store.reminders().length, 0);
  assert.throws(() => store.enroll("replaced-db", 0));
});

test("durable state resumes after the store reopens", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const first = new Store(path); first.enroll("test-db", 0);
  new Coordinator(config, first, new FakeTransport(), () => epoch).acceptPage(page([message("note buy milk")]));
  first.close();
  const second = new Store(path); t.after(() => second.close());
  assert.equal(second.reminders()[0]?.title, "buy milk");
  assert.equal(second.cursor(), 1);
  assert.equal(second.outbox()[0]?.status, "pending");
});

test("one due reminder is sent once, and done prevents later reminders", async t => {
  const { core, store, transport, advance } = setup(t);
  core.acceptPage(page([message("remind me to stretch in 1 minute")]));
  await core.tick(); advance(60_000); await core.tick(); await core.tick();
  assert.equal(transport.sent.length, 2);
  assert.match(transport.sent[1]!, /stretch/);
  core.acceptPage(page([message("done", 2)]));
  await core.tick(); advance(60_000); await core.tick();
  assert.equal(store.reminders()[0]?.status, "completed");
  assert.equal(transport.sent.length, 3);
});

test("completion cancels a pending notification before retry", async t => {
  const { core, store, transport, advance } = setup(t);
  core.acceptPage(page([message("remind me to stretch in 1 minute")]));
  await core.tick();
  transport.outcomes.push({ status: "not_started", reason: "not connected" });
  advance(60_000); await core.tick();
  core.acceptPage(page([message("done #1", 2)]));
  advance(120_000); await core.tick();
  assert.equal(store.outbox().filter(x => x.kind === "reminder")[0]?.status, "cancelled");
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("uncertain sends are retained without automatic retry", async t => {
  const { core, store, transport, advance } = setup(t);
  transport.outcomes.push({ status: "uncertain", reason: "timeout" });
  core.acceptPage(page([message("note buy milk")]));
  await core.tick(); advance(1_000_000); await core.tick();
  assert.equal(transport.sent.length, 1);
  assert.equal(store.outbox()[0]?.status, "uncertain");
});

test("unexpected transport exceptions are uncertain, never safe retries", async t => {
  const { core, store, transport } = setup(t);
  transport.send = async () => { throw new Error("lost response"); };
  core.acceptPage(page([message("note buy milk")]));
  await core.tick();
  assert.equal(store.outbox()[0]?.status, "uncertain");
});

test("process recovery marks an interrupted send uncertain", t => {
  const { core, store } = setup(t);
  core.acceptPage(page([message("note buy milk")]));
  assert.ok(store.claimOutgoing(epoch));
  store.recoverInFlight();
  assert.equal(store.outbox()[0]?.status, "uncertain");
  assert.equal(store.claimOutgoing(epoch), null);
});

test("pause all holds requested reminders; controls still work", async t => {
  const { core, transport, advance } = setup(t);
  core.acceptPage(page([message("remind me to stretch in 1 minute"), message("pause all", 2)]));
  await core.tick(); advance(60_000); await core.tick();
  assert.equal(transport.sent.length, 2);
  core.acceptPage(page([message("resume", 3)])); await core.tick();
  assert.equal(transport.sent.filter(x => x.startsWith("Reminder")).length, 1);
});

test("snooze preserves deadline and invalidates the old notification", async t => {
  const { core, store } = setup(t);
  core.acceptPage(page([message("remind me to stretch in 1 minute"), message("snooze 20m", 2)]));
  const reminder = store.reminders()[0]!;
  assert.equal(reminder.dueAt, epoch + 60_000);
  assert.equal(reminder.nextAt, epoch + 20 * 60_000);
  assert.equal(reminder.revision, 1);
});

test("ambiguous done changes no reminders", t => {
  const { core, store } = setup(t);
  core.acceptPage(page([message("note buy milk"), message("note call dentist", 2), message("done", 3)]));
  assert.equal(store.reminders().filter(x => x.status === "active").length, 2);
  assert.match(store.outbox().at(-1)!.text, /Which/);
});

test("complex work stays queued and can be cancelled without a model", t => {
  const { core, store } = setup(t);
  core.acceptPage(page([message("research a replacement for my laptop")]));
  assert.equal(store.jobs()[0]?.text, "research a replacement for my laptop");
  core.acceptPage(page([message("cancel job #1", 2)]));
  assert.equal(store.jobs()[0]?.status, "cancelled");
});

test("Jev remains advisory and is not called for commands", async t => {
  const { core, store } = setup(t);
  core.acceptPage(page([message("note buy milk"), message("research a laptop", 2)]));
  let calls = 0;
  const router: IntentRouter = { classify: async () => { calls++; return {
    model: "jev-test", version: "nori-route-v1", route: "automation", confidence: 1,
    probabilities: { automation: 1, codex: 0, clarify: 0 },
  }; } };
  await core.routeJobs(router);
  assert.equal(calls, 1);
  assert.equal(store.jobs()[0]?.status, "queued");
  assert.equal(store.jobs()[0]?.route?.route, "automation");
  assert.equal(store.reminders().length, 1);
});

test("router failure cannot lose or fail the queued job", async t => {
  const { core, store } = setup(t);
  core.acceptPage(page([message("research a laptop")]));
  await core.routeJobs({ classify: async () => { throw new Error("offline"); } });
  assert.equal(store.jobs()[0]?.status, "queued");
});
