import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../../src/config.ts';
import { createLogger, type LogFields } from '../../src/log.ts';
import { LAN_CONFIG } from '../../src/setup.ts';
import { TAILSCALE_PROBE_MS, TailscaleNotUp, absentResolution, presenceFrom, tailscaleDependents, tailscalePresence, waitForTailscale } from '../../src/server/tailscale-wait.ts';
import type { ExecResult } from '../../src/tailscale.ts';

const absent: ExecResult = { code: null, stdout: '', stderr: 'spawn tailscale ENOENT' };
const stopped: ExecResult = { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled; it doesn\'t appear to be running' };
const status = (state: string, self = true): ExecResult => ({ code: 0, stdout: JSON.stringify({ BackendState: state, ...(self ? { Self: { DNSName: 'host.tailnet-example.ts.net.', UserID: 1 } } : {}) }), stderr: '' });
const running = status('Running');

function capture() {
  const lines: LogFields[] = [];
  return { lines, log: createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l) as LogFields) }), events: () => lines.map((l) => `${l['level']}:${l['event']}`) };
}

test('tailscalePresence: no binary → absent; tailscaled down, logging in, logged out or junk → down; Running with Self → up', async () => {
  assert.equal(await tailscalePresence(async () => absent), 'absent');
  assert.equal(await tailscalePresence(async () => stopped), 'down');
  assert.equal(await tailscalePresence(async () => status('Starting')), 'down');
  assert.equal(await tailscalePresence(async () => status('NeedsLogin')), 'down');
  assert.equal(await tailscalePresence(async () => status('Running', false)), 'down', 'no Self: the gate could not identify anyone');
  assert.equal(await tailscalePresence(async () => ({ code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.tailnet-example.ts.net.' } }), stderr: '' })), 'down', 'Self without a UserID: the gate could not identify anyone either');
  assert.equal(await tailscalePresence(async () => ({ code: 0, stdout: 'Tailscale is stopped.', stderr: '' })), 'down');
  assert.equal(await tailscalePresence(async () => running), 'up');
  assert.equal(presenceFrom(stopped), 'down', 'setup and doctor read a status run the same way');
});

test('absentResolution: what each dependent setting does on a host without Tailscale', () => {
  assert.deepEqual(absentResolution(defaultConfig()), ['listen.host auto → every interface', 'tls.mode auto → self-signed certificate', 'security.require_tailnet auto → tailnet gate off']);
  const strict = defaultConfig();
  strict.listen.host = '0.0.0.0';
  strict.tls.mode = 'tailscale';
  strict.security.require_tailnet = true;
  assert.deepEqual(absentResolution(strict), ['tls.mode tailscale → no certificate, serve stops', 'security.require_tailnet true → every /pair and WebSocket request is denied']);
});

test('tailscaleDependents: every auto or Tailscale-only setting; nothing after setup --lan; listen.host alone does not count', () => {
  const cfg = defaultConfig();
  assert.deepEqual(tailscaleDependents(cfg), ['listen.host', 'tls.mode', 'security.require_tailnet']);
  cfg.listen.host = '100.101.102.103';
  cfg.tls.mode = 'tailscale';
  cfg.security.require_tailnet = true;
  assert.deepEqual(tailscaleDependents(cfg), ['tls.mode', 'security.require_tailnet'], 'a Tailscale-only value depends on it too');
  const lanish = defaultConfig();
  lanish.tls.mode = 'selfsigned';
  lanish.security.require_tailnet = false;
  assert.deepEqual(tailscaleDependents(lanish), [], 'listen.host auto with the LAN pair: every interface is the intended fallback, as setup and doctor say');
  const lan = defaultConfig();
  lan.listen.host = LAN_CONFIG.listen.host;
  lan.tls.mode = LAN_CONFIG.tls.mode;
  lan.security.require_tailnet = LAN_CONFIG.security.require_tailnet;
  assert.deepEqual(tailscaleDependents(lan), []);
});

test('waitForTailscale: LAN mode never runs tailscale; absent continues with a warning; up continues at once', async () => {
  const lan = defaultConfig();
  Object.assign(lan.listen, LAN_CONFIG.listen);
  Object.assign(lan.tls, LAN_CONFIG.tls);
  Object.assign(lan.security, LAN_CONFIG.security);
  let calls = 0;
  const { log, events } = capture();
  assert.equal(await waitForTailscale(lan, log, { exec: async () => (calls++, running) }), null);
  assert.equal(calls, 0);

  const a = capture();
  assert.equal(await waitForTailscale(defaultConfig(), a.log, { exec: async () => absent, sleep: async () => assert.fail('no waiting for a host without Tailscale') }), 'absent');
  assert.deepEqual(a.events(), ['warn:tailscale.absent']);
  assert.deepEqual(a.lines[0]!['resolves'], absentResolution(defaultConfig()), 'the journal says what each setting does without Tailscale');

  const u = capture();
  assert.equal(await waitForTailscale(defaultConfig(), u.log, { exec: async () => running, sleep: async () => assert.fail('no waiting when it is up') }), 'up');
  assert.deepEqual(u.events(), []);
  assert.deepEqual(events(), []);
});

/** A fake clock that the fake sleep advances; `probeMs` is how long each `tailscale status` run appears to take. */
function clock(probeMs = 0) {
  let t = 0;
  const slept: number[] = [];
  const timeouts: (number | undefined)[] = [];
  return {
    now: () => t,
    slept,
    timeouts,
    sleep: async (ms: number) => void (slept.push(ms), (t += ms)),
    probing:
      (answer: () => ExecResult) =>
      async (_cmd: string, _args: string[], o?: { timeoutMs?: number }): Promise<ExecResult> => {
        timeouts.push(o?.timeoutMs);
        t += probeMs;
        return answer();
      },
  };
}

test('waitForTailscale: installed but down → polls until Running, logging the wait', async () => {
  const answers = [stopped, status('Starting'), status('NeedsLogin'), running];
  const c = clock();
  const { log, lines, events } = capture();
  const cfg = defaultConfig();
  cfg.tls.mode = 'selfsigned'; // still depends on it: listen.host and the gate are auto
  const presence = await waitForTailscale(cfg, log, { exec: c.probing(() => answers.shift() ?? running), sleep: c.sleep, now: c.now, pollMs: 2000, timeoutMs: 60_000 });
  assert.equal(presence, 'up');
  assert.deepEqual(c.slept, [2000, 2000, 2000]);
  assert.deepEqual(events(), ['info:tailscale.waiting', 'info:tailscale.up']);
  assert.deepEqual(lines[0]!['depends'], ['listen.host', 'security.require_tailnet']);
  assert.equal(lines[1]!['waited_ms'], 6000);
  assert.ok(c.timeouts.every((ms) => ms === TAILSCALE_PROBE_MS), `every probe capped at ${TAILSCALE_PROBE_MS} ms while the budget is larger: ${c.timeouts.join(',')}`);
});

test('waitForTailscale: a binary that disappears while waiting is reported as absent (with the resolutions), never as up', async () => {
  const answers = [stopped, stopped, absent];
  const c = clock();
  const { log, lines, events } = capture();
  assert.equal(await waitForTailscale(defaultConfig(), log, { exec: c.probing(() => answers.shift() ?? absent), sleep: c.sleep, now: c.now, pollMs: 2000, timeoutMs: 60_000 }), 'absent');
  assert.deepEqual(events(), ['info:tailscale.waiting', 'warn:tailscale.absent']);
  assert.deepEqual(lines[1]!['resolves'], absentResolution(defaultConfig()));
  assert.equal(lines[1]!['waited_ms'], 4000);
});

test('waitForTailscale: still down after the timeout → TailscaleNotUp naming the settings, so systemd retries instead of a silent LAN fallback', async () => {
  const c = clock();
  const { log, events, lines } = capture();
  await assert.rejects(
    waitForTailscale(defaultConfig(), log, { exec: c.probing(() => stopped), sleep: c.sleep, now: c.now, pollMs: 2000, timeoutMs: 6000 }),
    (err: unknown) => err instanceof TailscaleNotUp && /installed but not up after 6 s/.test(err.message) && /listen.host, tls.mode, security.require_tailnet/.test(err.message) && /setup --lan/.test(err.message),
  );
  assert.deepEqual(c.slept, [2000, 2000, 2000]);
  assert.deepEqual(events(), ['info:tailscale.waiting', 'error:tailscale.not_up']);
  assert.equal(lines.at(-1)!['waited_ms'], 6000);
});

test('waitForTailscale: the deadline is wall-clock — a wedged tailscale CLI (every probe at its 10 s cap) still fails at about 60 s, with each probe bounded by what is left', async () => {
  // Every probe hangs until its cap: five probes and five sleeps fill the minute; the old sleep-only count would have
  // taken 30 probes (about 370 s).
  const wedged = clock(TAILSCALE_PROBE_MS);
  const w = capture();
  await assert.rejects(waitForTailscale(defaultConfig(), w.log, { exec: wedged.probing(() => stopped), sleep: wedged.sleep, now: wedged.now }), TailscaleNotUp);
  assert.equal(w.lines.at(-1)!['waited_ms'], 60_000);
  assert.deepEqual(wedged.timeouts, [10_000, 10_000, 10_000, 10_000, 10_000]);
  assert.deepEqual(wedged.slept, [2000, 2000, 2000, 2000, 2000], 'the last sleep uses up the 2 s left; no probe follows it');

  // Probes of 7 s: the last one starts with 6 s left and is given exactly that, so the wait ends at 61 s, not 64.
  const slow = clock(7000);
  const s = capture();
  await assert.rejects(waitForTailscale(defaultConfig(), s.log, { exec: slow.probing(() => stopped), sleep: slow.sleep, now: slow.now }), TailscaleNotUp);
  assert.equal(s.lines.at(-1)!['waited_ms'], 61_000);
  assert.deepEqual(slow.timeouts, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 6000]);
});
