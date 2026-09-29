import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Conversation, Enrollment, Message, OutboxItem, RoutingDecision, SendOutcome, Task, TaskState, TaskUsage,
  WaitingFor } from "./contracts.js";

export interface TimerRecord {
  id: number;
  pluginId: string;
  contactId: string;
  key: string;
  at: number;
  payload: unknown;
  status: "pending" | "fired" | "cancelled" | "failed";
  revision: number;
}

export interface ApprovalRecord {
  id: number;
  taskId: number;
  contactId: string;
  operation: string;
  detail: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
}

export interface ToolCallRecord {
  callId: string;
  tool: string;
  success: boolean;
  result: string;
}

export type TaskPatch = Partial<{ state: TaskState; threadId: string | null; waitingFor: WaitingFor | null; input: string | null;
  outcome: string | null; evidence: string[]; usage: Partial<TaskUsage> }>;

export interface OutgoingMessage {
  key: string;
  contactId: string;
  target: Conversation;
  text: string;
  kind: OutboxItem["kind"];
  timer: { id: number; revision: number } | null;
}

/** States a contact can cancel. A running task also needs its runtime turn interrupted. */
const CANCELLABLE: readonly TaskState[] = ["queued", "routed", "running", "waiting_contact", "waiting_access"];
const USAGE_COLUMNS: Record<keyof TaskUsage, string> = { turns: "turns", toolCalls: "tool_calls", tokens: "tokens", runMs: "run_ms", allowance: "allowance" };
const MAX_DOCUMENT = 65_536;

