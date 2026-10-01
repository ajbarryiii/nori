import { isAbsolute, join } from "node:path";
import { userInfo } from "node:os";
import type { Config, Contact, Thresholds } from "./contracts.js";

/** The development console's only contact. Its handle and conversation can never match a real iMessage chat. */
export const CONSOLE_CONTACT: Contact = Object.freeze({ id: "console", name: "Console", handles: Object.freeze(["console@nori.invalid"]),
  conversation: Object.freeze({ chatId: 1, chatGuid: "iMessage;-;console@nori.invalid" }), role: "owner", plugins: Object.freeze(["reminders"]) });

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> | null { return record(value) ? value : null; }
export function normalizeHandle(value: string): string {
  const handle = value.trim();
  if (/^\+[1-9]\d{6,14}$/.test(handle)) return handle;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle)) return handle.toLowerCase();
  throw new Error("Contact handles must be email addresses or E.164 phone numbers.");
}

function parseContact(value: unknown, index: number): Contact {
  if (!record(value)) throw new Error(`Contact ${index + 1} must be an object.`);
  const id = value.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error(`Contact ${index + 1} needs a lowercase id such as "owner".`);
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 64) throw new Error(`Contact ${id} needs a name.`);
  if (!Array.isArray(value.handles) || !value.handles.length || value.handles.some(x => typeof x !== "string"))
    throw new Error(`Configure at least one exact handle for contact ${id}.`);
  const handles = [...new Set((value.handles as string[]).map(normalizeHandle))];
  const chat = value.conversation;
  if (!record(chat) || !Number.isSafeInteger(chat.chatId) || (chat.chatId as number) <= 0) throw new Error(`Invalid chatId for contact ${id}.`);
  // Direct chats only (`;-;`). Newer macOS versions name them `any;-;…` instead of `iMessage;-;…`.
  if (typeof chat.chatGuid !== "string" || !/^(?:iMessage|any);-;\S+$/.test(chat.chatGuid))
    throw new Error(`Configure an iMessage direct-chat GUID for contact ${id}.`);
  if (value.role !== "owner" && value.role !== "member") throw new Error(`Contact ${id} needs role "owner" or "member".`);
  if (!Array.isArray(value.plugins) || value.plugins.some(x => typeof x !== "string"))
    throw new Error(`Contact ${id} needs a plugins allowlist, for example ["reminders"].`);
  return { id, name: value.name.trim(), handles, conversation: { chatId: chat.chatId as number, chatGuid: chat.chatGuid },
    role: value.role, plugins: [...new Set(value.plugins as string[])] };
}

/** Groups stay rejected: every contact has exactly one direct conversation, and nothing is shared between contacts. */
function parseContacts(value: unknown): Contact[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error("Configuration requires at least one approved contact in contacts; see nori.config.example.json.");
  const contacts = value.map(parseContact);
  const unique = (label: string, keys: Array<string | number>) => {
    if (new Set(keys).size !== keys.length) throw new Error(`Each contact needs its own ${label}.`);
  };
  unique("id", contacts.map(c => c.id));
  unique("handle", contacts.flatMap(c => c.handles));
  unique("conversation", contacts.map(c => c.conversation.chatId));
  unique("conversation", contacts.map(c => c.conversation.chatGuid));
  if (contacts.filter(c => c.role === "owner").length !== 1) throw new Error("Configure exactly one owner contact.");
  return contacts;
}

function parseJev(value: unknown): Config["jev"] {
  if (value == null) return null;
  if (!record(value) || typeof value.model !== "string" || !value.model.trim() || value.model.endsWith("latest"))
    throw new Error("Pin a versioned Jev model.");
  const timeoutMs = value.timeoutMs ?? 2500;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 50 || (timeoutMs as number) > 10_000) throw new Error("Invalid Jev timeout.");
  const dailyLimit = value.dailyLimit ?? 100;
  if (!Number.isInteger(dailyLimit) || (dailyLimit as number) < 1 || (dailyLimit as number) > 10_000)
    throw new Error("Jev dailyLimit must be between 1 and 10000.");
  const routes = value.routes ?? {};
  if (!record(routes) || Object.values(routes).some(x => typeof x !== "number" || !(x > 0 && x <= 1)))
    throw new Error("Jev routes map plugin ids to confidence thresholds above 0 and at most 1.");
  return { model: value.model, timeoutMs: timeoutMs as number, dailyLimit: dailyLimit as number,
    routes: Object.fromEntries(Object.entries(routes) as Array<[string, number]>), thresholds: parseThresholds(value.thresholds) };
}

function parseThresholds(value: unknown): Thresholds {
  const t = value ?? {};
  if (!record(t)) throw new Error("Jev thresholds must be an object.");
  const [act, clarify, verify] = [t.act ?? 0.8, t.clarify ?? 0.5, t.verify ?? 0.6];
  const unit = (x: unknown): x is number => typeof x === "number" && x > 0 && x < 1;
  if (!unit(act) || !unit(clarify) || !unit(verify) || clarify > act) throw new Error("Jev thresholds need 0 < clarify <= act < 1 and 0 < verify < 1.");
  return { act, clarify, verify };
}

