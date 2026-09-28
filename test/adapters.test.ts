import assert from "node:assert/strict";
import { test } from "node:test";
import { ImessageTransport, decodeMessage } from "../src/imsg.js";
import { JevRouter } from "../src/jev.js";
import { CodexProbe } from "../src/codex.js";
import { RpcError } from "../src/rpc.js";
import { config, epoch, member, owner } from "./helpers.js";
import type { RouteCatalog, RpcPort } from "../src/contracts.js";

class RpcFake implements RpcPort {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  result: unknown = {};
  failure: Error | null = null;
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params }); if (this.failure) throw this.failure; return this.result;
  }
  notify(method: string, params: Record<string, unknown>) { this.calls.push({ method, params }); }
  close() {}
}
const raw = { id: 3, guid: "in-guid", chat_id: 42, chat_guid: owner.conversation.chatGuid,
  sender: "owner@example.com", is_from_me: false, is_group: false, text: "hi", created_at: new Date(epoch).toISOString() };

test("imsg metadata is mandatory; missing group state never means direct chat", () => {
  assert.equal(decodeMessage(raw)?.rowId, 3);
  assert.equal(decodeMessage({ ...raw, is_group: undefined }), null);
  assert.equal(decodeMessage({ ...raw, created_at: "invalid" }), null);
  assert.equal(decodeMessage({ ...raw, is_reaction: true }), null);
});

test("provider timestamps cannot depend on the host timezone or normalize an impossible date", () => {
  assert.equal(decodeMessage({ ...raw, created_at: "2026-09-28T10:00:00" }), null);
  assert.equal(decodeMessage({ ...raw, created_at: "2026-02-30T10:00:00Z" }), null);
});

test("imsg catch-up uses the authoritative scan cursor including empty pages", async () => {
  const rpc = new RpcFake(); rpc.result = { messages: [], next_rowid: 80, has_more: true };
  const adapter = new ImessageTransport(rpc, [owner.conversation, member.conversation]);
  assert.deepEqual(await adapter.readAfter(member.conversation, 50), { messages: [], nextCursor: 80, hasMore: true });
  assert.equal(rpc.calls[0]?.params.chat_id, 43);
  assert.equal(rpc.calls[0]?.params.since_rowid, 50);
  rpc.result = { messages: [], next_rowid: 40, has_more: false };
  await assert.rejects(adapter.readAfter(owner.conversation, 50));
  await assert.rejects(adapter.readAfter({ chatId: 99, chatGuid: "iMessage;-;other@example.com" }, 0), /configured/);
  assert.equal(rpc.calls.length, 2);
});

test("readiness requires the documented messages.history method and live database access", async () => {
  const rpc = new RpcFake(); const adapter = new ImessageTransport(rpc, [owner.conversation]);
  rpc.result = { database: { ready: true }, methods: ["messages.after", "messages.history", "send"] };
  assert.equal((await adapter.readiness()).ready, true);
  rpc.result = { database: { ready: false }, methods: ["send"] };
  assert.equal((await adapter.readiness()).ready, false);
});

test("imsg sends only to a configured direct chat using AppleScript", async () => {
  const rpc = new RpcFake(); rpc.result = { ok: true, guid: "out-guid", id: 9 };
  const adapter = new ImessageTransport(rpc, [owner.conversation, member.conversation]);
  assert.deepEqual(await adapter.send(member.conversation, "hello"), { status: "sent", messageGuid: "out-guid" });
  assert.equal(rpc.calls[0]?.params.chat_guid, member.conversation.chatGuid);
  assert.equal(rpc.calls[0]?.params.transport, "applescript");
  assert.equal(rpc.calls[0]?.params.allow_sms_fallback, false);
  for (const target of [{ chatId: 99, chatGuid: "iMessage;-;other@example.com" }, { chatId: 42, chatGuid: member.conversation.chatGuid }])
    assert.equal((await adapter.send(target, "hello")).status, "not_started");
  assert.equal(rpc.calls.length, 1);
});

