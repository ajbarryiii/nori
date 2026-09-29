import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { RpcHandlers, RpcPort } from "./contracts.js";
import { object as record } from "./config.js";

const run = promisify(execFile);
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* Already gone. */ } };

/** Every process's parent and start time. The start time keeps a reused process id from being mistaken for another. */
async function processTable(): Promise<Map<number, { parent: number; start: string; exited: boolean }>> {
  const { stdout } = await run("/bin/ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], { maxBuffer: 16 * 1_048_576 });
  const table = new Map<number, { parent: number; start: string; exited: boolean }>();
  for (const line of stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (row) table.set(Number(row[1]), { parent: Number(row[2]), exited: row[3]!.startsWith("Z"), start: row[4]! });
  }
  return table;
}

/**
 * Pauses a process and all its descendants, including those in other sessions, so none can start another process or be
 * orphaned out of reach, then kills them all and waits until none is running. `uncollected` reports whether `root` is
 * still a child this process has not collected, so its id cannot belong to anything else.
 */
async function killTree(root: number, uncollected: () => boolean): Promise<void> {
  if (!uncollected()) return;
  signal(root, "SIGSTOP");
  const found = new Map<number, string>();
  for (let round = 0; round < 50; round++) {
    const table = await processTable();
    const start = table.get(root)?.start;
    if (!uncollected()) found.delete(root);
    else if (start !== undefined && !found.has(root)) found.set(root, start);
    let added = false; let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, entry] of table) {
        if (found.has(pid) || !found.has(entry.parent) || table.get(entry.parent)?.start !== found.get(entry.parent)) continue;
        signal(pid, "SIGSTOP"); found.set(pid, entry.start); added = grew = true;
      }
    }
    if (!added) break;
  }
  for (let round = 0; round < 40 && found.size; round++) {
    const table = await processTable();
    for (const [pid, start] of found) {
      const entry = table.get(pid);
      if (!entry || entry.start !== start || entry.exited || (pid === root && !uncollected())) found.delete(pid);
      else signal(pid, "SIGKILL");
    }
    if (found.size) await delay(50);
  }
}

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
  private readonly exited: Promise<void>;
  constructor(private readonly options: { command: string; args: string[]; timeoutMs: number; jsonrpc?: boolean;
    env?: NodeJS.ProcessEnv; handlers?: RpcHandlers }) {
    this.child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"], shell: false, ...(options.env ? { env: options.env } : {}) });
    this.exited = new Promise(resolve => { this.child.once("exit", () => resolve()); this.child.once("error", () => resolve()); });
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
  /**
   * Rejects pending requests, then stops the server and every process it started, including ones in their own
   * sessions (Codex runs commands that way), and reports `closed` once they have exited. Processes are found through
   * the running server: a server that already exited leaves nothing to trace.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("RPC connection closed.")); }
    this.pending.clear(); this.child.stdin.destroy();
    const report = () => { try { this.options.handlers?.closed?.(); } catch { /* Closing never throws. */ } };
    const pid = this.child.pid; const uncollected = () => this.child.exitCode === null && this.child.signalCode === null;
    if (pid === undefined || !uncollected()) { report(); return; }
    void killTree(pid, uncollected).catch(() => { this.child.kill("SIGKILL"); })
      .then(() => { this.child.kill("SIGKILL"); return this.exited; }).then(report);
  }
}