/** The responder needs Jev, because Jev decides what a message is before any extraction or phrasing. */
function parseResponder(value: unknown, jev: Config["jev"], runtime: Config["runtime"]): Config["responder"] {
  if (value == null) return null;
  if (!record(value)) throw new Error("responder must be an object.");
  if (!jev) throw new Error("Conversational replies need Jev. Configure jev as well as responder.");
  if (value.provider !== "openrouter" && value.provider !== "codex") throw new Error("responder.provider must be openrouter or codex.");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model || model.length > 100 || model.endsWith("latest") || model.startsWith("openrouter/"))
    throw new Error("Pin a specific responder model; routers and latest aliases are not allowed.");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const n = value[key] ?? fallback;
    if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`responder.${key} must be an integer between ${min} and ${max}.`);
    return n as number;
  };
  const timeoutMs = integer("timeoutMs", value.provider === "codex" ? 90_000 : 20_000, 1_000, 180_000);
  const dailyLimit = integer("dailyLimit", 300, 1, 10_000);
  if (value.provider === "openrouter") return { provider: "openrouter", model, timeoutMs, dailyLimit };
  const codexPath = value.codexPath ?? runtime?.codexPath;
  if (typeof codexPath !== "string" || !isAbsolute(codexPath)) throw new Error("responder.codexPath must be an absolute path.");
  return { provider: "codex", model, timeoutMs, dailyLimit, codexPath };
}

function parseRuntime(value: unknown, dataDir: string): Config["runtime"] {
  if (value == null) return null;
  if (!record(value)) throw new Error("runtime must be an object.");
  const codexPath = typeof value.codexPath === "string" ? value.codexPath.trim() : "";
  if (!codexPath || !isAbsolute(codexPath)) throw new Error("runtime.codexPath must be an absolute path.");
  let model: string | null = null;
  if (value.model != null) {
    const trimmed = typeof value.model === "string" ? value.model.trim() : "";
    if (!trimmed || trimmed.length > 100) throw new Error("runtime.model must be a non-empty string of at most 100 characters.");
    model = trimmed;
  }
  const workspaceDir = value.workspaceDir ?? join(dataDir, "workspaces");
  if (typeof workspaceDir !== "string" || !isAbsolute(workspaceDir)) throw new Error("runtime.workspaceDir must be an absolute path.");
  const limit = (source: Record<string, unknown>, key: string, label: string, fallback: number, max: number): number => {
    const n = source[key] ?? fallback;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > max) throw new Error(`${label} must be an integer between 1 and ${max}.`);
    return n as number;
  };
  const section = (key: "budget" | "daily"): Record<string, unknown> => {
    const v = value[key] ?? {};
    if (!record(v)) throw new Error(`runtime.${key} must be an object.`);
    return v;
  };
  const budget = section("budget"); const daily = section("daily");
  return { codexPath, model, workspaceDir,
    budget: { minutes: limit(budget, "minutes", "runtime.budget.minutes", 30, 1440), turns: limit(budget, "turns", "runtime.budget.turns", 8, 100),
      toolCalls: limit(budget, "toolCalls", "runtime.budget.toolCalls", 40, 1000),
      tokens: limit(budget, "tokens", "runtime.budget.tokens", 2_000_000, 100_000_000) },
    daily: { tasks: limit(daily, "tasks", "runtime.daily.tasks", 20, 1000), tokens: limit(daily, "tokens", "runtime.daily.tokens", 10_000_000, 1_000_000_000) },
    approvalMinutes: limit(value, "approvalMinutes", "runtime.approvalMinutes", 60, 1440),
    maxJobs: limit(value, "maxJobs", "runtime.maxJobs", 1, 8) };
}

export function parseConfig(value: unknown): Config {
  if (!record(value)) throw new Error("Configuration must be a JSON object.");
  const text = (key: string): string => {
    const v = value[key]; if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${key}.`); return v.trim();
  };
  const assistantUser = text("assistantUser");
  if (!/^[a-z_][a-z0-9_-]*$/i.test(assistantUser) || assistantUser === "root") throw new Error("Invalid assistantUser.");
  if (value.owner !== undefined)
    throw new Error("The single \"owner\" entry is no longer supported. List approved contacts in contacts instead; see nori.config.example.json.");
  const contacts = parseContacts(value.contacts);
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
  const jev = parseJev(value.jev); const runtime = parseRuntime(value.runtime, dataDir);
  return { assistantUser, contacts, timezone, dataDir, imsgPath, pollMs: pollMs as number, quietHours, jev,
    responder: parseResponder(value.responder, jev, runtime), runtime };
}

/**
 * Development console settings. Only timezone, quiet hours, Jev, and the responder are read from the file; identity,
 * contacts, paths, the transport, and the runtime are forced to local console values so a live config cannot leak in.
 */
export function parseConsoleConfig(input: unknown, options: { dataDir: string; username: string }): Config {
  const source = record(input) ? input : {};
  // The runtime is dropped, so a Codex responder that inherits its CLI takes the path now.
  const responder = record(source.responder) && source.responder.provider === "codex" && source.responder.codexPath == null
    && record(source.runtime) ? { ...source.responder, codexPath: source.runtime.codexPath } : source.responder;
  return parseConfig({ assistantUser: options.username, contacts: [{ ...CONSOLE_CONTACT, handles: [...CONSOLE_CONTACT.handles] }],
    dataDir: options.dataDir, imsgPath: "/dev/null", pollMs: 1000, timezone: source.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    quietHours: source.quietHours ?? null, jev: source.jev ?? null, responder: responder ?? null });
}

export function requireAssistantUser(config: Config, actual = userInfo().username): void {
  if (actual !== config.assistantUser) throw new Error(`Run this command in the ${config.assistantUser} macOS profile (current: ${actual}).`);
}
