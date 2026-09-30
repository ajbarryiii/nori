/** The engine's boundaries. Provider payloads must be validated before entering these types. */
export type Role = "owner" | "member";

export interface Conversation {
  chatId: number;
  chatGuid: string;
}

/** An approved contact. Enrolling its conversation is a separate, CLI-only operator step. */
export interface Contact {
  id: string;
  name: string;
  handles: readonly string[];
  conversation: Conversation;
  role: Role;
  /** Plugin allowlist. The plugin's manifest must also permit the contact's role. */
  plugins: readonly string[];
}

export interface JevConfig {
  model: string;
  timeoutMs: number;
  /** Routing calls allowed per local calendar day. Further tasks wait unrouted, or go to a runtime without Jev. */
  dailyLimit: number;
  /** Plugins whose Jev routes may act, mapped to their minimum confidence. Other routes are shadow-only. */
  routes: Readonly<Record<string, number>>;
}

export interface Budget {
  /** Running time per allowance, excluding time spent waiting for approvals. */
  minutes: number;
  turns: number;
  toolCalls: number;
  tokens: number;
}

/** The Codex runtime. When configured, the owner's unmatched requests run in it unless a plugin route acts. */
export interface RuntimeConfig {
  codexPath: string;
  /** Pinned model, or null for the Codex default. */
  model: string | null;
  /** Parent of each task's private working directory. */
  workspaceDir: string;
  /** Per-task limits. `continue #n` grants one more allowance of each. */
  budget: Budget;
  /** Limits across all tasks per local calendar day. */
  daily: { tasks: number; tokens: number };
  /** An unanswered approval is denied after this many minutes. */
  approvalMinutes: number;
}

export interface Config {
  assistantUser: string;
  contacts: readonly Contact[];
  timezone: string;
  dataDir: string;
  imsgPath: string;
  pollMs: number;
  quietHours: { start: number; end: number } | null;
  jev: JevConfig | null;
  runtime: RuntimeConfig | null;
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
  /** Only messages after the conversation's enrollment watermark are eligible for execution. */
  readAfter(conversation: Conversation, cursor: number): Promise<MessagePage>;
  send(target: Conversation, text: string): Promise<SendOutcome>;
  close(): void;
}

/** One enrolled conversation. Each has its own watermark and cursor. */
export interface Enrollment {
  contactId: string;
  conversation: Conversation;
  cursor: number;
  watermark: number;
}

/**
 * `storage` and `schedule` gate the matching PluginContext members. `network` and `desktop` are
 * declarations for review: an in-process plugin cannot be sandboxed.
 */
export type Capability = "storage" | "schedule" | "network" | "desktop";

export interface PluginManifest {
  /** Lowercase identifier. `runtime`, `continue`, and `clarify` are reserved for routing options. */
  id: string;
  version: string;
  /** Version of the plugin's stored state. The host runs migrate() when it increases. */
  stateVersion: number;
  capabilities: readonly Capability[];
  /** Roles permitted by default. The contact's allowlist must also name the plugin. */
  roles: readonly Role[];
  /** Routing criteria for the Jev catalog: the requests this plugin's interpret step handles. */
  criteria: string;
  /** Example commands for help replies. */
  examples: readonly string[];
}

export type FieldSchema =
  | { type: "string"; maxLength: number; description?: string }
  | { type: "integer"; minimum: number; maximum: number; nullable?: boolean; description?: string };

/** Accepted command kinds and their exact fields. The host rejects unknown kinds and missing or extra fields. */
export type CommandSchema = Readonly<Record<string, Readonly<Record<string, FieldSchema>>>>;

export interface Command {
  kind: string;
  [field: string]: unknown;
}

/** One focused question for the contact instead of a command. */
export interface Clarification {
  clarify: string;
}

export interface MessageContext {
  contact: Contact;
  /** Reference time: the source message's sent time, or when the timer fired. */
  time: number;
  timezone: string;
}

/** JSON documents namespaced by plugin and contact. Values are returned in insertion order. */
export interface PluginState {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  list<T>(prefix: string): T[];
  /** Next value of a per-contact sequence, starting at 1. */
  nextId(sequence: string): number;
}

