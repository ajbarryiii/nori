import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { RpcHandlers, RpcPort } from "./contracts.js";
import { object as record } from "./config.js";
import { childEnvironment } from "./secrets.js";

const run = promisify(execFile);
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* Already gone. */ } };

/** Set in the server's environment, and inherited by what it starts, so processes reparented away from it can be found. */
export const PROCESS_TAG = "NORI_PROCESS_TAG";

/**
 * Every process's parent, process group, and start time, and whether its environment carries `tag`. The start time keeps
 * a reused process id from being mistaken for another. macOS hides the environment of its own system binaries. The two
 * listings are not taken at the same instant: a tagged process missing from the process listing is kept, with no parent,
 * group, or start time, so cleanup looks again rather than missing it.
 */
export type ProcessTable = Map<number, { parent: number; group: number | null; start: string | null; exited: boolean; tagged: boolean }>;

/** Builds the table from `ps -o pid=,ppid=,pgid=,stat=,lstart=` and `ps -E -o pid=,command=` output. */
export function parseListings(processes: string, environments: string, tag: string): ProcessTable {
  const marker = `${PROCESS_TAG}=${tag}`; const tagged = new Set<number>();
  for (const line of environments.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(line)?.[1];
    if (pid && line.includes(marker)) tagged.add(Number(pid));
  }
  const table: ProcessTable = new Map();
  for (const line of processes.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (row) table.set(Number(row[1]), { parent: Number(row[2]), group: Number(row[3]), exited: row[4]!.startsWith("Z"), start: row[5]!,
      tagged: tagged.has(Number(row[1])) });
  }
  for (const pid of tagged) if (!table.has(pid)) table.set(pid, { parent: 0, group: null, start: null, exited: false, tagged: true });
  return table;
}

async function processTable(tag: string): Promise<ProcessTable> {
  const [{ stdout }, { stdout: environments }] = await Promise.all([
    run("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { maxBuffer: 16 * 1_048_576 }),
    run("/bin/ps", ["-A", "-E", "-ww", "-o", "pid=,command="], { maxBuffer: 256 * 1_048_576 })]);
  return parseListings(stdout, environments, tag);
}

/**
 * Pauses a process and all its descendants, including those in other sessions, so none can start another process or be
 * orphaned out of reach, then kills them all and waits until none is running. Processes already reparented away, because
 * what started them exited, are found by the tag in their environment, or by sharing a process group, other than this
 * process's own, with a process already found. `uncollected` reports whether `root` is
 * still a child this process has not collected, so its id cannot belong to anything else. Returns whether every process
 * found was confirmed stopped; if the processes cannot be listed, those already found are killed and it returns false.
 */
async function killTree(root: number, uncollected: () => boolean, list: () => Promise<ProcessTable>): Promise<boolean> {
  if (uncollected()) signal(root, "SIGSTOP");
  const found = new Map<number, string | null>();
  try { return await freezeAndKill(root, uncollected, list, found); }
  catch { for (const pid of found.keys()) if (pid !== root || uncollected()) signal(pid, "SIGKILL"); return false; }
}

async function freezeAndKill(root: number, uncollected: () => boolean, list: () => Promise<ProcessTable>, found: Map<number, string | null>):
  Promise<boolean> {
  for (let round = 0; round < 50; round++) if (!discover(await list(), root, uncollected, found)) break;
  // A process can appear between listings, so every listing is searched again while killing. Stopped means a listing
  // showed nothing found still running and nothing new.
  for (let round = 0; round < 40; round++) {
    const table = await list();
    const added = discover(table, root, uncollected, found);
    for (const [pid, seen] of found) {
      const entry = table.get(pid);
      if (!entry || entry.exited || (pid === root && !uncollected())) { found.delete(pid); continue; }
      // A different start time means the id was reused, unless the process carries the tag, which makes it ours either
      // way; a missing one means only the environment listing saw it.
      if (entry.start !== null && entry.start !== seen && seen !== null && !entry.tagged) { found.delete(pid); continue; }
      if (entry.start !== null) found.set(pid, entry.start);
      signal(pid, "SIGKILL");
    }
    if (!found.size && !added) return true;
    await delay(50);
  }
  return false;
}

/**
 * Adds and pauses every running process in the listing that belongs to the tree: the root while it is uncollected, the
 * children of processes found, tagged processes, and members of a found process's group other than this process's own.
 * Returns whether any was added.
 */
function discover(table: ProcessTable, root: number, uncollected: () => boolean, found: Map<number, string | null>): boolean {
  const rootEntry = table.get(root);
  if (!uncollected()) found.delete(root);
  else if (rootEntry && !rootEntry.exited && !found.has(root)) found.set(root, rootEntry.start);
  const own = table.get(process.pid)?.group;
  // Groups of processes found in this listing, so a group id reused after its members exited is never matched.
  const groups = new Set<number>();
  for (const [pid, start] of found) {
    const entry = table.get(pid);
    if (entry?.start === start && entry.group !== null && entry.group !== own) groups.add(entry.group);
  }
  let added = false; let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, entry] of table) {
      if (found.has(pid) || pid === process.pid || entry.exited) continue;
      const child = found.has(entry.parent) && table.get(entry.parent)?.start === found.get(entry.parent);
      if (!child && !entry.tagged && (entry.group === null || !groups.has(entry.group))) continue;
      signal(pid, "SIGSTOP"); found.set(pid, entry.start); added = grew = true;
      if (entry.group !== null && entry.group !== own) groups.add(entry.group);
    }
  }
  return added;
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
  private readonly tag = randomBytes(16).toString("hex");
  /**
   * `env` defaults to this process's environment without Nori's API keys. `processTable` lists processes when stopping the
   * server's process tree; it is replaceable for tests.
   */
  constructor(private readonly options: { command: string; args: string[]; timeoutMs: number; jsonrpc?: boolean;
    env?: NodeJS.ProcessEnv; handlers?: RpcHandlers; processTable?: (tag: string) => Promise<ProcessTable> }) {
    this.child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: { ...(options.env ?? childEnvironment()), [PROCESS_TAG]: this.tag } });
    this.exited = new Promise(resolve => { this.child.once("exit", () => resolve()); this.child.once("error", () => resolve()); });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Drain diagnostics without copying provider messages or credentials to our logs.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.close());
    this.child.on("error", () => this.close());
    this.child.on("close", () => this.close());
    // `close` waits for the output pipes, which something the server started may hold open after it exits.
    this.child.on("exit", () => this.close());
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
   * sessions (Codex runs commands that way), and reports `closed` once they have exited, or once it is clear that
   * cannot be confirmed. Processes are found through the running server, and by the tag and process groups of what it
   * started, so a server that already exited still has what it left behind stopped.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("RPC connection closed.")); }
    this.pending.clear(); this.child.stdin.destroy();
    const report = (stopped: boolean) => { try { this.options.handlers?.closed?.(stopped); } catch { /* Closing never throws. */ } };
    const pid = this.child.pid; const uncollected = () => this.child.exitCode === null && this.child.signalCode === null;
    if (pid === undefined) { report(true); return; }
    // Even after the server has exited, what it left behind is still found by its tag and process groups.
    const list = this.options.processTable ?? processTable;
    void killTree(pid, uncollected, () => list(this.tag)).then(async stopped => {
      this.child.kill("SIGKILL");
      return await Promise.race([this.exited.then(() => true), delay(5_000, false, { ref: false })]) && stopped;
    }).then(report);
  }
}
