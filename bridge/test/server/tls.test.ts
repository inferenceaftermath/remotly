import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { defaultConfig, type FlowConfig } from '../../src/config.ts';
import { silentLogger } from '../../src/log.ts';
import {
  buildSans,
  certInfo,
  ensureTls,
  fingerprintB64url,
  needsRenewal,
  parseSubjectAltName,
  selfSignedArgs,
  startTlsRenewal,
  tlsPaths,
  type TlsMaterial,
} from '../../src/server/tls.ts';
import { magicDnsName, type ExecFn, type ExecResult } from '../../src/tailscale.ts';

const FIXTURE = fs.readFileSync(new URL('../fixtures/isrg-root-x1.pem', import.meta.url));

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tls-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('fingerprint is base64url(SHA-256(leaf DER)) — matches X509Certificate.fingerprint256', () => {
  const fp = fingerprintB64url(FIXTURE);
  assert.match(fp, /^[A-Za-z0-9_-]{43}$/, 'unpadded base64url of 32 bytes');
  const oracle = Buffer.from(new crypto.X509Certificate(FIXTURE).fingerprint256.replace(/:/g, ''), 'hex').toString('base64url');
  assert.equal(fp, oracle);
  assert.equal(fingerprintB64url(FIXTURE.toString('utf8')), fp, 'string and Buffer input agree');
});

test('certInfo parses notAfter and falls back to CN when there is no SAN', () => {
  const info = certInfo(FIXTURE);
  assert.equal(info.notAfter.toISOString(), '2035-06-04T11:04:38.000Z');
  assert.deepEqual(info.hostnames, ['ISRG Root X1']);
  assert.equal(info.fingerprintB64url, fingerprintB64url(FIXTURE));
});

test('parseSubjectAltName handles DNS, IPv4 and IPv6 entries', () => {
  assert.deepEqual(parseSubjectAltName('DNS:host.tail.ts.net, IP Address:100.101.102.103, IP Address:FD7A:115C:A1E0:0:0:0:F01:CEC9'), [
    'host.tail.ts.net',
    '100.101.102.103',
    'FD7A:115C:A1E0:0:0:0:F01:CEC9',
  ]);
  assert.deepEqual(parseSubjectAltName(undefined), []);
  assert.deepEqual(parseSubjectAltName(''), []);
});