test("imsg success without evidence and unknown errors are uncertain", async () => {
  const rpc = new RpcFake(); const adapter = new ImessageTransport(rpc, [owner.conversation]);
  const send = () => adapter.send(owner.conversation, "hello");
  rpc.result = { ok: true };
  assert.equal((await send()).status, "uncertain");
  rpc.failure = new Error("timeout");
  assert.equal((await send()).status, "uncertain");
  rpc.failure = new RpcError(-32000, "not dispatched", { disposition: "not_started" });
  assert.equal((await send()).status, "not_started");
  rpc.failure = new RpcError(-32000, "still sending", { disposition: "still_in_flight" });
  assert.equal((await send()).status, "uncertain");
});

const catalog: RouteCatalog = { version: "catalog-test", options: [
  { id: "reminders", criteria: "Reminder requests.", route: { kind: "action", pluginId: "reminders" } },
  { id: "runtime", criteria: "Multi-step work.", route: { kind: "runtime" } },
  { id: "clarify", criteria: "Unclear requests.", route: { kind: "clarify" } },
] };
const answers = (choice: string, noul: unknown = 0.2, probabilities: Record<string, number> = { reminders: 0.1, runtime: 0.8, clarify: 0.1 }) => ({
  model: "jev-test", answers: { route: { type: "choice", choice, confidence: 0.8, probabilities }, multiple: { type: "noul", noul } } });

test("Jev asks the catalog Choice and a multiple-action Noul in one call; answers retain confidence", async () => {
  let response: unknown = answers("runtime", 0.7);
  let body: Record<string, any> = {}; let calls = 0;
  const router = new JevRouter({ key: "test-only", model: "jev-test", timeoutMs: 100,
    fetch: async (_url, init) => { calls++; body = JSON.parse(String(init?.body)); return Response.json(response); } });
  const decision = await router.classify("research a laptop", { timezone: config.timezone, catalog });
  assert.deepEqual(decision, { model: "jev-test", catalogVersion: "catalog-test", route: { kind: "runtime" }, confidence: 0.8,
    probabilities: { reminders: 0.1, runtime: 0.8, clarify: 0.1 }, multiAction: true });
  assert.equal(calls, 1);
  assert.equal(body.model, "jev-test");
  assert.deepEqual(body.state, { request: "research a laptop", timezone: config.timezone });
  assert.deepEqual(Object.keys(body.questions.route.criteria), ["reminders", "runtime", "clarify"]);
  assert.equal(body.questions.route.type, "choice");
  assert.equal(body.questions.multiple.type, "noul");
  response = answers("reminders", 0.1, { reminders: 0.9, runtime: 0.05, clarify: 0.05 });
  const single = await router.classify("remind me later", { timezone: config.timezone, catalog });
  assert.deepEqual([single?.route, single?.multiAction], [{ kind: "action", pluginId: "reminders" }, false]);
});

test("Jev answers outside the catalog, invalid distributions, and HTTP failures abstain", async () => {
  const bad = [answers("shell"), answers("runtime", 2), answers("runtime", null),
    answers("runtime", 0.2, { reminders: 0.1, runtime: 0.8 }), answers("runtime", 0.2, { reminders: 0.5, runtime: 0.8, clarify: 0.1 }),
    { ...answers("runtime"), model: "jev-other" }];
  for (const response of [...bad.map(x => Response.json(x)), new Response("offline", { status: 503 })]) {
    const router = new JevRouter({ key: "test", model: "jev-test", timeoutMs: 50, fetch: async () => response });
    assert.equal(await router.classify("request", { timezone: config.timezone, catalog }), null);
  }
});

test("Codex probe performs only a handshake, never starts a task or claims GUI support", async () => {
  const rpc = new RpcFake(); rpc.result = { userAgent: "codex-test" };
  const result = await new CodexProbe(rpc).inspect();
  assert.equal(result.connected, true);
  assert.equal(result.computerUse, "unverified");
  assert.deepEqual(rpc.calls.map(x => x.method), ["initialize", "initialized"]);
});
