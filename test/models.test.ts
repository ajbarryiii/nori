import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexModel, codexAppServerArgs } from "../src/codex.js";
import { REPLY_SCHEMA } from "../src/conversation.js";
import { JevJudge, JevUnderstander } from "../src/jev.js";
import { OpenRouterModel } from "../src/openrouter.js";
import { readSecret } from "../src/secrets.js";
import { Store } from "../src/store.js";
import { StoreMeter } from "../src/usage.js";
import { localDay } from "../src/parser.js";
import type { ModelRequest, Provider, RouteCatalog, RpcHandlers, RpcPort, TokenUsage, TurnContext, UsageMeter } from "../src/contracts.js";
import { config, epoch, owner } from "./helpers.js";

const signal = new AbortController().signal;
const request: ModelRequest = { purpose: "reply", system: "You are Nori.", prompt: "Say hi.", schema: REPLY_SCHEMA, maxOutputTokens: 200 };
const catalog: RouteCatalog = { version: "catalog-test", options: [
  { id: "reminders", criteria: "Reminders.", route: { kind: "action", pluginId: "reminders" } },
  { id: "chat", criteria: "Small talk.", route: { kind: "chat" } },
  { id: "clarify", criteria: "Unclear.", route: { kind: "clarify" } },
] };
const context: TurnContext = { contact: owner, text: "remind me to call mom at 5", sentAt: epoch, now: epoch, timezone: "America/Los_Angeles", catalog,
  summary: ["1 active tasks.", "#2: stretch"], jobs: [{ number: 3, text: "research laptops", state: "routed" }],
  turns: [{ from: "nori", text: "Anything else?", at: epoch - 1000 }], paused: "none" };

class Meter implements UsageMeter {
  records: Array<{ provider: Provider; ok: boolean; usage: TokenUsage | null }> = [];
  constructor(public allow = true) {}
  reserve() { return this.allow; }
  record(provider: Provider, result: { ok: boolean; usage: TokenUsage | null }) { this.records.push({ provider, ...result }); }
}
function capture(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) }); return response();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const completion = (content: unknown, extra: Record<string, unknown> = {}) => Response.json({ model: "xiaomi/mimo-v2.6-flash",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content }, ...extra }], usage: { prompt_tokens: 120, completion_tokens: 12 } });

test("OpenRouter requests strict JSON from non-collecting providers and meters every attempt", async () => {
  const meter = new Meter(); const { calls, fetch } = capture(() => completion('{"reply":"hi"}'));
  const model = new OpenRouterModel({ key: "test-key", model: "xiaomi/mimo-v2.6-flash", timeoutMs: 500, fetch, meter });
  assert.deepEqual(await model.generate(request, signal), { model: "xiaomi/mimo-v2.6-flash", json: { reply: "hi" }, usage: { input: 120, output: 12 } });
  const call = calls[0]!;
  assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.deepEqual(call.body.messages, [{ role: "system", content: "You are Nori." }, { role: "user", content: "Say hi." }]);
  assert.deepEqual(call.body.response_format, { type: "json_schema", json_schema: { name: "nori_reply", strict: true, schema: REPLY_SCHEMA } });
  assert.deepEqual(call.body.provider, { data_collection: "deny", require_parameters: true });
  assert.deepEqual(call.body.reasoning, { enabled: false });
  assert.equal(call.body.max_tokens, 200);
  assert.deepEqual(meter.records, [{ provider: "openrouter", ok: true, usage: { input: 120, output: 12 } }]);
});

