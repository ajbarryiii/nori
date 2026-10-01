import assert from "node:assert/strict";
import { test } from "node:test";
import { clockText, describeWhen, localNow, mentionsClock, mentionsDate, mentionsDay, resolveWhen, shortWhen, statesOnly } from "../src/time.js";
import { epoch } from "./helpers.js";

// epoch is Monday, September 28, 2026 at 9:00 AM in America/Los_Angeles.
const tz = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

test("durations resolve from the message time; calendar days reject DST gaps and out-of-range amounts", () => {
  assert.equal(resolveWhen({ kind: "in", amount: 20, unit: "minutes" }, epoch, tz), epoch + 20 * 60_000);
  assert.equal(resolveWhen({ kind: "in", amount: 2, unit: "hours" }, epoch, tz), epoch + 2 * 3_600_000);
  assert.equal(resolveWhen({ kind: "in", amount: 1, unit: "days" }, epoch, tz), at("2026-09-29T16:00:00Z"));
  assert.equal(resolveWhen({ kind: "in", amount: 1, unit: "days" }, at("2027-03-13T10:30:00Z"), tz), null);
  for (const amount of [0, -5, 1.5, 400]) assert.equal(resolveWhen({ kind: "in", amount, unit: "days" }, epoch, tz), null, String(amount));
});

test("clock times resolve named days in the configured zone and must be in the future", () => {
  assert.equal(resolveWhen({ kind: "at", day: "tomorrow", hour: 10, minute: 0 }, epoch, tz), at("2026-09-29T17:00:00Z"));
  assert.equal(resolveWhen({ kind: "at", day: "today", hour: 15, minute: 30 }, epoch, tz), at("2026-09-28T22:30:00Z"));
  assert.equal(resolveWhen({ kind: "at", day: "today", hour: 8, minute: 0 }, epoch, tz), null);
  assert.equal(resolveWhen({ kind: "at", day: "2026-10-01", hour: 14, minute: 0 }, epoch, tz), at("2026-10-01T21:00:00Z"));
  assert.equal(resolveWhen({ kind: "at", day: "friday", hour: 9, minute: 0 }, epoch, tz), at("2026-10-02T16:00:00Z"));
  assert.equal(resolveWhen({ kind: "at", day: "monday", hour: 17, minute: 0 }, epoch, tz), at("2026-09-29T00:00:00Z"));
  assert.equal(resolveWhen({ kind: "at", day: "monday", hour: 8, minute: 0 }, epoch, tz), at("2026-10-05T15:00:00Z"));
  for (const bad of [{ day: "someday", hour: 9, minute: 0 }, { day: "tomorrow", hour: 24, minute: 0 },
    { day: "tomorrow", hour: 9, minute: 60 }, { day: "2026-02-30", hour: 9, minute: 0 },
    { day: "2027-03-14", hour: 2, minute: 30 }, { day: "2026-11-01", hour: 1, minute: 30 },
    { day: "2028-01-01", hour: 9, minute: 0 }])
    assert.equal(resolveWhen({ kind: "at", ...bad }, epoch, tz), null, JSON.stringify(bad));
});

test("descriptions name the day relative to the message and the local clock", () => {
  assert.equal(describeWhen(at("2026-09-28T22:30:00Z"), epoch, tz), "today (Mon, Sep 28) at 3:30 PM");
  assert.equal(describeWhen(at("2026-09-29T17:00:00Z"), epoch, tz), "tomorrow (Tue, Sep 29) at 10:00 AM");
  assert.equal(describeWhen(at("2026-10-02T16:00:00Z"), epoch, tz), "Friday (Oct 2) at 9:00 AM");
  assert.equal(describeWhen(at("2026-11-10T17:00:00Z"), epoch, tz), "Tue, Nov 10 at 9:00 AM");
  assert.equal(describeWhen(at("2027-01-05T17:00:00Z"), epoch, tz), "Tue, Jan 5, 2027 at 9:00 AM");
  assert.equal(clockText(at("2026-09-29T17:00:00Z"), tz), "10:00 AM");
  assert.match(localNow(epoch, tz), /Monday, September 28, 2026/);
});

test("reply checks accept common spellings of the committed clock time only", () => {
  const due = at("2026-09-29T17:00:00Z");
  for (const text of ["at 10:00 AM", "at 10 am", "10am tomorrow", "10:00 AM", "10 a.m."]) assert.ok(mentionsClock(text, due, tz), text);
  for (const text of ["at 11:00 AM", "at 10:00 PM", "at 10:30 AM", "tomorrow morning", "110 am"]) assert.ok(!mentionsClock(text, due, tz), text);
  assert.ok(mentionsClock("3:30 PM", at("2026-09-28T22:30:00Z"), tz));
  assert.ok(!mentionsClock("3 PM", at("2026-09-28T22:30:00Z"), tz));
});