test('openssl argv matches the spec command and SANs are de-duplicated', () => {
  const sans = buildSans({ tailscaleIp: '100.101.102.103', lanIps: ['192.168.1.20', '100.101.102.103'], hostname: 'example-host' });
  assert.deepEqual(sans, ['IP:100.101.102.103', 'IP:192.168.1.20', 'DNS:example-host']);
  const args = selfSignedArgs('/t/self.key', '/t/self.crt', sans);
  assert.deepEqual(args.slice(0, 7), ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']);
  assert.deepEqual(args.slice(args.indexOf('-days'), args.indexOf('-days') + 2), ['-days', '800']);
  assert.ok(Number(args[args.indexOf('-days') + 1]) <= 825, 'Apple rejects TLS certs valid for more than 825 days');
  assert.ok(args.includes('extendedKeyUsage=serverAuth'), 'Apple requires a serverAuth EKU');
  assert.deepEqual(args.slice(args.indexOf('-subj'), args.indexOf('-subj') + 2), ['-subj', '/CN=remotly-bridge']);
  assert.deepEqual(args.slice(args.indexOf('-addext'), args.indexOf('-addext') + 2), ['-addext', 'subjectAltName=IP:100.101.102.103,IP:192.168.1.20,DNS:example-host']);
  assert.deepEqual(args.slice(-4), ['-keyout', '/t/self.key', '-out', '/t/self.crt']);
  assert.deepEqual(buildSans({ tailscaleIp: null, lanIps: [], hostname: 'h' }), ['DNS:h']);
});

test('magicDnsName strips the trailing dot and respects MagicDNS being off', () => {
  assert.equal(magicDnsName({ Self: { DNSName: 'host.tailnet-example.ts.net.' }, CurrentTailnet: { MagicDNSEnabled: true } }), 'host.tailnet-example.ts.net');
  assert.equal(magicDnsName({ Self: { DNSName: 'x.ts.net.' }, CurrentTailnet: { MagicDNSEnabled: false } }), null);
  assert.equal(magicDnsName({ Self: {} }), null);
  assert.equal(magicDnsName(null), null);
});

// ---------------------------------------------------------------- ensureTls with a mocked exec

const STATUS = JSON.stringify({ Self: { DNSName: 'host.tailnet-example.ts.net.' }, CurrentTailnet: { MagicDNSEnabled: true } });
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const missing: ExecResult = { code: null, stdout: '', stderr: 'spawn tailscale ENOENT' };

interface Call { cmd: string; args: string[]; timeoutMs: number | undefined }

/** Mock that emulates `tailscale cert` / `openssl` writing their output files. */
function mockExec(opts: { tailscale?: 'ok' | 'missing' | 'cert_fails'; openssl?: 'ok' | 'fails' } = {}) {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, o) => {
    calls.push({ cmd, args, timeoutMs: o?.timeoutMs });
    const ts = opts.tailscale ?? 'ok';
    if (cmd === 'tailscale') {
      if (ts === 'missing') return missing;
      if (args[0] === 'status') return ok(STATUS);
      if (args[0] === 'ip') return ok('100.101.102.103\n');
      if (args[0] === 'cert') {
        if (ts === 'cert_fails') return { code: 1, stdout: '', stderr: 'HTTPS certs are not enabled for this tailnet' };
        fs.writeFileSync(args[args.indexOf('--cert-file') + 1]!, FIXTURE);
        fs.writeFileSync(args[args.indexOf('--key-file') + 1]!, 'TS-KEY');
        return ok();
      }
    }
    if (cmd === 'openssl') {
      if ((opts.openssl ?? 'ok') === 'fails') return { code: 1, stdout: '', stderr: 'req: Use -help for summary.' };
      fs.writeFileSync(args[args.indexOf('-keyout') + 1]!, 'SELF-KEY');
      fs.writeFileSync(args[args.indexOf('-out') + 1]!, FIXTURE);
      return ok();
    }
    return { code: 127, stdout: '', stderr: `unexpected ${cmd}` };
  };
  return { exec, calls };
}

function cfg(mode: FlowConfig['tls']['mode']): FlowConfig {
  const c = defaultConfig();
  c.tls.mode = mode;
  return c;
}

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('auto → tailscale cert for the MagicDNS name (60 s timeout), no fingerprint', async () => {
  const { exec, calls } = mockExec();
  const m = await ensureTls(cfg('auto'), silentLogger, { exec, dir });
  assert.equal(m.mode, 'tailscale');
  assert.equal(m.fingerprintB64url, undefined, 'publicly trusted: nothing to pin');
  assert.deepEqual(m.hostnames, ['host.tailnet-example.ts.net']);
  assert.equal(m.notAfter.toISOString(), '2035-06-04T11:04:38.000Z');
  assert.equal(m.key.toString(), 'TS-KEY');
  const cert = calls.find((c) => c.cmd === 'tailscale' && c.args[0] === 'cert');
  assert.ok(cert);
  const p = tlsPaths(dir);
  assert.deepEqual(cert.args, ['cert', '--cert-file', p.tsCert, '--key-file', p.tsKey, 'host.tailnet-example.ts.net']);
  assert.equal(cert.timeoutMs, 60_000);
  assert.equal(mode(p.tsKey), 0o600);
  assert.equal(mode(p.tsCert), 0o600);
  assert.equal(calls.some((c) => c.cmd === 'openssl'), false);
});