/** Every contact's documents for one plugin, available only to its migration hook. */
export interface PluginDb {
  documents(): Array<{ contactId: string; key: string; value: unknown }>;
  set(contactId: string, key: string, value: unknown): void;
  delete(contactId: string, key: string): void;
}

/**
 * Valid only during the dispatch that created it. Plugins never see the store or transport:
 * every send goes through reply() and every timer through schedule().
 */
export interface PluginContext extends MessageContext {
  /** Enqueues an outbox item for this contact, deduplicated by the dispatch's source. */
  reply(text: string): void;
  /**
   * Durable timer upserted by key. Re-scheduling or cancelling replaces the pending fire and invalidates unsent
   * messages from earlier fires of that key, so recurring work should use a new key per occurrence.
   */
  schedule(key: string, at: number, payload: unknown): void;
  cancelTimer(key: string): void;
  state: PluginState;
  /** Creates a durable task for a runtime, preserving the full request text. Returns the contact's task number. */
  delegate(text: string, hint?: string): number;
}

export interface Timer {
  key: string;
  at: number;
  payload: unknown;
}

/** A command a plugin exports to runtimes. Its arguments are the command's schema fields. */
export interface ToolDefinition {
  kind: string;
  description: string;
  /** High-impact calls need the contact's approval every time, whatever the runtime asserts. */
  impact: "low" | "high";
}

/**
 * A typed operation that completes within one dispatch. handle, onTimer, and summary run inside the
 * engine's SQLite transaction, so they must be synchronous and local; a returned promise is refused.
 * A thrown error rolls back that dispatch only.
 */
export interface ActionPlugin {
  manifest: PluginManifest;
  schema: CommandSchema;
  /** Upgrades stored state from version `from` (0 on first install) to manifest.stateVersion. */
  migrate(db: PluginDb, from: number): void;
  /** Whole-message grammar. Runs before Jev and uses no model. */
  match(text: string, ctx: MessageContext): Command | Clarification | null;
  /** Natural-language step after a Jev route. It may await a parser or model; its context is read-only. */
  interpret?(text: string, ctx: PluginContext): Promise<Command | Clarification>;
  handle(command: Command, ctx: PluginContext): void;
  onTimer?(timer: Timer, ctx: PluginContext): void;
  /** Status lines for this contact. Read-only context. */
  summary?(ctx: PluginContext): string[];
  /** Commands runtimes may call for this contact. A call runs handle(), and its replies become the tool result. */
  tools?: readonly ToolDefinition[];
}

export type TaskState = "queued" | "routed" | "running" | "waiting_contact" | "waiting_access"
  | "verifying" | "completed" | "failed" | "cancelled" | "uncertain";

/** Why a task in `waiting_contact` is waiting, and what reply moves it on. */
export type WaitingFor =
  /** A plugin asked for a complete replacement request. */
  | { kind: "clarification" }
  /** The runtime asked a question; the contact's next reply continues the task. */
  | { kind: "question" }
  /** The active turn is blocked on `approve A<code>` or `deny A<code>`. */
  | { kind: "approval" }
  /** A budget was reached; `continue #n` grants another allowance. */
  | { kind: "limit"; limit: keyof Budget }
  /** The turn ended without an outcome, for example on restart. `continue #n` resumes after checking prior work. */
  | { kind: "interrupted" };

export interface TaskUsage {
  turns: number;
  toolCalls: number;
  tokens: number;
  runMs: number;
  /** Budget multiplier, raised by `continue #n` after a limit. */
  allowance: number;
}

export interface Task {
  id: number;
  contactId: string;
  /** Per-contact number shown as #n. */
  number: number;
  sourceGuid: string | null;
  text: string;
  /** Reference time of the source message, used by interpret. */
  time: number;
  state: TaskState;
  hint: string | null;
  /** Plugin failure retained for review. Never contains message text. */
  failure: string | null;
  route: RoutingDecision | null;
  /** Runtime thread, once started. */
  threadId: string | null;
  waitingFor: WaitingFor | null;
  /** Contact input queued for the next runtime turn. */
  input: string | null;
  /** The runtime's last message and the checks it reported. */
  outcome: string | null;
  evidence: string[];
  usage: TaskUsage;
}

