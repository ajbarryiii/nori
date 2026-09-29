import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, assertIdentity, databaseIdentity } from "../src/runtime.js";
import { catchUp, enroll, runService } from "../src/service.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { config, enroll as enrollAt, epoch, FakeTransport, message, page, reminders } from "./helpers.js";
import type { Runtime, TurnOutcome } from "../src/contracts.js";

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nori-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
test("one process holds a lock; existing locks are never automatically stolen", t => {
  const dir = directory(t); const release = acquireLock(dir);
  assert.ok(readFileSync(join(dir, "service.lock"), "utf8").includes(String(process.pid)));
  assert.throws(() => acquireLock(dir), /lock/i);
  release(); release(); const next = acquireLock(dir); next();
  writeFileSync(join(dir, "service.lock"), "{\"pid\":99999999}");
  assert.throws(() => acquireLock(dir), /lock/i);
});
test("lock refuses symlink data directories", t => {
  const dir = directory(t); const alias = join(dir, "alias"); symlinkSync(dir, alias);
  assert.throws(() => acquireLock(alias), /symlink/i);
});
test("database replacement or a different assistant account invalidates enrollment identity", t => {
  const dir = directory(t); const path = join(dir, "messages.db"); writeFileSync(path, "fixture");
  const identity = databaseIdentity(config.assistantUser, path);
  assert.doesNotThrow(() => assertIdentity(identity, databaseIdentity(config.assistantUser, path)));
  assert.throws(() => assertIdentity(identity, databaseIdentity("other-assistant", path)));
  renameSync(path, path + ".old"); writeFileSync(path, "replacement");
  assert.throws(() => assertIdentity(identity, databaseIdentity(config.assistantUser, path)), /identity/i);
});
test("enrollment follows physical cursors without retaining or executing historical content", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const transport = new FakeTransport(); const cursors: number[] = [];
  transport.readAfter = async (_conversation, cursor) => { cursors.push(cursor); return cursor === 0
    ? { ...page([message("note old command")], 80), hasMore: true } : page([], 100); };
  await enroll(config, store, transport, () => "db", "owner");
  assert.deepEqual(cursors, [0, 80]); assert.equal(store.enrollment("owner")?.cursor, 100);
  assert.equal(store.counts().inbox, 0); assert.equal(reminders(store).length, 0); assert.equal(transport.sent.length, 0);
});
test("enrollment requires owner evidence and a stable identity; failure leaves no watermark", async t => {
  for (const mode of ["foreign", "replacement"]) {
    const store = new Store(":memory:"); t.after(() => store.close());
    const transport = new FakeTransport();
    transport.readAfter = async () => page([message("hello", 1, mode === "foreign" ? { sender: "stranger@example.com" } : {})]);
    let checks = 0;
    await assert.rejects(enroll(config, store, transport, () => mode === "replacement" && checks++ ? "new" : "db", "owner"));
    assert.equal(store.enrollment("owner"), null);
  }
});
test("catch-up processes completion before send and returns false for incomplete backlog", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
  const transport = new FakeTransport(); const core = new Engine(config, store, transport, { clock: () => epoch + 120_000 });
  transport.readAfter = async (_conversation, cursor) => cursor === 0
    ? { ...page([message("remind me to stretch in 1 minute")]), hasMore: true }
    : page([message("done #1", 2)]);
  assert.equal(await catchUp(store, core, transport, () => {}, 1), false);
  assert.equal(transport.sent.length, 0);
  assert.equal(await catchUp(store, core, transport, () => {}, 1), true);
  await core.tick(); assert.equal(reminders(store)[0]?.status, "completed");
  assert.ok(!transport.sent.some(x => x.startsWith("Reminder")));
});
test("database identity change during read cannot commit the returned page", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
  const transport = new FakeTransport(); const core = new Engine(config, store, transport, { clock: () => epoch });
  transport.readAfter = async () => page([message("note new thing")]); let calls = 0;
  await assert.rejects(catchUp(store, core, transport, () => { if (calls++) throw new Error("identity changed"); }, 1));
  assert.equal(store.enrollment("owner")?.cursor, 0); assert.equal(store.counts().inbox, 0);
});

test("service ingests controls while a send is pending and closes cleanly on shutdown", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
  const transport = new FakeTransport(); const controller = new AbortController();
  transport.readAfter = async (_conversation, cursor) => cursor === 0 ? page([message("note capture")]) : page([message("pause all", 2)]);
  let finish: ((value: { status: "uncertain"; reason: string }) => void) | undefined;
  transport.send = async () => new Promise(resolve => { finish = resolve; });
  let closed = false;
  transport.close = () => { closed = true; finish?.({ status: "uncertain", reason: "shutdown" }); };
  let polls = 0;
  await runService({ config, store, transport, checkIdentity: () => {}, signal: controller.signal,
    wait: async () => { if (++polls === 2) controller.abort(); } });
  assert.equal(store.enrollment("owner")?.cursor, 2); assert.equal(store.setting("pause:owner"), "all"); assert.ok(closed);
  assert.equal(store.outbox()[0]?.status, "uncertain");
});

