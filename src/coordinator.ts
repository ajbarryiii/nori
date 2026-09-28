import type { Action, Config, IntentRouter, Message, MessagePage, MessageTransport, Reminder, SendOutcome } from "./contracts.js";
import { normalizeHandle } from "./config.js";
import { formatTime, inQuietHours, parseAction } from "./parser.js";
import { Store } from "./store.js";

export class Coordinator {
  private sending = false;
  constructor(private readonly config: Config, private readonly store: Store,
    private readonly transport: MessageTransport, private readonly clock: () => number = Date.now) {}

  acceptPage(page: MessagePage): void {
    const cursor = this.store.cursor();
    if (cursor === null) throw new Error("Enroll this Messages database before processing messages.");
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || page.messages.some(m => !Number.isSafeInteger(m.rowId) || m.rowId > page.nextCursor))
      throw new Error("Invalid catch-up page cursor.");
    this.store.transaction(() => {
      for (const message of [...page.messages].sort((a, b) => a.rowId - b.rowId)) {
        if (message.rowId <= cursor || !this.authorized(message) || this.store.hasMessage(message.guid)) continue;
        this.store.addMessage(message);
        const action = parseAction(message.text, message.sentAt, this.config.timezone);
        const reply = this.apply(action, message);
        this.store.enqueue(`reply:${message.guid}`, reply, this.clock());
      }
      this.store.setSetting("cursor", String(page.nextCursor));
    });
  }

  private authorized(message: Message): boolean {
    if (message.isGroup || message.isFromMe || message.chatId !== this.config.owner.chatId
      || message.chatGuid !== this.config.owner.chatGuid || !message.guid || !message.text.trim() || !Number.isFinite(message.sentAt)) return false;
    try { return this.config.owner.handles.includes(normalizeHandle(message.sender)); } catch { return false; }
  }

  private target(id: number | null): Reminder | null {
    const active = this.store.reminders().filter(x => x.status === "active");
    return id !== null ? active.find(x => x.id === id) ?? null : active.length === 1 ? active[0]! : null;
  }

  private apply(action: Action, message: Message): string {
    switch (action.kind) {
      case "remind": case "note": {
        const due = action.kind === "remind" ? action.dueAt : null;
        const id = this.store.addReminder(message.guid, action.title, due);
        return `Saved locally #${id}: ${action.title}.${due !== null ? ` I'll remind you ${formatTime(due, this.config.timezone)}.` : ""}`;
      }
      case "done": case "snooze": {
        const reminder = this.target(action.id);
        if (!reminder) return "Which reminder? Reply ‘done #1’ or ‘snooze #1 20m’ with its number. ‘List’ shows your tasks.";
        if (action.kind === "done") { this.store.complete(reminder.id); return `Completed #${reminder.id}: ${reminder.title}.`; }
        const nextAt = message.sentAt + action.minutes * 60_000;
        this.store.snooze(reminder.id, nextAt);
        return `Snoozed #${reminder.id} until ${formatTime(nextAt, this.config.timezone)}. Its original deadline is unchanged.`;
      }
      case "cancel": return this.store.cancelJob(action.id) ? `Cancelled job #${action.id}.` : `No queued job #${action.id} to cancel.`;
      case "pause": this.store.setSetting("pause", action.scope); return action.scope === "all"
        ? "All Nori reminder messages are paused. Reply ‘resume’ to restart them. Native app alerts are unchanged."
        : "Discretionary nudges are paused. Your requested reminders will still arrive.";
      case "resume": this.store.setSetting("pause", "none"); return "Resumed. Requested reminders follow your quiet hours.";
      case "clarify": return action.question;
      case "delegate": {
        const id = this.store.addJob(message.guid, message.text);
        return `Saved job #${id}. It is queued; Codex execution is not connected yet. Reply ‘status’ to check or ‘cancel job #${id}’ to remove it.`;
      }
      case "status": return this.status();
      case "help": return "Try ‘note buy milk’, ‘remind me to call tomorrow at 10 am’, ‘list’, ‘done #1’, ‘snooze #1 20m’, ‘pause all’, or ‘resume’. Other requests are saved as queued jobs.";
    }
  }

  status(): string {
    const reminders = this.store.reminders().filter(x => x.status === "active");
    const jobs = this.store.jobs().filter(x => x.status === "queued");
    const lines = [`${reminders.length} active tasks; ${jobs.length} queued jobs.`,
      ...reminders.slice(0, 5).map(x => `#${x.id}: ${x.title}`)];
    if (reminders.length > 5) lines.push(`Plus ${reminders.length - 5} more tasks.`);
    if (jobs.length) lines.push(`Queued jobs: ${jobs.slice(0, 5).map(x => `#${x.id}`).join(", ")}. Codex execution is not connected yet.`);
    if (this.store.setting("pause") === "all") lines.push("Reminder messages are paused.");
    const uncertain = this.store.counts().uncertain;
    if (uncertain) lines.push(`${uncertain} outgoing message(s) need delivery review; they will not be resent automatically.`);
    return lines.join("\n");
  }

  async tick(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const now = this.clock();
      this.store.transaction(() => {
        for (const reminder of this.store.reminders()) {
          if (reminder.status !== "active" || reminder.nextAt === null || reminder.nextAt > now) continue;
          const delayed = now - reminder.nextAt > 5 * 60_000 ? " (catching up after a delay)" : "";
          this.store.enqueue(`reminder:${reminder.id}:${reminder.revision}`,
            `Reminder #${reminder.id}${delayed}: ${reminder.title}. Reply ‘done #${reminder.id}’ or ‘snooze #${reminder.id} 20m’.`, now, reminder);
        }
      });
      // Bounded batch; recheck controls and task revisions before each external send.
      for (let n = 0; n < 10; n++) {
        const allowReminders = this.store.setting("pause") !== "all" && !inQuietHours(this.clock(), this.config.timezone, this.config.quietHours);
        const item = this.store.claimOutgoing(this.clock(), allowReminders);
        if (!item) break;
        let result: SendOutcome;
        try { result = await this.transport.send(item.text); }
        catch { result = { status: "uncertain", reason: "Transport ended without a confirmed result" }; }
        this.store.finishSend(item, result, this.clock());
      }
    } finally { this.sending = false; }
  }

  async routeJobs(router: IntentRouter, shouldContinue: () => boolean = () => true): Promise<void> {
    for (let n = 0; n < 5 && shouldContinue(); n++) {
      const job = this.store.claimUnroutedJob();
      if (!job) break;
      let route = null;
      try { route = await router.classify(job.text, this.config.timezone); } catch { /* Task stays queued. */ }
      this.store.saveRoute(job.id, route);
    }
  }
}
