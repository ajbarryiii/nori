import { Temporal } from "@js-temporal/polyfill";
import type { ActionPlugin, Clarification, Command, MessageContext, PluginContext } from "../contracts.js";
import { formatTime, validId } from "../parser.js";

/** A reminder or note, stored per contact. The engine timer keyed `reminder:<id>` owns delivery. */
export interface Reminder {
  id: number;
  title: string;
  dueAt: number | null;
  nextAt: number | null;
  status: "active" | "completed";
}

const minute = 60_000;
const clarify = (): Clarification => ({ clarify: "What exact date and time should I use? Resend the full request, for example: remind me to call tomorrow at 10 am." });
const id = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, nullable: true,
  description: "Reminder number, or null when the person has exactly one active reminder." } as const;
const title = { type: "string", maxLength: 4000, description: "What to remember, in the person's words." } as const;

/** A deliberately small, whole-message grammar. Unsupported language is left to the engine. */
function match(input: string, { time: sentAt, timezone }: MessageContext): Command | Clarification | null {
  const text = input.trim();
  if (/^list$/i.test(text)) return { kind: "list" };
  const done = /^(?:done|complete)(?:\s+#?(\d+))?$/i.exec(text);
  if (done && (!done[1] || validId(done[1]))) return { kind: "done", id: done[1] ? Number(done[1]) : null };
  const snooze = /^snooze\s+(?:#(\d+)\s+)?(\d+)\s*(m|min|mins|minute|minutes)$/i.exec(text);
  if (snooze && Number(snooze[2]) > 0 && Number(snooze[2]) <= 10080 && (!snooze[1] || validId(snooze[1])))
    return { kind: "snooze", id: snooze[1] ? Number(snooze[1]) : null, minutes: Number(snooze[2]) };
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
  return null;
}

function active(ctx: PluginContext): Reminder[] {
  return ctx.state.list<Reminder>("reminder:").filter(x => x.status === "active");
}

function target(ctx: PluginContext, reminderId: number | null): Reminder | null {
  const candidates = active(ctx);
  return reminderId !== null ? candidates.find(x => x.id === reminderId) ?? null : candidates.length === 1 ? candidates[0]! : null;
}

export const reminders: ActionPlugin = {
  manifest: {
    id: "reminders", version: "1.0.0", stateVersion: 1, capabilities: ["storage", "schedule"], roles: ["owner", "member"],
    criteria: "One reminder or note to save, or one completion, snooze, or list request about this contact's saved reminders.",
    examples: ["note buy milk", "remind me to call tomorrow at 10 am", "list", "done #1", "snooze #1 20m"],
  },
  schema: {
    remind: { title, dueAt: { type: "integer", minimum: 0, maximum: 8_640_000_000_000_000, description: "When to send the reminder, in Unix epoch milliseconds." } },
    note: { title },
    done: { id },
    snooze: { id, minutes: { type: "integer", minimum: 1, maximum: 10080, description: "Minutes from now until the reminder is sent again." } },
    list: {},
  },
  tools: [
    { kind: "remind", description: "Save a reminder for this person and send it to them over iMessage at a set time.", impact: "low" },
    { kind: "note", description: "Save a note or task for this person without a reminder time.", impact: "low" },
    { kind: "list", description: "List this person's active reminders and notes with their numbers.", impact: "low" },
    { kind: "done", description: "Mark one of this person's reminders complete.", impact: "low" },
    { kind: "snooze", description: "Send one of this person's reminders again after a delay. The original deadline is kept.", impact: "low" },
  ],
  migrate: () => {},
  match,
  /** Accepts polite phrasing around the same grammar; anything else becomes one focused question. */
  async interpret(text, ctx) {
    let core = text.trim().replace(/[.!?]+$/, "").trim();
    for (let previous = ""; previous !== core;) {
      previous = core;
      core = core.replace(/^(?:please|pls|can you|could you|would you|will you)[\s,]+/i, "").replace(/[\s,]+(?:please|thanks|thank you)$/i, "").trim();
    }
    return match(core, ctx) ?? { clarify: "I couldn't tell which reminder action you meant. Try ‘remind me to call tomorrow at 10 am’, ‘note buy milk’, ‘done #1’, or ‘snooze #1 20m’." };
  },
  handle(command, ctx) {
    switch (command.kind) {
      case "remind": case "note": {
        const reminderId = ctx.state.nextId("reminder");
        const due = command.kind === "remind" ? command.dueAt as number : null;
        const reminder: Reminder = { id: reminderId, title: command.title as string, dueAt: due, nextAt: due, status: "active" };
        ctx.state.set(`reminder:${reminderId}`, reminder);
        if (due !== null) ctx.schedule(`reminder:${reminderId}`, due, { id: reminderId });
        ctx.reply(`Saved locally #${reminderId}: ${reminder.title}.${due !== null ? ` I'll remind you ${formatTime(due, ctx.timezone)}.` : ""}`);
        return;
      }
      case "done": case "snooze": {
        const reminder = target(ctx, command.id as number | null);
        if (!reminder) { ctx.reply("Which reminder? Reply ‘done #1’ or ‘snooze #1 20m’ with its number. ‘List’ shows your tasks."); return; }
        if (command.kind === "done") {
          ctx.state.set(`reminder:${reminder.id}`, { ...reminder, status: "completed", nextAt: null });
          ctx.cancelTimer(`reminder:${reminder.id}`);
          ctx.reply(`Completed #${reminder.id}: ${reminder.title}.`);
          return;
        }
        // Snooze offsets use the command's timestamp, and the original deadline stays unchanged.
        const nextAt = ctx.time + (command.minutes as number) * minute;
        ctx.state.set(`reminder:${reminder.id}`, { ...reminder, nextAt });
        ctx.schedule(`reminder:${reminder.id}`, nextAt, { id: reminder.id });
        ctx.reply(`Snoozed #${reminder.id} until ${formatTime(nextAt, ctx.timezone)}. Its original deadline is unchanged.`);
        return;
      }
      case "list": {
        const items = active(ctx);
        ctx.reply(items.length ? [`${items.length} active tasks:`, ...items.slice(0, 10).map(x => `#${x.id}: ${x.title}`),
          ...(items.length > 10 ? [`Plus ${items.length - 10} more.`] : [])].join("\n") : "No active tasks.");
      }
    }
  },
  onTimer(timer, ctx) {
    const reminderId = (timer.payload as { id: number }).id;
    const reminder = ctx.state.get<Reminder>(`reminder:${reminderId}`);
    if (reminder?.status !== "active") return;
    const delayed = ctx.time - timer.at > 5 * minute ? " (catching up after a delay)" : "";
    ctx.reply(`Reminder #${reminder.id}${delayed}: ${reminder.title}. Reply ‘done #${reminder.id}’ or ‘snooze #${reminder.id} 20m’.`);
  },
  summary(ctx) {
    const items = active(ctx);
    return [`${items.length} active tasks.`, ...items.slice(0, 5).map(x => `#${x.id}: ${x.title}`),
      ...(items.length > 5 ? [`Plus ${items.length - 5} more tasks.`] : [])];
  },
};
