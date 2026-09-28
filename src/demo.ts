import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, MessageTransport } from "./contracts.js";
import { Coordinator } from "./coordinator.js";
import { Store } from "./store.js";

export async function demo(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "nori-demo-"));
  const config: Config = { assistantUser: "receipts", dataDir, imsgPath: "/unused/demo", pollMs: 5000,
    owner: { handles: ["demo@example.com"], chatId: 1, chatGuid: "iMessage;-;demo@example.com" },
    timezone: "America/Los_Angeles", quietHours: null, jev: null };
  const store = new Store(join(dataDir, "state.sqlite")); let now = Date.parse("2026-09-28T16:00:00Z"); let id = 0; let sent = 0;
  const transport: MessageTransport = { readiness: async () => ({ ready: true, detail: "Synthetic transport" }),
    readAfter: async cursor => ({ messages: [], nextCursor: cursor, hasMore: false }), close: () => {},
    send: async text => { console.log(`Nori: ${text}`); return { status: "sent", messageGuid: `demo-out-${++sent}` }; } };
  try {
    store.enroll("synthetic-demo", 0); const core = new Coordinator(config, store, transport, () => now);
    const say = async (text: string) => {
      console.log(`You: ${text}`); id++;
      core.acceptPage({ messages: [{ guid: `demo-${id}`, rowId: id, chatId: 1, chatGuid: config.owner.chatGuid,
        sender: "demo@example.com", isFromMe: false, isGroup: false, text, sentAt: now }], nextCursor: id, hasMore: false });
      await core.tick();
    };
    console.log("Nori synthetic demo. No messages or model requests leave this process.\n");
    await say("remind me to stretch in 1 minute");
    now += 60_000; console.log("[Clock advances one minute]"); await core.tick();
    await say("snooze #1 20m"); await say("done #1");
    await say("help me compare options for replacing my laptop"); await say("status");
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}
