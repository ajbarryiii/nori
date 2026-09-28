import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { config } from "./helpers.js";

const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], { encoding: "utf8", timeout: 10_000 });
test("demo completes a synthetic reminder and retains complex work without personal configuration", () => {
  const result = run("demo"); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved locally #1/); assert.match(result.stdout, /Reminder #1/);
  assert.match(result.stdout, /Completed #1/); assert.match(result.stdout, /queued/);
  assert.match(result.stdout, /No messages or model requests/);
});
test("all live commands reject the wrong profile before launching an adapter", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-cli-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json"); const expected = userInfo().username === "receipts" ? "nori-test-other" : "receipts";
  writeFileSync(path, JSON.stringify({ ...config, assistantUser: expected, imsgPath: "/nonexistent/imsg" }));
  for (const command of ["doctor", "enroll", "status", "probe-codex", "run"]) {
    const result = run(command, "--config", path); assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Run this command in the ${expected} macOS profile`));
  }
});
