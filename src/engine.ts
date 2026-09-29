import type { ActionPlugin, Budget, OutboxItem, Clarification, Command, Config, Contact, IntentRouter, Message, MessagePage, MessageTransport,
  RoutingDecision, Runtime, RuntimeEvents, SendOutcome, Task, TurnOutcome, WaitingFor } from "./contracts.js";
import { normalizeHandle, record } from "./config.js";
import { checkPlugins, isClarification, PluginHost, type DispatchSource } from "./host.js";
import { inQuietHours, isCompound, localDay, parseEngineCommand, type EngineCommand } from "./parser.js";
import { builtinPlugins } from "./plugins/index.js";
import type { ApprovalRecord, Store } from "./store.js";

function freeze(contact: Contact): Contact {
  return Object.freeze({ ...contact, handles: Object.freeze([...contact.handles]),
    conversation: Object.freeze({ ...contact.conversation }), plugins: Object.freeze([...contact.plugins]) });
}

/** Anything longer cannot be shown in full in one approval prompt, so it is refused rather than truncated. */
const MAX_APPROVAL_DETAIL = 1500;
const LIMIT_LABELS: Record<keyof Budget, string> = { minutes: "time", turns: "turn", toolCalls: "tool-call", tokens: "usage" };
const CONTINUE_AFTER_LIMIT = "Continue where you left off.";
const CONTINUE_AFTER_INTERRUPTION = "Your previous turn was interrupted before it finished. Check what was already done before repeating any step, then continue.";

/** A runtime turn in progress. Its run clock stops while approvals are pending. */
interface ActiveTurn {
  taskId: number;
  since: number | null;
  approvals: Map<number, (approved: boolean) => void>;
  /** Set when the engine interrupts the turn for a budget. The turn gets no further approvals or tools. */
  limit: WaitingFor | null;
  /** Serializes approvals so a job has at most one pending. */
  gate: Promise<void>;
  /** Input sent with this turn; removed from the task once the runtime accepts or finishes the turn. */
  sent: string | null;
}

/**
 * Owns identity, permissions, conversation state, durable timers, tasks, and delivery. Dispatch order: engine commands,
 * then permitted plugin grammars, then (asynchronously) Jev, then validation, then execution in a plugin or the runtime.
 */
export class Engine {
  readonly host: PluginHost;
  private readonly contacts: readonly Contact[];
  private readonly clock: () => number;
  private readonly runtime: Runtime | null;
  private readonly active = new Map<number, ActiveTurn>();
  private deferred: Array<() => void> | null = null;
  private sending = false;

  constructor(private readonly config: Config, private readonly store: Store, private readonly transport: MessageTransport,
    options: { plugins?: readonly ActionPlugin[]; clock?: () => number; runtime?: Runtime } = {}) {
    const plugins = options.plugins ?? builtinPlugins;
    checkPlugins(config, plugins);
    this.contacts = config.contacts.map(freeze);
    this.clock = options.clock ?? Date.now;
    this.runtime = config.runtime ? options.runtime ?? null : null;
    this.host = new PluginHost(store, plugins, config.timezone);
  }

  /** Configured contacts with an enrollment. A conversation that no longer matches its enrollment halts processing. */
  activeContacts(): Contact[] {
    return this.contacts.filter(contact => {
      const enrollment = this.store.enrollment(contact.id);
      if (!enrollment) return false;
      if (enrollment.conversation.chatId !== contact.conversation.chatId || enrollment.conversation.chatGuid !== contact.conversation.chatGuid)
        throw new Error(`Contact ${contact.id}'s conversation differs from its enrollment. Restore the configuration or review its state before enrolling again.`);
      return true;
    });
  }

  /** Runtimes are owner-only unless their manifest says otherwise. */
  private runtimeFor(contact: Contact): Runtime | null {
    return this.runtime && (contact.role === "owner" || !this.runtime.manifest.ownerOnly) ? this.runtime : null;
  }

  /** Commits the transaction, then runs callbacks deferred inside it, such as releasing a turn blocked on an approval. */
  private commit(fn: () => void): void {
    const callbacks: Array<() => void> = []; const outer = this.deferred;
    this.deferred = callbacks;
    try { this.store.transaction(fn); } finally { this.deferred = outer; }
    for (const callback of callbacks) callback();
  }
  private later(callback: () => void): void {
    if (this.deferred) this.deferred.push(callback); else callback();
  }