test("OpenRouter failures, truncation, and invalid JSON return null; budget stops skip the request", async () => {
  const fenced = new OpenRouterModel({ key: "k", model: "m/x", timeoutMs: 500, fetch: capture(() => completion('```json\n{"reply":"ok"}\n```')).fetch });
  assert.deepEqual((await fenced.generate(request, signal))?.json, { reply: "ok" });
  for (const response of [() => new Response("no", { status: 429 }), () => completion("{\"reply\":", { finish_reason: "length" }),
    () => completion("not json"), () => completion(null), () => completion("{}", { error: { code: 502, message: "upstream" } })]) {
    const meter = new Meter();
    const model = new OpenRouterModel({ key: "k", model: "m/x", timeoutMs: 500, fetch: capture(response).fetch, meter });
    assert.equal(await model.generate(request, signal), null);
    assert.equal(meter.records[0]?.ok, false);
  }
  const blocked = capture(() => completion('{"reply":"hi"}'));
  const stopped = new OpenRouterModel({ key: "k", model: "m/x", timeoutMs: 500, fetch: blocked.fetch, meter: new Meter(false) });
  assert.equal(await stopped.generate(request, signal), null); assert.equal(blocked.calls.length, 0);
  const aborted = new AbortController(); aborted.abort();
  const slow = new OpenRouterModel({ key: "k", model: "m/x", timeoutMs: 500, fetch: (async (_u: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted(); return completion('{"reply":"late"}'); }) as typeof fetch });
  assert.equal(await slow.generate(request, aborted.signal), null);
});

const jevAnswer = (answers: Record<string, unknown>) => () => Response.json({ model: "jev-test", answers, usage: { input_tokens: 400, output_tokens: 30 } });
const probabilities = { reminders: 0.9, chat: 0.05, clarify: 0.05 };

test("Jev understanding asks the catalog Choice and two Nouls with conversation context in one metered call", async () => {
  const meter = new Meter();
  const { calls, fetch } = capture(jevAnswer({ route: { type: "choice", choice: "reminders", confidence: 0.88, probabilities },
    multiple: { type: "noul", noul: 0.04 }, outbound: { type: "noul", noul: 0.1 } }));
  const understander = new JevUnderstander({ key: "k", model: "jev-test", timeoutMs: 500, fetch, meter });
  assert.deepEqual(await understander.understand(context, signal), { model: "jev-test", catalogVersion: "catalog-test",
    route: { kind: "action", pluginId: "reminders" }, confidence: 0.88, probabilities, multiAction: false, outbound: 0.1 });
  const body = calls[0]!.body; const state = body.state as Record<string, unknown>;
  const questions = body.questions as Record<string, Record<string, unknown>>;
  assert.equal(body.model, "jev-test"); assert.equal(state.request, context.text);
  assert.match(String(state.local_time), /Monday, September 28, 2026/);
  assert.deepEqual(state.tracking, ["1 active tasks.", "#2: stretch"]);
  assert.deepEqual(state.open_jobs, [{ number: "#3", request: "research laptops", state: "routed" }]);
  assert.deepEqual(state.recent_conversation, [{ from: "nori", sent: "Mon, Sep 28, 8:59 AM", text: "Anything else?" }]);
  assert.deepEqual(questions.route!.criteria, { reminders: "Reminders.", chat: "Small talk.", clarify: "Unclear." });
  assert.equal(questions.multiple?.type, "noul"); assert.equal(questions.outbound?.type, "noul");
  assert.deepEqual(meter.records, [{ provider: "jev", ok: true, usage: { input: 400, output: 30 } }]);
  for (const answers of [{ route: { type: "choice", choice: "launch", confidence: 0.9, probabilities } },
    { route: { type: "choice", choice: "reminders", confidence: 0.9, probabilities: { reminders: 0.2 } }, multiple: { type: "noul", noul: 0 }, outbound: { type: "noul", noul: 0 } },
    { route: { type: "choice", choice: "reminders", confidence: 0.9, probabilities }, multiple: { type: "noul", noul: 3 }, outbound: { type: "noul", noul: 0 } }]) {
    const bad = new JevUnderstander({ key: "k", model: "jev-test", timeoutMs: 500, fetch: capture(jevAnswer(answers)).fetch });
    assert.equal(await bad.understand(context, signal), null);
  }
  const blocked = capture(jevAnswer({}));
  assert.equal(await new JevUnderstander({ key: "k", model: "jev-test", timeoutMs: 500, fetch: blocked.fetch, meter: new Meter(false) })
    .understand(context, signal), null);
  assert.equal(blocked.calls.length, 0);
});

