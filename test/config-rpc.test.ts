import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";
import { CONSOLE_CONTACT, parseConfig, parseConsoleConfig, requireAssistantUser } from "../src/config.js";
import { parseListings, StdioRpc, type ProcessTable } from "../src/rpc.js";

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
    budget: { minutes: 30, turns: 8, toolCalls: 40, tokens: 2_000_000 }, daily: { tasks: 20, tokens: 10_000_000 }, approvalMinutes: 60, maxJobs: 1 });
  const custom = { codexPath, model: "gpt-6-astra", workspaceDir: "/tmp/work", budget: { minutes: 10, turns: 2, toolCalls: 5, tokens: 1000 },
    daily: { tasks: 3, tokens: 9000 }, approvalMinutes: 15, maxJobs: 3 };
  assert.deepEqual(parseConfig({ ...input, runtime: custom }).runtime, custom);
  assert.deepEqual(parseConfig({ ...input, runtime: { codexPath, budget: { minutes: 5 } } }).runtime?.budget,
    { minutes: 5, turns: 8, toolCalls: 40, tokens: 2_000_000 });
  for (const bad of [{ codexPath: "codex" }, { codexPath, workspaceDir: "work" }, { codexPath, model: "" }, { codexPath, budget: { minutes: 0 } },
    { codexPath, budget: { turns: 1.5 } }, { codexPath, daily: { tasks: -1 } }, { codexPath, approvalMinutes: 0 }, { codexPath, approvalMinutes: 2000 },
    { codexPath, maxJobs: 0 }, { codexPath, maxJobs: 9 }, { codexPath, maxJobs: 1.5 },
    { codexPath, budget: [] }, "codex"]) assert.throws(() => parseConfig({ ...input, runtime: bad }), JSON.stringify(bad));
});

test("Jev routing needs a pinned model and bounded thresholds and limits", () => {
  const jev = { model: "jev-1.13.0", timeoutMs: 2500, dailyLimit: 50, routes: { reminders: 0.9 }, thresholds: { act: 0.9, clarify: 0.4, verify: 0.7 } };
  assert.deepEqual(parseConfig({ ...input, jev }).jev, jev);
  assert.deepEqual(parseConfig({ ...input, jev: { model: "jev-1.13.0" } }).jev, { model: "jev-1.13.0", timeoutMs: 2500, dailyLimit: 100, routes: {},
    thresholds: { act: 0.8, clarify: 0.5, verify: 0.6 } });
  assert.equal(parseConfig({ ...input, jev }).responder, null);
  for (const bad of [{ ...jev, model: "jev-latest" }, { ...jev, dailyLimit: 0 }, { ...jev, routes: { reminders: 0 } },
    { ...jev, routes: { reminders: 1.5 } }, { ...jev, routes: [] }, { ...jev, thresholds: { act: 0.5, clarify: 0.8 } },
    { ...jev, thresholds: { verify: 1 } }, { ...jev, thresholds: [] }]) assert.throws(() => parseConfig({ ...input, jev: bad }), JSON.stringify(bad));
});

