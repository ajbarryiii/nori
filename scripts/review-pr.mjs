#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const model = 'gpt-6-astra';
const effort = 'xhigh';
const script = fileURLToPath(import.meta.url);
const resources = join(dirname(script), 'review');
const promptTemplate = readFileSync(join(resources, 'prompt.md'), 'utf8');
const schemaPath = join(resources, 'schema.json');
const digest = value => createHash('sha256').update(value).digest('hex');
const policy = digest(readFileSync(script) + promptTemplate + readFileSync(schemaPath));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
let childEnv;

function cleanGitEnvironment() {
  const result = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot determine Git hook environment.');
  const env = { ...process.env };
  for (const name of result.stdout.trim().split('\n')) delete env[name];
  // A push transfers real objects, so replacements must not change what is compared, snapshotted, or reviewed.
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

function git(cwd, args, optional = false) {
  const r = spawnSync('git', args, { cwd, env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    if (optional && r.status === 1) return null;
    throw new Error(`git ${args[0]} failed: ${r.stderr?.trim() || r.error?.message || r.status}`);
  }
  return r.stdout.trim();
}
function commit(root, ref) {
  if (!nonempty(ref) || ref.startsWith('-')) throw new Error('Expected a commit reference, not an option.');
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
function validate(review) {
  if (!object(review) || typeof review.review_complete !== 'boolean' || !nonempty(review.summary)
    || !Array.isArray(review.limitations) || !review.limitations.every(x => typeof x === 'string')
    || !Array.isArray(review.findings) || Object.keys(review).sort().join(',') !== 'findings,limitations,review_complete,summary')
    throw new Error('Invalid structured review output.');
  for (const f of review.findings) {
    if (!object(f) || !['P0', 'P1', 'P2', 'P3'].includes(f.priority)
      || ![f.title, f.body, f.path].every(nonempty) || !Number.isSafeInteger(f.line) || f.line < 1
      || Object.keys(f).sort().join(',') !== 'body,line,path,priority,title') throw new Error('Invalid review finding.');
  }
  return review;
}
function blocked(review) { return review.findings.some(f => f.priority !== 'P3'); }
function show(report, path, cached = false) {
  console.log(`${cached ? 'Cached' : 'Completed'} ${model} ${effort} review: ${report.head.slice(0, 12)}`);
  console.log(report.review.summary);
  for (const f of report.review.findings) console.log(`[${f.priority}] ${f.path}:${f.line} ${f.title}\n${f.body}`);
  for (const limitation of report.review.limitations) console.log(`Limitation: ${limitation}`);
  console.log(`Report: ${path}`);
}
const signal = (pid, name) => { try { process.kill(pid, name); } catch { /* Already gone. */ } };
/** Set in the reviewer's environment, and inherited by what it starts, so processes reparented away from it can be found. */
const PROCESS_TAG = 'NORI_PROCESS_TAG';
const ps = args => new Promise((resolve, reject) => execFile('ps', args, { env: childEnv, maxBuffer: 256 * 1024 * 1024 },
  (error, stdout) => { if (error) reject(error); else resolve(stdout); }));
/** Processes whose environment carries the tag. macOS hides the environment of its own system binaries. */
async function tagged(tag, pids) {
  const marker = `${PROCESS_TAG}=${tag}`; const found = new Set();
  if (process.platform === 'linux') {
    for (const pid of pids) { try { if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker)) found.add(pid); } catch { /* Gone or not ours. */ } }
    return found;
  }
  for (const line of (await ps(['-A', '-E', '-ww', '-o', 'pid=,command='])).split('\n')) {
    const pid = /^\s*(\d+)\s/.exec(line)?.[1];
    if (pid && line.includes(marker)) found.add(Number(pid));
  }
  return found;
}
/**
 * Every process's parent, process group, and start time, and whether it carries the tag. The start time keeps a reused
 * process id from being mistaken for another.
 */
async function processTable(tag) {
  const table = new Map();
  for (const line of (await ps(['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='])).split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (row) table.set(Number(row[1]), { parent: Number(row[2]), group: Number(row[3]), exited: row[4].startsWith('Z'), start: row[5], tagged: false });
  }
  // A process that started after the first listing is picked up in the next one.
  // The listings are not taken at the same instant: a tagged process missing from the first is kept, with nothing else
  // known about it, so cleanup looks again rather than missing it.
  for (const pid of await tagged(tag, [...table.keys()])) {
    const entry = table.get(pid);
    if (entry) entry.tagged = true; else table.set(pid, { parent: 0, group: null, start: null, exited: false, tagged: true });
  }
  return table;
}
/**
 * Pauses the reviewer and all its descendants, including tool commands in their own sessions that a process-group signal
 * misses, then kills them all and waits until none is running. Processes already reparented away, because what started
 * them exited, are found by the tag in their environment, or by sharing a process group, other than this process's own,
 * with a process already found. `uncollected` reports whether `root` is still a child this process has not collected, so
 * its id cannot belong to anything else. Returns whether every process was confirmed stopped.
 */
async function stopTree(root, uncollected, tag) {
  if (uncollected()) signal(root, 'SIGSTOP');
  const found = new Map();
  try {
    for (let round = 0; round < 50; round++) if (!discover(await processTable(tag), root, uncollected, found)) break;
    // A process can appear between listings, so every listing is searched again while killing. Stopped means a listing
    // showed nothing found still running and nothing new.
    for (let round = 0; round < 40; round++) {
      const table = await processTable(tag);
      const added = discover(table, root, uncollected, found);
      for (const [pid, seen] of found) {
        const entry = table.get(pid);
        if (!entry || entry.exited || (pid === root && !uncollected())) { found.delete(pid); continue; }
        // A different start time means the id was reused, unless the process carries the tag, which makes it ours either
        // way; a missing one means only the environment listing saw it.
        if (entry.start !== null && entry.start !== seen && seen !== null && !entry.tagged) { found.delete(pid); continue; }
        if (entry.start !== null) found.set(pid, entry.start);
        signal(pid, 'SIGKILL');
      }
      if (!found.size && !added) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  } catch {
    for (const pid of found.keys()) if (pid !== root || uncollected()) signal(pid, 'SIGKILL');
    return false;
  }
}
/**
 * Adds and pauses every running process in the listing that belongs to the tree: the root while it is uncollected, the
 * children of processes found, tagged processes, and members of a found process's group other than this process's own.
 * Returns whether any was added.
 */
function discover(table, root, uncollected, found) {
  const rootEntry = table.get(root);
  if (!uncollected()) found.delete(root); else if (rootEntry && !rootEntry.exited && !found.has(root)) found.set(root, rootEntry.start);
  const own = table.get(process.pid)?.group;
  // Groups of processes found in this listing, so a group id reused after its members exited is never matched.
  const groups = new Set();
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
      signal(pid, 'SIGSTOP'); found.set(pid, entry.start); added = grew = true;
      if (entry.group !== null && entry.group !== own) groups.add(entry.group);
    }
  }
  return added;
}
/** Rejects with `unconfirmed` set when a stopped review's processes could not be confirmed stopped. */
function runCodex(command, args, options, timeout) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const tag = randomUUID();
    const child = spawn(command, args, { ...spawnOptions, env: { ...(spawnOptions.env ?? process.env), [PROCESS_TAG]: tag }, detached: true });
    let failure; let stopping = null;
    const terminate = () => {
      if (!child.pid || stopping) return;
      const uncollected = () => child.exitCode === null && child.signalCode === null;
      stopping = stopTree(child.pid, uncollected, tag).then(stopped => {
        // The process group is the fallback when the process list is unavailable.
        if (!stopped && uncollected()) signal(-child.pid, 'SIGKILL');
        return stopped;
      });
    };
    const timer = setTimeout(() => { failure = new Error('Astra review timed out.'); terminate(); }, timeout);
    const interrupt = () => { failure = new Error('Astra review interrupted.'); terminate(); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const cleanup = () => {
      clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', async (status, exitSignal) => {
      cleanup();
      const stopped = stopping ? await stopping : true;
      if (!stopped) reject(Object.assign(new Error(`${failure.message} Its processes could not be confirmed stopped.`), { unconfirmed: true }));
      else if (failure) reject(failure); else resolve({ status, signal: exitSignal });
    });
    child.stdin.on('error', () => { /* A process failure is reported by error/close. */ });
    child.stdin.end(input);
  });
}
async function reviewCommit(root, base, head, force) {
  if (git(root, ['rev-parse', `${base}^{tree}`]) === git(root, ['rev-parse', `${head}^{tree}`])) {
    console.log(`No changed files at ${head.slice(0, 12)}; no review needed.`); return 0;
  }
  const cache = resolve(root, git(root, ['rev-parse', '--git-common-dir']), 'nori-review', digest(JSON.stringify({ base, head, policy, model, effort })));
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const lock = join(cache, 'running');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Review already running, or a stale review lock exists: ${lock}. See docs/PR_REVIEW.md.`);
    throw error;
  }
  let keep = false;
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    return await reviewLocked(root, base, head, force, cache);
  } catch (error) {
    // Reviewer processes may still be running, so another review of this commit must not start until someone checks.
    if (error.unconfirmed) { keep = true; throw new Error(`${error.message} The review lock stays at ${lock}; stop any leftover reviewer processes, then remove it.`); }
    throw error;
  } finally { if (!keep) rmSync(lock, { recursive: true, force: true }); }
}
async function reviewLocked(root, base, head, force, cache) {
  const reportPath = join(cache, 'report.json');
  if (!force && existsSync(reportPath)) {
    try {
      const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
      validate(saved.review);
      if (saved.base === base && saved.head === head && saved.policy === policy && saved.model === model && saved.effort === effort
        && saved.review.review_complete && !blocked(saved.review)) { show(saved, reportPath, true); return 0; }
    } catch { /* Invalid cache entries never authorize a push. */ }
  }
  // A failed forced review must not leave a previous passing result reusable.
  rmSync(reportPath, { force: true });
  const temporary = mkdtempSync(join(tmpdir(), 'nori-astra-'));
  const snapshot = join(temporary, 'repo');
  const output = join(temporary, 'result.json');
  const logPath = join(cache, `codex-${randomUUID()}.log`);
  try {
    git(root, ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--shared', '--no-checkout', '--', root, snapshot]);
    git(snapshot, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', head]);
    const timeout = Number(process.env.NORI_REVIEW_TIMEOUT_SECONDS ?? 1200);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error('NORI_REVIEW_TIMEOUT_SECONDS must be between 0 and 86400.');
    const prompt = `${promptTemplate}\nBase commit: ${base}\nHead commit: ${head}\nInspect with: git diff --no-ext-diff --no-textconv ${base} ${head} --\n`;
    console.log(`Reviewing ${head.slice(0, 12)} with ${model} ${effort}. Log: ${logPath}`);
    const log = openSync(logPath, 'w', 0o600);
    let result;
    try {
      const codex = git(root, ['config', '--get', 'nori.codexPath'], true) || 'codex';
      result = await runCodex(codex, ['-a', 'never', 'exec', '--ignore-user-config', '--ephemeral',
        '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--sandbox', 'read-only',
        '-C', snapshot, '--output-schema', schemaPath, '-o', output, '-'],
      { cwd: snapshot, env: childEnv, input: prompt, stdio: ['pipe', log, log] }, timeout * 1000);
    } catch (error) {
      throw Object.assign(new Error(`Codex review failed: ${error.message} See ${logPath}`), { unconfirmed: error.unconfirmed === true });
    } finally { closeSync(log); }
    if (result.status !== 0) throw new Error(`Codex review failed (${result.status ?? result.signal}). See ${logPath}`);
    if (git(snapshot, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Reviewer changed the snapshot; refusing its result.');
    const review = validate(JSON.parse(readFileSync(output, 'utf8')));
    const report = { base, head, policy, model, effort, createdAt: new Date().toISOString(), review };
    const pending = join(cache, `report-${randomUUID()}.tmp`);
    writeFileSync(pending, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    renameSync(pending, reportPath);
    show(report, reportPath);
    if (!review.review_complete) throw new Error('Review is incomplete; the push remains blocked.');
    if (blocked(review)) {
      console.error('Push blocked. The original implementation agent must verify findings, fix them, commit, and review again.');
      return 1;
    }
    return 0;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log('review-pr.mjs [--base REF] [--head REF] [--force]\nreview-pr.mjs --pre-push REMOTE LOCATION'); return 0; }
  childEnv = cleanGitEnvironment();
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const configuredBase = git(root, ['config', '--get', 'nori.reviewBase'], true) || 'origin/main';
  let baseRef = configuredBase; let headRef = 'HEAD'; let force = false; let push = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--force') force = true;
    else if (option === '--base' || option === '--head') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing reference after ${option}.`);
      if (option === '--base') baseRef = value; else headRef = value;
    } else if (option === '--pre-push' && i === 0 && args.length === 3) { push = true; break; }
    else throw new Error(`Unknown option: ${option}`);
  }
  const scopes = [];
  if (push) {
    const input = readFileSync(0, 'utf8').trim();
    for (const line of input ? input.split('\n') : []) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4 || ![fields[1], fields[3]].every(x => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x)))
        throw new Error('Malformed pre-push record.');
      const [, local, remoteRef, remote] = fields;
      if (/^0+$/.test(local)) continue;
      const head = commit(root, local);
      const fullBase = git(root, ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', baseRef]);
      // Remote names may contain slashes, so strip the longest configured remote whose tracking prefix matches; without
      // one, the first path segment is the remote.
      const remotes = git(root, ['remote']).split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
      const tracking = remotes.find(name => fullBase.startsWith(`refs/remotes/${name}/`));
      const baseBranch = tracking ? fullBase.slice(`refs/remotes/${tracking}/`.length)
        : fullBase.replace(/^refs\/remotes\/[^/]+\//, '').replace(/^refs\/heads\//, '');
      const base = remoteRef === `refs/heads/${baseBranch}` && !/^0+$/.test(remote)
        ? commit(root, remote) : git(root, ['merge-base', commit(root, baseRef), head]);
      scopes.push({ base, head });
    }
  } else {
    const head = commit(root, headRef);
    scopes.push({ base: git(root, ['merge-base', commit(root, baseRef), head]), head });
  }
  let exit = 0;
  for (const { base, head } of scopes) exit = Math.max(exit, await reviewCommit(root, base, head, force));
  return exit;
}
try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(`Nori review: ${error.message}`); process.exitCode = 2; }
