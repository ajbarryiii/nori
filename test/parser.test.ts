import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAction, inQuietHours } from "../src/parser.js";
import { epoch } from "./helpers.js";

const parse = (text: string, at = epoch) => parseAction(text, at, "America/Los_Angeles");

test("simple controls avoid model routing", () => {
  assert.deepEqual(parse(" DONE #12 "), { kind: "done", id: 12 });
  assert.deepEqual(parse("snooze 20 minutes"), { kind: "snooze", id: null, minutes: 20 });
  assert.deepEqual(parse("snooze #2 10m"), { kind: "snooze", id: 2, minutes: 10 });
  assert.deepEqual(parse("pause all"), { kind: "pause", scope: "all" });
  assert.deepEqual(parse("pause"), { kind: "pause", scope: "nudges" });
  assert.deepEqual(parse("resume"), { kind: "resume" });
  assert.deepEqual(parse("what's happening?"), { kind: "status" });
});

test("relative reminders use original message time, not catch-up time", () => {
  assert.deepEqual(parse("remind me to stretch in 20 minutes"),
    { kind: "remind", title: "stretch", dueAt: epoch + 20 * 60_000 });
});

test("calendar reminders resolve in the configured timezone", () => {
  assert.deepEqual(parse("Remind me to call the dentist tomorrow at 10 am"),
    { kind: "remind", title: "call the dentist", dueAt: Date.parse("2026-09-29T17:00:00Z") });
  assert.deepEqual(parse("remind me to stretch on 2026-10-01 at 14:00"),
    { kind: "remind", title: "stretch", dueAt: Date.parse("2026-10-01T21:00:00Z") });
});

test("nonexistent and ambiguous DST times require clarification", () => {
  assert.equal(parse("remind me to leave on 2027-03-14 at 2:30 am").kind, "clarify");
  assert.equal(parse("remind me to leave on 2026-11-01 at 1:30 am").kind, "clarify");
});

test("calendar-day offsets do not silently move a reminder through a DST gap or fold", () => {
  assert.equal(parse("remind me to leave in 1 day", Date.parse("2027-03-13T10:30:00Z")).kind, "clarify");
  assert.equal(parse("remind me to leave in 1 day", Date.parse("2026-10-31T08:30:00Z")).kind, "clarify");
});

test("clarification demonstrates a supported complete replacement command", () => {
  const action = parse("remind me to call tomorrow at 10");
  assert.equal(action.kind, "clarify");
  if (action.kind === "clarify") assert.match(action.question, /remind me to .* tomorrow at 10 am/);
});

test("unclear times and invalid dates do not silently become reminders", () => {
  for (const text of ["remind me to call tomorrow at 10", "remind me to call on 2026-02-30 at 10 am",
    "remind me to call in 0 minutes", "remind me to call tomorrow at 25:00"])
    assert.equal(parse(text).kind, "clarify", text);
});

test("mixed requests and quoted instructions are delegated intact", () => {
  for (const text of ['remind me tomorrow and also research a replacement',
    'remind me to call tomorrow at 10 am and also email Sam',
    'Someone said: "pause all"', 'find return instructions for this order'])
    assert.deepEqual(parse(text), { kind: "delegate" });
});

test("overnight quiet hours respect local time", () => {
  assert.equal(inQuietHours(Date.parse("2026-09-29T05:00:00Z"), "America/Los_Angeles", { start: 22, end: 8 }), true);
  assert.equal(inQuietHours(epoch, "America/Los_Angeles", { start: 22, end: 8 }), false);
  assert.equal(inQuietHours(epoch, "America/Los_Angeles", null), false);
});

test("compound note and remember requests are delegated intact", () => {
  for (const text of ["note buy milk; remind me to call in 5 minutes",
    "remember buy milk\nremind me to call in 5 minutes",
    "note buy milk and also research a laptop"])
    assert.deepEqual(parse(text), { kind: "delegate" }, text);
  assert.deepEqual(parse("note buy bread and milk"), { kind: "note", title: "buy bread and milk" });
});
