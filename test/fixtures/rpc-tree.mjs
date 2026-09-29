import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
// Starts processes the way Codex runs commands: one in its own session with a child of its own, and a plain child.
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method !== 'spawn') return;
  const session = spawn('/bin/sh', ['-c', 'sleep 300 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const plain = spawn('/bin/sleep', ['301'], { stdio: 'ignore' });
  session.stdout.once('data', data => send({ id: m.id, result: [process.pid, session.pid, Number(String(data).trim()), plain.pid] }));
});