test('auto → self-signed via openssl when tailscale is missing; reused on later starts', async () => {
  const { exec, calls } = mockExec({ tailscale: 'missing' });
  const m = await ensureTls(cfg('auto'), silentLogger, { exec, dir, hostname: () => 'myhost', lanIps: () => ['192.168.1.20'] });
  assert.equal(m.mode, 'selfsigned');
  assert.equal(m.fingerprintB64url, fingerprintB64url(FIXTURE));
  assert.equal(m.key.toString(), 'SELF-KEY');
  const p = tlsPaths(dir);
  const openssl = calls.find((c) => c.cmd === 'openssl');
  assert.ok(openssl);
  assert.deepEqual(openssl.args, selfSignedArgs(p.selfKey, p.selfCert, ['IP:192.168.1.20', 'DNS:myhost']));
  assert.equal(mode(p.selfKey), 0o600);
  assert.equal(fs.readFileSync(p.fingerprint, 'utf8').trim(), m.fingerprintB64url);

  const before = calls.length;
  const again = await ensureTls(cfg('auto'), silentLogger, { exec, dir });
  assert.equal(again.fingerprintB64url, m.fingerprintB64url);
  assert.equal(calls.slice(before).some((c) => c.cmd === 'openssl'), false, 'existing self-signed cert is reused');
});

test('auto falls back to self-signed when `tailscale cert` fails and includes the tailscale ip in SANs', async () => {
  const { exec, calls } = mockExec({ tailscale: 'cert_fails' });
  const m = await ensureTls(cfg('auto'), silentLogger, { exec, dir, hostname: () => 'h', lanIps: () => [] });
  assert.equal(m.mode, 'selfsigned');
  const openssl = calls.find((c) => c.cmd === 'openssl')!;
  assert.ok(openssl.args.includes('subjectAltName=IP:100.101.102.103,DNS:h'));
});

test('explicit modes: tailscale fails hard, selfsigned never runs tailscale cert', async () => {
  await assert.rejects(ensureTls(cfg('tailscale'), silentLogger, { exec: mockExec({ tailscale: 'cert_fails' }).exec, dir }), /tls\.mode is "tailscale"/);
  const { exec, calls } = mockExec();
  const m = await ensureTls(cfg('selfsigned'), silentLogger, { exec, dir, lanIps: () => [], hostname: () => 'h' });
  assert.equal(m.mode, 'selfsigned');
  assert.equal(calls.some((c) => c.cmd === 'tailscale' && c.args[0] === 'cert'), false);
  await assert.rejects(ensureTls(cfg('selfsigned'), silentLogger, { exec: mockExec({ openssl: 'fails' }).exec, dir: fs.mkdtempSync(path.join(dir, 'x')) }), /openssl.*failed.*Use -help/);
});

test('a still-valid cached tailscale cert survives a transient `tailscale cert` failure', async () => {
  await ensureTls(cfg('auto'), silentLogger, { exec: mockExec().exec, dir });
  const m = await ensureTls(cfg('auto'), silentLogger, { exec: mockExec({ tailscale: 'cert_fails' }).exec, dir });
  assert.equal(m.mode, 'tailscale');
  assert.deepEqual(m.hostnames, ['host.tailnet-example.ts.net']);
});

test('renewal: only tailscale certs with < 14 days left are renewed', async () => {
  const day = 24 * 3600_000;
  const base: TlsMaterial = { mode: 'tailscale', key: Buffer.alloc(0), cert: Buffer.alloc(0), notAfter: new Date(Date.now() + 10 * day), hostnames: ['h'] };
  assert.equal(needsRenewal(base), true);
  assert.equal(needsRenewal({ ...base, notAfter: new Date(Date.now() + 20 * day) }), false);
  assert.equal(needsRenewal({ ...base, mode: 'selfsigned' }), false);

  const { exec, calls } = mockExec();
  const renewed: TlsMaterial[] = [];
  const r = startTlsRenewal({ current: base, log: silentLogger, onRenewed: (m) => renewed.push(m), deps: { exec, dir }, intervalMs: 3600_000 });
  await r.runOnce();
  r.stop();
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0]?.notAfter.toISOString(), '2035-06-04T11:04:38.000Z');
  await r.runOnce(); // now far from expiry → nothing spawned
  assert.equal(calls.filter((c) => c.args[0] === 'cert').length, 1);
});