test("Jev checks return a probability or abstain", async () => {
  const { calls, fetch } = capture(jevAnswer({ faithful: { type: "noul", noul: 0.83 } }));
  assert.equal(await new JevJudge({ key: "k", model: "jev-test", timeoutMs: 500, fetch }).faithful(context, "remind you about “call mom” today at 5:00 PM", signal), 0.83);
  assert.equal((calls[0]!.body.state as Record<string, unknown>).proposed, "remind you about “call mom” today at 5:00 PM");
  const claims = capture(jevAnswer({ claims_action: { type: "noul", noul: 0.7 } }));
  assert.equal(await new JevJudge({ key: "k", model: "jev-test", timeoutMs: 500, fetch: claims.fetch }).claimsAction("I've booked it.", null, signal), 0.7);
  assert.deepEqual(claims.calls[0]!.body.state, { reply: "I've booked it.", committed: "Nothing. Nori did not save, change, cancel, schedule, or send anything." });
  const committed = capture(jevAnswer({ claims_action: { type: "noul", noul: 0.1 } }));
  await new JevJudge({ key: "k", model: "jev-test", timeoutMs: 500, fetch: committed.fetch }).claimsAction("Saved #3.", "Saved #3 “x”.", signal);
  assert.deepEqual(committed.calls[0]!.body.state, { reply: "Saved #3.", committed: "Saved #3 “x”." });
  const broken = capture(() => new Response("down", { status: 529 }));
  assert.equal(await new JevJudge({ key: "k", model: "jev-test", timeoutMs: 500, fetch: broken.fetch }).claimsAction("hi", null, signal), null);
});

