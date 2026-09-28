import { Temporal } from "@js-temporal/polyfill";
import type { Action, Config } from "./contracts.js";

const minute = 60_000;
const clarify = (): Action => ({ kind: "clarify", question: "What exact date and time should I use? Resend the full request, for example: remind me to call tomorrow at 10 am." });

/** A deliberately small, whole-message grammar. Unsupported language remains a complete queued task. */
export function parseAction(input: string, sentAt: number, timezone: string): Action {
  const text = input.trim();
  if (/^(status|list|what(?:'s| is) happening\??)$/i.test(text)) return { kind: "status" };
  if (/^help$/i.test(text)) return { kind: "help" };
  if (/^pause(?: all)?$/i.test(text)) return { kind: "pause", scope: /all$/i.test(text) ? "all" : "nudges" };
  if (/^resume$/i.test(text)) return { kind: "resume" };
  const done = /^(?:done|complete)(?:\s+#?(\d+))?$/i.exec(text);
  if (done && (!done[1] || validId(done[1]))) return { kind: "done", id: done[1] ? Number(done[1]) : null };
  const cancel = /^cancel job\s+#?(\d+)$/i.exec(text);
  if (cancel && validId(cancel[1]!)) return { kind: "cancel", id: Number(cancel[1]) };
  const snooze = /^snooze\s+(?:#(\d+)\s+)?(\d+)\s*(m|min|mins|minute|minutes)$/i.exec(text);
  if (snooze && Number(snooze[2]) > 0 && Number(snooze[2]) <= 10080 && (!snooze[1] || validId(snooze[1])))
    return { kind: "snooze", id: snooze[1] ? Number(snooze[1]) : null, minutes: Number(snooze[2]) };
  // Conservative detection avoids treating a second instruction as part of a task title.
  if (/\b(?:and also|and then|also research|also email|also send)\b|[\r\n;]/i.test(text)) return { kind: "delegate" };
  const note = /^(?:note|remember)\s+(.+)$/is.exec(text);
  if (note?.[1]?.trim()) return { kind: "note", title: note[1].trim() };
  const relative = /^remind me to (.+?) in (\d+)\s*(minutes?|mins?|m|hours?|h|days?|d)$/i.exec(text);
  if (relative) {
    const amount = Number(relative[2]);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10080) return clarify();
    const unit = relative[3]!.toLowerCase();
    try {
      const dueAt = unit.startsWith("d")
        ? Temporal.Instant.fromEpochMilliseconds(sentAt).toZonedDateTimeISO(timezone).toPlainDateTime()
          .add({ days: amount }).toZonedDateTime(timezone, { disambiguation: "reject" }).epochMilliseconds
        : sentAt + amount * (unit.startsWith("h") ? 60 : 1) * minute;
      return { kind: "remind", title: relative[1]!.trim(), dueAt };
    } catch { return clarify(); }
  }
  const absolute = /^remind me to (.+?) (today|tomorrow|on \d{4}-\d{2}-\d{2}) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (absolute) {
    try {
      let hour = Number(absolute[3]); const minutes = Number(absolute[4] ?? 0);
      const meridiem = absolute[5]?.toLowerCase();
      if ((!meridiem && !absolute[4]) || minutes > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return clarify();
      if (meridiem) hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
      const local = Temporal.Instant.fromEpochMilliseconds(sentAt).toZonedDateTimeISO(timezone);
      const day = absolute[2]!.toLowerCase();
      const date = day.startsWith("on ") ? Temporal.PlainDate.from(day.slice(3)) : local.toPlainDate().add({ days: day === "tomorrow" ? 1 : 0 });
      const dueAt = date.toPlainDateTime({ hour, minute: minutes }).toZonedDateTime(timezone, { disambiguation: "reject" }).epochMilliseconds;
      if (dueAt <= sentAt) return clarify();
      return { kind: "remind", title: absolute[1]!.trim(), dueAt };
    } catch { return clarify(); }
  }
  if (/^remind me\b/i.test(text) && !/\band\b/i.test(text)) return clarify();
  return { kind: "delegate" };
}

function validId(text: string): boolean { return Number.isSafeInteger(Number(text)) && Number(text) > 0; }

export function inQuietHours(at: number, timezone: string, quiet: Config["quietHours"]): boolean {
  if (!quiet) return false;
  const hour = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timezone).hour;
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

export function formatTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
}
