import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Contact, MessageTransport } from "./contracts.js";
import { Engine } from "./engine.js";
import { Store } from "./store.js";

export async function demo(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "nori-demo-"));
  const contact: Contact = { id: "demo", name: "Demo", handles: ["demo@example.com"], role: "owner", plugins: ["reminders"],
    conversation: { chatId: 1, chatGuid: "iMessage;-;demo@example.com" } };
  const config: Config = { assistantUser: "receipts", dataDir, imsgPath: "/unused/demo", pollMs: 5000, contacts: [contact],
    timezone: "America/Los_Angeles", quietHours: null, jev: null, responder: null, runtime: null };
  const store = new Store(join(dataDir, "state.sqlite")); let now = Date.parse("2026-09-28T16:00:00Z"); let id = 0; let sent = 0;
  const transport: MessageTransport = { readiness: async () => ({ ready: true, detail: "Synthetic transport" }),
    readAfter: async (_conversation, cursor) => ({ messages: [], nextCursor: cursor, hasMore: false }), close: () => {},
    send: async (_target, text) => { console.log(`Nori: ${text}`); return { status: "sent", messageGuid: `demo-out-${++sent}` }; } };
  try {
    store.enroll("synthetic-demo", contact.id, contact.conversation, 0); const core = new Engine(config, store, transport, { clock: () => now });
    const say = async (text: string) => {
      console.log(`You: ${text}`); id++;
      core.acceptPage(contact.id, { messages: [{ guid: `demo-${id}`, rowId: id, chatId: 1, chatGuid: contact.conversation.chatGuid,
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
