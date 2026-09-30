import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
// Starts processes the way Codex runs commands: one in its own session with a child of its own, and a plain child.
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'orphans') { orphans(m.id); return; }
  if (m.method === 'exit') process.exit(0);
  if (m.method !== 'spawn') return;
  const session = spawn('/bin/sh', ['-c', 'sleep 300 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const plain = spawn('/bin/sleep', ['301'], { stdio: 'ignore' });
  session.stdout.once('data', data => send({ id: m.id, result: [process.pid, session.pid, Number(String(data).trim()), plain.pid] }));
});

// Leaves processes behind the way a finished command can: launchers that exit, so what they started is reparented.
// A shell in its own session backgrounds a system binary and a Node process in its group; a Node launcher starts a
// detached worker in another session. Replies once both launchers have exited.
function orphans(id) {
  const node = JSON.stringify(process.execPath);
  const grouped = spawn('/bin/sh', ['-c', `/bin/sleep 303 & a=$!; ${node} -e "setTimeout(() => {}, 300000)" & echo $a $!`],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const launcher = spawn(process.execPath, ['-e', `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { detached: true, stdio: 'ignore' }); console.log(c.pid); c.unref();`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const output = child => new Promise(resolve => { let text = ''; child.stdout.on('data', d => { text += d; }); child.once('exit', () => resolve(text)); });
  Promise.all([output(grouped), output(launcher)]).then(([pair, worker]) =>
    send({ id, result: [...pair.trim().split(/\s+/).map(Number), Number(worker.trim())] }));
}
