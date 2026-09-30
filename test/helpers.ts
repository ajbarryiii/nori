import type { Config, Contact, Conversation, Message, MessagePage, MessageTransport, SendOutcome } from "../src/contracts.js";
import type { Store } from "../src/store.js";
import type { Reminder } from "../src/plugins/reminders.js";

export const epoch = Date.parse("2026-09-28T16:00:00Z");
export const owner: Contact = {
  id: "owner", name: "Owner", handles: ["owner@example.com"],
  conversation: { chatId: 42, chatGuid: "iMessage;-;owner@example.com" }, role: "owner", plugins: ["reminders"],
};
export const member: Contact = {
  id: "sam", name: "Sam", handles: ["+15555550123"],
  conversation: { chatId: 43, chatGuid: "iMessage;-;+15555550123" }, role: "member", plugins: ["reminders"],
};
export const config: Config = {
  assistantUser: "receipts", contacts: [owner],
  timezone: "America/Los_Angeles", dataDir: "/tmp/nori-test", imsgPath: "/usr/local/bin/imsg",
  pollMs: 1000, quietHours: null, jev: null, runtime: null,
};
export function message(text: string, rowId = 1, overrides: Partial<Message> = {}): Message {
  return messageFrom(owner, text, rowId, overrides);
}
export function messageFrom(contact: Contact, text: string, rowId = 1, overrides: Partial<Message> = {}): Message {
  return { guid: `guid-${rowId}`, rowId, chatId: contact.conversation.chatId, chatGuid: contact.conversation.chatGuid,
    sender: contact.handles[0]!, isFromMe: false, isGroup: false, text, sentAt: epoch, ...overrides };
}
export function page(messages: Message[], nextCursor = messages.at(-1)?.rowId ?? 0): MessagePage {
  return { messages, nextCursor, hasMore: false };
}
export function enroll(store: Store, contact: Contact = owner, cursor = 0, identity = "test-db"): void {
  store.enroll(identity, contact.id, contact.conversation, cursor);
}
export function reminders(store: Store, contact: Contact = owner): Reminder[] {
  return store.stateList<Reminder>("reminders", contact.id, "reminder:");
}
export class FakeTransport implements MessageTransport {
  sent: string[] = [];
  targets: Conversation[] = [];
  outcomes: SendOutcome[] = [];
  async readiness() { return { ready: true, detail: "test" }; }
  async readAfter(_conversation: Conversation, cursor: number) { return page([], cursor); }
  async send(target: Conversation, text: string): Promise<SendOutcome> {
    this.sent.push(text); this.targets.push(target);
    return this.outcomes.shift() ?? { status: "sent", messageGuid: `out-${this.sent.length}` };
  }
  close() {}
}
