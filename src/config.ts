import { isAbsolute } from "node:path";
import { userInfo } from "node:os";
import type { Config } from "./contracts.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> | null { return record(value) ? value : null; }
export function normalizeHandle(value: string): string {
  const handle = value.trim();
  if (/^\+[1-9]\d{6,14}$/.test(handle)) return handle;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle)) return handle.toLowerCase();
  throw new Error("Owner handles must be email addresses or E.164 phone numbers.");
}
export function parseConfig(value: unknown): Config {
  if (!record(value) || !record(value.owner)) throw new Error("Configuration requires an owner.");
  const text = (key: string): string => {
    const v = value[key]; if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${key}.`); return v.trim();
  };
  const assistantUser = text("assistantUser");
  if (!/^[a-z_][a-z0-9_-]*$/i.test(assistantUser) || assistantUser === "root") throw new Error("Invalid assistantUser.");
  const owner = value.owner;
  if (!Array.isArray(owner.handles) || !owner.handles.length || owner.handles.some(x => typeof x !== "string"))
    throw new Error("Configure at least one exact owner handle.");
  const handles = [...new Set((owner.handles as string[]).map(normalizeHandle))];
  if (!Number.isSafeInteger(owner.chatId) || (owner.chatId as number) <= 0) throw new Error("Invalid owner chatId.");
  if (typeof owner.chatGuid !== "string" || !owner.chatGuid.startsWith("iMessage;-;"))
    throw new Error("Configure an iMessage direct-chat GUID.");
  const timezone = text("timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("Invalid IANA timezone."); }
  const dataDir = text("dataDir"); const imsgPath = text("imsgPath");
  if (!isAbsolute(dataDir) || !isAbsolute(imsgPath)) throw new Error("dataDir and imsgPath must be absolute paths.");
  const pollMs = value.pollMs ?? 5000;
  if (!Number.isInteger(pollMs) || (pollMs as number) < 1000 || (pollMs as number) > 60_000)
    throw new Error("pollMs must be between 1000 and 60000.");
  let quietHours: Config["quietHours"] = null;
  if (value.quietHours != null) {
    const q = value.quietHours;
    if (!record(q) || ![q.start, q.end].every(x => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 23)
      || q.start === q.end) throw new Error("quietHours needs distinct start/end hours from 0 to 23.");
    quietHours = { start: q.start as number, end: q.end as number };
  }
  let jev: Config["jev"] = null;
  if (value.jev != null) {
    const j = value.jev;
    if (!record(j) || typeof j.model !== "string" || !j.model.trim() || j.model.endsWith("latest"))
      throw new Error("Pin a versioned Jev model.");
    const timeout = j.timeoutMs ?? 2500;
    if (!Number.isInteger(timeout) || (timeout as number) < 50 || (timeout as number) > 10_000) throw new Error("Invalid Jev timeout.");
    jev = { model: j.model, timeoutMs: timeout as number };
  }
  return { assistantUser, owner: { handles, chatId: owner.chatId as number, chatGuid: owner.chatGuid },
    timezone, dataDir, imsgPath, pollMs: pollMs as number, quietHours, jev };
}

export function requireAssistantUser(config: Config, actual = userInfo().username): void {
  if (actual !== config.assistantUser) throw new Error(`Run this command in the ${config.assistantUser} macOS profile (current: ${actual}).`);
}