/** A Codex app-server over Nori's RPC handlers. `script` plays the turn's notifications. */
class FakeCodex implements RpcPort {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false; threads = 0;
  /** The effective configuration `config/read` reports. */
  config: Record<string, unknown> = {};
  constructor(public handlers: RpcHandlers, public script: (rpc: FakeCodex, threadId: string, turnId: string) => void) {}
  emit(method: string, params: Record<string, unknown>) { this.handlers.notification?.(method, params); }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") return { userAgent: "codex-test" };
    if (method === "config/read") return { config: this.config, origins: {}, layers: null };
    if (method === "thread/start") return { thread: { id: `thread-${++this.threads}` } };
    if (method === "turn/start") {
      const threadId = String(params.threadId); const turnId = `turn-${this.threads}`;
      this.emit("item/completed", { threadId: "other", turnId: "x", item: { type: "agentMessage", id: "a0", text: '{"reply":"wrong thread"}' } });
      queueMicrotask(() => this.script(this, threadId, turnId));
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    return {};
  }
  notify(method: string, params: Record<string, unknown>) { this.calls.push({ method, params }); }
  close() { if (this.closed) return; this.closed = true; this.handlers.closed?.(true); }
}
const finish = (status: string, text: string | null) => (rpc: FakeCodex, threadId: string, turnId: string) => {
  if (text !== null) rpc.emit("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "a1", text } });
  rpc.emit("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { inputTokens: 900, outputTokens: 40 }, last: { inputTokens: 900, outputTokens: 40 } } });
  rpc.emit("turn/completed", { threadId, turn: { id: turnId, status, items: [], error: null } });
};
function connector(script: (rpc: FakeCodex, threadId: string, turnId: string) => void) {
  const made: FakeCodex[] = [];
  return { made, connect: (handlers: RpcHandlers) => { const rpc = new FakeCodex(handlers, script); made.push(rpc); return rpc; } };
}

test("Codex responder runs one read-only, ephemeral, tool-free turn per request", async () => {
  const meter = new Meter(); const { made, connect } = connector(finish("completed", '{"reply":"hello"}'));
  const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 1000, cwd: "/tmp/nori-scratch", meter, connect });
  assert.deepEqual(await model.generate(request, signal), { model: "gpt-6-luna", json: { reply: "hello" }, usage: { input: 900, output: 40 } });
  assert.deepEqual((await model.generate(request, signal))?.json, { reply: "hello" });
  assert.equal(made.length, 1);
  const rpc = made[0]!;
  assert.deepEqual(rpc.calls.map(x => x.method), ["initialize", "initialized", "config/read", "thread/start", "turn/start", "thread/unsubscribe",
    "thread/start", "turn/start", "thread/unsubscribe"]);
  assert.equal(rpc.calls[2]!.params.cwd, "/tmp/nori-scratch");
  const thread = rpc.calls[3]!.params; const turn = rpc.calls[4]!.params;
  assert.deepEqual({ model: thread.model, cwd: thread.cwd, approvalPolicy: thread.approvalPolicy, sandbox: thread.sandbox,
    ephemeral: thread.ephemeral, baseInstructions: thread.baseInstructions },
  { model: "gpt-6-luna", cwd: "/tmp/nori-scratch", approvalPolicy: "never", sandbox: "read-only", ephemeral: true, baseInstructions: "You are Nori." });
  assert.deepEqual(turn.input, [{ type: "text", text: "Say hi.", text_elements: [] }]);
  assert.equal(turn.outputSchema, REPLY_SCHEMA); assert.equal(turn.threadId, "thread-1");
  assert.deepEqual(meter.records.map(x => x.ok), [true, true]);
  for (const flag of ["shell_tool", "unified_exec", "apps", "plugins", "computer_use", "browser_use"]) assert.ok(codexAppServerArgs.includes(flag), flag);
  assert.ok(codexAppServerArgs.includes('web_search="disabled"')); assert.ok(codexAppServerArgs.includes("mcp_servers={}"));
  model.close(); assert.equal(rpc.closed, true);
});

test("Codex failures and timeouts return null, interrupt the turn, and reconnect after the server exits", async () => {
  for (const script of [finish("failed", '{"reply":"x"}'), finish("completed", null), finish("completed", "no json")]) {
    const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 1000, cwd: "/tmp", connect: connector(script).connect });
    assert.equal(await model.generate(request, signal), null);
  }
  const hanging = connector(() => {});
  const slow = new CodexModel({ model: "gpt-6-luna", timeoutMs: 50, cwd: "/tmp", connect: hanging.connect });
  assert.equal(await slow.generate(request, signal), null);
  assert.ok(hanging.made[0]!.calls.some(x => x.method === "turn/interrupt" && x.params.turnId === "turn-1"));
  let reply = "a";
  const restarting = connector((rpc, threadId, turnId) => finish("completed", JSON.stringify({ reply }))(rpc, threadId, turnId));
  const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 1000, cwd: "/tmp", connect: restarting.connect });
  await model.generate(request, signal);
  restarting.made[0]!.close(); reply = "b";
  assert.deepEqual((await model.generate(request, signal))?.json, { reply: "b" });
  assert.equal(restarting.made.length, 2);
  assert.equal(await new CodexModel({ model: "gpt-6-luna", timeoutMs: 1000, cwd: "/tmp", meter: new Meter(false),
    connect: () => { throw new Error("should not connect"); } }).generate(request, signal), null);
});

