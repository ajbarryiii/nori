import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = join(project, 'scripts/review-pr.mjs');
const installer = join(project, 'scripts/install-review-hook.mjs');
const clean = { review_complete: true, summary: 'Reviewed the change.', findings: [], limitations: [] };
const finding = priority => ({ priority, title: 'Incorrect result', body: 'This input returns an incorrect result.', path: 'code.js', line: 1 });

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nori-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Review Test');
  git(root, 'config', 'user.email', 'review@example.invalid');
  writeFileSync(join(root, 'code.js'), 'export const value = 1;\n');
  git(root, 'add', 'code.js'); git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', base);
  git(root, 'checkout', '-qb', 'feature');
  writeFileSync(join(root, 'code.js'), 'export const value = 2;\n');
  git(root, 'commit', '-qam', 'feature');
  const head = git(root, 'rev-parse', 'HEAD');
  const bin = join(root, '.git', 'test-bin'); mkdirSync(bin);
  const log = join(root, '.git', 'codex-calls.jsonl');
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
const cwd = args[args.indexOf('-C') + 1];
const prompt = readFileSync(0, 'utf8');
appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, prompt,
  head: spawnSync('git', ['rev-parse','HEAD'], {cwd, encoding:'utf8'}).stdout.trim(),
  source: readFileSync(join(cwd, 'code.js'), 'utf8')}) + '\\n');
