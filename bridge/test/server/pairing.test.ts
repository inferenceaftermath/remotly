import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAIRING_ALPHABET,
  PairingManager,
  buildQrPayload,
  generateCode,
  normalizeCode,
  pairUrl,
  parseQrPayload,
} from '../../src/server/pairing.ts';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('alphabet excludes confusables and codes are 8 chars drawn from it', () => {
  assert.equal(PAIRING_ALPHABET.length, 32);
  for (const bad of 'IO01') assert.equal(PAIRING_ALPHABET.includes(bad), false, bad);
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  }
  // every byte value maps onto the alphabet without bias (256 = 8 × 32)
  const seen = new Set<string>();
  for (let b = 0; b < 256; b += 8) seen.add(generateCode(() => Buffer.from([b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7])));
  assert.equal(new Set([...seen].join('')).size, 32);
});

test('codes are single-use and honour the TTL', () => {
  const clock = fakeClock();
  const pm = new PairingManager({ now: clock.now });
  const { code, expiresAt } = pm.create();
  assert.equal(expiresAt.getTime(), clock.now() + 300_000);
  clock.advance(299_999);
  assert.equal(pm.redeem(code), 'ok');
  assert.equal(pm.redeem(code), 'bad_code', 'second use must fail');

  const late = pm.create(60).code;
  clock.advance(60_000);
  assert.equal(pm.redeem(late), 'bad_code', 'expired at exactly ttl');
  assert.equal(pm.outstanding(), 0);
});

test('a reusable code pairs any number of devices until it expires', () => {
  const clock = fakeClock();
  const pm = new PairingManager({ now: clock.now });
  const { code } = pm.create(600, { reusable: true });
  assert.equal(pm.redeem(code, 'phone-1'), 'ok');
  assert.equal(pm.redeem(code, 'phone-2'), 'ok', 'still valid for the second phone');
  assert.equal(pm.outstanding(), 1);
  clock.advance(600_000);
  assert.equal(pm.redeem(code, 'phone-3'), 'bad_code', 'gone at expiry like any other code');
  const single = pm.create(600).code;
  assert.equal(pm.redeem(single), 'ok');
  assert.equal(pm.redeem(single), 'bad_code', 'plain codes stay single-use');
});

