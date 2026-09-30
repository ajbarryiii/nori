import type { Conversation, Message, MessagePage, MessageTransport, RpcPort, SendOutcome } from "./contracts.js";
import { object as record } from "./config.js";
import { RpcError } from "./rpc.js";
import { Temporal } from "@js-temporal/polyfill";

export function decodeMessage(value: unknown): Message | null {
  const row = record(value);
  if (!row || !Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !Number.isSafeInteger(row.chat_id) || Number(row.chat_id) <= 0
    || typeof row.guid !== "string" || !row.guid || typeof row.chat_guid !== "string" || !row.chat_guid
    || typeof row.sender !== "string" || typeof row.is_from_me !== "boolean" || typeof row.is_group !== "boolean"
    || typeof row.text !== "string" || typeof row.created_at !== "string" || row.is_reaction === true) return null;
  let sentAt: number;
  try { sentAt = Temporal.Instant.from(row.created_at).epochMilliseconds; } catch { return null; }
  return { guid: row.guid, rowId: Number(row.id), chatId: Number(row.chat_id), chatGuid: row.chat_guid,
    sender: row.sender, isFromMe: row.is_from_me, isGroup: row.is_group, text: row.text, sentAt };
}

/** Reads and sends only in the configured direct conversations. */
export class ImessageTransport implements MessageTransport {
  private readonly conversations: readonly Conversation[];
  constructor(private readonly rpc: RpcPort, conversations: readonly Conversation[]) {
    this.conversations = conversations.map(c => ({ ...c }));
  }
  private configured(target: Conversation): boolean {
    return this.conversations.some(c => c.chatId === target.chatId && c.chatGuid === target.chatGuid);
  }
  async readiness(): Promise<{ ready: boolean; detail: string }> {
    const status = record(await this.rpc.request("status", {}));
    const database = record(status?.database);
    const methods = status?.methods;
    const ready = database?.ready === true && Array.isArray(methods) && ["messages.after", "send", "messages.history"].every(m => methods.includes(m));
    return { ready, detail: ready ? "Messages database and required RPC methods are available." : "imsg needs database access and status/messages.after/messages.history/send support." };
  }
  async readAfter(conversation: Conversation, cursor: number): Promise<MessagePage> {
    if (!this.configured(conversation)) throw new Error("Refusing to read a conversation that is not configured.");
    const response = record(await this.rpc.request("messages.after", { since_rowid: cursor, chat_id: conversation.chatId, limit: 100, attachments: false }));
    if (!response || !Array.isArray(response.messages) || !Number.isSafeInteger(response.next_rowid)
      || Number(response.next_rowid) < cursor || typeof response.has_more !== "boolean"
      || (response.has_more && Number(response.next_rowid) === cursor)) throw new Error("Invalid imsg catch-up cursor.");
    const nextCursor = Number(response.next_rowid);
    const messages = response.messages.map(decodeMessage).filter((m): m is Message => m !== null);
    if (messages.some(m => m.rowId > nextCursor)) throw new Error("imsg returned a message beyond its scan cursor.");
    return { messages, nextCursor, hasMore: response.has_more };
  }
  async send(target: Conversation, text: string): Promise<SendOutcome> {
    if (!this.configured(target)) return { status: "not_started", reason: "Target is not a configured conversation" };
    try {
      const response = record(await this.rpc.request("send", { chat_guid: target.chatGuid, text,
        transport: "applescript", allow_sms_fallback: false }));
      if (response?.ok === true && typeof response.guid === "string" && response.guid.trim())
        return { status: "sent", messageGuid: response.guid };
      return { status: "uncertain", reason: "Send response did not contain a confirmed message GUID" };
    } catch (error) {
      if (error instanceof RpcError && record(error.data)?.disposition === "not_started")
        return { status: "not_started", reason: "imsg confirmed dispatch did not begin" };
      return { status: "uncertain", reason: "imsg ended without a confirmed send result" };
    }
  }
  close(): void { this.rpc.close(); }
}
