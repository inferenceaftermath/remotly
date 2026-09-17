import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, normalizeIp, tailscaleIp4, tailscaleStatus, tailscaleWhois } from '../src/tailscale.ts';

test('execFile never rejects: exit codes, missing binaries and timeouts are plain results', async () => {
  // A synchronous write: with a piped stdout, `process.stdout.write` followed by `process.exit` can drop the bytes.
  const ok = await execFile(process.execPath, ['-e', 'require("node:fs").writeSync(1, "hi"); process.exit(3)']);
  assert.deepEqual({ code: ok.code, stdout: ok.stdout }, { code: 3, stdout: 'hi' });

  const missing = await execFile('flow-definitely-not-a-binary-xyz', ['--version']);
  assert.equal(missing.code, null);
  assert.match(missing.stderr, /ENOENT/);

  const slow = await execFile(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 });
  assert.equal(slow.code, null);
  assert.match(slow.stderr, /timed out/);
});

test('parsers reject non-zero exits and non-JSON output', async () => {
  const bad = async () => ({ code: 1, stdout: '{"Self":{}}', stderr: 'not running' });
  const junk = async () => ({ code: 0, stdout: 'Tailscale is stopped.', stderr: '' });
  assert.equal(await tailscaleStatus(bad), null);
  assert.equal(await tailscaleStatus(junk), null);
  assert.equal(await tailscaleIp4(junk), null);
  assert.equal(await tailscaleWhois('not-an-ip', junk), null, 'never passes garbage to the binary');
  assert.deepEqual(await tailscaleWhois('100.1.1.1', async () => ({ code: 0, stdout: '{"UserProfile":{"ID":1,"LoginName":"a@b"}}', stderr: '' })), {
    UserProfile: { ID: 1, LoginName: 'a@b' },
  });
});

test('normalizeIp unwraps IPv4-mapped IPv6 and tolerates undefined', () => {
  assert.equal(normalizeIp('::ffff:192.168.0.5'), '192.168.0.5');
  assert.equal(normalizeIp('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeIp('fd7a::1'), 'fd7a::1');
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp(undefined), '');
});
