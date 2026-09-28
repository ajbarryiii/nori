import assert from "node:assert/strict";
import { test } from "node:test";
import { inQuietHours, isCompound, localDay, parseEngineCommand } from "../src/parser.js";
import { epoch } from "./helpers.js";

test("engine commands are deterministic and need no model", () => {
  assert.deepEqual(parseEngineCommand("pause all"), { kind: "pause", scope: "all" });
  assert.deepEqual(parseEngineCommand("pause"), { kind: "pause", scope: "nudges" });
  assert.deepEqual(parseEngineCommand("resume"), { kind: "resume" });
  assert.deepEqual(parseEngineCommand("what's happening?"), { kind: "status" });
  assert.deepEqual(parseEngineCommand(" STATUS "), { kind: "status" });
  assert.deepEqual(parseEngineCommand("help"), { kind: "help" });
  assert.deepEqual(parseEngineCommand("stop"), { kind: "stop" });
});

test("cancel accepts the plan's short form and the earlier job form", () => {
  assert.deepEqual(parseEngineCommand("cancel #3"), { kind: "cancel", id: 3 });
  assert.deepEqual(parseEngineCommand("cancel job #3"), { kind: "cancel", id: 3 });
  assert.deepEqual(parseEngineCommand("cancel task 3"), { kind: "cancel", id: 3 });
  assert.equal(parseEngineCommand("cancel #0"), null);
  assert.equal(parseEngineCommand("cancel the dentist"), null);
});

test("runtime controls address a job by number", () => {
  assert.deepEqual(parseEngineCommand("approve #3"), { kind: "approve", id: 3 });
  assert.deepEqual(parseEngineCommand("Deny"), { kind: "deny", id: null });
  assert.deepEqual(parseEngineCommand("continue 2"), { kind: "continue", id: 2 });
  assert.deepEqual(parseEngineCommand("#3 use the cheaper one"), { kind: "followUp", id: 3, text: "use the cheaper one" });
  assert.deepEqual(parseEngineCommand("#3: also\nthe garage"), { kind: "followUp", id: 3, text: "also\nthe garage" });
  for (const text of ["#3", "#0 hi", "approve all", "continue working on it"]) assert.equal(parseEngineCommand(text), null, text);
});

test("plugin commands and quoted controls are not engine commands", () => {
  for (const text of ["list", "done #1", "snooze 20m", "note pause all", 'Someone said: "pause all"'])
    assert.equal(parseEngineCommand(text), null, text);
});

test("explicit compound markers keep a second instruction from being truncated", () => {
  for (const text of ["note buy milk; remind me to call in 5 minutes", "remember buy milk\nremind me to call in 5 minutes",
    "note buy milk and also research a laptop", "remind me tomorrow and then email Sam"])
    assert.equal(isCompound(text), true, text);
  assert.equal(isCompound("note buy bread and milk"), false);
});

test("overnight quiet hours respect local time", () => {
  assert.equal(inQuietHours(Date.parse("2026-09-29T05:00:00Z"), "America/Los_Angeles", { start: 22, end: 8 }), true);
  assert.equal(inQuietHours(epoch, "America/Los_Angeles", { start: 22, end: 8 }), false);
  assert.equal(inQuietHours(epoch, "America/Los_Angeles", null), false);
});

test("routing budgets use the configured local calendar day", () => {
  assert.equal(localDay(Date.parse("2026-09-29T05:00:00Z"), "America/Los_Angeles"), "2026-09-28");
  assert.equal(localDay(Date.parse("2026-09-29T08:00:00Z"), "America/Los_Angeles"), "2026-09-29");
});
