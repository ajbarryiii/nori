import { Temporal } from "@js-temporal/polyfill";
import type { ActionPlugin, Clarification, Command, MessageContext, PluginContext } from "../contracts.js";
import { object as record } from "../config.js";
import { formatTime, validId } from "../parser.js";
import { describeWhen, resolveWhen, type When } from "../time.js";

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

type Missing = "time" | "task" | "which_task";
/** A decoded extraction. Never executed directly: code resolves it into a command or a question. */
export interface Proposal {
  action: "remind" | "note" | "done" | "snooze" | "list" | "none";
  title: string | null;
  taskId: number | null;
  when: When | null;
  snoozeMinutes: number | null;
  missing: Missing[];
}
const ACTIONS: readonly Proposal["action"][] = ["remind", "note", "done", "snooze", "list", "none"];
const MISSING: readonly Missing[] = ["time", "task", "which_task"];
const MAX_TITLE = 200;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["action", "title", "task_id", "when", "snooze_minutes", "missing"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    title: nullable({ type: "string" }),
    task_id: nullable({ type: "integer" }),
    when: nullable({ type: "object", additionalProperties: false, required: ["kind", "amount", "unit", "day", "hour", "minute"],
      properties: { kind: { type: "string", enum: ["in", "at"] }, amount: nullable({ type: "integer" }),
        unit: nullable({ type: "string", enum: ["minutes", "hours", "days"] }), day: nullable({ type: "string" }),
        hour: nullable({ type: "integer" }), minute: nullable({ type: "integer" }) } }),
    snooze_minutes: nullable({ type: "integer" }),
    missing: { type: "array", items: { type: "string", enum: MISSING } },
  },
};
const INSTRUCTIONS = [
  "Extract the one reminder action the person wants into the JSON fields below. Code checks every value, so leave a field null rather than guess.",
  "- action: remind, note, done, snooze, or list; none if it is none of these.",
  "- title: the task in the person's own words, without the time and without \"remind me to\". Null if not stated.",
  "- when: when to remind, or until when to snooze.",
  "  - For a duration (\"in 20 minutes\"), use kind \"in\" with amount and unit (minutes, hours, days).",
  "  - For a clock time, use kind \"at\" with day, hour (0-23), and minute. day is today, tomorrow, a lowercase weekday name, or YYYY-MM-DD. Name the weekday instead of working out its date.",
  "  - For vague times, pick a sensible time: morning 9:00, noon or lunch 12:00, afternoon 15:00, evening 18:00, tonight 20:00. If an hour has no am or pm, pick the reading that makes sense and comes next (at 5 usually means 17:00).",
  "  - Null if no time is given, and add \"time\" to missing.",
  "- task_id: the number of the existing reminder the person means, for done or snooze. Use the conversation for words like it, that, or the dentist one. Null if unsure, and add \"which_task\" to missing.",
  "- snooze_minutes: a snooze given as a duration, in minutes.",
  "- missing: what Nori would need to ask. Empty if nothing is missing.",
  "If Nori just asked a question in the conversation, the message is probably the answer to it: combine them.",
  "<data> lists the person's active reminders and notes by number.",
].join("\n");
const QUESTIONS: Record<Missing, string> = { which_task: "Which reminder do you mean? Tell me its number, or say ‘list’ to see them.",
  task: "What should I remind you about?", time: "When should I remind you?" };
const UNSURE = { clarify: "I couldn't tell which reminder action you meant. Try ‘remind me to call tomorrow at 10 am’, ‘note buy milk’, ‘done #1’, or ‘snooze #1 20m’." };

const reference = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;

/** Strict decoding of the extraction schema. Wrong shapes fail; out-of-range references become null. */
export function decodeProposal(value: unknown): Proposal | null {
  const v = record(value);
  // Absent optional fields read as empty (some providers relax strict mode); present fields must be well typed.
  if (!v || !ACTIONS.includes(v.action as Proposal["action"]) || (v.missing != null && !Array.isArray(v.missing))) return null;
  if (v.title != null && typeof v.title !== "string") return null;
  const missing: unknown[] = Array.isArray(v.missing) ? v.missing : [];
  let when: When | null = null;
  const w = record(v.when);
  if (w?.kind === "in" && Number.isSafeInteger(w.amount) && ["minutes", "hours", "days"].includes(String(w.unit)))
    when = { kind: "in", amount: w.amount as number, unit: w.unit as "minutes" | "hours" | "days" };
  else if (w?.kind === "at" && typeof w.day === "string" && Number.isInteger(w.hour))
    when = { kind: "at", day: w.day.trim().toLowerCase(), hour: w.hour as number, minute: Number.isInteger(w.minute) ? w.minute as number : 0 };
  return { action: v.action as Proposal["action"], title: typeof v.title === "string" && v.title.trim() ? v.title.trim() : null,
    taskId: reference(v.task_id), when, snoozeMinutes: Number.isSafeInteger(v.snooze_minutes) ? v.snooze_minutes as number : null,
    missing: [...new Set(missing.filter((x): x is Missing => MISSING.includes(x as Missing)))] };
}

