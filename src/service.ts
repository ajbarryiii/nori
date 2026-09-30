import { setTimeout as delay } from "node:timers/promises";
import { normalizeHandle } from "./config.js";
import { Engine } from "./engine.js";
import type { ActionPlugin, Config, Contact, IntentRouter, Message, MessageTransport, Runtime } from "./contracts.js";
import { assertIdentity } from "./runtime.js";
import { Store } from "./store.js";

function isFrom(contact: Contact, message: Message): boolean {
  try { return !message.isFromMe && !message.isGroup && message.chatId === contact.conversation.chatId
    && message.chatGuid === contact.conversation.chatGuid && contact.handles.includes(normalizeHandle(message.sender)); }
  catch { return false; }
}

/** Operator-only: scans one contact's conversation to its tail without executing or retaining history. */
export async function enroll(config: Config, store: Store, transport: MessageTransport, identity: () => string, contactId: string): Promise<void> {
  const contact = config.contacts.find(c => c.id === contactId);
  if (!contact) throw new Error(`Unknown contact ${contactId}. Add it to contacts in the configuration first.`);
  if (store.enrollment(contactId)) throw new Error(`Contact ${contactId} is already enrolled. Review existing state before changing enrollment.`);
  const expected = identity(); const stored = store.identity();
  if (stored !== null) assertIdentity(stored, expected);
  let cursor = 0; let seen = false;
  for (let pages = 0; pages < 1000; pages++) {
    assertIdentity(expected, identity());
    const page = await transport.readAfter(contact.conversation, cursor);
    assertIdentity(expected, identity());
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || (page.hasMore && page.nextCursor === cursor)) throw new Error("Invalid enrollment cursor.");
    seen ||= page.messages.some(message => isFrom(contact, message));
    cursor = page.nextCursor;
    if (!page.hasMore) {
      if (!seen) throw new Error("Enrollment needs an inbound message from this contact in its direct chat. Send a setup greeting first.");
      store.enroll(expected, contactId, contact.conversation, cursor); return;
    }
  }
  throw new Error("Enrollment scan exceeded its limit. No watermark was saved.");
}

/** Reads every enrolled conversation. Returns true only when all of them reached their tail. */
export async function catchUp(store: Store, engine: Engine, transport: MessageTransport,
  checkIdentity: () => void, maxPages = 20): Promise<boolean> {
  let complete = true;
  for (const contact of engine.activeContacts()) {
    let reached = false;
    for (let n = 0; n < maxPages && !reached; n++) {
      checkIdentity(); const cursor = store.enrollment(contact.id)!.cursor;
      const page = await transport.readAfter(contact.conversation, cursor);
      checkIdentity(); engine.acceptPage(contact.id, page);
      reached = !page.hasMore;
    }
    complete &&= reached;
  }
  return complete;
}

export async function runService(options: { config: Config; store: Store; transport: MessageTransport;
  checkIdentity: () => void; signal: AbortSignal; router?: IntentRouter; plugins?: readonly ActionPlugin[]; runtime?: Runtime;
  wait?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<void> {
  const { config, store, transport, checkIdentity, signal, router, runtime } = options;
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  let caughtUp = false; let stopped = false; let failure: unknown;
  let sending: Promise<void> | null = null; let routing: Promise<void> | null = null;
  // One entry per runTasks call that still has turns running; each poll may start more while free slots remain.
  const working = new Set<Promise<void>>();
  const canDispatch = () => !stopped && !signal.aborted && caughtUp && !failure;
  const guarded: MessageTransport = {
    readiness: () => transport.readiness(), readAfter: (conversation, cursor) => transport.readAfter(conversation, cursor),
    close: () => transport.close(),
    send: async (target, text) => {
      if (!canDispatch()) return { status: "not_started", reason: "Service paused before dispatch" };
      try { checkIdentity(); } catch (error) {
        failure = error;
        return { status: "not_started", reason: "Identity check failed before dispatch" };
      }
      try {
        const result = await transport.send(target, text);
        if (result.status === "uncertain") failure = new Error("Transport send outcome is uncertain. Review delivery before restarting.");
        return result;
      } catch {
        failure = new Error("Transport send failed without a confirmed result. Review delivery before restarting.");
        return { status: "uncertain", reason: "Transport ended without a confirmed send result" };
      }
    },
  };
  const core = new Engine(config, store, guarded, { ...(options.plugins ? { plugins: options.plugins } : {}), ...(runtime ? { runtime } : {}) });
  // Shutting the runtime down ends active turns, which leaves their tasks interrupted until the contact continues them.
  const stop = () => { stopped = true; transport.close(); return runtime?.shutdown(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    store.recoverInFlight();
    core.recoverRuntime();
    while (!signal.aborted && !stopped) {
      if (runtime?.halted) failure ??= new Error(runtime.halted);
      if (failure) throw failure;
      caughtUp = false;
      caughtUp = await catchUp(store, core, transport, checkIdentity);
      core.maintain();
      if (caughtUp && !signal.aborted && !failure) {
        sending ??= core.tick().catch(error => { failure = error; }).finally(() => { sending = null; });
        if (router || (runtime && config.runtime))
          routing ??= core.routeTasks(router ?? null, canDispatch).catch(error => { failure = error; }).finally(() => { routing = null; });
        if (runtime && config.runtime) {
          const run: Promise<void> = core.runTasks(canDispatch).catch(error => { failure = error; }).finally(() => { working.delete(run); });
          working.add(run);
        }
      }
      await wait(config.pollMs, signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally {
    // The caller releases the service lock after this returns, so wait until the runtime's processes have exited.
    const closed = stop(); signal.removeEventListener("abort", stop);
    await Promise.allSettled([sending, routing, ...working, core.idle(), closed]);
    store.recoverInFlight();
  }
  // Even after a requested stop: the operator must check for Codex commands still running before Nori runs again.
  if (runtime?.halted) throw new Error(runtime.halted);
}
