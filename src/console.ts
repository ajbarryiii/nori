import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CONSOLE_CONTACT } from "./config.js";
import type { Conversation, Message, MessagePage, MessageTransport, SendOutcome } from "./contracts.js";

/**
 * Development transport: each non-empty input line is one message from the console contact; replies print to the
 * output stream. It never touches iMessage. Only for local testing of the real service loop, stores, and configured models.
 */
export class ConsoleTransport implements MessageTransport {
  private queue: Message[] = [];
  private rowId: number;
  private readonly lines: Interface;
  readonly ended: Promise<void>;
  constructor(private readonly options: { input: Readable; output: Writable; startRowId: number; clock?: () => number }) {
    this.rowId = options.startRowId;
    this.lines = createInterface({ input: options.input, terminal: false });
    this.ended = new Promise(resolve => { this.lines.once("close", () => resolve()); });
    this.lines.on("line", line => {
      const text = line.trim();
      if (!text) return;
      this.queue.push({ guid: `console-${randomUUID()}`, rowId: ++this.rowId, ...CONSOLE_CONTACT.conversation,
        sender: CONSOLE_CONTACT.handles[0]!, isFromMe: false, isGroup: false, text, sentAt: (options.clock ?? Date.now)() });
    });
  }
  get lastRowId(): number { return this.rowId; }
  async readiness(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: "Console transport for local development. iMessage is not used." };
  }
  async readAfter(_conversation: Conversation, cursor: number): Promise<MessagePage> {
    this.queue = this.queue.filter(m => m.rowId > cursor);
    const messages = [...this.queue];
    return { messages, nextCursor: Math.max(cursor, messages.at(-1)?.rowId ?? cursor), hasMore: false };
  }
  async send(_target: Conversation, text: string): Promise<SendOutcome> {
    this.options.output.write(`Nori: ${text}\n`);
    return { status: "sent", messageGuid: `console-out-${randomUUID()}` };
  }
  close(): void { this.lines.close(); }
}