export type Route =
  | { kind: "action"; pluginId: string }
  | { kind: "runtime" }
  | { kind: "continue" }
  | { kind: "clarify" };

export interface RouteCatalog {
  version: string;
  options: ReadonlyArray<{ id: string; criteria: string; route: Route }>;
}

export interface RoutingDecision {
  model: string;
  catalogVersion: string;
  route: Route;
  confidence: number;
  probabilities: Record<string, number>;
  multiAction: boolean;
}

/** A routing answer never authorizes an action. Code checks authority after routing. */
export interface IntentRouter {
  classify(text: string, ctx: { timezone: string; catalog: RouteCatalog }): Promise<RoutingDecision | null>;
}

export interface RuntimeManifest {
  id: string;
  /** An unverified runtime cannot take a GUI task. */
  computerUse: "verified" | "unverified";
  ownerOnly: boolean;
}

/** An exported plugin tool as a runtime sees it. Named `<pluginId>_<kind>`. */
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RuntimeEvents {
  /** Called as soon as the thread exists (turnId null), and again once the turn exists, so a restart can find them. */
  started(ids: { threadId: string; turnId: string | null }): void;
  /** The runtime began one of its own tool actions (a command, file change, or web search). Counts against the tool-call budget. */
  activity(): void;
  /** One of the runtime's own tool actions finished. Once the budget is used, the turn stops here, before another begins. */
  activityEnded(): void;
  /** Holds the turn until the contact decides. Resolves false on deny, expiry, or cancellation. */
  approval(request: { operation: string; detail: string }): Promise<boolean>;
  /** Runs an exported plugin tool for the task's contact. Never throws. */
  tool(call: { callId: string; name: string; arguments: unknown }): Promise<{ success: boolean; text: string }>;
  /** Cumulative tokens used by the task's thread. */
  usage(totalTokens: number): void;
}

/** Only a completed outcome with evidence produces a completed reply. */
export type TurnOutcome =
  | { status: "completed"; message: string; evidence: string[] }
  | { status: "needs_input"; message: string }
  | { status: "failed"; message: string }
  | { status: "interrupted" };

/** Runs longer work. Each call runs one turn and resolves when it ends; a lost connection rejects. */
export interface Runtime {
  manifest: RuntimeManifest;
  /** Starts a thread for the task and runs its first turn with the full request text. */
  start(task: Task, tools: readonly RuntimeTool[], events: RuntimeEvents): Promise<TurnOutcome>;
  /** Runs another turn on the task's existing thread, loading it first if needed. */
  resume(task: Task, input: string, tools: readonly RuntimeTool[], events: RuntimeEvents): Promise<TurnOutcome>;
  /** Interrupts the task's active turn, if any. */
  cancel(taskId: number): Promise<void>;
  /**
   * Stops the runtime. Active turns end, and the promise resolves, only once every process it started has exited or the
   * runtime has halted.
   */
  close(): Promise<void>;
  /**
   * Why the runtime stopped for good: processes it started could not be confirmed stopped. It then starts nothing more,
   * and the service stops with this reason and keeps its lock until the operator has checked.
   */
  halted: string | null;
}

export interface RpcPort {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  /** Rejects pending requests at once, then stops the server; `closed` reports when it has stopped. */
  close(): void;
}

/** Handlers for messages a server initiates. Without a request handler, every server request is refused. */
export interface RpcHandlers {
  /** The result becomes the response; a throw becomes an error response. */
  request?(method: string, params: Record<string, unknown>): Promise<unknown>;
  notification?(method: string, params: Record<string, unknown>): void;
  /**
   * The connection ended and pending requests have been rejected. `stopped` confirms that the server has exited along
   * with every process it started that could still be traced to it; it is false when that could not be confirmed.
   */
  closed?(stopped: boolean): void;
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
  contactId: string;
  target: Conversation;
  text: string;
  /** Timer messages are held by pause-all and quiet hours; replies are not. */
  kind: "reply" | "timer";
  timerId: number | null;
  revision: number | null;
  status: "pending" | "sending" | "sent" | "uncertain" | "cancelled";
  attempts: number;
  availableAt: number;
}