if (process.env.FAKE_MODE === 'error') process.exit(7);
if (process.env.FAKE_MODE === 'tree') {
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {stdio:'ignore'});
  writeFileSync(process.env.FAKE_LOG + '.child', String(worker.pid));
  await new Promise(resolve => setTimeout(resolve, 10000));
}
if (process.env.FAKE_MODE === 'hang') await new Promise(resolve => setTimeout(resolve, 10000));
if (process.env.FAKE_MODE === 'mutate') writeFileSync(join(cwd, 'code.js'), 'modified by reviewer');
writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_MODE === 'malformed' ? 'not JSON' : process.env.FAKE_REVIEW);
`);
  // A package marker makes the extensionless fake a Node ES module.
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}'); chmodSync(fake, 0o755);
  const run = (args = [], extra = {}, input = '') => spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: 'utf8', input, timeout: 20000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_REVIEW: JSON.stringify(clean), ...extra },
  });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, base, head, run, calls };
}

test('reviews the committed snapshot with Astra xHigh and preserves dirty work and index', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'code.js'), 'staged work'); git(f.root, 'add', 'code.js');
  writeFileSync(join(f.root, 'code.js'), 'unstaged work');
  writeFileSync(join(f.root, 'private-untracked.txt'), 'untracked');
  const before = git(f.root, 'status', '--porcelain');
  const index = git(f.root, 'write-tree');
  const r = f.run(); assert.equal(r.status, 0, r.stderr);
  const [call] = f.calls();
  assert.equal(call.head, f.head); assert.equal(call.source, 'export const value = 2;\n');
  assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-6-astra');
  assert.ok(call.args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.ok(call.prompt.includes(f.base)); assert.ok(call.prompt.includes(f.head));
  assert.equal(git(f.root, 'status', '--porcelain'), before);
  assert.equal(git(f.root, 'write-tree'), index);
});
test('Git hook environment cannot redirect snapshot operations into the source checkout', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'code.js'), 'keep my unfinished implementation');
  git(f.root, 'add', 'code.js');
  const index = git(f.root, 'write-tree');
  const r = f.run([], { GIT_DIR: join(f.root, '.git'), GIT_WORK_TREE: f.root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.calls()[0].source, 'export const value = 2;\n');
  assert.equal(readFileSync(join(f.root, 'code.js'), 'utf8'), 'keep my unfinished implementation');
  assert.equal(git(f.root, 'write-tree'), index);
});

for (const priority of ['P0', 'P1', 'P2']) {
  test(`${priority} findings block the push and are not cached as passing`, t => {
    const f = fixture(t); const extra = { FAKE_REVIEW: JSON.stringify({ ...clean, findings: [finding(priority)] }) };
    const r = f.run([], extra); assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /Incorrect result/);
    assert.match(r.stdout + r.stderr, /report\.json/);
    assert.equal(f.run([], extra).status, 1); assert.equal(f.calls().length, 2);
  });
}
test('P3 suggestions are reported without blocking', t => {
  const f = fixture(t); const r = f.run([], { FAKE_REVIEW: JSON.stringify({ ...clean, findings: [finding('P3')] }) });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /P3/);
});
test('an explicit Codex executable works when the hook PATH cannot find codex', t => {
  const f = fixture(t);
  git(f.root, 'config', '--local', 'nori.codexPath', join(f.root, '.git/test-bin/codex'));
  const r = f.run([], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });
  assert.equal(r.status, 0, r.stderr); assert.equal(f.calls().length, 1);
});
for (const mode of ['malformed', 'error', 'mutate']) {
  test(`${mode} reviewer result fails closed`, t => {
    const f = fixture(t); const r = f.run([], { FAKE_MODE: mode });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(readFileSync(join(f.root, 'code.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(f.run().status, 0); assert.equal(f.calls().length, 2);
  });
}
test('incomplete and structurally invalid reviews fail closed', t => {
  const f = fixture(t);
  for (const result of [{ ...clean, review_complete: false }, { ...clean, findings: [{}] }, { ...clean, findings: 'none' }]) {
    const r = f.run([], { FAKE_REVIEW: JSON.stringify(result) }); assert.equal(r.status, 2, r.stderr);
  }
});
test('review timeout fails closed', t => {
  const f = fixture(t); const r = f.run([], { FAKE_MODE: 'hang', NORI_REVIEW_TIMEOUT_SECONDS: '1' });
  assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /timed out/i);
});
test('timeout terminates children of the Codex launcher', async t => {
  const f = fixture(t);
  const r = f.run([], { FAKE_MODE: 'tree', NORI_REVIEW_TIMEOUT_SECONDS: '1' });
  assert.equal(r.status, 2, r.stderr);
  const pid = Number(readFileSync(join(f.root, '.git/codex-calls.jsonl.child'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('passing cache is specific to commits and force refreshes it', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0); assert.equal(f.run().status, 0); assert.equal(f.calls().length, 1);
  assert.equal(f.run(['--force']).status, 0); assert.equal(f.calls().length, 2);
  writeFileSync(join(f.root, 'code.js'), 'export const value = 3;\n'); git(f.root, 'commit', '-qam', 'fix');
  assert.equal(f.run().status, 0); assert.equal(f.calls().length, 3);
});
test('concurrent reviews cannot race a forced review or duplicate model calls', async t => {
  const f = fixture(t); const log = join(f.root, '.git/codex-calls.jsonl');
  const first = spawn(process.execPath, [runner], { cwd: f.root, stdio: 'ignore', env: {
    ...process.env, PATH: `${join(f.root, '.git/test-bin')}:${process.env.PATH}`,
    FAKE_LOG: log, FAKE_REVIEW: JSON.stringify(clean), FAKE_MODE: 'hang', NORI_REVIEW_TIMEOUT_SECONDS: '2',
  } });
  const finished = new Promise(resolve => first.once('exit', resolve));
  t.after(() => { if (first.exitCode === null) first.kill('SIGTERM'); });
  const deadline = Date.now() + 10000;
  while (!existsSync(log) && Date.now() < deadline && first.exitCode === null)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(log), 'first review reached the model');
  const second = f.run(['--force']);
  assert.equal(second.status, 2, second.stderr);
  assert.match(second.stderr, /already running/i); assert.equal(f.calls().length, 1);
  assert.equal(await finished, 2);
  const retry = f.run(); assert.equal(retry.status, 0, retry.stderr); assert.equal(f.calls().length, 2);
});
test('pre-push reviews each supplied commit, not the checked-out HEAD', t => {
  const f = fixture(t);
  git(f.root, 'checkout', '-qb', 'second', f.base);
  writeFileSync(join(f.root, 'code.js'), 'export const value = 3;\n'); git(f.root, 'commit', '-qam', 'second');
  const second = git(f.root, 'rev-parse', 'HEAD'); const zero = '0'.repeat(40);
  const records = `refs/heads/feature ${f.head} refs/heads/feature ${zero}\nrefs/heads/second ${second} refs/heads/second ${zero}\n`;
  const r = f.run(['--pre-push', 'origin', 'unused'], {}, records);
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(f.calls().map(c => c.head), [f.head, second]);
});
test('a push to main compares the remote old commit even when origin/main already equals HEAD', t => {
  const f = fixture(t); git(f.root, 'update-ref', 'refs/remotes/origin/main', f.head);
  const r = f.run(['--pre-push', 'origin', 'unused'], {}, `refs/heads/main ${f.head} refs/heads/main ${f.base}\n`);
  assert.equal(r.status, 0, r.stderr); assert.equal(f.calls().length, 1); assert.ok(f.calls()[0].prompt.includes(f.base));
});
test('deletion and empty diffs skip model calls', t => {
  const f = fixture(t); const zero = '0'.repeat(40);
  assert.equal(f.run(['--pre-push', 'origin', 'unused'], {}, `(delete) ${zero} refs/heads/old ${f.head}\n`).status, 0);
  assert.equal(f.run(['--head', f.base]).status, 0); assert.equal(f.calls().length, 0);
});
test('invalid refs, missing bases and malformed push records fail closed', t => {
  const f = fixture(t);
  for (const args of [['--base', 'missing'], ['--head', '--help'], ['--unexpected']]) assert.equal(f.run(args).status, 2);
  assert.equal(f.run(['--pre-push', 'origin', 'unused'], {}, 'malformed\n').status, 2);
  assert.equal(f.calls().length, 0);
});
test('installer configures a repo-local hook and refuses to replace existing hooks', t => {
  const f = fixture(t); mkdirSync(join(f.root, '.githooks'));
  copyFileSync(join(project, '.githooks/pre-push'), join(f.root, '.githooks/pre-push'));
  const install = () => spawnSync(process.execPath, [installer], { cwd: f.root, encoding: 'utf8' });
  git(f.root, 'config', '--local', 'core.hooksPath', '/custom/hooks');
  assert.equal(install().status, 2); assert.equal(git(f.root, 'config', 'core.hooksPath'), '/custom/hooks');
  git(f.root, 'config', '--local', '--unset', 'core.hooksPath');
  writeFileSync(join(f.root, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n');
  assert.equal(install().status, 2); rmSync(join(f.root, '.git/hooks/pre-push'));
  assert.equal(install().status, 0);
  assert.equal(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: f.root }).status, 1);
  assert.equal(readFileSync(join(f.root, '.git/hooks/pre-push'), 'utf8'), readFileSync(join(project, '.githooks/pre-push'), 'utf8'));
  assert.equal(install().status, 0);
});
test('installer preserves existing pre-commit hooks instead of silently disabling them', t => {
  const f = fixture(t); mkdirSync(join(f.root, '.githooks'));
  copyFileSync(join(project, '.githooks/pre-push'), join(f.root, '.githooks/pre-push'));
  const hook = join(f.root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  const r = spawnSync(process.execPath, [installer], { cwd: f.root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: f.root }).status, 1);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 1\n');
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-m', 'must be blocked'], { cwd: f.root }).status, 1);
});
test('an installed hook still blocks after switching to a branch without the review runner', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.githooks')); mkdirSync(join(f.root, 'scripts'));
  copyFileSync(join(project, '.githooks/pre-push'), join(f.root, '.githooks/pre-push'));
  copyFileSync(runner, join(f.root, 'scripts/review-pr.mjs'));
  git(f.root, 'add', '.githooks', 'scripts'); git(f.root, 'commit', '-qm', 'review tooling');
  const install = spawnSync(process.execPath, [installer], { cwd: f.root, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  git(f.root, 'checkout', '-q', 'main');
  const remote = join(f.root, '.git', 'destination.git'); git(f.root, 'init', '--bare', remote);
  const push = spawnSync('git', ['push', remote, 'feature'], { cwd: f.root, encoding: 'utf8' });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /review runner/i);
  assert.equal(spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1);
});
test('installation from a subdirectory writes to that repository, not its parent', t => {
  const f = fixture(t); const inner = join(f.root, 'inner');
  mkdirSync(inner); git(inner, 'init', '-q');
  mkdirSync(join(inner, '.githooks')); mkdirSync(join(inner, 'subdir'));
  copyFileSync(join(project, '.githooks/pre-push'), join(inner, '.githooks/pre-push'));
  const r = spawnSync(process.execPath, [installer], { cwd: join(inner, 'subdir'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(inner, '.git/hooks/pre-push')));
  assert.equal(existsSync(join(f.root, '.git/hooks/pre-push')), false);
});