test("closing the Codex responder while it is still starting leaves no live app-server", async () => {
  let finishInit: ((value: unknown) => void) | undefined; let rpc: FakeCodex | undefined;
  const connect = (handlers: RpcHandlers) => {
    rpc = new FakeCodex(handlers, finish("completed", '{"reply":"x"}'));
    const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => method === "initialize"
      ? new Promise<unknown>(resolve => { rpc!.calls.push({ method, params }); finishInit = resolve; }) : original(method, params);
    return rpc;
  };
  const controller = new AbortController();
  const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 5_000, cwd: "/tmp", connect });
  const pending = model.generate(request, controller.signal);
  while (!finishInit) await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(); assert.equal(await pending, null);
  model.close();
  finishInit({ userAgent: "codex-test" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(rpc!.closed, true);
  assert.equal(await model.generate(request, new AbortController().signal), null);
});

test("secrets come from the environment, then the macOS Keychain, never from arguments", () => {
  assert.equal(readSecret("OPENROUTER_API_KEY", { env: { OPENROUTER_API_KEY: " env-key " }, platform: "darwin", run: () => { throw new Error("unused"); } }), "env-key");
  const calls: string[][] = [];
  assert.equal(readSecret("TYPESAFE_API_KEY", { env: {}, platform: "darwin",
    run: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: "kc-key\n" }; } }), "kc-key");
  assert.deepEqual(calls, [["/usr/bin/security", "find-generic-password", "-s", "ai.nori.typesafe", "-w"]]);
  assert.equal(readSecret("TYPESAFE_API_KEY", { env: {}, platform: "darwin", run: () => ({ status: 44, stdout: "" }) }), null);
  assert.equal(readSecret("TYPESAFE_API_KEY", { env: {}, platform: "linux", run: () => ({ status: 0, stdout: "x" }) }), null);
});

test("usage meters are durable daily ceilings that reset at local midnight", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  let now = epoch;
  const meter = new StoreMeter(store, { timezone: config.timezone, limits: { jev: 2 }, clock: () => now });
  assert.deepEqual([meter.reserve("jev"), meter.reserve("jev"), meter.reserve("jev")], [true, true, false]);
  assert.equal(meter.reserve("openrouter"), false);
  meter.record("jev", { ok: false, usage: { input: 300, output: 20 } });
  assert.deepEqual(store.usage(localDay(now, config.timezone)),
    [{ provider: "jev", calls: 2, failures: 1, inputTokens: 300, outputTokens: 20 }]);
  now += 15 * 3_600_000;
  assert.equal(localDay(now, config.timezone), "2026-09-29");
  assert.equal(meter.reserve("jev"), true);
});

test("a Codex turn confirmed only after a timeout is still interrupted", async () => {
  // The start response arrives late; the turn's id comes from that response.
  let respond!: () => void; const late = connector(() => {});
  const lateModel = new CodexModel({ model: "gpt-6-luna", timeoutMs: 50, cwd: "/tmp", connect: handlers => {
    const rpc = late.connect(handlers); const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => method === "turn/start"
      ? new Promise<unknown>(resolve => { rpc.calls.push({ method, params }); respond = () => resolve({ turn: { id: "turn-late" } }); })
      : original(method, params);
    return rpc;
  } });
  assert.equal(await lateModel.generate(request, signal), null);
  respond(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(late.made[0]!.calls.some(x => x.method === "turn/interrupt" && x.params.turnId === "turn-late"));
  // The start response never arrives, but a turn/started notification names the turn.
  const noticed = connector(() => {});
  const noticedModel = new CodexModel({ model: "gpt-6-luna", timeoutMs: 50, cwd: "/tmp", connect: handlers => {
    const rpc = noticed.connect(handlers); const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method !== "turn/start") return original(method, params);
      rpc.calls.push({ method, params });
      rpc.emit("turn/started", { threadId: params.threadId, turn: { id: "turn-noticed" } });
      return new Promise<unknown>(() => {});
    };
    return rpc;
  } });
  assert.equal(await noticedModel.generate(request, signal), null);
  assert.ok(noticed.made[0]!.calls.some(x => x.method === "turn/interrupt" && x.params.turnId === "turn-noticed"));
});

