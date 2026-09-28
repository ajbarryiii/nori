#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
function git(args, optional = false) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (optional && result.status === 1) return '';
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Git failed.');
  return result.stdout.trim();
}
try {
  const root = git(['rev-parse', '--show-toplevel']);
  const configured = git(['config', '--get', 'core.hooksPath'], true);
  if (configured) throw new Error(`Existing core.hooksPath=${configured}; integrate the Nori hook manually instead of replacing it.`);
  const previous = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push']);
  const marker = '# Nori Astra review hook v1';
  if (existsSync(previous) && !readFileSync(previous, 'utf8').startsWith(`#!/bin/sh\n${marker}\n`))
    throw new Error(`Existing pre-push hook at ${previous}; integrate it manually.`);
  const template = readFileSync(join(root, '.githooks/pre-push'), 'utf8');
  if (!template.startsWith(`#!/bin/sh\n${marker}\n`)) throw new Error('Unexpected Nori hook template.');
  mkdirSync(dirname(previous), { recursive: true });
  writeFileSync(previous, template, { mode: 0o755 });
  chmodSync(previous, 0o755);
  console.log('Installed Nori Astra xHigh pre-push review for this repository.');
} catch (error) { console.error(error.message); process.exitCode = 2; }