/** Validates a proposal against the contact's reminders. Only the returned command can run. */
function resolveProposal(proposal: Proposal, ctx: PluginContext): Command | Clarification {
  const ask = (missing: Missing): Clarification => ({ clarify: QUESTIONS[missing] });
  const first = (["which_task", "task", "time"] as const).find(x => proposal.missing.includes(x));
  if (first) return ask(first);
  const title = proposal.title && proposal.title.length <= MAX_TITLE ? proposal.title : null;
  switch (proposal.action) {
    case "none": return { clarify: "I couldn't tell what you'd like me to do with your reminders. Could you say it another way?" };
    case "list": return { kind: "list" };
    case "note": return title ? { kind: "note", title } : { clarify: "What should I save?" };
    case "remind": {
      if (!title) return ask("task");
      const dueAt = proposal.when ? resolveWhen(proposal.when, ctx.time, ctx.timezone) : null;
      return dueAt === null ? ask("time") : { kind: "remind", title, dueAt };
    }
    case "done": case "snooze": {
      const reminder = target(ctx, proposal.taskId);
      if (!reminder) return ask("which_task");
      if (proposal.action === "done") return { kind: "done", id: reminder.id };
      let minutes = proposal.snoozeMinutes;
      if (proposal.when) {
        const at = resolveWhen(proposal.when, ctx.time, ctx.timezone);
        minutes = at === null ? null : Math.ceil((at - ctx.time) / minute);
      }
      if (minutes === null || !Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 10080) return { clarify: "When should I remind you again?" };
      return { kind: "snooze", id: reminder.id, minutes };
    }
  }
}

/**
 * Names the reminder an implicit `done` or `snooze` means, so the command cannot change target between the contact's
 * confirmation and the commit. Without exactly one active reminder it asks which.
 */
function bind(command: Command, ctx: PluginContext): Command | Clarification {
  if ((command.kind !== "done" && command.kind !== "snooze") || command.id !== null) return command;
  const candidates = active(ctx);
  return candidates.length === 1 ? { ...command, id: candidates[0]!.id } : { clarify: QUESTIONS.which_task };
}

/** The contact's active reminders and notes, for extraction. */
function lines(ctx: PluginContext): string {
  const items = active(ctx).slice(0, 30);
  return items.length ? items.map(x => `#${x.id} ${x.title.length > 120 ? `${x.title.slice(0, 119)}…` : x.title} (${x.nextAt === null ? "note"
    : `reminder ${describeWhen(x.nextAt, ctx.time, ctx.timezone)}`})`).join("\n") : "none";
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
    criteria: "One reminder or note to save, or one completion, snooze, or list request about this contact's saved reminders. Includes answering Nori's question about one of these, or confirming one Nori suggested.",
    examples: ["note buy milk", "remind me to call tomorrow at 10 am", "list", "done #1", "snooze #1 20m"],
    label: "save or change a reminder",
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
  /**
   * Accepts polite phrasing around the same grammar. With the responder, anything else is extracted and resolved by code;
   * without it, anything else becomes one focused question.
   */
  async interpret(text, ctx) {
    let core = text.trim().replace(/[.!?]+$/, "").trim();
    for (let previous = ""; previous !== core;) {
      previous = core;
      core = core.replace(/^(?:please|pls|can you|could you|would you|will you)[\s,]+/i, "").replace(/[\s,]+(?:please|thanks|thank you)$/i, "").trim();
    }
    const direct = match(core, ctx);
    if (direct && !("clarify" in direct)) return bind(direct, ctx);
    if (!ctx.extract) return direct ?? UNSURE;
    const proposal = decodeProposal(await ctx.extract({ instructions: INSTRUCTIONS, schema: EXTRACT_SCHEMA, data: lines(ctx) }));
    return proposal && resolveProposal(proposal, ctx);
  },
  describe(command, ctx) {
    const when = (at: number) => describeWhen(at, ctx.time, ctx.timezone);
    switch (command.kind) {
      case "remind": return { description: `remind you about “${String(command.title)}” ${when(command.dueAt as number)}`, times: [command.dueAt as number] };
      case "note": return { description: `save the note “${String(command.title)}”`, times: [] };
      case "done": case "snooze": {
        const reminder = target(ctx, command.id as number | null);
        if (!reminder) return { description: "ask which reminder you mean", times: [] };
        if (command.kind === "done") return { description: `mark #${reminder.id} “${reminder.title}” as done`, times: [] };
        const nextAt = ctx.time + (command.minutes as number) * minute;
        return { description: `snooze #${reminder.id} “${reminder.title}” until ${when(nextAt)}`, times: [nextAt] };
      }
      default: return { description: "show your active reminders", times: [] };
    }
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
        // Titles are shortened and the list capped so it always fits in one message.
        const items = active(ctx); const lines = [`${items.length} active tasks:`]; let shown = 0;
        for (const item of items.slice(0, 10)) {
          const line = `#${item.id}: ${item.title.length > 150 ? `${item.title.slice(0, 149)}…` : item.title}`;
          if (lines.join("\n").length + line.length > 1800) break;
          lines.push(line); shown++;
        }
        if (items.length > shown) lines.push(`Plus ${items.length - shown} more.`);
        ctx.reply(items.length ? lines.join("\n") : "No active tasks.");
      }
    }
  },
  onTimer(timer, ctx) {
    const reminderId = (timer.payload as { id: number }).id;
    const reminder = ctx.state.get<Reminder>(`reminder:${reminderId}`);
    if (reminder?.status !== "active") return;
    const delayed = ctx.time - timer.at > 5 * minute ? " (catching up after a delay)" : "";
    ctx.reply(ctx.conversational ? `Reminder: ${reminder.title} (#${reminder.id})${delayed}. Tell me when it's done, or ask me to snooze it.`
      : `Reminder #${reminder.id}${delayed}: ${reminder.title}. Reply ‘done #${reminder.id}’ or ‘snooze #${reminder.id} 20m’.`);
  },
  summary(ctx) {
    const items = active(ctx);
    return [`${items.length} active tasks.`, ...items.slice(0, 5).map(x => `#${x.id}: ${x.title}`),
      ...(items.length > 5 ? [`Plus ${items.length - 5} more tasks.`] : [])];
  },
};
