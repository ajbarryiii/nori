import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, Message, OutboxItem, Reminder, RoutingDecision, SendOutcome } from "./contracts.js";

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
    if (version > 1) { this.db.close(); throw new Error("Database schema is newer than this Nori installation."); }
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE inbox (guid TEXT PRIMARY KEY, row_id INTEGER NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL) STRICT;
        CREATE TABLE reminders (id INTEGER PRIMARY KEY, source_guid TEXT NOT NULL UNIQUE REFERENCES inbox(guid),
          title TEXT NOT NULL, due_at INTEGER, next_at INTEGER, status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE jobs (id INTEGER PRIMARY KEY, source_guid TEXT NOT NULL UNIQUE REFERENCES inbox(guid),
          text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', route TEXT, route_attempted INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE outbox (id INTEGER PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
          kind TEXT NOT NULL, reminder_id INTEGER REFERENCES reminders(id), revision INTEGER,
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
          message_guid TEXT, reason TEXT) STRICT;
        CREATE INDEX outbox_pending ON outbox(status, available_at);
        PRAGMA user_version=1;
      `);
    });
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? String(row.value) : null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  cursor(): number | null { const value = this.setting("cursor"); return value === null ? null : Number(value); }
  enroll(identity: string, cursor: number): void {
    if (!identity || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid enrollment.");
    this.transaction(() => {
      if (this.setting("identity") !== null) throw new Error("Already enrolled. Review database identity and pending work before re-enrolling.");
      this.setSetting("identity", identity); this.setSetting("cursor", String(cursor)); this.setSetting("watermark", String(cursor));
    });
  }
  hasMessage(guid: string): boolean { return !!this.db.prepare("SELECT guid FROM inbox WHERE guid=?").get(guid); }
  addMessage(message: Message): void {
    this.db.prepare("INSERT INTO inbox VALUES (?,?,?,?)").run(message.guid, message.rowId, message.text, message.sentAt);
  }
  addReminder(sourceGuid: string, title: string, dueAt: number | null): number {
    return Number(this.db.prepare("INSERT INTO reminders(source_guid,title,due_at,next_at) VALUES (?,?,?,?)").run(sourceGuid, title, dueAt, dueAt).lastInsertRowid);
  }
  reminders(): Reminder[] {
    return this.db.prepare("SELECT id,title,due_at AS dueAt,next_at AS nextAt,status,revision FROM reminders ORDER BY id").all() as unknown as Reminder[];
  }
  complete(id: number): void {
    this.db.prepare("UPDATE reminders SET status='completed',next_at=NULL,revision=revision+1 WHERE id=? AND status='active'").run(id);
    this.cancelStaleReminders();
  }
  snooze(id: number, at: number): void {
    this.db.prepare("UPDATE reminders SET next_at=?,revision=revision+1 WHERE id=? AND status='active'").run(at, id);
    this.cancelStaleReminders();
  }
  addJob(sourceGuid: string, text: string): number {
    return Number(this.db.prepare("INSERT INTO jobs(source_guid,text) VALUES (?,?)").run(sourceGuid, text).lastInsertRowid);
  }
  jobs(): Job[] {
    return this.db.prepare("SELECT id,source_guid AS sourceGuid,text,status,route FROM jobs ORDER BY id").all().map(row => ({
      id: Number(row.id), sourceGuid: String(row.sourceGuid), text: String(row.text), status: row.status as Job["status"],
      route: row.route ? JSON.parse(String(row.route)) as RoutingDecision : null,
    }));
  }
  cancelJob(id: number): boolean {
    return this.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND status='queued'").run(id).changes > 0;
  }
  unroutedJobs(): Job[] {
    const pending = new Set(this.db.prepare("SELECT id FROM jobs WHERE status='queued' AND route_attempted=0").all().map(x => Number(x.id)));
    return this.jobs().filter(x => pending.has(x.id));
  }
  claimUnroutedJob(): Job | null {
    return this.transaction(() => {
      const job = this.unroutedJobs()[0];
      if (!job) return null;
      this.db.prepare("UPDATE jobs SET route_attempted=1 WHERE id=?").run(job.id);
      return job;
    });
  }
  saveRoute(id: number, route: RoutingDecision | null): void {
    this.db.prepare("UPDATE jobs SET route=?,route_attempted=1 WHERE id=? AND status='queued'").run(route ? JSON.stringify(route) : null, id);
  }
  enqueue(key: string, text: string, at: number, reminder?: Reminder): void {
    this.db.prepare("INSERT OR IGNORE INTO outbox(dedup_key,text,kind,reminder_id,revision,available_at) VALUES (?,?,?,?,?,?)")
      .run(key, text, reminder ? "reminder" : "reply", reminder?.id ?? null, reminder?.revision ?? null, at);
  }
  outbox(): OutboxItem[] {
    return this.db.prepare(`SELECT id,text,kind,reminder_id AS reminderId,revision,status,attempts,available_at AS availableAt FROM outbox ORDER BY id`).all() as unknown as OutboxItem[];
  }
  cancelStaleReminders(): void {
    this.db.exec(`UPDATE outbox SET status='cancelled' WHERE status='pending' AND kind='reminder' AND NOT EXISTS
      (SELECT 1 FROM reminders r WHERE r.id=outbox.reminder_id AND r.status='active' AND r.revision=outbox.revision)`);
  }
  claimOutgoing(now: number, allowReminders = true): OutboxItem | null {
    return this.transaction(() => {
      this.cancelStaleReminders();
      const row = this.db.prepare(`SELECT id FROM outbox WHERE status='pending' AND available_at<=?
        AND (kind='reply' OR ?=1) ORDER BY CASE kind WHEN 'reply' THEN 0 ELSE 1 END,id LIMIT 1`).get(now, allowReminders ? 1 : 0);
      if (!row) return null;
      this.db.prepare("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=?").run(row.id!);
      return this.outbox().find(x => x.id === row.id)!;
    });
  }
  finishSend(item: OutboxItem, result: SendOutcome, now: number): void {
    if (result.status === "sent") this.db.prepare("UPDATE outbox SET status='sent',message_guid=? WHERE id=? AND status='sending'").run(result.messageGuid, item.id);
    else if (result.status === "not_started") {
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(item.attempts - 1, 5));
      this.db.prepare("UPDATE outbox SET status='pending',available_at=?,reason=? WHERE id=? AND status='sending'").run(now + delay, result.reason, item.id);
    } else this.db.prepare("UPDATE outbox SET status='uncertain',reason=? WHERE id=? AND status='sending'").run(result.reason, item.id);
  }
  recoverInFlight(): void { this.db.exec("UPDATE outbox SET status='uncertain',reason='Service stopped during send' WHERE status='sending'"); }
  counts(): { inbox: number; reminders: number; jobs: number; uncertain: number } {
    const count = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    return { inbox: count("SELECT count(*) n FROM inbox"), reminders: count("SELECT count(*) n FROM reminders"),
      jobs: count("SELECT count(*) n FROM jobs"), uncertain: count("SELECT count(*) n FROM outbox WHERE status='uncertain'") };
  }
}