test('normalizeCode tolerates case, spaces and dashes', () => {
  assert.equal(normalizeCode(' ab cd-ef gh '), 'ABCDEFGH');
  const pm = new PairingManager();
  const { code } = pm.create();
  assert.equal(pm.redeem(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`), 'ok');
});

test('five failures lock /pair for 15 minutes, then the slate is clean', () => {
  const clock = fakeClock();
  const pm = new PairingManager({ now: clock.now });
  const { code } = pm.create(3600);
  for (let i = 0; i < 4; i++) assert.equal(pm.redeem('AAAAAAAA'), 'bad_code');
  assert.equal(pm.redeem('AAAAAAAA'), 'locked_out');
  assert.equal(pm.isLockedOut(), true);
  assert.equal(pm.redeem(code), 'locked_out', 'even the right code is refused while locked');
  assert.equal(pm.lockoutRemainingMs(), 15 * 60_000);
  clock.advance(15 * 60_000 - 1);
  assert.equal(pm.redeem(code), 'locked_out');
  clock.advance(1);
  assert.equal(pm.isLockedOut(), false);
  assert.equal(pm.redeem('BBBBBBBB'), 'bad_code', 'counter reset after lockout');
  assert.equal(pm.redeem(code), 'ok');
});

test('a successful pairing resets the failure counter', () => {
  const pm = new PairingManager();
  for (let i = 0; i < 4; i++) pm.redeem('ZZZZZZZZ');
  assert.equal(pm.redeem(pm.create().code), 'ok');
  for (let i = 0; i < 4; i++) assert.equal(pm.redeem('ZZZZZZZZ'), 'bad_code');
});

test('at most maxOutstanding live codes; the oldest is dropped', () => {
  const pm = new PairingManager({ maxOutstanding: 3 });
  const first = pm.create().code;
  pm.create();
  pm.create();
  const fourth = pm.create().code;
  assert.equal(pm.outstanding(), 3);
  assert.equal(pm.redeem(first), 'bad_code');
  assert.equal(pm.redeem(fourth), 'ok');
});

test('a reusable setup code outlives maxOutstanding pressure from plain pair codes', () => {
  const pm = new PairingManager({ maxOutstanding: 3 });
  const setup = pm.create(600, { reusable: true }).code;
  const first = pm.create().code;
  pm.create();
  pm.create(); // fourth live code: the oldest *single-use* one goes, not the setup code
  assert.equal(pm.outstanding(), 3);
  assert.equal(pm.redeem(first), 'bad_code');
  assert.equal(pm.redeem(setup, 'phone-1'), 'ok');
  pm.create();
  pm.create();
  pm.create();
  assert.equal(pm.redeem(setup, 'phone-2'), 'ok', 'still there after three more pair codes');
  // only reusable codes left: then the oldest of them goes, as before
  const other = pm.create(600, { reusable: true }).code;
  pm.create(600, { reusable: true });
  pm.create(600, { reusable: true });
  assert.equal(pm.redeem(setup, 'phone-3'), 'bad_code');
  assert.equal(pm.redeem(other, 'phone-3'), 'ok');
});

test('QR payload carries u/fp/c/n and omits fp for publicly trusted certs', () => {
  const withFp = buildQrPayload({ url: 'wss://100.101.102.103:7460', fingerprintB64url: 'abc_-9', code: 'ABCDEFGH', hostName: 'example host' });
  assert.equal(withFp, 'remotly://pair?u=wss%3A%2F%2F100.101.102.103%3A7460&fp=abc_-9&c=ABCDEFGH&n=example+host');
  assert.deepEqual(parseQrPayload(withFp), { url: 'wss://100.101.102.103:7460', fingerprintB64url: 'abc_-9', code: 'ABCDEFGH', hostName: 'example host' });

  const trusted = buildQrPayload({ url: 'wss://host.tail.ts.net:7460', code: 'ABCDEFGH', hostName: 'h' });
  assert.equal(trusted.includes('fp='), false);
  assert.deepEqual(parseQrPayload(trusted), { url: 'wss://host.tail.ts.net:7460', code: 'ABCDEFGH', hostName: 'h' });
  assert.equal(parseQrPayload('https://example.com'), null);
});

test('pairUrl prefers the MagicDNS name for tailscale certs and the bound IP otherwise', () => {
  assert.equal(pairUrl({ tlsMode: 'tailscale', hostnames: ['h.tail.ts.net'], listenAddress: '100.101.102.103', port: 7460, fallbackHost: 'x' }), 'wss://h.tail.ts.net:7460');
  assert.equal(pairUrl({ tlsMode: 'selfsigned', hostnames: ['h'], listenAddress: '100.101.102.103', port: 7460, fallbackHost: 'x' }), 'wss://100.101.102.103:7460');
  assert.equal(pairUrl({ tlsMode: 'selfsigned', hostnames: [], listenAddress: '0.0.0.0', port: 7460, fallbackHost: '192.168.1.20' }), 'wss://192.168.1.20:7460');
  assert.equal(pairUrl({ tlsMode: 'selfsigned', hostnames: [], listenAddress: 'fd7a::1', port: 7460, fallbackHost: 'x' }), 'wss://[fd7a::1]:7460');
});

test('lockout is per peer: one phone hammering a stale QR does not lock the others', () => {
  let t = 1_000_000;
  const pm = new PairingManager({ now: () => t });
  const { code } = pm.create();
  for (let i = 0; i < 4; i++) assert.equal(pm.redeem('AAAAAAAA', '100.0.0.1'), 'bad_code');
  assert.equal(pm.redeem('AAAAAAAA', '100.0.0.1'), 'locked_out');
  assert.equal(pm.isLockedOut('100.0.0.1'), true);
  assert.equal(pm.isLockedOut('100.0.0.2'), false);
  assert.equal(pm.lockoutRemainingMs('100.0.0.2'), 0);
  assert.equal(pm.redeem(code, '100.0.0.2'), 'ok', 'a different peer still pairs');
  t += 15 * 60_000;
  assert.equal(pm.isLockedOut('100.0.0.1'), false);
});