test("a responder needs Jev, a pinned model, and an absolute Codex path", () => {
  const jev = { model: "jev-1.13.0" };
  assert.deepEqual(parseConfig({ ...input, jev, responder: { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" } }).responder,
    { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash", timeoutMs: 20_000, dailyLimit: 300 });
  assert.deepEqual(parseConfig({ ...input, jev, responder: { provider: "codex", model: "gpt-6-luna", codexPath: "/opt/homebrew/bin/codex" } }).responder,
    { provider: "codex", model: "gpt-6-luna", timeoutMs: 90_000, dailyLimit: 300, codexPath: "/opt/homebrew/bin/codex" });
  // A Codex responder may reuse the runtime's Codex CLI.
  assert.deepEqual(parseConfig({ ...input, jev, runtime: { codexPath: "/usr/local/bin/codex" }, responder: { provider: "codex", model: "gpt-6-luna" } })
    .responder, { provider: "codex", model: "gpt-6-luna", timeoutMs: 90_000, dailyLimit: 300, codexPath: "/usr/local/bin/codex" });
  for (const bad of [{ responder: { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" } },
    { jev, responder: { provider: "anthropic", model: "x" } }, { jev, responder: { provider: "openrouter", model: "openrouter/auto" } },
    { jev, responder: { provider: "openrouter", model: "a/latest" } },
    { jev, responder: { provider: "codex", model: "gpt-6-luna", codexPath: "codex" } }, { jev, responder: { provider: "codex", model: "gpt-6-luna" } },
    { jev, responder: { provider: "openrouter", model: "a/b", dailyLimit: 0 } },
    { jev, responder: { provider: "openrouter", model: "a/b", timeoutMs: 10 } }, { jev, responder: "openrouter" }])
    assert.throws(() => parseConfig({ ...input, ...bad }), JSON.stringify(bad));
});

test("console configuration ignores live identity, contacts, paths, and the runtime", () => {
  const parsed = parseConsoleConfig({ ...input, dataDir: "/Users/nori/Library/Application Support/Nori", timezone: "Europe/Paris",
    runtime: { codexPath: "/usr/local/bin/codex" } }, { dataDir: "/tmp/nori-console", username: "dev" });
  assert.equal(parsed.dataDir, "/tmp/nori-console"); assert.equal(parsed.assistantUser, "dev");
  assert.deepEqual(parsed.contacts, [CONSOLE_CONTACT]); assert.equal(parsed.timezone, "Europe/Paris");
  assert.equal(parsed.runtime, null);
  assert.equal(parseConsoleConfig({}, { dataDir: "/tmp/nori-console", username: "dev" }).jev, null);
  // A Codex responder that inherits the live runtime's CLI keeps it, though the runtime itself is dropped.
  const inherited = parseConsoleConfig({ ...input, jev: { model: "jev-1.13.0" }, runtime: { codexPath: "/usr/local/bin/codex" },
    responder: { provider: "codex", model: "gpt-6-luna" } }, { dataDir: "/tmp/nori-console", username: "dev" });
  assert.deepEqual([inherited.runtime, inherited.responder?.provider === "codex" && inherited.responder.codexPath], [null, "/usr/local/bin/codex"]);
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
  let closed = 0; let reported!: () => void; const report = new Promise<void>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 500,
    env: { PATH: process.env.PATH ?? "", NORI_TEST: "1" }, handlers: { closed: () => { closed++; reported(); } } });
  t.after(() => rpc.close());
  const keys = await rpc.request("env", {}) as string[];
  assert.ok(keys.includes("NORI_TEST")); assert.ok(!keys.includes("HOME"));
  await assert.rejects(rpc.request("exit", {}), /closed/);
  // Reported once what the server left behind has been checked.
  await report; rpc.close();
  assert.equal(closed, 1);
});

test("stdio RPC children inherit the environment without Nori's API keys", async t => {
  const saved = { typesafe: process.env.TYPESAFE_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
  process.env.TYPESAFE_API_KEY = "parent-only"; process.env.OPENROUTER_API_KEY = "parent-only";
  t.after(() => {
    for (const [name, value] of [["TYPESAFE_API_KEY", saved.typesafe], ["OPENROUTER_API_KEY", saved.openrouter]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 500 });
  t.after(() => rpc.close());
  const keys = await rpc.request("env", {}) as string[];
  assert.ok(keys.includes("PATH"));
  assert.ok(!keys.includes("TYPESAFE_API_KEY")); assert.ok(!keys.includes("OPENROUTER_API_KEY"));
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

test("closing also stops processes left behind by commands that have exited", async t => {
  let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
    handlers: { closed: stopped => reported(stopped) } });
  const pids = await rpc.request("orphans", {}) as number[];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } });
  // Their launchers have exited, so none of them is a descendant of the server any more.
  const parents = pids.map(pid => Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()));
  assert.deepEqual(parents, [1, 1, 1]);
  rpc.close();
  assert.equal(await closed, true);
  assert.deepEqual(pids.map(running), [false, false, false]);
});

test("after the server exits on its own, closing still stops what it left behind", async t => {
  let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
    handlers: { closed: stopped => reported(stopped) } });
  const pids = await rpc.request("orphans", {}) as number[];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } } });
  await assert.rejects(rpc.request("exit", {}), /closed/);
  assert.equal(await closed, true);
  assert.deepEqual(pids.map(running), [false, false, false]);
});

