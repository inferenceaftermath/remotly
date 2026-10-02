import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAILSCALE_CANDIDATES, execFile, findTailscaleBinary, normalizeIp, resolveTailscaleBinary, tailscaleIp4, tailscaleResolver, tailscaleStatus, tailscaleWhois } from '../src/tailscale.ts';

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

test('resolveTailscaleBinary: REMOTLY_TAILSCALE, then PATH (spawned as `tailscale`), then the platform candidates (the Mac app bundle), else `tailscale` so the failure reads as ENOENT', () => {
  const present = new Set<string>();
  const exists = (p: string): boolean => present.has(p);
  assert.equal(resolveTailscaleBinary({ REMOTLY_TAILSCALE: ' /opt/ts/tailscale ', PATH: '/usr/bin' }, 'darwin', exists), '/opt/ts/tailscale');
  assert.equal(resolveTailscaleBinary({ PATH: '/usr/bin:/usr/local/bin' }, 'darwin', exists), 'tailscale', 'nothing anywhere: the plain name');
  present.add('/usr/local/bin/tailscale');
  assert.equal(resolveTailscaleBinary({ PATH: '/usr/bin:/usr/local/bin' }, 'darwin', exists), 'tailscale', 'on PATH: the plain name');
  assert.equal(resolveTailscaleBinary({ PATH: '/usr/bin:/bin' }, 'darwin', exists), '/usr/local/bin/tailscale', 'off PATH (a launchd agent): the candidate that exists');
  present.add('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(resolveTailscaleBinary({ PATH: '/usr/bin:/bin' }, 'darwin', exists), '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'the app bundle first: it is the daemon the user logged in to');
  assert.equal(resolveTailscaleBinary({ PATH: '/usr/bin:/bin' }, 'linux', exists), 'tailscale', 'no candidates on Linux');
  assert.equal(resolveTailscaleBinary({}, 'darwin', exists), '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'no PATH at all');
  assert.deepEqual(Object.keys(TAILSCALE_CANDIDATES), ['darwin']);
  assert.equal(findTailscaleBinary({ PATH: '/usr/bin' }, 'linux', () => false), null, 'the resolver without the fallback: nothing found is null');
});

test('tailscaleResolver: looks again on every call until something is found, then keeps it — a Tailscale installed while setup waits is found on the next poll', () => {
  const answers: (string | null)[] = [null, null, '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/elsewhere/tailscale'];
  let asked = 0;
  const command = tailscaleResolver(() => {
    asked++;
    return answers.shift() ?? null;
  });
  assert.equal(command(), 'tailscale', 'nothing yet: the plain name, so a spawn fails as ENOENT');
  assert.equal(command(), 'tailscale');
  assert.equal(command(), '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'the app appeared');
  assert.equal(command(), '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'kept: not asked again');
  assert.equal(asked, 3);
  const onPath = tailscaleResolver(() => 'tailscale');
  assert.equal(onPath(), 'tailscale');
});
