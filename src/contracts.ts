/** The coordinator's boundaries. Provider payloads must be validated before entering these types. */
export interface Owner {
  handles: readonly string[];
  chatId: number;
  chatGuid: string;
}

export interface Config {
  assistantUser: string;
  owner: Owner;
  timezone: string;
  dataDir: string;
  imsgPath: string;
  pollMs: number;
  quietHours: { start: number; end: number } | null;
  jev: { model: string; timeoutMs: number } | null;
}

export interface Message {
  guid: string;
  rowId: number;
  chatId: number;
  chatGuid: string;
  sender: string;
  isFromMe: boolean;
  isGroup: boolean;
  text: string;
  sentAt: number;
}

export interface MessagePage {
  messages: Message[];
  nextCursor: number;
  hasMore: boolean;
}

/** Transport success is local Messages evidence, not delivery/read acknowledgement by the phone. */
export type SendOutcome =
  | { status: "sent"; messageGuid: string }
  | { status: "not_started"; reason: string }
  | { status: "uncertain"; reason: string };

export interface MessageTransport {
  readiness(): Promise<{ ready: boolean; detail: string }>;
  /** Only messages after the explicit enrollment watermark are eligible for execution. */
  readAfter(cursor: number): Promise<MessagePage>;
  send(text: string): Promise<SendOutcome>;
  close(): void;
}

export type Action =
  | { kind: "remind"; title: string; dueAt: number }
  | { kind: "note"; title: string }
  | { kind: "done"; id: number | null }
  | { kind: "snooze"; id: number | null; minutes: number }
  | { kind: "cancel"; id: number }
  | { kind: "pause"; scope: "nudges" | "all" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "clarify"; question: string }
  | { kind: "delegate" };

export interface Reminder {
  id: number;
  title: string;
  dueAt: number | null;
  nextAt: number | null;
  status: "active" | "completed";
  revision: number;
}

export interface Job {
  id: number;
  sourceGuid: string;
  text: string;
  status: "queued" | "cancelled";
  route: RoutingDecision | null;
}

export type Route = "automation" | "codex" | "clarify";
export interface RoutingDecision {
  model: string;
  version: "nori-route-v1";
  route: Route;
  confidence: number;
  probabilities: Record<Route, number>;
}

/** Advisory only: a routing answer never executes a script or grants authority. */
export interface IntentRouter {
  classify(text: string, timezone: string): Promise<RoutingDecision | null>;
}

export interface RpcPort {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): void;
}

/** Future native helper: successful writes must return identifiers suitable for read-back. */
export interface ReminderPort {
  create(input: { operationId: string; listId: string; title: string; dueAt: number | null }): Promise<{ id: string }>;
  read(id: string): Promise<{ id: string; title: string; completed: boolean } | null>;
  complete(id: string): Promise<void>;
}

export interface CalendarPort {
  listEvents(input: { calendarIds: string[]; start: number; end: number }): Promise<
    Array<{ id: string; title: string; start: number; end: number }>
  >;
}

export interface CodexWorker {
  inspect(): Promise<{ connected: boolean; computerUse: "unverified"; detail: string }>;
}

export interface OutboxItem {
  id: number;
  text: string;
  kind: "reply" | "reminder";
  reminderId: number | null;
  revision: number | null;
  status: "pending" | "sending" | "sent" | "uncertain" | "cancelled";
  attempts: number;
  availableAt: number;
}
