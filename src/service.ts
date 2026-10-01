import { setTimeout as delay } from "node:timers/promises";
import { normalizeHandle } from "./config.js";
import { Engine } from "./engine.js";
import type { ActionPlugin, Config, Contact, ConversationPort, IntentRouter, Message, MessageTransport, Runtime } from "./contracts.js";
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

/**
 * Runs until the signal aborts or a failure stops it. With `until`, it also stops once `until()` holds and the service is
 * idle: caught up, with nothing being sent, routed, understood, or run, no pending messages, no tasks waiting to be routed,
 * and no unsent replies. The development console uses this to exit cleanly at the end of its input.
 */
export async function runService(options: { config: Config; store: Store; transport: MessageTransport;
  checkIdentity: () => void; signal: AbortSignal; router?: IntentRouter | undefined; plugins?: readonly ActionPlugin[]; runtime?: Runtime;
  conversation?: ConversationPort | undefined; until?: () => boolean; wait?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<void> {
  const { config, store, transport, checkIdentity, signal, router, runtime, conversation } = options;
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  let caughtUp = false; let stopped = false; let failure: unknown;
  let sending: Promise<void> | null = null; let routing: Promise<void> | null = null;
  // Drains started by each poll. The engine skips contacts already draining, so a slow model call holds only its own contact.
  const understanding = new Set<Promise<void>>();
  // Model calls stop on shutdown and on any failure, not only on the external signal.
  const work = new AbortController();
  const fail = (error: unknown) => { failure ??= error; work.abort(); };
  const canWork = () => !stopped && !signal.aborted && !failure;
  // One entry per runTasks call that still has turns running; each poll may start more while free slots remain.
  const working = new Set<Promise<void>>();
  const canDispatch = () => !stopped && !signal.aborted && caughtUp && !failure;
  const idle = () => caughtUp && !sending && !routing && !understanding.size && !working.size && !store.hasPendingMessages()
    && !((router || (runtime && config.runtime)) && store.unroutedTasks().length)
    && !store.outbox().some(x => x.kind === "reply" && ["drafting", "pending", "sending"].includes(x.status));
  const guarded: MessageTransport = {
    readiness: () => transport.readiness(), readAfter: (conversation, cursor) => transport.readAfter(conversation, cursor),
    close: () => transport.close(),
    send: async (target, text) => {
      if (!canDispatch()) return { status: "not_started", reason: "Service paused before dispatch" };
      try { checkIdentity(); } catch (error) {
        fail(error);
        return { status: "not_started", reason: "Identity check failed before dispatch" };
      }
      try {
        const result = await transport.send(target, text);
        if (result.status === "uncertain") fail(new Error("Transport send outcome is uncertain. Review delivery before restarting."));
        return result;
      } catch {
        fail(new Error("Transport send failed without a confirmed result. Review delivery before restarting."));
        return { status: "uncertain", reason: "Transport ended without a confirmed send result" };
      }
    },
  };
  const core = new Engine(config, store, guarded, { ...(options.plugins ? { plugins: options.plugins } : {}), ...(runtime ? { runtime } : {}),
    ...(conversation ? { conversation } : {}) });
  // Shutting the runtime down ends active turns, which leaves their tasks interrupted until the contact continues them.
  const stop = () => { stopped = true; work.abort(); transport.close(); return runtime?.shutdown(); };
  const startSending = () => { sending ??= core.tick().catch(fail).finally(() => { sending = null; }); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    store.recoverInFlight();
    core.recoverRuntime();
    while (!signal.aborted && !stopped) {
      if (runtime?.halted) fail(new Error(runtime.halted));
      if (failure) throw failure;
      caughtUp = false;
      caughtUp = await catchUp(store, core, transport, checkIdentity);
      core.maintain();
      if (caughtUp && !signal.aborted && !failure) {
        // Pending messages drain in order; model calls see the service's signal so shutdown and failures abort them.
        const drain: Promise<void> = core.processPending(canWork, work.signal).catch(fail)
          .finally(() => { understanding.delete(drain); if (canDispatch()) startSending(); });
        understanding.add(drain);
        startSending();
        if (router || (runtime && config.runtime))
          routing ??= core.routeTasks(router ?? null, canDispatch).catch(fail).finally(() => { routing = null; });
        if (runtime && config.runtime) {
          const run: Promise<void> = core.runTasks(canDispatch).catch(fail).finally(() => { working.delete(run); });
          working.add(run);
        }
      }
      await wait(config.pollMs, signal);
      if (options.until?.() && idle()) break;
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally {
    // The caller releases the service lock after this returns, so wait until the runtime's processes have exited.
    const closed = stop(); signal.removeEventListener("abort", stop);
    await Promise.allSettled([sending, routing, ...understanding, ...working, core.idle(), closed]);
    // A send started as understanding finished may still be in flight.
    await Promise.allSettled([sending]);
    store.recoverInFlight();
  }
  // Even after a requested stop: the operator must check for Codex commands still running before Nori runs again.
  if (runtime?.halted) throw new Error(runtime.halted);
}
