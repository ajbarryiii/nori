import { Temporal } from "@js-temporal/polyfill";
import type { Config } from "./contracts.js";

export type EngineCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "pause"; scope: "nudges" | "all" }
  | { kind: "resume" }
  | { kind: "cancel"; id: number }
  | { kind: "stop" }
  /** `id` may be omitted when exactly one job is waiting on that decision. */
  | { kind: "approve" | "deny"; id: number | null }
  | { kind: "continue"; id: number | null }
  /** Input for an open job: `#3 use the cheaper one`. */
  | { kind: "followUp"; id: number; text: string };

/** Engine commands are whole-message, deterministic, and available when model services are down. */
export function parseEngineCommand(input: string): EngineCommand | null {
  const text = input.trim();
  if (/^(status|what(?:'s| is) happening\??)$/i.test(text)) return { kind: "status" };
  if (/^help$/i.test(text)) return { kind: "help" };
  if (/^pause(?: all)?$/i.test(text)) return { kind: "pause", scope: /all$/i.test(text) ? "all" : "nudges" };
  if (/^resume$/i.test(text)) return { kind: "resume" };
  if (/^stop$/i.test(text)) return { kind: "stop" };
  const cancel = /^cancel(?: job| task)?\s+#?(\d+)$/i.exec(text);
  if (cancel && validId(cancel[1]!)) return { kind: "cancel", id: Number(cancel[1]) };
  const decide = /^(approve|deny|continue)(?:\s+#?(\d+))?$/i.exec(text);
  if (decide && (!decide[2] || validId(decide[2])))
    return { kind: decide[1]!.toLowerCase() as "approve" | "deny" | "continue", id: decide[2] ? Number(decide[2]) : null };
  const followUp = /^#(\d+)[:,]?\s+(\S[\s\S]*)$/.exec(text);
  if (followUp && validId(followUp[1]!)) return { kind: "followUp", id: Number(followUp[1]), text: followUp[2]!.trim() };
  return null;
}

/** Conservative detection keeps a second instruction from being truncated into a simpler action. */
export function isCompound(text: string): boolean {
  return /\b(?:and also|and then|also research|also email|also send)\b|[\r\n;]/i.test(text);
}

export function validId(text: string): boolean { return Number.isSafeInteger(Number(text)) && Number(text) > 0; }

export function inQuietHours(at: number, timezone: string, quiet: Config["quietHours"]): boolean {
  if (!quiet) return false;
  const hour = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timezone).hour;
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

export function localDay(at: number, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

export function formatTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
}
