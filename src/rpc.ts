import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RpcHandlers, RpcPort } from "./contracts.js";
import { object as record } from "./config.js";

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown = null) { super(message); }
}

/**
 * Bounded, fail-closed JSONL subprocess client. Server-initiated requests are refused unless a handler answers them;
 * a handler error becomes a generic error response.
 */
export class StdioRpc implements RpcPort {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  constructor(private readonly options: { command: string; args: string[]; timeoutMs: number; jsonrpc?: boolean;
    env?: NodeJS.ProcessEnv; handlers?: RpcHandlers }) {
    this.child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"], shell: false, ...(options.env ? { env: options.env } : {}) });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Drain diagnostics without copying provider messages or credentials to our logs.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.close());
    this.child.on("error", () => this.close());
    this.child.on("close", () => this.close());
  }
  private write(value: Record<string, unknown>): void {
    if (this.closed) throw new Error("RPC connection closed.");
    const line = JSON.stringify(this.options.jsonrpc ? { jsonrpc: "2.0", ...value } : value);
    if (Buffer.byteLength(line) > 1_048_576 || this.child.stdin.writableLength > 1_048_576) throw new Error("RPC request exceeds buffer limit.");
    this.child.stdin.write(line + "\n");
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("RPC connection closed."));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many pending RPC requests."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error("RPC request timed out."));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: Record<string, unknown>): void { this.write({ method, params }); }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8_388_608) { this.close(); return; }
    let end: number;
    while (!this.closed && (end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let data: Record<string, unknown> | null;
      try { data = record(JSON.parse(line)); } catch { this.close(); return; }
      if (!data) { this.close(); return; }
      if (typeof data.method === "string") {
        const params = record(data.params) ?? {};
        if (typeof data.id === "number" || typeof data.id === "string") this.answer(data.id, data.method, params);
        else { try { this.options.handlers?.notification?.(data.method, params); } catch { /* A notification cannot fail the connection. */ } }
        continue;
      }
      if (typeof data.id !== "number") continue;
      const pending = this.pending.get(data.id);
      if (!pending) continue;
      this.pending.delete(data.id); clearTimeout(pending.timer);
      const error = record(data.error);
      if (error) pending.reject(new RpcError(typeof error.code === "number" ? error.code : -32603,
        "RPC provider rejected the request.", error.data));
      else if (Object.hasOwn(data, "result")) pending.resolve(data.result);
      else pending.reject(new Error("Malformed RPC response."));
    }
  }
  private answer(id: number | string, method: string, params: Record<string, unknown>): void {
    const handler = this.options.handlers?.request;
    const refuse = (message: string) => { try { this.write({ id, error: { code: -32601, message } }); } catch { this.close(); } };
    if (!handler) { refuse("This client does not handle server requests or approvals."); return; }
    handler(method, params).then(
      result => { if (!this.closed) { try { this.write({ id, result: result ?? null }); } catch { this.close(); } } },
      () => { if (!this.closed) refuse("Request refused."); });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("RPC connection closed.")); }
    this.pending.clear(); this.child.stdin.destroy(); this.child.kill("SIGTERM");
    const killTimer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 2_000);
    killTimer.unref(); this.child.once("close", () => clearTimeout(killTimer));
    try { this.options.handlers?.closed?.(); } catch { /* Closing never throws. */ }
  }
}
