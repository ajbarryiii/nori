import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";
import { parseConfig, requireAssistantUser } from "../src/config.js";
import { StdioRpc } from "../src/rpc.js";

const contact = { id: "owner", name: "Owner", handles: ["Owner@Example.com"], role: "owner", plugins: ["reminders"],
  conversation: { chatId: 42, chatGuid: "iMessage;-;owner@example.com" } };
const sam = { id: "sam", name: "Sam", handles: ["+15555550123"], role: "member", plugins: ["reminders"],
  conversation: { chatId: 43, chatGuid: "iMessage;-;+15555550123" } };
const input = { assistantUser: "receipts", contacts: [contact, sam],
  timezone: "America/Los_Angeles", dataDir: "/tmp/nori", imsgPath: "/usr/local/bin/imsg" };

test("configuration fails closed for missing identity, groups, relative paths and invalid zones", () => {
  assert.equal(parseConfig(input).contacts[0]?.handles[0], "owner@example.com");
  for (const bad of [{ ...input, contacts: [{ ...contact, handles: [] }] },
    { ...input, contacts: [{ ...contact, conversation: { ...contact.conversation, chatGuid: "iMessage;+;group" } }] },
    { ...input, timezone: "Mars/Olympus" }, { ...input, dataDir: "./data" },
    { ...input, quietHours: { start: 25, end: 8 } }, { ...input, pollMs: 1 }]) assert.throws(() => parseConfig(bad));
  assert.throws(() => requireAssistantUser(parseConfig(input), "ajbarry"), /receipts/);
  assert.doesNotThrow(() => requireAssistantUser(parseConfig(input), "receipts"));
});

test("approved contacts need unique ids, handles, and conversations, and exactly one owner", () => {
  const cases: Array<[unknown[], RegExp]> = [
    [[], /contacts/],
    [[contact, { ...sam, id: "owner" }], /id/],
    [[contact, { ...sam, handles: ["owner@example.com"] }], /handle/],
    [[contact, { ...sam, conversation: contact.conversation }], /conversation/],
    [[contact, { ...sam, conversation: { ...sam.conversation, chatGuid: contact.conversation.chatGuid } }], /conversation/],
    [[sam], /owner/], [[contact, { ...sam, role: "owner" }], /owner/],
    [[contact, { ...sam, role: "admin" }], /role/],
    [[contact, { ...sam, plugins: "reminders" }], /plugins/],
    [[contact, { ...sam, id: "Sam Smith" }], /id/],
  ];
  for (const [contacts, error] of cases) assert.throws(() => parseConfig({ ...input, contacts }), error, JSON.stringify(contacts));
  assert.throws(() => parseConfig({ ...input, contacts: undefined, owner: contact }), /contacts/);
  assert.throws(() => parseConfig({ ...input, owner: contact }), /owner/);
});

test("the Codex runtime needs absolute paths and bounded budgets", () => {
  const codexPath = "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex";
  assert.equal(parseConfig(input).runtime, null);
  assert.deepEqual(parseConfig({ ...input, runtime: { codexPath } }).runtime, { codexPath, model: null, workspaceDir: "/tmp/nori/workspaces",
    budget: { minutes: 30, turns: 8, toolCalls: 40, tokens: 2_000_000 }, daily: { tasks: 20, tokens: 10_000_000 }, approvalMinutes: 60 });
  const custom = { codexPath, model: "gpt-6-astra", workspaceDir: "/tmp/work", budget: { minutes: 10, turns: 2, toolCalls: 5, tokens: 1000 },
    daily: { tasks: 3, tokens: 9000 }, approvalMinutes: 15 };
  assert.deepEqual(parseConfig({ ...input, runtime: custom }).runtime, custom);
  assert.deepEqual(parseConfig({ ...input, runtime: { codexPath, budget: { minutes: 5 } } }).runtime?.budget,
    { minutes: 5, turns: 8, toolCalls: 40, tokens: 2_000_000 });
  for (const bad of [{ codexPath: "codex" }, { codexPath, workspaceDir: "work" }, { codexPath, model: "" }, { codexPath, budget: { minutes: 0 } },
    { codexPath, budget: { turns: 1.5 } }, { codexPath, daily: { tasks: -1 } }, { codexPath, approvalMinutes: 0 }, { codexPath, approvalMinutes: 2000 },
    { codexPath, budget: [] }, "codex"]) assert.throws(() => parseConfig({ ...input, runtime: bad }), JSON.stringify(bad));
});

