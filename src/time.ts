import { Temporal } from "@js-temporal/polyfill";

/** Time parts a model may name. Code turns them into instants. */
export type When =
  | { kind: "in"; amount: number; unit: "minutes" | "hours" | "days" }
  /** `day` is today, tomorrow, a lowercase weekday, or YYYY-MM-DD. Hour is 0-23 local time. */
  | { kind: "at"; day: string; hour: number; minute: number };

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MAX_AHEAD_MS = 366 * 86_400_000;

const zoned = (at: number, timezone: string) => Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timezone);
const format = (at: number, timezone: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...options }).format(at).replace(/[  ]/g, " ");

/**
 * Turns model-extracted time parts into an instant. Code owns all calendar math; models only name the parts.
 * Returns null for past, nonexistent, ambiguous (DST), or out-of-range times.
 */
export function resolveWhen(when: When, sentAt: number, timezone: string): number | null {
  try {
    let at: number;
    if (when.kind === "in") {
      if (!Number.isSafeInteger(when.amount) || when.amount <= 0) return null;
      at = when.unit === "days"
        ? zoned(sentAt, timezone).toPlainDateTime().add({ days: when.amount }).toZonedDateTime(timezone, { disambiguation: "reject" }).epochMilliseconds
        : sentAt + when.amount * (when.unit === "hours" ? 3_600_000 : 60_000);
    } else {
      const { hour, minute } = when;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
      const on = (date: Temporal.PlainDate) =>
        date.toPlainDateTime({ hour, minute }).toZonedDateTime(timezone, { disambiguation: "reject" }).epochMilliseconds;
      const today = zoned(sentAt, timezone).toPlainDate();
      const day = when.day.trim().toLowerCase();
      if (day === "today") at = on(today);
      else if (day === "tomorrow") at = on(today.add({ days: 1 }));
      else if (WEEKDAYS.includes(day)) {
        let date = today.add({ days: (WEEKDAYS.indexOf(day) + 1 - today.dayOfWeek + 7) % 7 });
        if (on(date) <= sentAt) date = date.add({ days: 7 });
        at = on(date);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(day)) at = on(Temporal.PlainDate.from(day));
      else return null;
    }
    return at > sentAt && at - sentAt <= MAX_AHEAD_MS ? at : null;
  } catch { return null; }
}

/** Local wall-clock time with a plain space, e.g. "9:00 AM". */
export function clockText(at: number, timezone: string): string {
  return format(at, timezone, { hour: "numeric", minute: "2-digit" });
}

/** A long local timestamp that gives models the weekday and date explicitly. */
export function localNow(at: number, timezone: string): string {
  return format(at, timezone, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Human description of `at` relative to `from`, e.g. "tomorrow (Tue, Sep 29) at 10:00 AM". */
export function describeWhen(at: number, from: number, timezone: string): string {
  const target = zoned(at, timezone); const base = zoned(from, timezone);
  const days = base.toPlainDate().until(target.toPlainDate(), { largestUnit: "days" }).days;
  const clock = clockText(at, timezone); const date = format(at, timezone, { month: "short", day: "numeric" });
  const weekday = format(at, timezone, { weekday: "short" });
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow (${weekday}, ${date}) at ${clock}`;
  if (days > 1 && days < 7) return `${format(at, timezone, { weekday: "long" })} (${date}) at ${clock}`;
  return target.year === base.year ? `${weekday}, ${date} at ${clock}` : `${weekday}, ${date}, ${target.year} at ${clock}`;
}

/** True when `text` states the same local clock time as `at` (e.g. "9 AM", "9:00am", "9 a.m."). */
export function mentionsClock(text: string, at: number, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at);
  const part = (type: string) => parts.find(x => x.type === type)?.value ?? "";
  const minutes = part("minute") === "00" ? "(?::00)?" : `:${part("minute")}`;
  const period = part("dayPeriod").toLowerCase().startsWith("a") ? "a" : "p";
  return new RegExp(`(?<![\\d:])${part("hour")}${minutes}\\s?${period}\\.?m\\b`, "i").test(text.replace(/[  ]/g, " "));
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_DAY = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+(\d{1,2})(?!\d)/g;
const NUMERIC_DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g;

/**
 * True when `text` places `at` on the right day: it names that day (today, tomorrow, its weekday, or its date)
 * and names no other day or calendar date. A same-day time may omit the day. Used to reject phrased replies that move
 * a reminder.
 */
export function mentionsDay(text: string, at: number, from: number, timezone: string): boolean {
  const t = text.toLowerCase().replace(/[  ]/g, " ");
  const has = (pattern: string) => new RegExp(`\\b${pattern}(?![\\w])`).test(t);
  const days = zoned(from, timezone).toPlainDate().until(zoned(at, timezone).toPlainDate(), { largestUnit: "days" }).days;
  const weekday = format(at, timezone, { weekday: "long" }).toLowerCase();
  if ((has("today") || has("tonight") || has("this (?:morning|afternoon|evening)")) && days !== 0) return false;
  if (has("tomorrow") && days !== 1) return false;
  if (WEEKDAYS.some(w => w !== weekday && (has(w) || has(w.slice(0, 3))))) return false;
  // Every explicit calendar date must be the target's; one that is counts as naming the day.
  const target = zoned(at, timezone); let dated = false;
  for (const [, month, day] of t.matchAll(MONTH_DAY)) {
    if (MONTHS.findIndex(name => name.startsWith(month!)) + 1 !== target.month || Number(day) !== target.day) return false;
    dated = true;
  }
  for (const [, month, day] of t.matchAll(NUMERIC_DATE)) {
    if (Number(month) !== target.month || Number(day) !== target.day) return false;
    dated = true;
  }
  if (days === 0 || dated) return true;
  const dates = [format(at, timezone, { month: "short", day: "numeric" }), format(at, timezone, { month: "long", day: "numeric" })]
    .map(x => x.toLowerCase().replace(/ /g, "\\.? "));
  return (days === 1 && has("tomorrow")) || has(weekday) || has(weekday.slice(0, 3)) || dates.some(has);
}
