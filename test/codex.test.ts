import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexRuntime, codexEnvironment } from "../src/codex.js";
import type { RpcHandlers, RpcPort, RuntimeEvents, RuntimeTool, Task } from "../src/contracts.js";
import { epoch } from "./helpers.js";

class FakeCodex implements RpcPort {
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  notes: string[] = [];
  private threads = 0; private turns = 0;
  constructor(readonly handlers: RpcHandlers) {}
  async request(method: string, params: Record<string, unknown>) {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: "codex-test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" };
    if (method === "thread/start") return { thread: { id: `th-${++this.threads}` } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: `tu-${++this.turns}`, status: "inProgress", items: [] } };
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected ${method}`);
  }
  notify(method: string) { this.notes.push(method); }
  close() { this.handlers.closed?.(); }
  emit(method: string, params: Record<string, unknown>) { this.handlers.notification?.(method, params); }
  ask(method: string, params: Record<string, unknown>) { return this.handlers.request!(method, params); }
  finish(threadId: string, turnId: string, text: string, status = "completed", error: unknown = null) {
    if (text) this.emit("item/completed", { threadId, turnId, completedAtMs: 0, item: { type: "agentMessage", id: "m", text, phase: null } });
    this.emit("turn/completed", { threadId, turn: { id: turnId, status, error, items: [] } });
  }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const task = (id: number, threadId: string | null = null): Task => ({ id, contactId: "owner", number: id, sourceGuid: null,
  text: `request ${id}`, time: epoch, state: "running", hint: null, failure: null, route: null, threadId, waitingFor: null,
  input: null, outcome: null, evidence: [], usage: { turns: 0, toolCalls: 0, tokens: 0, runMs: 0, allowance: 1 } });
const tools: RuntimeTool[] = [{ name: "reminders_note", description: "Save a note.",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }];
const outcome = (value: unknown) => JSON.stringify(value);

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nori-codex-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connections: FakeCodex[] = [];
  const runtime = new CodexRuntime({ connect: handlers => { const c = new FakeCodex(handlers); connections.push(c); return c; },
    model: "gpt-test", workspaceDir: dir, timezone: "America/Los_Angeles", clock: () => epoch });
  const seen = { started: [] as unknown[], approvals: [] as unknown[], tools: [] as unknown[], usage: [] as number[] };
  let approve = true;
  const events: RuntimeEvents = {
    started: ids => { seen.started.push(ids); },
    approval: async request => { seen.approvals.push(request); return approve; },
    tool: async call => { seen.tools.push(call); return { success: true, text: "Saved." }; },
    usage: tokens => { seen.usage.push(tokens); },
  };
  return { dir, runtime, connections, conn: () => connections.at(-1)!, events, seen, setApprove: (value: boolean) => { approve = value; } };
}

test("start opts into the experimental API once, sandboxes a private thread with only the given tools, and parses the outcome", async t => {
  const { dir, runtime, conn, events, seen } = setup(t);
  const done = runtime.start(task(1), tools, events);
  await flush();
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "thread/start", "turn/start"]);
  assert.equal((conn().requests[0]!.params.capabilities as Record<string, unknown>).experimentalApi, true);
  assert.deepEqual(conn().notes, ["initialized"]);
  const thread = conn().requests[1]!.params;
  assert.equal(thread.cwd, join(dir, "task-1"));
  assert.equal(statSync(join(dir, "task-1")).mode & 0o777, 0o700);
  assert.deepEqual([thread.approvalPolicy, thread.sandbox, thread.model, thread.ephemeral], ["on-request", "workspace-write", "gpt-test", false]);
  assert.deepEqual(thread.dynamicTools, [{ type: "function", ...tools[0] }]);
  assert.match(String(thread.developerInstructions), /America\/Los_Angeles/);
  assert.match(String(thread.developerInstructions), /untrusted/);
  const turn = conn().requests[2]!.params;
  assert.deepEqual(turn.input, [{ type: "text", text: "request 1", text_elements: [] }]);
  assert.deepEqual((turn.outputSchema as { required: string[] }).required, ["outcome", "message", "evidence"]);
  assert.deepEqual(seen.started, [{ threadId: "th-1", turnId: "tu-1" }]);
  conn().emit("thread/tokenUsage/updated", { threadId: "th-1", turnId: "tu-1", tokenUsage: { total: { totalTokens: 1234 }, last: { totalTokens: 1234 } } });
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "Done.", evidence: ["Checked the file"] }));
  assert.deepEqual(await done, { status: "completed", message: "Done.", evidence: ["Checked the file"] });
  assert.deepEqual(seen.usage, [1234]);
  const next = runtime.start(task(2), [], events); await flush();
  assert.deepEqual(conn().requests.map(r => r.method).filter(m => m === "initialize"), ["initialize"]);
  conn().finish("th-2", "tu-2", outcome({ outcome: "needs_input", message: "Which one?", evidence: [] }));
  assert.deepEqual(await next, { status: "needs_input", message: "Which one?" });
});

test("approvals and tool calls from Codex go through events; other server requests are refused", async t => {
  const { runtime, conn, events, seen, setApprove } = setup(t);
  const done = runtime.start(task(1), tools, events); await flush();
  const ids = { threadId: "th-1", turnId: "tu-1", itemId: "i1", startedAtMs: 0 };
  assert.deepEqual(await conn().ask("item/commandExecution/requestApproval", { ...ids, command: "curl https://example.com", cwd: "/w", reason: "needs network" }),
    { decision: "accept" });
  setApprove(false);
  assert.deepEqual(await conn().ask("item/fileChange/requestApproval", { ...ids, reason: "write outside workspace", grantRoot: "/Users" }), { decision: "decline" });
  assert.deepEqual(seen.approvals, [
    { operation: "run a command", detail: "curl https://example.com (in /w; needs network)" },
    { operation: "change files", detail: "write outside workspace (/Users)" },
  ]);
  assert.deepEqual(await conn().ask("item/tool/call", { ...ids, callId: "c1", namespace: null, tool: "reminders_note", arguments: { title: "milk" } }),
    { contentItems: [{ type: "inputText", text: "Saved." }], success: true });
  assert.deepEqual(seen.tools, [{ callId: "c1", name: "reminders_note", arguments: { title: "milk" } }]);
  for (const method of ["item/permissions/requestApproval", "item/tool/requestUserInput", "execCommandApproval", "mcpServer/elicitation/request", "account/chatgptAuthTokens/refresh"])
    await assert.rejects(conn().ask(method, ids), method);
  await assert.rejects(conn().ask("item/commandExecution/requestApproval", { ...ids, threadId: "th-other", command: "rm -rf /" }));
  assert.equal(seen.approvals.length, 2);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});

test("resume loads an existing thread once per connection, and cancel interrupts the task's active turn", async t => {
  const { runtime, conn, events } = setup(t);
  await runtime.cancel(9);
  const first = runtime.resume(task(9, "th-9"), "follow up", [], events); await flush();
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "thread/resume", "turn/start"]);
  assert.equal(conn().requests[1]!.params.threadId, "th-9");
  assert.deepEqual(conn().requests[2]!.params.input, [{ type: "text", text: "follow up", text_elements: [] }]);
  await runtime.cancel(9);
  assert.deepEqual(conn().requests.at(-1), { method: "turn/interrupt", params: { threadId: "th-9", turnId: "tu-1" } });
  conn().finish("th-9", "tu-1", "", "interrupted");
  assert.deepEqual(await first, { status: "interrupted" });
  const second = runtime.resume(task(9, "th-9"), "again", [], events); await flush();
  assert.equal(conn().requests.filter(r => r.method === "thread/resume").length, 1);
  conn().finish("th-9", "tu-2", outcome({ outcome: "failed", message: "Site is down.", evidence: [] }));
  assert.deepEqual(await second, { status: "failed", message: "Site is down." });
});

test("failed, unstructured, and unevidenced turns never become completed", async t => {
  const { runtime, conn, events } = setup(t);
  const cases: Array<[string, string, unknown, unknown]> = [
    ["failed", "", { message: "Model overloaded" }, { status: "failed", message: "Model overloaded" }],
    ["completed", "Here you go", null, { status: "failed", message: "Here you go" }],
    ["completed", outcome({ outcome: "completed", message: "Done.", evidence: [] }), null,
      { status: "failed", message: "Done. (It reported no checks, so it is not marked done.)" }],
    ["completed", "", null, { status: "failed", message: "The job ended without a usable result." }],
  ];
  for (const [n, [status, text, error, expected]] of cases.entries()) {
    const done = runtime.start(task(n + 1), [], events); await flush();
    conn().finish(`th-${n + 1}`, `tu-${n + 1}`, text, status, error);
    assert.deepEqual(await done, expected, JSON.stringify([status, text]));
  }
  const long = runtime.start(task(9), [], events); await flush();
  conn().finish("th-5", "tu-5", outcome({ outcome: "needs_input", message: "x".repeat(5000), evidence: [] }));
  const result = await long as { message: string };
  assert.equal(result.message.length, 1500);
  assert.ok(result.message.endsWith("…"));
});

test("a lost connection rejects the active turn, and the next call reconnects", async t => {
  const { runtime, connections, conn, events } = setup(t);
  const done = runtime.start(task(1), [], events); await flush();
  conn().close();
  await assert.rejects(done, /disconnected/);
  const next = runtime.resume(task(1, "th-1"), "continue", [], events); await flush();
  assert.equal(connections.length, 2);
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "thread/resume", "turn/start"]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await next;
});

test("the Codex child gets a minimal environment without Nori's secrets", () => {
  const env = codexEnvironment({ PATH: "/usr/bin", HOME: "/Users/receipts", USER: "receipts", LANG: "en_US.UTF-8", TMPDIR: "/tmp/x",
    CODEX_HOME: "/Users/receipts/.codex", TYPESAFE_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", NODE_OPTIONS: "--inspect" });
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR", "USER"]);
});

test("a cancel that arrives before the turn exists stops it from starting", async t => {
  const { runtime, conn, events } = setup(t);
  const done = runtime.start(task(1), [], events);
  await runtime.cancel(1);
  assert.deepEqual(await done, { status: "interrupted" });
  assert.ok(!conn().requests.some(r => r.method === "turn/start"));
});

test("every turn pins user review and a sandbox without extra writable roots or network", async t => {
  const { dir, runtime, conn, events } = setup(t);
  const done = runtime.start(task(1), [], events); await flush();
  assert.equal(conn().requests[1]!.params.approvalsReviewer, "user");
  const turn = conn().requests[2]!.params;
  assert.deepEqual([turn.approvalPolicy, turn.approvalsReviewer], ["on-request", "user"]);
  assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [join(dir, "task-1")], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});

test("approval prompts show the files, network hosts, and extra access being authorized", async t => {
  const { runtime, conn, events, seen } = setup(t);
  const done = runtime.start(task(1), [], events); await flush();
  const ids = { threadId: "th-1", turnId: "tu-1", startedAtMs: 0 };
  conn().emit("item/started", { ...ids, item: { type: "fileChange", id: "f1", status: "inProgress", changes: [
    { path: "/Users/receipts/Library/LaunchAgents/x.plist", kind: { type: "add" }, diff: "" }, { path: "/w/notes.md", kind: { type: "update", move_path: null }, diff: "" }] } });
  await conn().ask("item/fileChange/requestApproval", { ...ids, itemId: "f1", reason: "update notes", grantRoot: null });
  await conn().ask("item/commandExecution/requestApproval", { ...ids, itemId: "c1", kind: "command", command: "curl https://api.example.com",
    cwd: "/w", networkApprovalContext: { host: "api.example.com", protocol: "https" },
    additionalPermissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/Users/receipts/Documents"] } } });
  await conn().ask("item/commandExecution/requestApproval", { ...ids, itemId: "c2", kind: "writeStdin", command: "yes", cwd: "/w" });
  assert.deepEqual(seen.approvals, [
    { operation: "change files", detail: "add /Users/receipts/Library/LaunchAgents/x.plist, update /w/notes.md (update notes)" },
    { operation: "run a command", detail: "curl https://api.example.com (in /w; network access to api.example.com; network access; write access to /Users/receipts/Documents)" },
    { operation: "send input to a running command", detail: "yes (in /w)" },
  ]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});