test("reply checks require the right day and reject any other", () => {
  const tomorrow = at("2026-09-29T17:00:00Z"); const wednesday = at("2026-09-30T16:00:00Z"); const today = at("2026-09-28T22:30:00Z");
  for (const text of ["tomorrow at 10 AM", "Tuesday at 10", "Tue, Sep 29 at 10 AM", "on September 29"]) assert.ok(mentionsDay(text, tomorrow, epoch, tz), text);
  for (const text of ["today at 10 AM", "at 10 AM", "Wednesday at 10", "tomorrow, or Friday"]) assert.ok(!mentionsDay(text, tomorrow, epoch, tz), text);
  assert.ok(mentionsDay("Wednesday at 9 AM", wednesday, epoch, tz));
  assert.ok(!mentionsDay("tomorrow at 9 AM", wednesday, epoch, tz));
  assert.ok(mentionsDay("at 3:30 PM", today, epoch, tz));
  assert.ok(!mentionsDay("tomorrow at 3:30 PM", today, epoch, tz));
});

test("reply checks reject an explicit calendar date other than the committed one", () => {
  const today = at("2026-09-28T17:00:00Z"); const tomorrow = at("2026-09-29T16:00:00Z");
  for (const text of ["September 30 at 10 AM", "Sep 30 at 10 AM", "on 9/30 at 10 AM"]) assert.ok(!mentionsDay(text, today, epoch, tz), text);
  for (const text of ["Tuesday, October 6 at 9 AM", "Tue, Oct. 6 at 9 AM", "tomorrow (Sept 30) at 9 AM"]) assert.ok(!mentionsDay(text, tomorrow, epoch, tz), text);
  for (const text of ["Tuesday, Sep 29 at 9 AM", "tomorrow, September 29, at 9 AM", "9/29 at 9 AM"]) assert.ok(mentionsDay(text, tomorrow, epoch, tz), text);
  assert.ok(mentionsDay("today, Sep 28, at 10 AM", today, epoch, tz));
});

test("durable replies must name the calendar date; absolute descriptions read the same on any day", () => {
  const tuesday = at("2026-09-29T16:00:00Z");
  for (const text of ["Tue, Sep 29 at 9 AM", "on September 29 at 9", "9/29 at 9 AM"]) assert.ok(mentionsDate(text, tuesday, tz), text);
  for (const text of ["tomorrow at 9 AM", "Tuesday at 9 AM", "Sep 30 at 9 AM", "Sep 29 or Sep 30"]) assert.ok(!mentionsDate(text, tuesday, tz), text);
  assert.equal(shortWhen(tuesday, epoch, tz), "Tue, Sep 29 at 9:00 AM");
  assert.equal(shortWhen(at("2027-01-05T17:00:00Z"), epoch, tz), "Tue, Jan 5, 2027 at 9:00 AM");
});

test("an explicit year must be the reminder's, and a reminder in another year needs one", () => {
  const nextYear = at("2027-01-05T17:00:00Z");
  for (const text of ["Tue, Jan 5, 2027 at 9 AM", "January 5 2027 at 9", "1/5/2027 at 9 AM"])
    assert.ok(mentionsDate(text, nextYear, tz, epoch), text);
  for (const text of ["Jan 5, 2026 at 9 AM", "1/5/2026 at 9 AM", "Jan 5 at 9 AM"]) assert.ok(!mentionsDate(text, nextYear, tz, epoch), text);
  assert.ok(mentionsDate("Jan 5 at 9 AM", nextYear, tz, at("2027-01-01T17:00:00Z")));
  assert.ok(!mentionsDay("Jan 5, 2026 at 9 AM", nextYear, epoch, tz));
  assert.ok(mentionsDate("Sep 29, 2026 at 9 AM", at("2026-09-29T16:00:00Z"), tz, epoch));
  assert.ok(!mentionsDate("Sep 29, 2027 at 9 AM", at("2026-09-29T16:00:00Z"), tz, epoch));
});

test("a weekday whose time already passed today means next week, even across a DST change today", () => {
  // Sunday, November 1, 2026 at noon: 1:30 AM fell in today's repeated hour. Next Sunday is a normal day.
  assert.equal(resolveWhen({ kind: "at", day: "sunday", hour: 1, minute: 30 }, at("2026-11-01T20:00:00Z"), tz), at("2026-11-08T09:30:00Z"));
  // Sunday, March 14, 2027 at noon: 2:30 AM did not exist today.
  assert.equal(resolveWhen({ kind: "at", day: "sunday", hour: 2, minute: 30 }, at("2027-03-14T19:00:00Z"), tz), at("2027-03-21T09:30:00Z"));
  // A gap or repeat on the target date itself is still refused.
  assert.equal(resolveWhen({ kind: "at", day: "sunday", hour: 1, minute: 30 }, at("2026-10-28T20:00:00Z"), tz), null);
});

test("only committed times, dates, and weekdays may be stated, in any common form", () => {
  const due = at("2026-10-15T19:00:00Z"); // Thursday, October 15, 2026 at noon
  for (const text of ["Thu, Oct 15 at 12 PM", "October 15, 2026 at noon", "on 2026-10-15 at 12:00", "Thursday at 12 p.m."])
    assert.ok(statesOnly(text, [due], tz), text);
  for (const text of ["on 2026-10-16", "at midnight", "at 1 PM", "Friday", "Oct 15, 2027", "13:30"]) assert.ok(!statesOnly(text, [due], tz), text);
  assert.ok(statesOnly("No times here.", [], tz));
  assert.ok(!statesOnly("See you at noon.", [], tz));
});