/** Transactions contain only synchronous local work. Never keep one open around model/network I/O. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing a symlink database.");
    }
    const oldMask = process.umask(0o077);
    try { this.db = new DatabaseSync(path); } finally { process.umask(oldMask); }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > 2) { this.db.close(); throw new Error("Database schema is newer than this Nori installation."); }
    if (version === 1) {
      this.db.close();
      throw new Error("This state database predates approved contacts. Stop Nori, move state.sqlite and its sidecars aside, and enroll each contact again.");
    }
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE enrollments (contact_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL UNIQUE, chat_guid TEXT NOT NULL UNIQUE,
          cursor INTEGER NOT NULL, watermark INTEGER NOT NULL) STRICT;
        CREATE TABLE inbox (guid TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES enrollments(contact_id),
          row_id INTEGER NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL) STRICT;
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES enrollments(contact_id), number INTEGER NOT NULL,
          source_guid TEXT REFERENCES inbox(guid), text TEXT NOT NULL, time INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
          hint TEXT, failure TEXT, route TEXT, route_attempted INTEGER NOT NULL DEFAULT 0, thread_id TEXT, waiting_for TEXT, input TEXT,
          outcome TEXT, evidence TEXT NOT NULL DEFAULT '[]', turns INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0, run_ms INTEGER NOT NULL DEFAULT 0, allowance INTEGER NOT NULL DEFAULT 1,
          UNIQUE (contact_id, number)) STRICT;
        CREATE TABLE approvals (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), contact_id TEXT NOT NULL REFERENCES enrollments(contact_id),
          operation TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL) STRICT;
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), call_id TEXT NOT NULL, tool TEXT NOT NULL,
          arguments TEXT NOT NULL, success INTEGER NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (task_id, call_id)) STRICT;
        CREATE TABLE timers (id INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES enrollments(contact_id),
          key TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          revision INTEGER NOT NULL DEFAULT 0, UNIQUE (plugin_id, contact_id, key)) STRICT;
        CREATE INDEX timers_due ON timers(status, at);
        CREATE TABLE plugin_state (id INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES enrollments(contact_id),
          key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE (plugin_id, contact_id, key)) STRICT;
        CREATE TABLE plugin_sequences (plugin_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES enrollments(contact_id),
          name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (plugin_id, contact_id, name)) STRICT;
        CREATE TABLE plugin_versions (plugin_id TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
        CREATE TABLE outbox (id INTEGER PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, contact_id TEXT NOT NULL REFERENCES enrollments(contact_id),
          chat_id INTEGER NOT NULL, chat_guid TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
          timer_id INTEGER REFERENCES timers(id), revision INTEGER,
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
          message_guid TEXT, reason TEXT, withdrawn INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE INDEX outbox_pending ON outbox(status, available_at);
        PRAGMA user_version=2;
      `);
    });
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** An inner atomic section: a thrown error rolls back only this part of the enclosing transaction. */
  savepoint<T>(fn: () => T): T {
    if (!this.db.isTransaction) throw new Error("Savepoints need an enclosing transaction.");
    this.db.exec("SAVEPOINT dispatch");
    try { const result = fn(); this.db.exec("RELEASE dispatch"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO dispatch"); this.db.exec("RELEASE dispatch"); throw error; }
  }
  setting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? String(row.value) : null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  identity(): string | null { return this.setting("identity"); }
  /** Records one conversation's watermark. Every enrollment shares the first enrollment's database identity. */
  enroll(identity: string, contactId: string, conversation: Conversation, cursor: number): void {
    if (!identity || !contactId || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid enrollment.");
    this.transaction(() => {
      const stored = this.identity();
      if (stored !== null && stored !== identity)
        throw new Error("Messages database/account identity changed. Stop and reconcile before enrolling another contact.");
      if (this.enrollment(contactId)) throw new Error(`Contact ${contactId} is already enrolled. Review its state before changing enrollment.`);
      if (this.db.prepare("SELECT 1 FROM enrollments WHERE chat_id=? OR chat_guid=?").get(conversation.chatId, conversation.chatGuid))
        throw new Error("That conversation is already enrolled for another contact.");
      this.setSetting("identity", identity);
      this.db.prepare("INSERT INTO enrollments VALUES (?,?,?,?,?)").run(contactId, conversation.chatId, conversation.chatGuid, cursor, cursor);
    });
  }
  enrollment(contactId: string): Enrollment | null {
    return this.enrollments().find(x => x.contactId === contactId) ?? null;
  }
  enrollments(): Enrollment[] {
    return this.db.prepare("SELECT contact_id,chat_id,chat_guid,cursor,watermark FROM enrollments ORDER BY rowid").all().map(row => ({
      contactId: String(row.contact_id), conversation: { chatId: Number(row.chat_id), chatGuid: String(row.chat_guid) },
      cursor: Number(row.cursor), watermark: Number(row.watermark),
    }));
  }
  setCursor(contactId: string, cursor: number): void {
    this.db.prepare("UPDATE enrollments SET cursor=? WHERE contact_id=? AND cursor<=?").run(cursor, contactId, cursor);
  }

  hasMessage(guid: string): boolean { return !!this.db.prepare("SELECT guid FROM inbox WHERE guid=?").get(guid); }
  addMessage(contactId: string, message: Message): void {
    this.db.prepare("INSERT INTO inbox VALUES (?,?,?,?,?)").run(message.guid, contactId, message.rowId, message.text, message.sentAt);
  }

  /** Unroutable tasks (plugin failures and runtime hand-offs) never reach Jev. */
  addTask(input: { contactId: string; sourceGuid: string | null; text: string; time: number; hint: string | null;
    failure: string | null; routable: boolean }): Task {
    const number = Number(this.db.prepare("SELECT coalesce(max(number),0)+1 AS n FROM tasks WHERE contact_id=?").get(input.contactId)!.n);
    const id = Number(this.db.prepare("INSERT INTO tasks(contact_id,number,source_guid,text,time,hint,failure,route_attempted) VALUES (?,?,?,?,?,?,?,?)")
      .run(input.contactId, number, input.sourceGuid, input.text, input.time, input.hint, input.failure, input.routable ? 0 : 1).lastInsertRowid);
    return this.task(id)!;
  }
  private taskRows(where: string, ...params: SQLInputValue[]): Task[] {
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY id`).all(...params).map(row => ({
      id: Number(row.id), contactId: String(row.contact_id), number: Number(row.number),
      sourceGuid: row.source_guid === null ? null : String(row.source_guid), text: String(row.text), time: Number(row.time),
      state: row.state as TaskState, hint: row.hint === null ? null : String(row.hint),
      failure: row.failure === null ? null : String(row.failure),
      route: row.route ? JSON.parse(String(row.route)) as RoutingDecision : null,
      threadId: row.thread_id === null ? null : String(row.thread_id),
      waitingFor: row.waiting_for ? JSON.parse(String(row.waiting_for)) as WaitingFor : null,
      input: row.input === null ? null : String(row.input), outcome: row.outcome === null ? null : String(row.outcome),
      evidence: JSON.parse(String(row.evidence)) as string[],
      usage: { turns: Number(row.turns), toolCalls: Number(row.tool_calls), tokens: Number(row.tokens), runMs: Number(row.run_ms),
        allowance: Number(row.allowance) },
    }));
  }
  task(id: number): Task | null { return this.taskRows("WHERE id=?", id)[0] ?? null; }
  tasks(contactId?: string): Task[] {
    return contactId === undefined ? this.taskRows("") : this.taskRows("WHERE contact_id=?", contactId);
  }
  cancelTask(contactId: string, number: number): boolean {
    return this.db.prepare(`UPDATE tasks SET state='cancelled',waiting_for=NULL WHERE contact_id=? AND number=? AND state IN (${CANCELLABLE.map(() => "?").join(",")})`)
      .run(contactId, number, ...CANCELLABLE).changes > 0;
  }
  setTaskState(id: number, from: TaskState, to: TaskState): boolean {
    return this.updateTask(id, { state: to }, [from]);
  }
  /** Applies the patch only while the task is in one of the `from` states, when given. Usage fields are set, not added. */
  updateTask(id: number, patch: TaskPatch, from?: readonly TaskState[]): boolean {
    const sets: string[] = []; const values: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue) => { sets.push(`${column}=?`); values.push(value); };
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.threadId !== undefined) set("thread_id", patch.threadId);
    if (patch.waitingFor !== undefined) set("waiting_for", patch.waitingFor === null ? null : JSON.stringify(patch.waitingFor));
    if (patch.input !== undefined) set("input", patch.input);
    if (patch.outcome !== undefined) set("outcome", patch.outcome);
    if (patch.evidence !== undefined) set("evidence", JSON.stringify(patch.evidence));
    for (const [key, value] of Object.entries(patch.usage ?? {})) set(USAGE_COLUMNS[key as keyof TaskUsage], value);
    if (!sets.length) return false;
    const guard = from ? ` AND state IN (${from.map(() => "?").join(",")})` : "";
    return this.db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=?${guard}`).run(...values, id, ...(from ?? [])).changes > 0;
  }
  /** Adds contact input for the task's next runtime turn. */
  appendInput(id: number, text: string): void {
    this.db.prepare("UPDATE tasks SET input=CASE WHEN input IS NULL THEN ? ELSE input || char(10) || ? END WHERE id=?").run(text, text, id);
  }
  /**
   * Hands queued tasks that routing already passed over (including plugin delegations) to the runtime, for contacts who
   * may use it. Retained plugin failures stay queued for review.
   */
  promoteToRuntime(contactIds: readonly string[]): void {
    if (!contactIds.length) return;
    this.db.prepare(`UPDATE tasks SET state='routed' WHERE state='queued' AND route_attempted=1 AND failure IS NULL
      AND contact_id IN (${contactIds.map(() => "?").join(",")})`).run(...contactIds);
  }
  
  setTaskFailure(id: number, failure: string): void {
    this.db.prepare("UPDATE tasks SET failure=? WHERE id=?").run(failure, id);
  }
  unroutedTasks(): Task[] { return this.taskRows("WHERE state='queued' AND route_attempted=0"); }
  /**
   * Atomically marks the oldest routable task attempted. While the day's routing budget lasts, the claim is charged a
   * routing call. Past it, only tasks from `fallbackIds` are claimed, and without a call.
   */
  claimUnroutedTask(contactIds: readonly string[], fallbackIds: readonly string[], day: string, dailyLimit: number): { task: Task; classify: boolean } | null {
    return this.transaction(() => {
      const classify = this.daily("routing-calls", day) < dailyLimit;
      const ids = classify ? contactIds : fallbackIds;
      if (!ids.length) return null;
      const task = this.taskRows(`WHERE state='queued' AND route_attempted=0 AND contact_id IN (${ids.map(() => "?").join(",")})`, ...ids)[0];
      if (!task) return null;
      this.db.prepare("UPDATE tasks SET route_attempted=1 WHERE id=?").run(task.id);
      if (classify) this.addDaily("routing-calls", day, 1);
      return { task, classify };
    });
  }
  /** A per-local-day counter. Older days' values for the same name are discarded. */
  daily(name: string, day: string): number { return Number(this.setting(`${name}:${day}`) ?? 0); }
  addDaily(name: string, day: string, amount: number): void {
    const key = `${name}:${day}`;
    this.db.prepare("DELETE FROM settings WHERE substr(key,1,?)=? AND key<>?").run(name.length + 1, `${name}:`, key);
    this.setSetting(key, String(this.daily(name, day) + amount));
  }
  /** A decision is kept only for a still-queued task; late advice cannot restore a cancelled one. */
  saveDecision(id: number, decision: RoutingDecision | null): void {
    this.db.prepare("UPDATE tasks SET route=?,route_attempted=1 WHERE id=? AND state='queued'").run(decision ? JSON.stringify(decision) : null, id);
  }

  addApproval(input: { taskId: number; contactId: string; operation: string; detail: string; createdAt: number; expiresAt: number }): number {
    return Number(this.db.prepare("INSERT INTO approvals(task_id,contact_id,operation,detail,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(input.taskId, input.contactId, input.operation, input.detail, input.createdAt, input.expiresAt).lastInsertRowid);
  }
  approvals(contactId?: string): ApprovalRecord[] {
    const rows = contactId === undefined ? this.db.prepare("SELECT * FROM approvals ORDER BY id").all()
      : this.db.prepare("SELECT * FROM approvals WHERE contact_id=? ORDER BY id").all(contactId);
    return rows.map(row => ({ id: Number(row.id), taskId: Number(row.task_id), contactId: String(row.contact_id), operation: String(row.operation),
      detail: String(row.detail), status: row.status as ApprovalRecord["status"], createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) }));
  }
  /**
   * Withdraws an unsent message, for example a prompt that can no longer be answered. A message already being sent keeps
   * its delivery tracking, but is cancelled rather than retried if the transport reports it never went out.
   */
  cancelOutbox(key: string): void {
    this.db.prepare("UPDATE outbox SET withdrawn=1, status=CASE status WHEN 'pending' THEN 'cancelled' ELSE status END WHERE dedup_key=?").run(key);
  }
  /** Removes input the runtime has accepted, keeping anything added since it was sent. */
  consumeInput(id: number, sent: string): void {
    const input = this.task(id)?.input;
    if (input === null || input === undefined || !input.startsWith(sent)) return;
    this.updateTask(id, { input: input.slice(sent.length).replace(/^\n/, "") || null });
  }
  /** Settles a pending approval once. */
  settleApproval(id: number, status: "approved" | "denied" | "expired"): boolean {
    return this.db.prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'").run(status, id).changes > 0;
  }

  toolCall(taskId: number, callId: string): ToolCallRecord | null { return this.toolCalls(taskId).find(x => x.callId === callId) ?? null; }
  toolCalls(taskId: number): ToolCallRecord[] {
    return this.db.prepare("SELECT call_id,tool,success,result FROM tool_calls WHERE task_id=? ORDER BY id").all(taskId)
      .map(row => ({ callId: String(row.call_id), tool: String(row.tool), success: row.success === 1, result: String(row.result) }));
  }
  recordToolCall(taskId: number, call: ToolCallRecord & { arguments: unknown }, at: number): void {
    this.db.prepare("INSERT INTO tool_calls(task_id,call_id,tool,arguments,success,result,at) VALUES (?,?,?,?,?,?,?)")
      .run(taskId, call.callId, call.tool, document(call.arguments ?? null), call.success ? 1 : 0, call.result, at);
  }

  /** Upserts by key. Re-scheduling bumps the revision, which cancels the old fire's unsent messages. */
  schedule(pluginId: string, contactId: string, key: string, at: number, payload: unknown): void {
    this.db.prepare(`INSERT INTO timers(plugin_id,contact_id,key,at,payload) VALUES (?,?,?,?,?) ON CONFLICT(plugin_id,contact_id,key)
      DO UPDATE SET at=excluded.at,payload=excluded.payload,status='pending',revision=revision+1`).run(pluginId, contactId, key, at, document(payload ?? null));
    this.cancelStaleTimerMessages();
  }
  cancelTimer(pluginId: string, contactId: string, key: string): void {
    this.db.prepare("UPDATE timers SET status='cancelled',revision=revision+1 WHERE plugin_id=? AND contact_id=? AND key=? AND status<>'cancelled'")
      .run(pluginId, contactId, key);
    this.cancelStaleTimerMessages();
  }
  private timerRows(where: string, ...params: SQLInputValue[]): TimerRecord[] {
    return this.db.prepare(`SELECT * FROM timers ${where}`).all(...params).map(row => ({
      id: Number(row.id), pluginId: String(row.plugin_id), contactId: String(row.contact_id), key: String(row.key),
      at: Number(row.at), payload: JSON.parse(String(row.payload)), status: row.status as TimerRecord["status"], revision: Number(row.revision),
    }));
  }
  timers(contactId?: string): TimerRecord[] {
    return contactId === undefined ? this.timerRows("ORDER BY id") : this.timerRows("WHERE contact_id=? ORDER BY id", contactId);
  }
  dueTimers(now: number): TimerRecord[] { return this.timerRows("WHERE status='pending' AND at<=? ORDER BY at,id", now); }
  /** Claims one pending fire at the given revision. False when it was cancelled or rescheduled since being read. */
  markFired(id: number, revision: number): boolean {
    return this.db.prepare("UPDATE timers SET status='fired' WHERE id=? AND status='pending' AND revision=?").run(id, revision).changes > 0;
  }
  markFailed(id: number): void {
    this.db.prepare("UPDATE timers SET status='failed' WHERE id=? AND status='fired'").run(id);
  }

  stateGet<T>(pluginId: string, contactId: string, key: string): T | null {
    const row = this.db.prepare("SELECT value FROM plugin_state WHERE plugin_id=? AND contact_id=? AND key=?").get(pluginId, contactId, key);
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  stateSet(pluginId: string, contactId: string, key: string, value: unknown): void {
    this.db.prepare("INSERT INTO plugin_state(plugin_id,contact_id,key,value) VALUES (?,?,?,?) ON CONFLICT(plugin_id,contact_id,key) DO UPDATE SET value=excluded.value")
      .run(pluginId, contactId, key, document(value));
  }
  stateDelete(pluginId: string, contactId: string, key: string): void {
    this.db.prepare("DELETE FROM plugin_state WHERE plugin_id=? AND contact_id=? AND key=?").run(pluginId, contactId, key);
  }
  stateList<T>(pluginId: string, contactId: string, prefix: string): T[] {
    return this.db.prepare("SELECT value FROM plugin_state WHERE plugin_id=? AND contact_id=? AND substr(key,1,?)=? ORDER BY id")
      .all(pluginId, contactId, prefix.length, prefix).map(row => JSON.parse(String(row.value)) as T);
  }
  nextId(pluginId: string, contactId: string, sequence: string): number {
    return Number(this.db.prepare(`INSERT INTO plugin_sequences VALUES (?,?,?,1) ON CONFLICT(plugin_id,contact_id,name)
      DO UPDATE SET value=value+1 RETURNING value`).get(pluginId, contactId, sequence)!.value);
  }
  pluginDocuments(pluginId: string): Array<{ contactId: string; key: string; value: unknown }> {
    return this.db.prepare("SELECT contact_id,key,value FROM plugin_state WHERE plugin_id=? ORDER BY id").all(pluginId)
      .map(row => ({ contactId: String(row.contact_id), key: String(row.key), value: JSON.parse(String(row.value)) }));
  }
  pluginVersion(pluginId: string): number {
    return Number(this.db.prepare("SELECT version FROM plugin_versions WHERE plugin_id=?").get(pluginId)?.version ?? 0);
  }
  setPluginVersion(pluginId: string, version: number): void {
    this.db.prepare("INSERT INTO plugin_versions VALUES (?,?) ON CONFLICT(plugin_id) DO UPDATE SET version=excluded.version").run(pluginId, version);
  }

  enqueue(message: OutgoingMessage, at: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(dedup_key,contact_id,chat_id,chat_guid,text,kind,timer_id,revision,available_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(message.key, message.contactId, message.target.chatId, message.target.chatGuid, message.text,
      message.kind, message.timer?.id ?? null, message.timer?.revision ?? null, at);
  }
  private outboxRows(where: string, ...params: SQLInputValue[]): OutboxItem[] {
    return this.db.prepare(`SELECT * FROM outbox ${where}`).all(...params).map(row => ({
      id: Number(row.id), contactId: String(row.contact_id), target: { chatId: Number(row.chat_id), chatGuid: String(row.chat_guid) },
      text: String(row.text), kind: row.kind as OutboxItem["kind"], timerId: row.timer_id === null ? null : Number(row.timer_id),
      revision: row.revision === null ? null : Number(row.revision), status: row.status as OutboxItem["status"],
      attempts: Number(row.attempts), availableAt: Number(row.available_at),
    }));
  }
  outbox(contactId?: string): OutboxItem[] {
    return contactId === undefined ? this.outboxRows("ORDER BY id") : this.outboxRows("WHERE contact_id=? ORDER BY id", contactId);
  }
  cancelStaleTimerMessages(): void {
    this.db.exec(`UPDATE outbox SET status='cancelled' WHERE status='pending' AND kind='timer' AND NOT EXISTS
      (SELECT 1 FROM timers t WHERE t.id=outbox.timer_id AND t.status<>'cancelled' AND t.revision=outbox.revision)`);
  }
  /** Replies go before timer messages. `eligible` applies per-contact holds such as pause and removed contacts. */
  claimOutgoing(now: number, eligible: (item: OutboxItem) => boolean): OutboxItem | null {
    return this.transaction(() => {
      this.cancelStaleTimerMessages();
      const item = this.outboxRows("WHERE status='pending' AND available_at<=? ORDER BY CASE kind WHEN 'reply' THEN 0 ELSE 1 END,id", now).find(eligible);
      if (!item) return null;
      this.db.prepare("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=?").run(item.id);
      return { ...item, status: "sending", attempts: item.attempts + 1 };
    });
  }
  finishSend(item: OutboxItem, result: SendOutcome, now: number): void {
    if (result.status === "sent") this.db.prepare("UPDATE outbox SET status='sent',message_guid=? WHERE id=? AND status='sending'").run(result.messageGuid, item.id);
    else if (result.status === "not_started") {
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(item.attempts - 1, 5));
      this.db.prepare("UPDATE outbox SET status=CASE withdrawn WHEN 1 THEN 'cancelled' ELSE 'pending' END,available_at=?,reason=? WHERE id=? AND status='sending'")
        .run(now + delay, result.reason, item.id);
    } else this.db.prepare("UPDATE outbox SET status='uncertain',reason=? WHERE id=? AND status='sending'").run(result.reason, item.id);
  }
  recoverInFlight(): void { this.db.exec("UPDATE outbox SET status='uncertain',reason='Service stopped during send' WHERE status='sending'"); }
  counts(): { inbox: number; tasks: number; state: number; timers: number; uncertain: number } {
    const count = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    return { inbox: count("SELECT count(*) n FROM inbox"), tasks: count("SELECT count(*) n FROM tasks"),
      state: count("SELECT count(*) n FROM plugin_state"), timers: count("SELECT count(*) n FROM timers"),
      uncertain: count("SELECT count(*) n FROM outbox WHERE status='uncertain'") };
  }
}

function document(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || text.length > MAX_DOCUMENT) throw new Error("Plugin documents must be JSON of at most 64 KiB.");
  return text;
}