test("Jev routing needs a pinned model and bounded thresholds and limits", () => {
  const jev = { model: "jev-1.13.0", timeoutMs: 2500, dailyLimit: 50, routes: { reminders: 0.9 } };
  assert.deepEqual(parseConfig({ ...input, jev }).jev, jev);
  assert.deepEqual(parseConfig({ ...input, jev: { model: "jev-1.13.0" } }).jev, { model: "jev-1.13.0", timeoutMs: 2500, dailyLimit: 100, routes: {} });
  for (const bad of [{ ...jev, model: "jev-latest" }, { ...jev, dailyLimit: 0 }, { ...jev, routes: { reminders: 0 } },
    { ...jev, routes: { reminders: 1.5 } }, { ...jev, routes: [] }]) assert.throws(() => parseConfig({ ...input, jev: bad }), JSON.stringify(bad));
});

test("stdio RPC correlates responses and rejects unknown inbound calls", async t => {
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 500 });
  t.after(() => rpc.close());
  const [a, b] = await Promise.all([rpc.request("echo", { value: 1 }), rpc.request("echo", { value: 2 })]);
  assert.deepEqual(a, { value: 1 }); assert.deepEqual(b, { value: 2 });
  assert.deepEqual(await rpc.request("ask", {}), { rejected: true });
});

test("stdio RPC answers server requests through its handler and delivers notifications", async t => {
  const notes: unknown[] = []; let answer: unknown = { ok: true };
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 500, handlers: {
    request: async (method, params) => { if (answer instanceof Error) throw answer; return { method, params, answer }; },
    notification: (method, params) => { notes.push({ method, params }); },
  } });
  t.after(() => rpc.close());
  assert.deepEqual(await rpc.request("ask", {}), { answered: { method: "unknown/approval", params: { threadId: "t" }, answer: { ok: true } } });
  answer = new Error("secret detail");
  assert.deepEqual(await rpc.request("ask", {}), { rejected: true });
  await rpc.request("note", {});
  assert.deepEqual(notes, [{ method: "progress", params: { step: 1 } }]);
});

test("stdio RPC can pass the child an explicit environment and reports when it closes", async t => {
  let closed = 0;
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 500,
    env: { PATH: process.env.PATH ?? "", NORI_TEST: "1" }, handlers: { closed: () => { closed++; } } });
  t.after(() => rpc.close());
  const keys = await rpc.request("env", {}) as string[];
  assert.ok(keys.includes("NORI_TEST")); assert.ok(!keys.includes("HOME"));
  await assert.rejects(rpc.request("exit", {}), /closed/);
  assert.equal(closed, 1);
});

/** Whether a process is still running. One that has exited but not yet been collected is not. */
function running(pid: number): boolean {
  try { return !execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch { return false; }
}

test("closing stops the server and every process it started, even in another session, before reporting it closed", async t => {
  let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
    handlers: { closed: stopped => reported(stopped) } });
  const pids = await rpc.request("spawn", {}) as number[];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } });
  assert.deepEqual(pids.map(running), [true, true, true, true]);
  let done = false; void closed.then(() => { done = true; });
  rpc.close();
  await assert.rejects(rpc.request("spawn", {}), /closed/);
  assert.equal(done, false);
  assert.equal(await closed, true);
  assert.deepEqual(pids.map(running), [false, false, false, false]);
});

test("a stop that cannot be confirmed is reported as unconfirmed", async t => {
  let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
    processTable: async () => { throw new Error("ps failed"); }, handlers: { closed: stopped => reported(stopped) } });
  const pids = await rpc.request("spawn", {}) as number[];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } });
  rpc.close();
  assert.equal(await closed, false);
  assert.equal(running(pids[0]!), false);
});

test("stdio RPC times out and rejects outstanding requests when child exits", async t => {
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 100 });
  t.after(() => rpc.close());
  await assert.rejects(rpc.request("hang", {}), /timed out/);
  await assert.rejects(rpc.request("exit", {}), /closed/);
});

test("direct chats may use the newer any;-; GUID prefix; groups and SMS stay rejected", () => {
  const guid = (chatGuid: string) => ({ ...input, contacts: [{ ...contact, conversation: { chatId: 42, chatGuid } }] });
  assert.equal(parseConfig(guid("any;-;owner@example.com")).contacts[0]?.conversation.chatGuid, "any;-;owner@example.com");
  for (const bad of ["any;+;chat123", "SMS;-;+15555550123", "iMessage;+;chat123"]) assert.throws(() => parseConfig(guid(bad)), bad);
});