test("a Codex turn that starts only after its start request failed is interrupted, or its connection closed", async () => {
  // The start notification arrives after the deadline, while the start request is still outstanding.
  let notify!: () => void; const watched = connector(() => {});
  const watchedModel = new CodexModel({ model: "gpt-6-luna", timeoutMs: 50, cwd: "/tmp", connect: handlers => {
    const rpc = watched.connect(handlers); const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method !== "turn/start") return original(method, params);
      rpc.calls.push({ method, params });
      notify = () => rpc.emit("turn/started", { threadId: params.threadId, turn: { id: "turn-after" } });
      return new Promise<unknown>(() => {});
    };
    return rpc;
  } });
  assert.equal(await watchedModel.generate(request, signal), null);
  notify();
  assert.ok(watched.made[0]!.calls.some(x => x.method === "turn/interrupt" && x.params.turnId === "turn-after"));
  // The start request itself fails (an RPC timeout) without any turn being named: the connection is closed.
  let fail!: () => void; const failed = connector(() => {});
  const failedModel = new CodexModel({ model: "gpt-6-luna", timeoutMs: 50, cwd: "/tmp", connect: handlers => {
    const rpc = failed.connect(handlers); const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => method === "turn/start"
      ? new Promise<unknown>((_resolve, reject) => { rpc.calls.push({ method, params }); fail = () => reject(new Error("RPC request timed out.")); })
      : original(method, params);
    return rpc;
  } });
  assert.equal(await failedModel.generate(request, signal), null);
  assert.equal(failed.made[0]!.closed, false);
  fail(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(failed.made[0]!.closed, true);
});

test("a Codex responder turn that cannot be interrupted takes its connection down with it", async () => {
  const stuck = connector(() => {});
  const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 50, cwd: "/tmp", connect: handlers => {
    const rpc = stuck.connect(handlers); const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => method === "turn/interrupt" ? Promise.reject(new Error("RPC provider rejected the request."))
      : original(method, params);
    return rpc;
  } });
  assert.equal(await model.generate(request, signal), null);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stuck.made[0]!.closed, true);
});

test("the Codex responder refuses a connection whose effective configuration still has an MCP server", async () => {
  for (const [servers, usable] of [[{ inherited: { command: "/usr/local/bin/tool" } }, false], [{ off: { command: "x", enabled: false } }, true],
    [{}, true]] as const) {
    const made = connector(finish("completed", '{"reply":"hi"}'));
    const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 1000, cwd: "/tmp", connect: handlers => {
      const rpc = made.connect(handlers); rpc.config = { mcp_servers: servers }; return rpc;
    } });
    assert.equal((await model.generate(request, signal)) !== null, usable, JSON.stringify(servers));
    const rpc = made.made[0]!;
    assert.equal(rpc.calls.some(x => x.method === "thread/start"), usable);
    assert.equal(rpc.closed, !usable);
    model.close();
  }
  // A configuration Codex cannot report is refused too.
  const unreadable = connector(finish("completed", '{"reply":"hi"}'));
  const model = new CodexModel({ model: "gpt-6-luna", timeoutMs: 1000, cwd: "/tmp", connect: handlers => {
    const rpc = unreadable.connect(handlers); const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => method === "config/read" ? {} : original(method, params);
    return rpc;
  } });
  assert.equal(await model.generate(request, signal), null);
});

test("Jev distributions must name exactly the catalog's options", async () => {
  const extra = { ...probabilities, unknown: 1 };
  const bad = new JevUnderstander({ key: "k", model: "jev-test", timeoutMs: 500, fetch: capture(jevAnswer({
    route: { type: "choice", choice: "reminders", confidence: 0.9, probabilities: extra }, multiple: { type: "noul", noul: 0 },
    outbound: { type: "noul", noul: 0 } })).fetch });
  assert.equal(await bad.understand(context, signal), null);
});
