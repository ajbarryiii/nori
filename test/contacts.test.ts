import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { catchUp, enroll as enrollContact, runService } from "../src/service.js";
import { Store } from "../src/store.js";
import type { Conversation } from "../src/contracts.js";
import { config, enroll, epoch, FakeTransport, member, message, messageFrom, owner, page, reminders } from "./helpers.js";

const both = { ...config, contacts: [owner, member] };
function setup(t: { after(fn: () => void): void }) {
  const store = new Store(":memory:"); t.after(() => store.close());
  enroll(store, owner); enroll(store, member);
  const transport = new FakeTransport(); let now = epoch;
  const engine = new Engine(both, store, transport, { clock: () => now });
  return { store, transport, engine, advance: (ms: number) => { now += ms; } };
}

test("two contacts keep isolated reminders, numbering, and reply targets", async t => {
  const { store, engine, transport } = setup(t);
  engine.acceptPage("owner", page([message("note buy milk", 1)]));
  engine.acceptPage("sam", page([messageFrom(member, "note call mom", 2), messageFrom(member, "note water plants", 3),
    messageFrom(member, "done #1", 4)]));
  engine.acceptPage("owner", page([message("list", 5)]));
  assert.deepEqual(reminders(store, owner).map(x => [x.id, x.title, x.status]), [[1, "buy milk", "active"]]);
  assert.deepEqual(reminders(store, member).map(x => [x.id, x.title, x.status]),
    [[1, "call mom", "completed"], [2, "water plants", "active"]]);
  const list = store.outbox("owner").at(-1)!.text;
  assert.match(list, /buy milk/); assert.doesNotMatch(list, /water plants|call mom/);
  await engine.tick();
  const expected = new Map<string, Conversation>(store.outbox().map(x => [x.text, x.contactId === "owner" ? owner.conversation : member.conversation]));
  assert.equal(transport.sent.length, 5);
  transport.sent.forEach((text, i) => assert.deepEqual(transport.targets[i], expected.get(text), text));
});

test("an approved handle cannot act in another contact's conversation", t => {
  const { store, engine } = setup(t);
  engine.acceptPage("owner", page([messageFrom(member, "note from sam", 1, { chatId: owner.conversation.chatId, chatGuid: owner.conversation.chatGuid })]));
  engine.acceptPage("sam", page([message("note from owner", 2)]));
  assert.deepEqual(store.counts(), { inbox: 0, tasks: 0, state: 0, timers: 0, uncertain: 0 });
});

test("pause, cancel, and status are scoped to the sending contact", async t => {
  const { store, engine, transport, advance } = setup(t);
  engine.acceptPage("owner", page([message("research laptops", 1), message("remind me to stretch in 1 minute", 2)]));
  engine.acceptPage("sam", page([messageFrom(member, "research phones", 3), messageFrom(member, "cancel #1", 4),
    messageFrom(member, "remind me to drink water in 1 minute", 5), messageFrom(member, "pause all", 6)]));
  assert.deepEqual(store.tasks().map(x => [x.contactId, x.number, x.state]), [["owner", 1, "queued"], ["sam", 1, "cancelled"]]);
  advance(60_000); await engine.tick();
  const reminderTargets = transport.sent.flatMap((text, i) => text.startsWith("Reminder") ? [transport.targets[i]] : []);
  assert.deepEqual(reminderTargets, [owner.conversation]);
  engine.acceptPage("owner", page([message("status", 7)]));
  const status = store.outbox("owner").at(-1)!.text;
  assert.match(status, /1 active task/); assert.match(status, /Queued jobs: #1/);
  assert.doesNotMatch(status, /paused|water/);
});

test("configured but unenrolled contacts are inactive and their conversations are never read", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store, owner);
  const transport = new FakeTransport(); const reads: number[] = [];
  transport.readAfter = async (conversation, cursor) => { reads.push(conversation.chatId); return page([], cursor); };
  const engine = new Engine(both, store, transport, { clock: () => epoch });
  assert.deepEqual(engine.activeContacts().map(x => x.id), ["owner"]);
  assert.equal(await catchUp(store, engine, transport, () => {}), true);
  assert.deepEqual(reads, [owner.conversation.chatId]);
  assert.throws(() => engine.acceptPage("sam", page([messageFrom(member, "note hi")])), /enroll/i);
});

test("messages for a contact removed from configuration are held, not sent", async t => {
  const { store, engine, transport } = setup(t);
  engine.acceptPage("sam", page([messageFrom(member, "note call mom", 1)]));
  const ownerOnly = new Engine(config, store, transport, { clock: () => epoch });
  await ownerOnly.tick();
  assert.deepEqual(transport.sent, []);
  assert.equal(store.outbox("sam")[0]?.status, "pending");
  await engine.tick();
  assert.deepEqual(transport.targets, [member.conversation]);
});

test("a changed conversation halts processing until an operator reviews it", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store, owner);
  const moved = { ...config, contacts: [{ ...owner, conversation: { chatId: 77, chatGuid: owner.conversation.chatGuid } }] };
  const transport = new FakeTransport();
  const engine = new Engine(moved, store, transport, { clock: () => epoch });
  assert.throws(() => engine.activeContacts(), /enrollment/);
  await assert.rejects(runService({ config: moved, store, transport, checkIdentity: () => {},
    signal: new AbortController().signal, wait: async () => {} }), /enrollment/);
  assert.deepEqual(transport.sent, []);
});

test("each conversation enrolls separately without executing its history", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const transport = new FakeTransport(); const reads: Array<[number, number]> = [];
  transport.readAfter = async (conversation, cursor) => {
    reads.push([conversation.chatId, cursor]);
    const from = conversation.chatId === owner.conversation.chatId ? owner : member;
    return cursor === 0 ? { ...page([messageFrom(from, "note old command", 10)], 80), hasMore: true } : page([], 100);
  };
  await enrollContact(both, store, transport, () => "db", "owner");
  await enrollContact(both, store, transport, () => "db", "sam");
  assert.deepEqual(reads, [[42, 0], [42, 80], [43, 0], [43, 80]]);
  assert.deepEqual(store.enrollments().map(x => [x.contactId, x.cursor, x.watermark]), [["owner", 100, 100], ["sam", 100, 100]]);
  assert.equal(store.counts().inbox, 0); assert.equal(reminders(store).length, 0); assert.equal(transport.sent.length, 0);
  await assert.rejects(enrollContact(both, store, transport, () => "db", "sam"), /already enrolled/i);
  await assert.rejects(enrollContact(both, store, transport, () => "db", "nobody"), /unknown contact/i);
});

test("enrollment needs that contact's own message and the same database identity", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); enroll(store, owner, 0, "db");
  const transport = new FakeTransport();
  transport.readAfter = async () => page([message("hello from the owner", 1, { chatId: member.conversation.chatId, chatGuid: member.conversation.chatGuid })]);
  await assert.rejects(enrollContact(both, store, transport, () => "db", "sam"), /inbound message/);
  transport.readAfter = async () => page([messageFrom(member, "hello", 1)]);
  await assert.rejects(enrollContact(both, store, transport, () => "other-db", "sam"), /identity/);
  assert.equal(store.enrollment("sam"), null);
});
