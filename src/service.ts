import { setTimeout as delay } from "node:timers/promises";
import { normalizeHandle } from "./config.js";
import { Coordinator } from "./coordinator.js";
import type { Config, IntentRouter, Message, MessageTransport } from "./contracts.js";
import { assertIdentity } from "./runtime.js";
import { Store } from "./store.js";

function isOwner(config: Config, message: Message): boolean {
  try { return !message.isFromMe && !message.isGroup && message.chatId === config.owner.chatId
    && message.chatGuid === config.owner.chatGuid && config.owner.handles.includes(normalizeHandle(message.sender)); }
  catch { return false; }
}

export async function enroll(config: Config, store: Store, transport: MessageTransport, identity: () => string): Promise<void> {
  if (store.cursor() !== null) throw new Error("Already enrolled. Review existing state before changing enrollment.");
  const expected = identity(); let cursor = 0; let ownerSeen = false;
  for (let pages = 0; pages < 1000; pages++) {
    assertIdentity(expected, identity());
    const page = await transport.readAfter(cursor);
    assertIdentity(expected, identity());
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || (page.hasMore && page.nextCursor === cursor)) throw new Error("Invalid enrollment cursor.");
    ownerSeen ||= page.messages.some(message => isOwner(config, message));
    cursor = page.nextCursor;
    if (!page.hasMore) {
      if (!ownerSeen) throw new Error("Enrollment needs an inbound message from the configured owner in this direct chat. Send a setup greeting first.");
      store.enroll(expected, cursor); return;
    }
  }
  throw new Error("Enrollment scan exceeded its limit. No watermark was saved.");
}

export async function catchUp(store: Store, core: Coordinator, transport: MessageTransport,
  checkIdentity: () => void, maxPages = 20): Promise<boolean> {
  for (let n = 0; n < maxPages; n++) {
    checkIdentity(); const cursor = store.cursor();
    if (cursor === null) throw new Error("Enroll before running the service.");
    const page = await transport.readAfter(cursor);
    checkIdentity(); core.acceptPage(page);
    if (!page.hasMore) return true;
  }
  return false;
}

export async function runService(options: { config: Config; store: Store; transport: MessageTransport;
  checkIdentity: () => void; signal: AbortSignal; router?: IntentRouter;
  wait?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<void> {
  const { config, store, transport, checkIdentity, signal, router } = options;
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  let caughtUp = false; let stopped = false; let failure: unknown;
  let sending: Promise<void> | null = null; let routing: Promise<void> | null = null;
  const guarded: MessageTransport = {
    readiness: () => transport.readiness(), readAfter: cursor => transport.readAfter(cursor), close: () => transport.close(),
    send: async text => {
      if (stopped || signal.aborted || !caughtUp) return { status: "not_started", reason: "Service paused before dispatch" };
      try { checkIdentity(); } catch (error) { failure = error; throw error; }
      return transport.send(text);
    },
  };
  const core = new Coordinator(config, store, guarded);
  const stop = () => { stopped = true; transport.close(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    store.recoverInFlight();
    while (!signal.aborted && !stopped) {
      if (failure) throw failure;
      caughtUp = false;
      caughtUp = await catchUp(store, core, transport, checkIdentity);
      if (caughtUp && !signal.aborted && !failure) {
        sending ??= core.tick().catch(error => { failure = error; }).finally(() => { sending = null; });
        if (router) routing ??= core.routeJobs(router).catch(error => { failure = error; }).finally(() => { routing = null; });
      }
      await wait(config.pollMs, signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally {
    stop(); signal.removeEventListener("abort", stop);
    await Promise.allSettled([sending, routing]);
    store.recoverInFlight();
  }
}
