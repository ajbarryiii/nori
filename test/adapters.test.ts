import assert from "node:assert/strict";
import { test } from "node:test";
import { ImessageTransport, decodeMessage } from "../src/imsg.js";
import { JevRouter } from "../src/jev.js";
import { CodexProbe } from "../src/codex.js";
import { RpcError } from "../src/rpc.js";
import { config, epoch } from "./helpers.js";
import type { RpcPort } from "../src/contracts.js";

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
const raw = { id: 3, guid: "in-guid", chat_id: 42, chat_guid: config.owner.chatGuid,
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
  const adapter = new ImessageTransport(rpc, config.owner);
  assert.deepEqual(await adapter.readAfter(50), { messages: [], nextCursor: 80, hasMore: true });
  assert.equal(rpc.calls[0]?.params.chat_id, 42);
  assert.equal(rpc.calls[0]?.params.since_rowid, 50);
  rpc.result = { messages: [], next_rowid: 40, has_more: false };
  await assert.rejects(adapter.readAfter(50));
});

test("readiness requires the documented messages.history method and live database access", async () => {
  const rpc = new RpcFake(); const adapter = new ImessageTransport(rpc, config.owner);
  rpc.result = { database: { ready: true }, methods: ["messages.after", "messages.history", "send"] };
  assert.equal((await adapter.readiness()).ready, true);
  rpc.result = { database: { ready: false }, methods: ["send"] };
  assert.equal((await adapter.readiness()).ready, false);
});

test("imsg sends only to the enrolled direct chat using AppleScript", async () => {
  const rpc = new RpcFake(); rpc.result = { ok: true, guid: "out-guid", id: 9 };
  const adapter = new ImessageTransport(rpc, config.owner);
  assert.deepEqual(await adapter.send("hello"), { status: "sent", messageGuid: "out-guid" });
  assert.equal(rpc.calls[0]?.params.chat_guid, config.owner.chatGuid);
  assert.equal(rpc.calls[0]?.params.transport, "applescript");
  assert.equal(rpc.calls[0]?.params.allow_sms_fallback, false);
});

test("imsg success without evidence and unknown errors are uncertain", async () => {
  const rpc = new RpcFake(); const adapter = new ImessageTransport(rpc, config.owner);
  rpc.result = { ok: true };
  assert.equal((await adapter.send("hello")).status, "uncertain");
  rpc.failure = new Error("timeout");
  assert.equal((await adapter.send("hello")).status, "uncertain");
  rpc.failure = new RpcError(-32000, "not dispatched", { disposition: "not_started" });
  assert.equal((await adapter.send("hello")).status, "not_started");
  rpc.failure = new RpcError(-32000, "still sending", { disposition: "still_in_flight" });
  assert.equal((await adapter.send("hello")).status, "uncertain");
});

test("Jev Choice results retain confidence; invalid responses abstain", async () => {
  let response: unknown = { model: "jev-test", answers: { handler: { type: "choice", choice: "codex", confidence: 0.8,
    probabilities: { automation: 0.1, codex: 0.8, clarify: 0.1 } } } };
  let body: Record<string, unknown> = {};
  const router = new JevRouter({ key: "test-only", model: "jev-test", timeoutMs: 100,
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json(response); } });
  const decision = await router.classify("research a laptop", config.timezone);
  assert.equal(decision?.route, "codex"); assert.equal(decision?.confidence, 0.8);
  assert.equal(body.model, "jev-test"); assert.ok(body.questions);
  response = { model: "jev-test", answers: { handler: { type: "choice", choice: "shell", confidence: 1 } } };
  assert.equal(await router.classify("do things", config.timezone), null);
});

test("Jev HTTP failures and bad distributions do not produce a route", async () => {
  for (const response of [new Response("offline", { status: 503 }), Response.json({ answers: { handler: {
    type: "choice", choice: "codex", confidence: 9, probabilities: { automation: 0, codex: 1, clarify: 0 },
  } } })]) {
    const router = new JevRouter({ key: "test", model: "jev-test", timeoutMs: 50, fetch: async () => response });
    assert.equal(await router.classify("request", config.timezone), null);
  }
});

test("Codex probe performs only a handshake, never starts a task or claims GUI support", async () => {
  const rpc = new RpcFake(); rpc.result = { userAgent: "codex-test" };
  const result = await new CodexProbe(rpc).inspect();
  assert.equal(result.connected, true);
  assert.equal(result.computerUse, "unverified");
  assert.deepEqual(rpc.calls.map(x => x.method), ["initialize", "initialized"]);
});
