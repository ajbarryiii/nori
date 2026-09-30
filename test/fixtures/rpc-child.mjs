import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let asking;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'echo') send({ id: m.id, result: m.params });
  if (m.method === 'exit') process.exit(1);
  if (m.method === 'ask') { asking = m.id; send({ id: 'server-request', method: 'unknown/approval', params: { threadId: 't' } }); }
  if (m.method === 'note') { send({ method: 'progress', params: { step: 1 } }); send({ id: m.id, result: {} }); }
  if (m.method === 'env') send({ id: m.id, result: Object.keys(process.env).sort() });
  if (m.id === 'server-request' && m.error) send({ id: asking, result: { rejected: true } });
  if (m.id === 'server-request' && m.result) send({ id: asking, result: { answered: m.result } });
});