test("a server that exits closes the connection even while something it started holds its output", async t => {
  let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
    handlers: { closed: stopped => reported(stopped) } });
  const pid = await rpc.request("holder", {}) as number;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } });
  await assert.rejects(rpc.request("exit", {}), /closed/);
  assert.equal(await closed, true);
  assert.equal(running(pid), false);
});

test("a process that is first seen while the others are being killed is stopped too", async t => {
  // A detached process outside the server's tree, which listings report as tagged only from the second one on.
  const late = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { detached: true, stdio: "ignore" }); late.unref();
  t.after(() => { try { process.kill(late.pid!, "SIGKILL"); } catch { /* Already gone. */ } });
  let listings = 0;
  const table = async (): Promise<ProcessTable> => {
    const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8" });
    const result: ProcessTable = new Map(); listings++;
    for (const line of rows.split("\n")) {
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
      if (row) result.set(Number(row[1]), { parent: Number(row[2]), group: Number(row[3]), exited: row[4]!.startsWith("Z"),
        start: row[5]!, tagged: Number(row[1]) === late.pid && listings > 1 });
    }
    return result;
  };
  let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
    processTable: table, handlers: { closed: stopped => reported(stopped) } });
  rpc.close();
  assert.equal(await closed, true);
  assert.equal(running(late.pid!), false);
});

test("a tagged process missing from the separate process listing is kept, with nothing else known about it", () => {
  const processes = "  100     1   100 Ss   Wed Sep 30 10:00:00 2026\n  200   100   100 S    Wed Sep 30 10:00:01 2026\n";
  const environments = "  100 /usr/bin/app A=1\n  200 node worker.js NORI_PROCESS_TAG=abc B=2\n  300 node late.js NORI_PROCESS_TAG=abc\n  400 other NORI_PROCESS_TAG=xyz\n";
  assert.deepEqual([...parseListings(processes, environments, "abc")], [
    [100, { parent: 1, group: 100, start: "Wed Sep 30 10:00:00 2026", exited: false, tagged: false }],
    [200, { parent: 100, group: 100, start: "Wed Sep 30 10:00:01 2026", exited: false, tagged: true }],
    [300, { parent: 0, group: null, start: null, exited: false, tagged: true }],
  ]);
});

test("a tagged process found earlier stays tracked when a later listing shows a missing or different start time", async t => {
  for (const later of [{ parent: 0, group: null, start: null }, { parent: 1, group: 1, start: "Thu Jan  1 00:00:00 2099" }]) {
    const late = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { detached: true, stdio: "ignore" }); late.unref();
    t.after(() => { try { process.kill(late.pid!, "SIGKILL"); } catch { /* Already gone. */ } });
    let listings = 0;
    const table = async (): Promise<ProcessTable> => {
      const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8" });
      const result: ProcessTable = new Map(); listings++;
      for (const line of rows.split("\n")) {
        const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
        if (row) result.set(Number(row[1]), { parent: Number(row[2]), group: Number(row[3]), exited: row[4]!.startsWith("Z"),
          start: row[5]!, tagged: Number(row[1]) === late.pid });
      }
      // The first listing while killing shows the tagged process with other start-time metadata.
      if (listings === 3 && result.has(late.pid!)) result.set(late.pid!, { ...later, exited: false, tagged: true });
      return result;
    };
    let reported!: (stopped: boolean) => void; const closed = new Promise<boolean>(resolve => { reported = resolve; });
    const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-tree.mjs")], timeoutMs: 5000,
      processTable: table, handlers: { closed: stopped => reported(stopped) } });
    // The server exits first, so the tagged process is the only one left to stop.
    await assert.rejects(rpc.request("exit", {}), /closed/);
    assert.equal(await closed, true, JSON.stringify(later));
    assert.equal(running(late.pid!), false, JSON.stringify(later));
  }
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
