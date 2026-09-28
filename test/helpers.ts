import type { Config, Message, MessagePage, MessageTransport, SendOutcome } from "../src/contracts.js";

export const epoch = Date.parse("2026-09-28T16:00:00Z");
export const config: Config = {
  assistantUser: "receipts",
  owner: { handles: ["owner@example.com"], chatId: 42, chatGuid: "iMessage;-;owner@example.com" },
  timezone: "America/Los_Angeles", dataDir: "/tmp/nori-test", imsgPath: "/usr/local/bin/imsg",
  pollMs: 1000, quietHours: null, jev: null,
};
export function message(text: string, rowId = 1, overrides: Partial<Message> = {}): Message {
  return { guid: `guid-${rowId}`, rowId, chatId: 42, chatGuid: config.owner.chatGuid,
    sender: "owner@example.com", isFromMe: false, isGroup: false, text, sentAt: epoch, ...overrides };
}
export function page(messages: Message[], nextCursor = messages.at(-1)?.rowId ?? 0): MessagePage {
  return { messages, nextCursor, hasMore: false };
}
export class FakeTransport implements MessageTransport {
  sent: string[] = [];
  outcomes: SendOutcome[] = [];
  async readiness() { return { ready: true, detail: "test" }; }
  async readAfter(cursor: number) { return page([], cursor); }
  async send(text: string): Promise<SendOutcome> {
    this.sent.push(text);
    return this.outcomes.shift() ?? { status: "sent", messageGuid: `out-${this.sent.length}` };
  }
  close() {}
}
