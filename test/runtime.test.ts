import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, assertIdentity, databaseIdentity } from "../src/runtime.js";
import { catchUp, enroll, runService } from "../src/service.js";
import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import { config, epoch, FakeTransport, message, page } from "./helpers.js";

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
test("database replacement or owner changes invalidate enrollment identity", t => {
  const dir = directory(t); const path = join(dir, "messages.db"); writeFileSync(path, "fixture");
  const identity = databaseIdentity(config, path);
  assert.doesNotThrow(() => assertIdentity(identity, databaseIdentity(config, path)));
  assert.throws(() => assertIdentity(identity, databaseIdentity({ ...config, owner: { ...config.owner, chatId: 10 } }, path)));
  renameSync(path, path + ".old"); writeFileSync(path, "replacement");
  assert.throws(() => assertIdentity(identity, databaseIdentity(config, path)), /identity/i);
});
test("enrollment follows physical cursors without retaining or executing historical content", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const transport = new FakeTransport(); const cursors: number[] = [];
  transport.readAfter = async cursor => { cursors.push(cursor); return cursor === 0
    ? { ...page([message("note old command")], 80), hasMore: true } : page([], 100); };
  await enroll(config, store, transport, () => "db");
  assert.deepEqual(cursors, [0, 80]); assert.equal(store.cursor(), 100);
  assert.equal(store.counts().inbox, 0); assert.equal(store.reminders().length, 0); assert.equal(transport.sent.length, 0);
});
test("enrollment requires owner evidence and a stable identity; failure leaves no watermark", async t => {
  for (const mode of ["foreign", "replacement"]) {
    const store = new Store(":memory:"); t.after(() => store.close());
    const transport = new FakeTransport();
    transport.readAfter = async () => page([message("hello", 1, mode === "foreign" ? { sender: "stranger@example.com" } : {})]);
    let checks = 0;
    await assert.rejects(enroll(config, store, transport, () => mode === "replacement" && checks++ ? "new" : "db"));
    assert.equal(store.cursor(), null);
  }
});
test("catch-up processes completion before send and returns false for incomplete backlog", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); store.enroll("db", 0);
  const transport = new FakeTransport(); const core = new Coordinator(config, store, transport, () => epoch + 120_000);
  transport.readAfter = async cursor => cursor === 0
    ? { ...page([message("remind me to stretch in 1 minute")]), hasMore: true }
    : page([message("done #1", 2)]);
  assert.equal(await catchUp(store, core, transport, () => {}, 1), false);
  assert.equal(transport.sent.length, 0);
  assert.equal(await catchUp(store, core, transport, () => {}, 1), true);
  await core.tick(); assert.equal(store.reminders()[0]?.status, "completed");
  assert.ok(!transport.sent.some(x => x.startsWith("Reminder")));
});
test("database identity change during read cannot commit the returned page", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); store.enroll("db", 0);
  const transport = new FakeTransport(); const core = new Coordinator(config, store, transport, () => epoch);
  transport.readAfter = async () => page([message("note new thing")]); let calls = 0;
  await assert.rejects(catchUp(store, core, transport, () => { if (calls++) throw new Error("identity changed"); }, 1));
  assert.equal(store.cursor(), 0); assert.equal(store.counts().inbox, 0);
});

test("service ingests controls while a send is pending and closes cleanly on shutdown", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); store.enroll("db", 0);
  const transport = new FakeTransport(); const controller = new AbortController();
  transport.readAfter = async cursor => cursor === 0 ? page([message("note capture")]) : page([message("pause all", 2)]);
  let finish: ((value: { status: "uncertain"; reason: string }) => void) | undefined;
  transport.send = async () => new Promise(resolve => { finish = resolve; });
  let closed = false;
  transport.close = () => { closed = true; finish?.({ status: "uncertain", reason: "shutdown" }); };
  let polls = 0;
  await runService({ config, store, transport, checkIdentity: () => {}, signal: controller.signal,
    wait: async () => { if (++polls === 2) controller.abort(); } });
  assert.equal(store.cursor(), 2); assert.equal(store.setting("pause"), "all"); assert.ok(closed);
  assert.equal(store.outbox()[0]?.status, "uncertain");
});

test("service closes and sends nothing if database identity no longer matches", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); store.enroll("db", 0);
  const transport = new FakeTransport(); let closed = false; transport.close = () => { closed = true; };
  await assert.rejects(runService({ config, store, transport, checkIdentity: () => { throw new Error("identity changed"); },
    signal: new AbortController().signal, wait: async () => {} }), /identity/);
  assert.ok(closed); assert.equal(transport.sent.length, 0);
});