  acceptPage(contactId: string, page: MessagePage): void {
    const contact = this.activeContacts().find(c => c.id === contactId);
    if (!contact) throw new Error(`Enroll contact ${contactId} before processing its messages.`);
    const cursor = this.store.enrollment(contactId)!.cursor;
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || page.messages.some(m => !Number.isSafeInteger(m.rowId) || m.rowId > page.nextCursor))
      throw new Error("Invalid catch-up page cursor.");
    this.commit(() => {
      for (const message of [...page.messages].sort((a, b) => a.rowId - b.rowId)) {
        if (message.rowId <= cursor || !this.authorized(contact, message) || this.store.hasMessage(message.guid)) continue;
        this.store.addMessage(contact.id, message);
        this.dispatch(contact, message);
      }
      this.store.setCursor(contact.id, page.nextCursor);
    });
  }

  private authorized(contact: Contact, message: Message): boolean {
    if (message.isGroup || message.isFromMe || message.chatId !== contact.conversation.chatId
      || message.chatGuid !== contact.conversation.chatGuid || !message.guid || !message.text.trim() || !Number.isFinite(message.sentAt)) return false;
    try { return contact.handles.includes(normalizeHandle(message.sender)); } catch { return false; }
  }

  /** Runs inside the page transaction. A plugin failure rolls back only its own savepoint. */
  private dispatch(contact: Contact, message: Message): void {
    const source: DispatchSource = { contact, time: message.sentAt, now: this.clock(), replyKey: n => `reply:${message.guid}:${n}`,
      timer: null, sourceGuid: message.guid };
    const reply = (text: string) => this.enqueue(source, `reply:${message.guid}`, text);
    const command = parseEngineCommand(message.text);
    if (command) { reply(this.command(contact, command)); return; }
    // Grammars consume the entire message, so a compound request never reaches one.
    if (!isCompound(message.text)) {
      const context = { contact, time: message.sentAt, timezone: this.config.timezone };
      for (const plugin of this.host.permitted(contact)) {
        const id = plugin.manifest.id;
        let result: Command | Clarification | null;
        try { result = this.host.match(plugin, message.text, context); }
        catch { this.retain(source, message.text, `${id}: grammar error`); return; }
        if (result === null) continue;
        if (isClarification(result)) { reply(result.clarify); return; }
        const valid = this.host.validate(plugin, result);
        if (!valid) { this.retain(source, message.text, `${id}: invalid command`); return; }
        try { this.store.savepoint(() => this.host.invoke(plugin, source, ctx => plugin.handle(valid, ctx))); }
        catch { this.retain(source, message.text, `${id}: handler error`); }
        return;
      }
    }
    // A reply to the runtime's one open question continues that job. With several open, ask once which.
    // Only a message written after the question was sent (or while it was being sent) can be its answer.
    const asking = this.store.tasks(contact.id).filter(x => {
      const delivered = x.state === "waiting_contact" && x.waitingFor?.kind === "question"
        ? this.store.dispatchedAt(`task:${x.id}:turn:${x.usage.turns}:question`) : null;
      return delivered !== null && delivered <= message.sentAt;
    });
    if (asking.length === 1) { reply(this.followUp(contact, asking[0]!, message.text)); return; }
    if (asking.length > 1) { reply(`Which job is that for? Reply ${asking.map(x => `‘#${x.number} …’`).join(" or ")}.`); return; }
    this.retain(source, message.text, null);
  }

  /** Keeps the whole request as a task. Failed dispatches are recorded without message text and skip Jev. */
  private retain(source: DispatchSource, text: string, failure: string | null): void {
    const { number } = this.store.addTask({ contactId: source.contact.id, sourceGuid: source.sourceGuid, text, time: source.time,
      hint: null, failure, routable: failure === null });
    this.enqueue(source, `reply:${source.sourceGuid}`, failure
      ? `Something went wrong with that request. I kept it as job #${number}; reply ‘status’ to check or ‘cancel #${number}’ to remove it.`
      : this.runtimeFor(source.contact)
        ? `Got it — job #${number}. I'll message you when it's done or if I need you. Reply ‘status’ to check or ‘cancel #${number}’ to stop it.`
        : `Saved job #${number}. It is queued${this.queuedNote()}. Reply ‘status’ to check or ‘cancel #${number}’ to remove it.`);
  }

  /** Why a contact's queued jobs are not running. Only called for contacts without runtime access. */
  private queuedNote(): string {
    return this.runtime ? "; Codex jobs are for the owner only" : "; Codex execution is not connected yet";
  }

  private enqueue(source: Pick<DispatchSource, "contact" | "now">, key: string, text: string): void {
    this.store.enqueue({ key, contactId: source.contact.id, target: source.contact.conversation, text, kind: "reply", timer: null }, source.now);
  }
  private tell(contact: Contact, key: string, text: string): void { this.enqueue({ contact, now: this.clock() }, key, text); }

  private command(contact: Contact, command: EngineCommand): string {
    const tasks = () => this.store.tasks(contact.id);
    switch (command.kind) {
      case "cancel": {
        const task = tasks().find(x => x.number === command.id);
        if (!task || !this.store.cancelTask(contact.id, command.id)) return `No open job #${command.id} to cancel.`;
        this.store.cancelOutboxPrefix(`task:${task.id}:`);
        if (!this.active.has(task.id)) return `Cancelled job #${command.id}.`;
        this.stop(task);
        return `Stopped job #${command.id}. Anything it already did stays done.`;
      }
      case "stop": {
        const running = tasks().filter(x => this.active.has(x.id));
        for (const task of running) { this.store.cancelTask(contact.id, task.number); this.store.cancelOutboxPrefix(`task:${task.id}:`); this.stop(task); }
        return running.length ? `Stopped job ${running.map(x => `#${x.number}`).join(", ")}. Anything it already did stays done.`
          : "Nothing is running right now. Queued jobs stay queued; reply ‘cancel #1’ with a job's number to remove it.";
      }
      case "approve": case "deny": {
        // Each prompt carries its approval's code, so a reply can only ever decide the request it answers.
        const mine = this.store.approvals(contact.id);
        const number = (approval: ApprovalRecord) => this.store.task(approval.taskId)!.number;
        if (command.code === null) {
          const pending = mine.filter(x => x.status === "pending");
          if (pending.length === 1) return `Reply with the code from the request: ‘approve A${pending[0]!.id}’ or ‘deny A${pending[0]!.id}’.`;
          return pending.length ? `Reply with the code from the request, for example ‘${command.kind} A${pending[0]!.id}’.` : "No approval is pending.";
        }
        const approval = mine.find(x => x.id === command.code);
        if (approval?.status === "pending" && approval.expiresAt <= this.clock()) this.settle(approval, "expired");
        const current = approval && this.store.approvals(contact.id).find(x => x.id === approval.id)!;
        if (current?.status === "expired") return `The approval for job #${number(current)} expired, so it was refused.`;
        if (!current || current.status !== "pending") return `Approval A${command.code} is not pending.`;
        this.settle(current, command.kind === "approve" ? "approved" : "denied");
        return `${command.kind === "approve" ? "Approved" : "Denied"} A${current.id} for job #${number(current)}.`;
      }
      case "continue": {
        const paused = tasks().filter(x => x.state === "waiting_contact" && (x.waitingFor?.kind === "limit" || x.waitingFor?.kind === "interrupted")
          && (command.id === null || x.number === command.id));
        if (paused.length > 1) return "Several jobs are paused. Reply ‘continue #n’ with the job number.";
        const task = paused[0];
        if (!task) return command.id === null ? "No job is paused." : `Job #${command.id} isn't paused.`;
        const resume = task.waitingFor?.kind === "limit" ? CONTINUE_AFTER_LIMIT : CONTINUE_AFTER_INTERRUPTION;
        this.store.updateTask(task.id, { state: "routed", waitingFor: null, input: task.input ? `${resume}\n${task.input}` : resume,
          usage: task.waitingFor?.kind === "limit" ? { allowance: task.usage.allowance + 1 } : {} }, ["waiting_contact"]);
        return `Continuing job #${task.number}.`;
      }
      case "followUp": {
        const task = tasks().find(x => x.number === command.id);
        return task ? this.followUp(contact, task, command.text) : `No open job #${command.id}.`;
      }
      case "pause": this.store.setSetting(`pause:${contact.id}`, command.scope); return command.scope === "all"
        ? "All Nori reminder messages are paused. Reply ‘resume’ to restart them. Native app alerts are unchanged."
        : "Discretionary nudges are paused. Your requested reminders will still arrive.";
      case "resume": this.store.setSetting(`pause:${contact.id}`, "none"); return "Resumed. Requested reminders follow your quiet hours.";
      case "status": return this.status(contact);
      case "help": {
        const examples = [...this.host.examples(contact), "status", "pause all", "resume"].map(x => `‘${x}’`);
        return `Try ${examples.slice(0, -1).join(", ")}, or ${examples.at(-1)}. Other requests are saved as queued jobs.`;
      }
    }
  }

  /** Adds contact input to an open runtime job. An answer to its question makes it ready to resume. */
  private followUp(contact: Contact, task: Task, text: string): string {
    const waiting = task.state === "waiting_contact" ? task.waitingFor?.kind : null;
    if (waiting === "question") {
      this.store.appendInput(task.id, text);
      this.store.updateTask(task.id, { state: "routed", waitingFor: null }, ["waiting_contact"]);
      return `Thanks — continuing job #${task.number}.`;
    }
    if (task.state === "routed" || task.state === "running" || waiting === "approval") {
      this.store.appendInput(task.id, text);
      return `Added to job #${task.number}.`;
    }
    if (waiting === "limit" || waiting === "interrupted") return `Job #${task.number} is paused. Reply ‘continue #${task.number}’ to resume it first.`;
    // A queued job that will run in the runtime keeps the follow-up for its first turn.
    if (task.state === "queued" && task.failure === null && this.runtimeFor(contact)) {
      this.store.appendInput(task.id, text);
      return `Added to job #${task.number}.`;
    }
    if (task.state === "queued") return `Job #${task.number} is queued and can't take follow-ups yet.`;
    return `No open job #${task.number}.`;
  }

  /** Called inside a transaction after the task is cancelled: refuses its approvals and interrupts its turn. */
  private stop(task: Task): void {
    for (const approval of this.store.approvals(task.contactId)) if (approval.taskId === task.id && approval.status === "pending") this.settle(approval, "denied");
    this.later(() => this.cancelTurn(task.id));
  }

  /** Interrupts a turn. If the interrupt cannot be confirmed, closing the runtime stops the turn with its connection. */
  private cancelTurn(taskId: number): void {
    void this.runtime?.cancel(taskId).catch(() => { this.runtime?.close(); });
  }

  private status(contact: Contact): string {
    const now = this.clock();
    const source: DispatchSource = { contact, time: now, now, replyKey: () => "", timer: null, sourceGuid: null };
    const lines: string[] = [];
    for (const plugin of this.host.permitted(contact)) {
      if (!plugin.summary) continue;
      try {
        const summary: unknown = this.host.invoke(plugin, source, ctx => plugin.summary!(ctx), false);
        if (!Array.isArray(summary) || summary.some(line => typeof line !== "string")) throw new Error("Invalid summary.");
        lines.push(...summary as string[]);
      } catch { lines.push(`${plugin.manifest.id} status is unavailable.`); }
    }
    const tasks = this.store.tasks(contact.id);
    const numbers = (keep: (task: Task) => boolean) => tasks.filter(keep).map(x => `#${x.number}`);
    const waiting = (...kinds: Array<WaitingFor["kind"]>) => (x: Task) => x.state === "waiting_contact" && kinds.includes(x.waitingFor?.kind ?? "clarification");
    const queued = numbers(x => x.state === "queued");
    lines.push(`${queued.length} queued jobs.`);
    if (queued.length) lines.push(`Queued jobs: ${queued.slice(0, 5).join(", ")}${this.runtimeFor(contact) ? "" : this.queuedNote()}.`);
    const running = numbers(x => x.state === "running"); const replies = numbers(waiting("question", "clarification"));
    const approvals = numbers(waiting("approval")); const routed = numbers(x => x.state === "routed");
    if (running.length) lines.push(`Running: ${running.join(", ")}.`);
    if (replies.length) lines.push(`Waiting for your reply: ${replies.slice(0, 5).join(", ")}.`);
    if (approvals.length) lines.push(`Waiting for your approval: ${approvals.join(", ")}.`);
    for (const number of numbers(waiting("limit", "interrupted")).slice(0, 5)) lines.push(`Paused: ${number} (reply ‘continue ${number}’).`);
    if (routed.length) {
      lines.push(`Waiting to start: ${routed.slice(0, 5).join(", ")}.`);
      if (this.dailyLimitReached()) lines.push("Today's Codex limit is reached; waiting jobs start tomorrow.");
    }
    if (this.store.setting(`pause:${contact.id}`) === "all") lines.push("Reminder messages are paused.");
    const uncertain = this.store.outbox(contact.id).filter(x => x.status === "uncertain").length;
    if (uncertain) lines.push(`${uncertain} outgoing message(s) need delivery review; they will not be resent automatically.`);
    return lines.join("\n");
  }

  private dailyLimitReached(fresh = true): boolean {
    const limits = this.config.runtime; const day = localDay(this.clock(), this.config.timezone);
    return !!limits && (this.store.daily("runtime-tokens", day) >= limits.daily.tokens
      || (fresh && this.store.daily("runtime-tasks", day) >= limits.daily.tasks));
  }

  /** Approval expiry and runtime budgets. Runs on every poll, independently of a send batch that may be in flight. */
  maintain(): void {
    this.expireApprovals();
    this.enforceTime();
  }

  async tick(): Promise<void> {
    this.maintain();
    if (this.sending) return;
    this.sending = true;
    try {
      const contacts = this.activeContacts();
      this.fireTimers(contacts);
      const active = new Set(contacts.map(c => c.id));
      // A timer message is held while its plugin is not permitted, even if it fired before the permission was revoked.
      const permitted = (item: OutboxItem) => {
        const contact = contacts.find(c => c.id === item.contactId);
        const timer = item.timerId === null ? null : this.store.timers(item.contactId).find(x => x.id === item.timerId);
        return !!contact && !!timer && !!this.host.permits(contact, timer.pluginId);
      };
      // Bounded batch; recheck controls and timer revisions before each external send.
      for (let n = 0; n < 10; n++) {
        const now = this.clock(); const quiet = inQuietHours(now, this.config.timezone, this.config.quietHours);
        const item = this.store.claimOutgoing(now, item => active.has(item.contactId)
          && (item.kind === "reply" || (!quiet && this.store.setting(`pause:${item.contactId}`) !== "all" && permitted(item))));
        if (!item) break;
        let result: SendOutcome;
        try { result = await this.transport.send(item.target, item.text); }
        catch { result = { status: "uncertain", reason: "Transport ended without a confirmed result" }; }
        this.store.finishSend(item, result, this.clock());
      }
    } finally { this.sending = false; }
  }

  /** Each due timer fires at most once. Timers of inactive contacts or unpermitted plugins wait. */
  private fireTimers(contacts: readonly Contact[]): void {
    const now = this.clock();
    this.store.transaction(() => {
      for (const timer of this.store.dueTimers(now)) {
        const contact = contacts.find(c => c.id === timer.contactId);
        const plugin = contact && this.host.permits(contact, timer.pluginId);
        // An earlier fire in this batch may have cancelled or rescheduled this timer.
        if (!contact || !plugin || !this.store.markFired(timer.id, timer.revision)) continue;
        if (!plugin.onTimer) continue;
        const fire = { id: timer.id, revision: timer.revision };
        const source: DispatchSource = { contact, time: now, now, replyKey: n => `timer:${timer.id}:${timer.revision}:${n}`, timer: fire, sourceGuid: null };
        try { this.store.savepoint(() => this.host.invoke(plugin, source, ctx => plugin.onTimer!({ key: timer.key, at: timer.at, payload: timer.payload }, ctx))); }
        catch { this.store.markFailed(timer.id); }
      }
    });
  }

  /**
   * Records a decision for each queued task. Only an enabled, permitted, confident single action executes in a plugin.
   * Everything else goes to the runtime when the contact may use one; without a router, or past the Jev budget, only
   * those tasks are claimed.
   */
  async routeTasks(router: IntentRouter | null, shouldContinue: () => boolean = () => true): Promise<void> {
    this.store.promoteToRuntime(this.activeContacts().filter(c => this.runtimeFor(c)).map(c => c.id));
    for (let n = 0; n < 5 && shouldContinue(); n++) {
      const contacts = this.activeContacts();
      const claim = this.store.claimUnroutedTask(contacts.map(c => c.id), contacts.filter(c => this.runtimeFor(c)).map(c => c.id),
        localDay(this.clock(), this.config.timezone), router ? this.config.jev?.dailyLimit ?? Infinity : 0);
      if (!claim) break;
      const { task } = claim; const contact = contacts.find(c => c.id === task.contactId)!;
      let decision: RoutingDecision | null = null;
      if (claim.classify && router) {
        try { decision = await router.classify(task.text, { timezone: this.config.timezone, catalog: this.host.catalog(contact) }); }
        catch { /* Task stays queued or falls back to the runtime. */ }
      }
      this.store.saveDecision(task.id, decision);
      // The task is already claimed, so finish it even if the lifecycle gate closed meanwhile; it would never be routed again.
      const plugin = decision && this.actionFor(contact, task, decision);
      if (plugin) await this.dispatchTask(contact, task, plugin);
      // A retained plugin failure stays queued for review rather than being retried in the runtime.
      if (this.runtimeFor(contact) && this.store.task(task.id)?.failure === null) this.store.updateTask(task.id, { state: "routed" }, ["queued"]);
    }
  }

  /** A routing answer never authorizes an action; code checks authority after routing. */
  private actionFor(contact: Contact, task: Task, decision: RoutingDecision): ActionPlugin | null {
    if (decision.route.kind !== "action" || decision.multiAction || isCompound(task.text)) return null;
    const id = decision.route.pluginId; const routes = this.config.jev?.routes;
    if (!routes || !Object.hasOwn(routes, id) || !(decision.confidence >= routes[id]!)) return null;
    const plugin = this.host.permits(contact, id);
    return plugin?.interpret ? plugin : null;
  }

  private async dispatchTask(contact: Contact, task: Task, plugin: ActionPlugin): Promise<void> {
    const id = plugin.manifest.id;
    const source = (now: number): DispatchSource => ({ contact, time: task.time, now, replyKey: n => `task:${task.id}:${n}`,
      timer: null, sourceGuid: task.sourceGuid });
    if (this.store.task(task.id)?.state !== "queued") return;
    let result: Command | Clarification;
    try { result = await this.host.interpret(plugin, source(this.clock()), task.text); }
    catch { this.store.setTaskFailure(task.id, `${id}: interpret error`); return; }
    const now = this.clock();
    this.store.transaction(() => {
      if (this.store.task(task.id)?.state !== "queued") return;
      if (isClarification(result)) {
        this.enqueue(source(now), `task:${task.id}:question`, result.clarify);
        this.store.updateTask(task.id, { state: "waiting_contact", waitingFor: { kind: "clarification" } }, ["queued"]);
        return;
      }
      const command = this.host.validate(plugin, result);
      if (!command) { this.store.setTaskFailure(task.id, `${id}: invalid command`); return; }
      try { this.store.savepoint(() => this.host.invoke(plugin, source(now), ctx => plugin.handle(command, ctx))); }
      catch { this.store.setTaskFailure(task.id, `${id}: handler error`); return; }
      this.store.setTaskState(task.id, "queued", "completed");
    });
  }

  /**
   * Starts or resumes at most one runtime turn and resolves when it ends. Turns run one at a time; intake, timers, and
   * engine commands stay responsive meanwhile.
   */
  async runTasks(shouldContinue: () => boolean = () => true): Promise<void> {
    const runtime = this.runtime; const limits = this.config.runtime;
    if (!runtime || !limits || this.active.size || !shouldContinue()) return;
    const contacts = this.activeContacts().filter(c => this.runtimeFor(c));
    // The oldest job the daily limits allow: a new job blocked by the task limit does not hold up jobs resuming a thread.
    const task = this.store.tasks().find(x => x.state === "routed" && contacts.some(c => c.id === x.contactId)
      && !this.dailyLimitReached(x.threadId === null));
    if (!task) return;
    const contact = contacts.find(c => c.id === task.contactId)!;
    const fresh = task.threadId === null;
    // Every budget is checked before a turn starts, so no reply can start work past a limit without `continue #n`.
    const { usage } = task; const budget = limits.budget; const allowance = usage.allowance;
    const exhausted = usage.tokens >= budget.tokens * allowance ? "tokens" : usage.toolCalls >= budget.toolCalls * allowance ? "toolCalls"
      : usage.runMs >= budget.minutes * 60_000 * allowance ? "minutes" : usage.turns >= budget.turns * allowance ? "turns" : null;
    if (exhausted) {
      this.commit(() => {
        if (this.store.updateTask(task.id, { state: "waiting_contact", waitingFor: { kind: "limit", limit: exhausted } }, ["routed"]))
          this.tell(contact, `task:${task.id}:limit:${exhausted}:${usage.turns}`, this.limitMessage(task.number, exhausted));
      });
      return;
    }
    // The input stays on the task until the runtime accepts the turn, so a failed start loses nothing.
    const input = fresh ? (task.input ? `${task.text}\n${task.input}` : task.text) : task.input ?? CONTINUE_AFTER_LIMIT;
    const sent = fresh || task.input !== null ? input : null;
    const now = this.clock();
    let claimed = false;
    this.commit(() => {
      claimed = this.store.updateTask(task.id, { state: "running", input: sent, usage: { turns: task.usage.turns + 1 } }, ["routed"]);
      if (claimed && fresh) this.store.addDaily("runtime-tasks", localDay(now, this.config.timezone), 1);
    });
    if (!claimed) return;
    const turn: ActiveTurn = { taskId: task.id, since: now, approvals: new Map(), limit: null, gate: Promise.resolve(), sent };
    this.active.set(task.id, turn);
    let outcome: TurnOutcome;
    try {
      const current = this.store.task(task.id)!; const tools = this.host.tools(contact); const events = this.events(current, contact, turn);
      // Follow-ups sent before the first turn become part of the request.
      outcome = fresh ? await runtime.start({ ...current, text: input }, tools, events) : await runtime.resume(current, input, tools, events);
    } catch { outcome = { status: "interrupted" }; }
    this.finishTurn(contact, turn, outcome);
  }

  private events(task: Task, contact: Contact, turn: ActiveTurn): RuntimeEvents {
    const live = () => this.active.get(task.id) === turn;
    return {
      // Throws if the id cannot be saved, so the runtime does not start work Nori could not find again.
      started: ({ threadId, turnId }) => {
        if (!live()) return;
        this.store.updateTask(task.id, { threadId });
        if (turnId !== null && turn.sent !== null) { this.store.consumeInput(task.id, turn.sent); turn.sent = null; }
      },
      approval: async ({ operation, detail }) => this.requestApproval(task.id, contact, turn, operation, detail),
      tool: async call => {
        try { return await this.callTool(task.id, contact, turn, call); }
        catch { return { success: false, text: "The tool failed." }; }
      },
      activity: () => {
        if (!live()) return;
        const current = this.store.task(task.id)!; const toolCalls = current.usage.toolCalls + 1;
        this.store.updateTask(task.id, { usage: { toolCalls } });
        if (toolCalls > this.config.runtime!.budget.toolCalls * current.usage.allowance) this.interrupt(turn, { kind: "limit", limit: "toolCalls" });
      },
      usage: total => {
        if (!live() || !Number.isSafeInteger(total) || total < 0) return;
        const current = this.store.task(task.id)!; const limits = this.config.runtime!;
        const delta = total - current.usage.tokens;
        if (delta > 0) this.store.transaction(() => {
          this.store.updateTask(task.id, { usage: { tokens: total } });
          this.store.addDaily("runtime-tokens", localDay(this.clock(), this.config.timezone), delta);
        });
        if (total > limits.budget.tokens * current.usage.allowance) this.interrupt(turn, { kind: "limit", limit: "tokens" });
      },
    };
  }

  /**
   * Stops a turn for a budget. The task then waits for `continue #n`, which is not a failure. Safe to repeat: each call
   * re-sends the interrupt, in case an earlier one was lost.
   */
  private interrupt(turn: ActiveTurn, why: WaitingFor): void {
    turn.limit ??= why;
    // Pending approvals are refused durably and their prompts withdrawn, not just answered false.
    if (turn.approvals.size) this.commit(() => {
      for (const approval of this.store.approvals()) if (turn.approvals.has(approval.id)) this.settle(approval, "denied");
    });
    this.cancelTurn(turn.taskId);
  }

  /** Interrupts turns past their time budget, and re-sends the interrupt to turns already stopped for any budget. */
  private enforceTime(): void {
    const limits = this.config.runtime; const now = this.clock();
    if (!limits) return;
    for (const turn of this.active.values()) {
      const task = this.store.task(turn.taskId);
      if (task?.state === "cancelled") this.cancelTurn(turn.taskId);
      else if (turn.limit) this.interrupt(turn, turn.limit);
      else if (task && turn.since !== null && task.usage.runMs + now - turn.since > limits.budget.minutes * 60_000 * task.usage.allowance)
        this.interrupt(turn, { kind: "limit", limit: "minutes" });
    }
  }

  /** Whether the turn may still ask for approvals and call tools: active, not stopped for a budget, and not cancelled. */
  private open(taskId: number, turn: ActiveTurn): boolean {
    const state = this.store.task(taskId)?.state;
    return this.active.get(taskId) === turn && !turn.limit && (state === "running" || state === "waiting_contact");
  }

  private stopClock(turn: ActiveTurn): void {
    if (turn.since === null) return;
    const task = this.store.task(turn.taskId)!;
    this.store.updateTask(turn.taskId, { usage: { runMs: task.usage.runMs + this.clock() - turn.since } });
    turn.since = null;
  }

  /**
   * Binds the request to the contact, task, operation, parameters, and expiry, then holds the turn until it settles.
   * Requests on one job wait their turn, so only one is ever pending.
   */
  private requestApproval(taskId: number, contact: Contact, turn: ActiveTurn, operation: string, detail: string): Promise<boolean> {
    if (detail.length > MAX_APPROVAL_DETAIL) return Promise.resolve(false);
    const decision = turn.gate.then(() => this.ask(taskId, contact, turn, operation, detail));
    turn.gate = decision.then(() => undefined, () => undefined);
    return decision;
  }

  private ask(taskId: number, contact: Contact, turn: ActiveTurn, operation: string, detail: string): Promise<boolean> {
    const limits = this.config.runtime!; const now = this.clock();
    let approvalId: number | null = null;
    this.commit(() => {
      const task = this.store.task(taskId);
      if (!task || !this.open(taskId, turn)) return;
      this.stopClock(turn);
      approvalId = this.store.addApproval({ taskId, contactId: contact.id, operation, detail, createdAt: now,
        expiresAt: now + limits.approvalMinutes * 60_000 });
      this.store.updateTask(taskId, { state: "waiting_contact", waitingFor: { kind: "approval" } });
      this.tell(contact, `approval:${approvalId}`, `Job #${task.number} needs your OK to ${operation}: ${detail}\n`
        + `Reply ‘approve A${approvalId}’ or ‘deny A${approvalId}’ within ${limits.approvalMinutes} minutes.`);
    });
    const id = approvalId;
    if (id === null) return Promise.resolve(false);
    return new Promise(resolve => { turn.approvals.set(id, resolve); });
  }

  /** Called inside a transaction. The waiting turn is released only after the decision is committed. */
  private settle(approval: ApprovalRecord, status: "approved" | "denied" | "expired"): void {
    if (!this.store.settleApproval(approval.id, status)) return;
    this.store.cancelOutbox(`approval:${approval.id}`);
    const task = this.store.task(approval.taskId)!;
    const pending = this.store.approvals(task.contactId).some(x => x.taskId === task.id && x.status === "pending");
    if (!pending && task.state === "waiting_contact" && task.waitingFor?.kind === "approval")
      this.store.updateTask(task.id, { state: "running", waitingFor: null }, ["waiting_contact"]);
    const turn = this.active.get(task.id); const resolve = turn?.approvals.get(approval.id);
    if (!turn || !resolve) return;
    turn.approvals.delete(approval.id);
    this.later(() => {
      if (!turn.approvals.size && turn.since === null && this.active.get(task.id) === turn) turn.since = this.clock();
      resolve(status === "approved");
    });
  }

  private expireApprovals(): void {
    const now = this.clock();
    const expired = this.store.approvals().filter(x => x.status === "pending" && x.expiresAt <= now);
    if (expired.length) this.commit(() => { for (const approval of expired) this.settle(approval, "expired"); });
  }

  /**
   * The tool broker. Re-checks the contact's permission for the tool on every call, validates arguments against the
   * command schema, asks for approval on high-impact tools, and returns the plugin's replies as the result.
   */
  private async callTool(taskId: number, contact: Contact, turn: ActiveTurn, call: { callId: string; name: string; arguments: unknown }):
    Promise<{ success: boolean; text: string }> {
    const live = () => this.open(taskId, turn);
    if (!live() || typeof call.callId !== "string" || !call.callId) return { success: false, text: "The job is no longer running." };
    const previous = this.store.toolCall(taskId, call.callId);
    if (previous) return { success: previous.success, text: previous.result };
    const task = this.store.task(taskId)!;
    if (task.usage.toolCalls >= this.config.runtime!.budget.toolCalls * task.usage.allowance) {
      this.interrupt(turn, { kind: "limit", limit: "toolCalls" });
      return { success: false, text: "This job has used its tool-call budget." };
    }
    // Records the call once with its result. `run` executes the tool inside the same transaction and returns null on failure.
    const finish = (success: boolean, text: string, run?: () => string | null) => {
      this.store.transaction(() => {
        const existing = this.store.toolCall(taskId, call.callId);
        if (existing) { success = existing.success; text = existing.result; return; }
        if (run) { const output = run(); success = output !== null; text = output ?? "The tool failed."; }
        this.store.recordToolCall(taskId, { callId: call.callId, tool: String(call.name), success, result: text, arguments: call.arguments }, this.clock());
        this.store.updateTask(taskId, { usage: { toolCalls: this.store.task(taskId)!.usage.toolCalls + 1 } });
      });
      return { success, text };
    };
    const resolved = typeof call.name === "string" ? this.host.tool(contact, call.name) : null;
    if (!resolved) return finish(false, "Unknown or unavailable tool.");
    const args = record(call.arguments) && !Object.hasOwn(call.arguments, "kind") ? call.arguments : null;
    const command = args && this.host.validate(resolved.plugin, { ...args, kind: resolved.definition.kind });
    if (!command) return finish(false, "Invalid arguments for this tool.");
    if (resolved.definition.impact === "high") {
      const approved = await this.requestApproval(taskId, contact, turn,
        `use ${resolved.plugin.manifest.id} ‘${resolved.definition.kind}’`, JSON.stringify(args));
      if (!approved) return finish(false, "The person did not approve this.");
      if (!live()) return { success: false, text: "The job is no longer running." };
      // Other calls may have used the budget while this one waited for approval.
      const current = this.store.task(taskId)!;
      if (current.usage.toolCalls >= this.config.runtime!.budget.toolCalls * current.usage.allowance) {
        this.interrupt(turn, { kind: "limit", limit: "toolCalls" });
        return { success: false, text: "This job has used its tool-call budget." };
      }
    }
    const capture: string[] = []; const now = this.clock();
    const source: DispatchSource = { contact, time: now, now, replyKey: () => "", timer: null, sourceGuid: task.sourceGuid, capture };
    return finish(true, "", () => {
      try { this.store.savepoint(() => this.host.invoke(resolved.plugin, source, ctx => resolved.plugin.handle(command, ctx))); }
      catch { return null; }
      return capture.join("\n") || "Done.";
    });
  }

  /** Applies a turn's outcome. Only a completed outcome, which the runtime must back with evidence, completes the task. */
  private finishTurn(contact: Contact, turn: ActiveTurn, outcome: TurnOutcome): void {
    this.active.delete(turn.taskId);
    for (const resolve of turn.approvals.values()) resolve(false);
    this.commit(() => {
      if (turn.since !== null) this.stopClock(turn);
      for (const approval of this.store.approvals(contact.id))
        if (approval.taskId === turn.taskId && approval.status === "pending") this.settle(approval, "denied");
      if (outcome.status !== "interrupted" && turn.sent !== null) this.store.consumeInput(turn.taskId, turn.sent);
      const task = this.store.task(turn.taskId);
      if (!task || task.state === "cancelled") return;
      const n = task.number; const key = (suffix: string) => `task:${task.id}:turn:${task.usage.turns}:${suffix}`;
      // A budget stop holds even if the turn finished with a question or failure at the same moment.
      if (turn.limit?.kind === "limit" && outcome.status !== "completed") {
        this.store.updateTask(task.id, { state: "waiting_contact", waitingFor: turn.limit });
        this.tell(contact, key("limit"), this.limitMessage(n, turn.limit.limit));
        return;
      }
      // Follow-ups that arrived during the turn start another one.
      const next = task.input !== null ? "routed" : null;
      switch (outcome.status) {
        case "completed":
          if (!outcome.evidence.length) {
            this.store.updateTask(task.id, { state: "failed", waitingFor: null, outcome: outcome.message });
            this.tell(contact, key("failed"), `Job #${n} couldn't be finished: ${outcome.message} (It reported no checks, so it is not marked done.)`);
            return;
          }
          this.store.updateTask(task.id, { state: next ?? "completed", waitingFor: null, outcome: outcome.message, evidence: outcome.evidence });
          this.tell(contact, key("done"), `Job #${n} is done. ${outcome.message}`);
          return;
        case "needs_input":
          // A question always waits for the contact. Input sent during the turn stays queued and goes with the answer.
          this.store.updateTask(task.id, { state: "waiting_contact", waitingFor: { kind: "question" }, outcome: outcome.message });
          this.tell(contact, key("question"), `Job #${n} asks: ${outcome.message}\nReply to answer it.`);
          return;
        case "failed":
          this.store.updateTask(task.id, { state: "failed", waitingFor: null, outcome: outcome.message });
          this.tell(contact, key("failed"), `Job #${n} couldn't be finished: ${outcome.message}`);
          return;
        case "interrupted": {
          const why = turn.limit ?? { kind: "interrupted" };
          this.store.updateTask(task.id, { state: "waiting_contact", waitingFor: why });
          this.tell(contact, key(why.kind), why.kind === "limit" ? this.limitMessage(n, why.limit) : this.interruptedMessage(n));
        }
      }
    });
  }

  private limitMessage(n: number, limit: keyof Budget): string {
    return `Job #${n} reached its ${LIMIT_LABELS[limit]} limit. Reply ‘continue #${n}’ to allow more, or ‘cancel #${n}’.`;
  }
  private interruptedMessage(n: number): string {
    return `Job #${n} was interrupted before it finished. Reply ‘continue #${n}’ to resume it (it will check what was already done first), or ‘cancel #${n}’.`;
  }

  /**
   * After a restart, turns that were active are gone. Their tasks wait for `continue #n` rather than resubmitting work
   * whose effects are unknown, and their pending approvals expire.
   */
  recoverRuntime(): void {
    if (this.active.size) throw new Error("Recover runtime state only before starting turns.");
    this.commit(() => {
      for (const approval of this.store.approvals()) if (approval.status === "pending") this.settle(approval, "expired");
      for (const task of this.store.tasks()) {
        if (!(task.state === "running" || (task.state === "waiting_contact" && task.waitingFor?.kind === "approval"))) continue;
        this.store.updateTask(task.id, { state: "waiting_contact", waitingFor: { kind: "interrupted" } });
        const contact = this.contacts.find(c => c.id === task.contactId);
        if (contact) this.tell(contact, `task:${task.id}:turn:${task.usage.turns}:interrupted`, this.interruptedMessage(task.number));
      }
    });
  }
}
