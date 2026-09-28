import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { parseConfig, requireAssistantUser } from "../src/config.js";
import { StdioRpc } from "../src/rpc.js";

const input = { assistantUser: "receipts", owner: { handles: ["Owner@Example.com"], chatId: 42, chatGuid: "iMessage;-;owner@example.com" },
  timezone: "America/Los_Angeles", dataDir: "/tmp/nori", imsgPath: "/usr/local/bin/imsg" };

test("configuration fails closed for missing identity, groups, relative paths and invalid zones", () => {
  assert.equal(parseConfig(input).owner.handles[0], "owner@example.com");
  for (const bad of [{ ...input, owner: { ...input.owner, handles: [] } },
    { ...input, owner: { ...input.owner, chatGuid: "iMessage;+;group" } },
    { ...input, timezone: "Mars/Olympus" }, { ...input, dataDir: "./data" },
    { ...input, quietHours: { start: 25, end: 8 } }, { ...input, pollMs: 1 }]) assert.throws(() => parseConfig(bad));
  assert.throws(() => requireAssistantUser(parseConfig(input), "ajbarry"), /receipts/);
  assert.doesNotThrow(() => requireAssistantUser(parseConfig(input), "receipts"));
});

test("stdio RPC correlates responses and rejects unknown inbound calls", async t => {
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 500 });
  t.after(() => rpc.close());
  const [a, b] = await Promise.all([rpc.request("echo", { value: 1 }), rpc.request("echo", { value: 2 })]);
  assert.deepEqual(a, { value: 1 }); assert.deepEqual(b, { value: 2 });
  assert.deepEqual(await rpc.request("ask", {}), { rejected: true });
});

test("stdio RPC times out and rejects outstanding requests when child exits", async t => {
  const rpc = new StdioRpc({ command: process.execPath, args: [resolve("test/fixtures/rpc-child.mjs")], timeoutMs: 100 });
  t.after(() => rpc.close());
  await assert.rejects(rpc.request("hang", {}), /timed out/);
  await assert.rejects(rpc.request("exit", {}), /closed/);
});
