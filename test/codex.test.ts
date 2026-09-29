import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexRuntime, codexEnvironment, codexHome } from "../src/codex.js";
import type { RpcHandlers, RpcPort, RuntimeEvents, RuntimeTool, Task } from "../src/contracts.js";
import { epoch } from "./helpers.js";

class FakeCodex implements RpcPort {
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  notes: string[] = [];
  closed = 0;
  failTurnStart = false;
  /** Holds the closed report, as a real connection does until the server's processes have exited. */
  holdClose = false;
  private threads = 0; private turns = 0;
  /** `layers` is what `config/read` reports as Codex's configuration layers. */
  constructor(readonly handlers: RpcHandlers, private readonly layers: () => unknown = () => []) {}
  async request(method: string, params: Record<string, unknown>) {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: "codex-test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" };
    if (method === "config/read") return { config: {}, origins: {}, layers: this.layers() };
    if (method === "thread/start") return { thread: { id: `th-${++this.threads}` } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start" && this.failTurnStart) throw new Error("RPC request timed out.");
    if (method === "turn/start") return { turn: { id: `tu-${++this.turns}`, status: "inProgress", items: [] } };
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected ${method}`);
  }
  params(method: string) { return this.requests.find(r => r.method === method)!.params; }
  notify(method: string) { this.notes.push(method); }
  close() { this.closed++; if (!this.holdClose) this.handlers.closed?.(); }
  finishClose() { this.handlers.closed?.(); }
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
const layer = (name: Record<string, unknown>, disabledReason: string | null = null) => ({ name, config: {}, version: "1", disabledReason });

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nori-codex-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connections: FakeCodex[] = [];
  let layers: unknown = [layer({ type: "user", file: join(dir, "home", "config.toml"), profile: null })];
  const runtime = new CodexRuntime({ connect: handlers => { const c = new FakeCodex(handlers, () => layers); connections.push(c); return c; },
    model: "gpt-test", workspaceDir: dir, timezone: "America/Los_Angeles", clock: () => epoch });
  const seen = { started: [] as unknown[], approvals: [] as unknown[], tools: [] as unknown[], usage: [] as number[], activity: 0 };
  let approve = true;
  const events: RuntimeEvents = {
    started: ids => { seen.started.push(ids); },
    approval: async request => { seen.approvals.push(request); return approve; },
    tool: async call => { seen.tools.push(call); return { success: true, text: "Saved." }; },
    usage: tokens => { seen.usage.push(tokens); },
    activity: () => { seen.activity++; },
  };
  return { dir, runtime, connections, conn: () => connections.at(-1)!, events, seen, setApprove: (value: boolean) => { approve = value; },
    setLayers: (value: unknown) => { layers = value; } };
}

test("start opts into the experimental API once, sandboxes a private thread with only the given tools, and parses the outcome", async t => {
  const { dir, runtime, conn, events, seen } = setup(t);
  const done = runtime.start(task(1), tools, events);
  await flush();
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "config/read", "thread/start", "turn/start"]);
  assert.equal((conn().requests[0]!.params.capabilities as Record<string, unknown>).experimentalApi, true);
  assert.deepEqual(conn().notes, ["initialized"]);
  const thread = conn().params("thread/start");
  assert.equal(thread.cwd, join(dir, "task-1"));
  assert.equal(statSync(join(dir, "task-1")).mode & 0o777, 0o700);
  assert.deepEqual([thread.approvalPolicy, thread.sandbox, thread.model, thread.ephemeral], ["on-request", "workspace-write", "gpt-test", false]);
  assert.deepEqual(thread.dynamicTools, [{ type: "function", ...tools[0] }]);
  assert.match(String(thread.developerInstructions), /America\/Los_Angeles/);
  assert.match(String(thread.developerInstructions), /untrusted/);
  const turn = conn().params("turn/start");
  assert.deepEqual(turn.input, [{ type: "text", text_elements: [],
    text: "This request was sent at 2026-09-28T16:00:00.000Z (the person's timezone is America/Los_Angeles).\n\nrequest 1" }]);
  assert.deepEqual((turn.outputSchema as { required: string[] }).required, ["outcome", "message", "evidence"]);
  assert.deepEqual(seen.started, [{ threadId: "th-1", turnId: null }, { threadId: "th-1", turnId: "tu-1" }]);
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
  assert.deepEqual(seen.approvals, [{ operation: "run a command", detail: "curl https://example.com (in /w; needs network)" }]);
  assert.deepEqual(await conn().ask("item/tool/call", { ...ids, callId: "c1", namespace: null, tool: "reminders_note", arguments: { title: "milk" } }),
    { contentItems: [{ type: "inputText", text: "Saved." }], success: true });
  assert.deepEqual(seen.tools, [{ callId: "c1", name: "reminders_note", arguments: { title: "milk" } }]);
  for (const method of ["item/permissions/requestApproval", "item/tool/requestUserInput", "execCommandApproval", "mcpServer/elicitation/request", "account/chatgptAuthTokens/refresh"])
    await assert.rejects(conn().ask(method, ids), method);
  await assert.rejects(conn().ask("item/commandExecution/requestApproval", { ...ids, threadId: "th-other", command: "rm -rf /" }));
  assert.equal(seen.approvals.length, 1);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});

test("resume loads an existing thread once per connection, and cancel interrupts the task's active turn", async t => {
  const { runtime, conn, events } = setup(t);
  await runtime.cancel(9);
  const first = runtime.resume(task(9, "th-9"), "follow up", [], events); await flush();
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "config/read", "thread/resume", "turn/start"]);
  assert.equal(conn().params("thread/resume").threadId, "th-9");
  assert.deepEqual(conn().params("turn/start").input, [{ type: "text", text: "follow up", text_elements: [] }]);
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
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "config/read", "thread/resume", "turn/start"]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await next;
});

test("the Codex child gets a minimal environment without Nori's secrets, and Nori's own Codex home", () => {
  const home = "/Users/receipts/Library/Application Support/Nori/codex";
  const env = codexEnvironment({ PATH: "/usr/bin", HOME: "/Users/receipts", USER: "receipts", LANG: "en_US.UTF-8", TMPDIR: "/tmp/x",
    CODEX_HOME: "/Users/receipts/.codex", TYPESAFE_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", NODE_OPTIONS: "--inspect" }, home);
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR", "USER"]);
  assert.equal(env.CODEX_HOME, home);
  assert.equal(codexEnvironment({ PATH: "/usr/bin" }, home).CODEX_HOME, home);
});

test("Nori's Codex home is a private directory inside its data directory", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-home-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "a")); mkdirSync(join(dir, "b")); mkdirSync(join(dir, "elsewhere"));
  assert.equal(codexHome(join(dir, "a")), join(dir, "a", "codex"));
  assert.equal(statSync(join(dir, "a", "codex")).mode & 0o777, 0o700);
  symlinkSync(join(dir, "elsewhere"), join(dir, "b", "codex"));
  assert.throws(() => codexHome(join(dir, "b")), /symlink/);
});

test("no turn starts while an active Codex configuration layer has execution rules", async t => {
  const { dir, runtime, conn, events, setLayers } = setup(t);
  const withRules = (folder: string) => {
    mkdirSync(join(folder, "rules"), { recursive: true });
    writeFileSync(join(folder, "rules", "default.rules"), 'prefix_rule(pattern=["curl"], decision="allow")\n');
    return folder;
  };
  const home = withRules(join(dir, "home")); const project = withRules(join(dir, "project", ".codex"));
  setLayers([layer({ type: "user", file: join(home, "config.toml"), profile: null })]);
  const refused = await runtime.start(task(1), [], events);
  assert.equal(refused.status, "failed");
  assert.ok(refused.status === "failed" && refused.message.includes(join(home, "rules")), JSON.stringify(refused));
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "config/read"]);
  assert.deepEqual(conn().params("config/read"), { includeLayers: true, cwd: join(dir, "task-1") });
  assert.equal((await runtime.resume(task(2, "th-2"), "go on", [], events)).status, "failed");
  assert.deepEqual(conn().requests.at(-1)?.params, { includeLayers: true, cwd: join(dir, "task-2") });
  // Layers Codex reports as disabled, such as untrusted projects, load no rules. A layer Nori cannot inspect counts as having them.
  const refusals: Array<[unknown, RegExp]> = [[[layer({ type: "project", dotCodexFolder: project })], /execution rules/],
    [[layer({ type: "mdm", domain: "com.openai.codex", key: "config_toml_base64" })], /cannot check/],
    [[{ disabledReason: null }], /cannot check/], [null, /cannot check/]];
  for (const [n, [layers, why]] of refusals.entries()) {
    setLayers(layers);
    const result = await runtime.start(task(10 + n), [], events);
    assert.ok(result.status === "failed" && why.test(result.message), JSON.stringify([layers, result]));
  }
  assert.ok(!conn().requests.some(r => r.method === "thread/start" || r.method === "thread/resume"));
  setLayers([layer({ type: "project", dotCodexFolder: project }, "untrusted"), layer({ type: "system", file: join(dir, "etc", "config.toml") }),
    layer({ type: "user", file: join(dir, "clean", "config.toml"), profile: null })]);
  const done = runtime.start(task(3), [], events); await flush();
  assert.deepEqual(conn().requests.map(r => r.method).slice(-3), ["config/read", "thread/start", "turn/start"]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  assert.equal((await done).status, "completed");
  // Rules that appear later stop the next turn, even on a thread this connection already loaded.
  setLayers([layer({ type: "user", file: join(home, "config.toml"), profile: null })]);
  assert.equal((await runtime.resume(task(3, "th-1"), "go on", [], events)).status, "failed");
  assert.deepEqual(conn().requests.map(r => r.method).slice(-2), ["turn/start", "config/read"]);
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
  assert.equal(conn().params("thread/start").approvalsReviewer, "user");
  const turn = conn().params("turn/start");
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

test("an ambiguous turn start closes the connection so the turn cannot keep running untracked", async t => {
  const { runtime, connections, events, seen } = setup(t);
  const first = runtime.start(task(1), [], events);
  await flush();
  connections[0]!.failTurnStart = true; connections[0]!.holdClose = true;
  const second = runtime.resume(task(2, "th-7"), "more", [], events);
  let ended = false; void second.catch(() => { ended = true; });
  connections[0]!.finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await first; await flush();
  assert.equal(connections[0]!.closed, 1);
  // The turn ends only once the connection reports that Codex's processes have exited.
  assert.equal(ended, false);
  connections[0]!.finishClose();
  await assert.rejects(second);
  assert.deepEqual(seen.started.slice(-1), [{ threadId: "th-7", turnId: null }]);
});

test("closing ends active turns, and resolves, only once Codex's processes have exited; the next job waits for that", async t => {
  const { runtime, connections, conn, events } = setup(t);
  const active = runtime.start(task(1), [], events); await flush();
  conn().holdClose = true;
  let ended = false; void active.catch(() => { ended = true; });
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  const next = runtime.start(task(2), [], events); await flush();
  assert.deepEqual([ended, closed, connections.length, connections[0]!.closed], [false, false, 1, 1]);
  assert.equal(connections[0]!.requests.filter(r => r.method === "config/read").length, 1);
  connections[0]!.finishClose();
  await assert.rejects(active, /disconnected/); await closing;
  await flush();
  assert.equal(connections.length, 2);
  assert.deepEqual(conn().requests.map(r => r.method), ["initialize", "config/read", "thread/start", "turn/start"]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  assert.equal((await next).status, "completed");
  await runtime.close();
});

test("Codex's own tool actions are reported as activity; plugin tool calls are not", async t => {
  const { runtime, conn, events, seen } = setup(t);
  const done = runtime.start(task(1), [], events); await flush();
  const ids = { threadId: "th-1", turnId: "tu-1", startedAtMs: 0 };
  for (const type of ["commandExecution", "fileChange", "webSearch", "mcpToolCall", "dynamicToolCall", "agentMessage", "reasoning"])
    conn().emit("item/started", { ...ids, item: { type, id: type, changes: [] } });
  assert.equal(seen.activity, 4);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});

test("a thread id that cannot be saved stops the turn from starting", async t => {
  const { runtime, conn, events } = setup(t);
  await assert.rejects(runtime.start(task(1), [], { ...events, started: () => { throw new Error("disk full"); } }), /disk full/);
  assert.ok(!conn().requests.some(r => r.method === "turn/start"));
});

test("a new job tells Codex when the request was sent", async t => {
  const { runtime, conn, events } = setup(t);
  const done = runtime.start({ ...task(1), time: Date.parse("2026-09-28T16:00:00Z") }, [], events); await flush();
  const input = (conn().requests.find(r => r.method === "turn/start")!.params.input as Array<{ text: string }>)[0]!.text;
  assert.match(input, /2026-09-28T16:00:00\.000Z/);
  assert.match(input, /request 1$/);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});

test("command approvals use the command from its item, and are refused when the command cannot be shown", async t => {
  const { runtime, conn, events, seen } = setup(t);
  const done = runtime.start(task(1), [], events); await flush();
  const ids = { threadId: "th-1", turnId: "tu-1", startedAtMs: 0 };
  conn().emit("item/started", { ...ids, item: { type: "commandExecution", id: "c1", command: "rm -rf /w/tmp", cwd: "/w", status: "inProgress" } });
  assert.deepEqual(await conn().ask("item/commandExecution/requestApproval", { ...ids, itemId: "c1", reason: "clean up" }), { decision: "accept" });
  assert.deepEqual(await conn().ask("item/commandExecution/requestApproval", { ...ids, itemId: "unknown", reason: "clean up" }), { decision: "decline" });
  assert.deepEqual(seen.approvals, [{ operation: "run a command", detail: "rm -rf /w/tmp (in /w; clean up)" }]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});

test("file approvals need known files, and permission entries are shown or refused", async t => {
  const { runtime, conn, events, seen } = setup(t);
  const done = runtime.start(task(1), [], events); await flush();
  const ids = { threadId: "th-1", turnId: "tu-1", startedAtMs: 0 };
  assert.deepEqual(await conn().ask("item/fileChange/requestApproval", { ...ids, itemId: "none", reason: "update settings" }), { decision: "decline" });
  await conn().ask("item/commandExecution/requestApproval", { ...ids, itemId: "c1", command: "python task.py", cwd: "/w",
    additionalPermissions: { network: null, fileSystem: { read: null, write: null, entries: [
      { path: { type: "path", path: "/Users/receipts/Library/Application Support/Nori" }, access: "write" },
      { path: { type: "glob_pattern", pattern: "/tmp/*.log" }, access: "read" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" }] } } });
  assert.deepEqual(await conn().ask("item/commandExecution/requestApproval", { ...ids, itemId: "c2", command: "ls", cwd: "/w",
    additionalPermissions: { network: null, fileSystem: { read: null, write: null, somethingNew: ["/"] } } }), { decision: "decline" });
  assert.deepEqual(seen.approvals, [{ operation: "run a command",
    detail: "python task.py (in /w; write access to /Users/receipts/Library/Application Support/Nori; read access to files matching /tmp/*.log; write access to the temporary directory)" }]);
  conn().finish("th-1", "tu-1", outcome({ outcome: "completed", message: "ok", evidence: ["x"] }));
  await done;
});