test("service closes and sends nothing if database identity no longer matches", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
  const transport = new FakeTransport(); let closed = false; transport.close = () => { closed = true; };
  await assert.rejects(runService({ config, store, transport, checkIdentity: () => { throw new Error("identity changed"); },
    signal: new AbortController().signal, wait: async () => {} }), /identity/);
  assert.ok(closed); assert.equal(transport.sent.length, 0);
});

for (const transient of [false, true]) {
  test(`pre-dispatch identity failure preserves pending messages and halts the batch (transient=${transient})`, async t => {
    const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
    const transport = new FakeTransport();
    new Engine(config, store, transport, { clock: () => epoch }).acceptPage("owner", page([
      message("note first"), message("note second", 2), message("note third", 3),
    ]));
    let checks = 0;
    const checkIdentity = () => {
      checks++;
      if (checks === 3 || (!transient && checks > 3)) throw new Error("identity changed");
    };
    await assert.rejects(runService({ config, store, transport, checkIdentity,
      signal: new AbortController().signal,
      wait: async () => { await new Promise<void>(resolve => setImmediate(resolve)); } }), /identity/);
    assert.deepEqual(transport.sent, []);
    assert.deepEqual(store.outbox().map(item => item.status), ["pending", "pending", "pending"]);
  });
}

test("shutdown during advisory routing leaves later jobs unattempted", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
  const transport = new FakeTransport(); const controller = new AbortController();
  new Engine(config, store, transport, { clock: () => epoch }).acceptPage("owner", page([
    message("research a laptop"), message("research a phone", 2),
  ]));
  const calls: string[] = [];
  await runService({ config, store, transport, checkIdentity: () => {}, signal: controller.signal,
    router: { classify: async text => { calls.push(text); controller.abort(); return null; } },
    wait: async () => {} });
  assert.deepEqual(calls, ["research a laptop"]);
  assert.deepEqual(store.unroutedTasks().map(task => task.number), [2]);
});

for (const throws of [false, true]) {
  test(`service halts after an uncertain send without draining the pending batch (throws=${throws})`, async t => {
    const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
    const transport = new FakeTransport(); const controller = new AbortController();
    new Engine(config, store, transport, { clock: () => epoch }).acceptPage("owner", page([
      message("note first"), message("note second", 2), message("note third", 3),
    ]));
    transport.send = async (_target, text) => {
      transport.sent.push(text);
      if (throws) throw new Error("Connection lost");
      return { status: "uncertain", reason: "Delivery unknown" };
    };
    let polls = 0;
    await assert.rejects(runService({ config, store, transport, checkIdentity: () => {}, signal: controller.signal,
      wait: async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (++polls === 2) controller.abort();
      } }), /send|transport/i);
    assert.equal(transport.sent.length, 1);
    assert.deepEqual(store.outbox().map(item => item.status), ["uncertain", "pending", "pending"]);
  });
}

test("with a runtime, the service recovers interrupted turns, runs routed jobs, and waits for the runtime to close on shutdown", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enrollAt(store, undefined, 0, "db");
  const cfg = { ...config, runtime: { codexPath: "/usr/local/bin/codex", model: null, workspaceDir: "/tmp/nori-work",
    budget: { minutes: 30, turns: 8, toolCalls: 40, tokens: 1_000_000 }, daily: { tasks: 5, tokens: 5_000_000 }, approvalMinutes: 60 } };
  const transport = new FakeTransport(); const controller = new AbortController();
  new Engine(cfg, store, transport, { clock: () => epoch }).acceptPage("owner", page([message("check the weather"), message("research a laptop", 2)]));
  store.updateTask(store.tasks()[0]!.id, { state: "running", threadId: "thread-old" });
  const started: string[] = []; let closed = 0;
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  const runtime: Runtime = {
    manifest: { id: "codex", computerUse: "unverified", ownerOnly: true },
    start: async task => { started.push(task.text); controller.abort(); return { status: "completed", message: "Found it.", evidence: ["Checked"] } as TurnOutcome; },
    resume: async () => ({ status: "interrupted" }), cancel: async () => {}, close: () => { closed++; return released; },
  };
  let finished = false;
  const service = runService({ config: cfg, store, transport, checkIdentity: () => {}, signal: controller.signal, runtime,
    wait: async () => { await new Promise<void>(resolve => setImmediate(resolve)); } }).then(() => { finished = true; });
  for (let n = 0; n < 10; n++) await new Promise<void>(resolve => setImmediate(resolve));
  // The service lock is released after this returns, so it must outlast the runtime's processes.
  assert.deepEqual([closed >= 1, finished], [true, false]);
  release(); await service;
  assert.deepEqual(started, ["research a laptop"]);
  assert.deepEqual(store.tasks().map(x => [x.state, x.waitingFor]), [["waiting_contact", { kind: "interrupted" }], ["completed", null]]);
  assert.ok(closed >= 1);
});
