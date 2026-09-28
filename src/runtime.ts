import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./contracts.js";

export function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (lstatSync(dataDir).isSymbolicLink()) throw new Error("Refusing a symlink data directory.");
  const stat = statSync(dataDir);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Nori data directory must belong to this user and have mode 700.");
  const path = join(dataDir, "service.lock");
  const token = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() });
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch { throw new Error("Nori service lock exists or cannot be created. Stop the other process; review a stale lock manually."); }
  try { writeFileSync(fd, token); } finally { closeSync(fd); }
  let released = false;
  return () => {
    if (released) return; released = true;
    try { if (readFileSync(path, "utf8") === token) unlinkSync(path); } catch { /* Already removed; do not remove a replacement. */ }
  };
}

export function databaseIdentity(config: Config, databasePath: string): string {
  const path = realpathSync(databasePath); const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Messages database is not a regular file.");
  return createHash("sha256").update(JSON.stringify({ version: 1, transport: "imsg", user: config.assistantUser,
    owner: { ...config.owner, handles: [...config.owner.handles].sort() }, path,
    device: stat.dev, inode: stat.ino, birthtime: stat.birthtimeMs })).digest("hex");
}
export function assertIdentity(expected: string | null, actual: string): void {
  if (expected === null || expected !== actual) throw new Error("Messages database/account identity changed or is not enrolled. Stop and reconcile before enrolling again.");
}
