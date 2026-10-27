#!/usr/bin/env node
// A stand-in for herdr's socket API, enough for `remotly-bridge setup` and `serve` to come up without herdr installed:
// one JSON request per connection, answered with one line (herdr/client.ts). `ping` gets the version and protocol
// the bridge was built against; everything else is an error, which the bridge's link treats as herdr being down and
// retries — the service, the certificate, the control socket and the health wait do not depend on it.
// Usage: node fake-herdr.mjs <socket path>
import fs from 'node:fs';
import net from 'node:net';

const sock = process.argv[2];
if (!sock) {
  console.error('usage: fake-herdr.mjs <socket path>');
  process.exit(2);
}
fs.rmSync(sock, { force: true });
const server = net.createServer((c) => {
  let buf = '';
  c.setEncoding('utf8');
  c.on('data', (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    let msg = {};
    try {
      msg = JSON.parse(buf.slice(0, nl));
    } catch {
      /* answered below as an error */
    }
    const id = msg.id ?? null;
    const answer = msg.method === 'ping' ? { id, result: { version: '0.8.0-fake', protocol: 19 } } : { id, error: { code: 'not_implemented', message: `fake herdr does not implement ${msg.method}` } };
    c.end(JSON.stringify(answer) + '\n');
  });
  c.on('error', () => {});
});
server.listen(sock, () => console.log(`fake herdr listening on ${sock}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
