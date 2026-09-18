// CLI entry: `remotly-bridge setup | serve | pair | devices | status | push-test | doctor | update` (§6.1).
import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode';
import pkg from '../package.json' with { type: 'json' };
import { createTailnetGate, DeviceStore } from './auth/devices.ts';
import { ConfigError, DEFAULT_RELAY_URL, configDir, configPath, directApns, directFcm, loadConfig, statePath, tlsDir } from './config.ts';
import { ControlError, controlRequest, controlSocketPath, startControlServer, type ControlHandlers, type ControlStatus, type PairInfo, type PushMode } from './control.ts';
import { HerdrClient, resolveSocketPath } from './herdr/client.ts';
import { HerdrLink } from './herdr/link.ts';
import { createLogger, parseLevel, type Logger } from './log.ts';
import { ApnsClient } from './push/apns.ts';
import { FcmClient } from './push/fcm.ts';
import { Notifier } from './push/notify.ts';
import { RelayClient } from './push/relay.ts';
import { startHttpServer } from './server/http.ts';
import { presenceFrom, waitForTailscale } from './server/tailscale-wait.ts';
import { HERDR_INSTALL, TAILSCALE_INSTALL, classifyTailnet, parseSetupArgs, reconcileHerdrEnv, runSetup, stableNodePath, systemdUserDir, unitFile, type SetupDeps } from './setup.ts';
import crypto from 'node:crypto';
import { UploadStore } from './server/uploads.ts';
import { Hub } from './server/hub.ts';
import { buildQrPayload, PairingManager, pairFallbackHost, pairUrl } from './server/pairing.ts';
import { Session } from './server/session.ts';
import { certInfo, ensureTls, lanIPv4Addresses, startTlsRenewal, tlsPaths, type TlsMaterial } from './server/tls.ts';
import { execFile as spawn, tailscaleIp4, type TailscaleStatus } from './tailscale.ts';
import { LOCK_TAKEN_EXIT, inheritedLockFd, runUpdate, type UpdateDeps } from './update.ts';

export const VERSION: string = pkg.version;

const USAGE = `remotly-bridge ${VERSION}
usage: remotly-bridge <command>
  setup [--ttl N] [--no-pair] [--no-wait] [--lan] [--keep-mode] [--keep-stopped] [--no-auto-update]
        [--unit NAME] [--config-dir DIR] [--herdr-session NAME] [--herdr-socket PATH]
                              check herdr and Tailscale, get the certificate, install and start the user
                              service and the daily update timer, print one pairing QR for all your phones
                              (what install.sh runs)
  serve                       run the daemon (systemd)
  pair [--manual] [--ttl N]   create a single-use pairing code; prints a QR unless --manual
  devices list                list paired devices
  devices revoke <device_id>  revoke a device
  status                      daemon status (herdr, listener, TLS, devices, push)
  push-test <device_id>       send a test notification
  doctor                      environment checks
  update                      install the newest release when this is not it (what the daily timer runs); a bridge
                              that does not stay up on it gets the previous copy back when that copy can be verified,
                              otherwise the output says what to do by hand
env: REMOTLY_CONFIG_DIR (default ~/.config/remotly), REMOTLY_LOG_LEVEL (debug|info|warn|error), REMOTLY_SYSTEMD_UNIT (the unit setup installs and doctor checks; default remotly-bridge)`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---- serve ------------------------------------------------------------------------------------

async function serve(log: Logger): Promise<void> {
  const config = loadConfig(log);
  // Boot order: Tailscale installed but not up yet must not turn into the every-interface / self-signed / gate-off fallback.
  // Seen up here, the listener and the gate hold on to it (a Tailscale that stops in between cannot open the host up;
  // the certificate may still fall back to self-signed, which only costs iPhones their connection).
  const tailscaleUp = (await waitForTailscale(config, log)) === 'up';
  const hostName = os.hostname();
  let tls: TlsMaterial = await ensureTls(config, log);
  const devices = new DeviceStore(statePath('devices.json'), { log }).load();
  const pairing = new PairingManager();
  const link = new HerdrLink({ socketPath: resolveSocketPath(config.herdr), log });
  const hub = new Hub({ link, log, hostName, version: VERSION });

  // Per platform: local credentials send directly; otherwise the relay (relay/README.md) sends on the host's behalf.
  const apnsCfg = config.push.apns;
  const localApns = directApns(config).ready
    ? new ApnsClient({ teamId: apnsCfg.team_id, keyId: apnsCfg.key_id, p8: fs.readFileSync(apnsCfg.p8_path), bundleId: apnsCfg.bundle_id, log })
    : null;
  const fcmCfg = config.push.fcm;
  const localFcm = directFcm(config).ready
    ? new FcmClient({ projectId: fcmCfg.project_id, serviceAccount: JSON.parse(fs.readFileSync(fcmCfg.service_account_path, 'utf8')), log })
    : null;
  const relay = config.push.relay_url ? new RelayClient({ url: config.push.relay_url, log, version: VERSION }) : null;
  const apns = localApns ?? relay?.apns() ?? null;
  const fcm = localFcm ?? relay?.fcm() ?? null;
  const pushMode: { apns: PushMode; fcm: PushMode } = {
    apns: localApns ? 'direct' : apns ? 'relay' : 'off',
    fcm: localFcm ? 'direct' : fcm ? 'relay' : 'off',
  };
  const notifier = new Notifier({
    config,
    devices,
    log,
    hostName,
    apns,
    fcm,
    isViewed: (pane, deviceId) => hub.isViewed(pane, deviceId),
    paneState: (pane) => hub.paneState(pane),
    excerpt: (pane) => hub.excerpt(pane),
    finishedExcerpt: (pane) => hub.finishedExcerpt(pane),
    approval: (pane) => hub.readApproval(pane),
    onArmChanged: (deviceId, pane, done) => hub.broadcastTo(deviceId, { t: 'notify.state', pane, done }),
  });
  hub.on('pane.status', (pane: string, status) => notifier.onStatusChange(pane, status));
  hub.on('pane.gone', (pane: string) => notifier.onPaneGone(pane));
  hub.on('pane.title', (pane: string) => notifier.onTitleChange(pane));
  hub.on('activity.token', (deviceId: string, pane: string) => notifier.syncActivity(deviceId, pane));
  log.info('push.ready', { apns: pushMode.apns, fcm: pushMode.fcm, ...(relay ? { relay: config.push.relay_url } : {}) });

  link.start();
  const gate = createTailnetGate(config, { log, tailscaleUp });
  const uploads = new UploadStore({ dir: config.uploads.dir, keepDays: config.uploads.keep_days, maxBytes: config.uploads.max_mb * 1024 * 1024, log });
  const http = await startHttpServer({
    config,
    devices,
    pairing,
    gate: (ip) => gate.allow(ip),
    onWebSocket: (ws, remoteIp) => void new Session(ws, { hub, devices, config, log, remoteIp }),
    log,
    herdrState: () => (link.isUp ? 'up' : 'down'),
    version: VERSION,
    hostName,
    tls,
    uploads,
    tailscaleUp,
  });
  const renewal = startTlsRenewal({
    current: tls,
    log,
    onRenewed: (material) => {
      tls = material;
      http.setTls(material);
    },
  });

  const handlers: ControlHandlers = {
    pair: async (ttlSec, reusable): Promise<PairInfo> => {
      const { code, expiresAt } = pairing.create(ttlSec, { reusable });
      const fallbackHost = pairFallbackHost({ lanFirst: config.security.require_tailnet === false, tailscaleIp: await tailscaleIp4(), lanIps: lanIPv4Addresses(), hostName });
      const url = pairUrl({ tlsMode: tls.mode, hostnames: tls.hostnames, listenAddress: http.address, port: http.port, fallbackHost });
      const info: PairInfo = { code, expires_at: expiresAt.toISOString(), reusable, url, host_name: hostName, qr_payload: '' };
      if (tls.fingerprintB64url) info.fingerprint = tls.fingerprintB64url;
      info.qr_payload = buildQrPayload({ url, fingerprintB64url: tls.fingerprintB64url, code, hostName });
      log.info('pair.code_created', { expires_at: info.expires_at, reusable });
      return info;
    },
    devices: () => devices.list().map((d) => ({ id: d.id, name: d.name, platform: d.platform, created_at: d.created_at, last_seen: d.last_seen, push: d.push !== undefined })),
    revoke: (id) => {
      const ok = devices.revoke(id);
      if (ok) log.info('device.revoked', { device_id: id });
      return ok;
    },
    status: (): ControlStatus => ({
      pid: process.pid,
      herdr: link.isUp ? 'up' : 'down',
      listen: { host: http.address, port: http.port },
      tls: { mode: tls.mode, not_after: tls.notAfter.toISOString(), ...(tls.fingerprintB64url ? { fingerprint: tls.fingerprintB64url } : {}) },
      devices: devices.list().length,
      push: { apns: apns !== null, fcm: fcm !== null, mode: pushMode },
      clients: hub.clientCount,
      version: VERSION,
    }),
    pushTest: (id) => notifier.pushTest(id),
  };
  const control = await startControlServer(handlers, { log });
  log.info('bridge.started', { version: VERSION, config_dir: configDir(), listen: `${http.address}:${http.port}`, tls: tls.mode, herdr_socket: resolveSocketPath(config.herdr) });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('bridge.stopping', { signal });
    renewal.stop();
    notifier.close();
    devices.flush();
    // Give the desktop its panes back before the process goes (a deploy while a phone is viewing used to leave the
    // pane at phone width for good): fits first, zooms after, so herdr applies its own layout size last. Only then
    // drop the herdr link and the listeners. The 3 s deadline still bounds the whole exit.
    hub.fitter
      .restoreAll()
      .then(() => hub.zoomer.restoreAll())
      .catch(() => undefined)
      .then(() => {
        link.stop();
        return Promise.allSettled([control.close(), http.close()]);
      })
      .then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ---- client commands (talk to the daemon over the control socket) -----------------------------

async function control<T>(req: Parameters<typeof controlRequest>[0], opts: { timeoutMs?: number } = {}): Promise<T> {
  try {
    return await controlRequest<T>(req, opts);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e instanceof ControlError) throw new Error(`${e.code}: ${e.message}`);
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      throw new Error(`daemon not reachable at ${controlSocketPath()} — is remotly-bridge running? (systemctl --user status ${unitFile(process.env['REMOTLY_SYSTEMD_UNIT'] ?? 'remotly-bridge')})`);
    }
    throw err;
  }
}

async function pair(argv: string[]): Promise<void> {
  const ttlRaw = arg(argv, '--ttl');
  const req: { cmd: 'pair'; ttl?: number } = { cmd: 'pair' };
  if (ttlRaw !== undefined) {
    const ttl = Number(ttlRaw);
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600) throw new Error('--ttl must be an integer between 30 and 3600 seconds');
    req.ttl = ttl;
  }
  await printPairInfo(await control<PairInfo>(req), { qr: !argv.includes('--manual') });
}

async function printPairInfo(info: PairInfo, opts: { qr: boolean }): Promise<void> {
  if (opts.qr) console.log(await qrcode.toString(info.qr_payload, { type: 'terminal', small: true }));
  console.log(`Remotly pairing — scan the QR in the Remotly app, or enter these manually:`);
  console.log(`  Host name:    ${info.host_name}`);
  console.log(`  Server URL:   ${info.url}`);
  console.log(`  Code:         ${info.code.slice(0, 4)} ${info.code.slice(4)}`);
  if (info.fingerprint) console.log(`  Fingerprint:  ${info.fingerprint}   (self-signed certificate; the app pins it)`);
  else console.log(`  Certificate:  publicly trusted (Tailscale)`);
  console.log(`  Expires:      ${info.expires_at}   ${info.reusable ? '(one code for all your phones: scan it on each)' : '(single use)'}`);
  if (process.env['REMOTLY_PRINT_PAYLOAD']) console.log(`  Payload:      ${info.qr_payload}`);
}

// ---- setup ------------------------------------------------------------------------------------

async function setup(argv: string[]): Promise<void> {
  const opts = parseSetupArgs(argv);
  // Before anything touches the filesystem: loadConfig() below creates the config dir and config.json, which as root
  // would leave root-owned state in the user's home (runSetup repeats the check for callers that skip this path).
  if (process.getuid?.() === 0) {
    console.error("run setup as the user who runs herdr, not as root (herdr's socket and the service are per user)");
    process.exitCode = 1;
    return;
  }
  // The config dir decides every path below (config, control socket, tls); the unit gets the same absolute value.
  if (opts.configDir) process.env['REMOTLY_CONFIG_DIR'] = opts.configDir;
  else if (process.env['REMOTLY_CONFIG_DIR']) opts.configDir = configDir();
  // config.json's herdr.socket / herdr.session win over flags and the shell's environment, as in `serve`.
  let configuredHerdr: { socket?: string | null; session?: string | null } = {};
  try {
    configuredHerdr = loadConfig().herdr;
  } catch {
    /* runSetup reports the config problem */
  }
  reconcileHerdrEnv(opts, process.env, configuredHerdr);
  const home = os.homedir();
  const deps: SetupDeps = {
    version: VERSION,
    exec: spawn,
    out: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    user: os.userInfo().username,
    uid: process.getuid?.() ?? -1,
    nodePath: stableNodePath(process.execPath, home),
    mainPath: fileURLToPath(import.meta.url),
    env: process.env,
    unitDir: systemdUserDir(process.env, home),
    configPath: configPath(),
    tlsDir: tlsDir(),
    herdrSocket: resolveSocketPath(),
    loadConfig: () => loadConfig(),
    herdrPing: (sock) => new HerdrClient({ socketPath: sock }).request<{ version: string; protocol: number }>('ping', {}, 3000),
    status: (timeoutMs) => controlRequest<ControlStatus>({ cmd: 'status' }, { timeoutMs }),
    pair: (ttl) => controlRequest<PairInfo>({ cmd: 'pair', ttl, reusable: true }, { timeoutMs: 10_000 }),
    showPairing: (info) => printPairInfo(info, { qr: true }),
  };
  deps.herdrSocket = resolveSocketPath(configuredHerdr);
  process.exitCode = await runSetup(deps, opts);
}

async function devicesCmd(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'list';
  if (sub === 'list') {
    const list = await control<{ id: string; name: string; platform: string; created_at: string; last_seen: string | null; push: boolean }[]>({ cmd: 'devices' });
    if (list.length === 0) return console.log('no paired devices');
    for (const d of list) console.log(`${d.id}  ${d.platform.padEnd(7)}  push=${d.push ? 'yes' : 'no '}  last_seen=${d.last_seen ?? '-'}  ${d.name}`);
    return;
  }
  if (sub === 'revoke') {
    const id = argv[1];
    if (!id) throw new Error('usage: remotly-bridge devices revoke <device_id>');
    await control({ cmd: 'revoke', id });
    return console.log(`revoked ${id}`);
  }
  throw new Error(`unknown devices subcommand "${sub}"`);
}

async function status(): Promise<void> {
  const s = await control<ControlStatus>({ cmd: 'status' });
  console.log(`version:  ${s.version ?? '-'}`);
  console.log(`herdr:    ${s.herdr}`);
  console.log(`listen:   ${s.listen ? `${s.listen.host}:${s.listen.port}` : '-'}`);
  console.log(`tls:      ${s.tls.mode}, expires ${s.tls.not_after}${s.tls.fingerprint ? `, fingerprint ${s.tls.fingerprint}` : ''}`);
  console.log(`devices:  ${s.devices}`);
  const pushWord = (ready: boolean, mode: PushMode | undefined): string => (ready ? `ready${mode ? ` (${mode})` : ''}` : 'off');
  console.log(`push:     apns=${pushWord(s.push.apns, s.push.mode?.apns)} fcm=${pushWord(s.push.fcm, s.push.mode?.fcm)}`);
  console.log(`clients:  ${s.clients}`);
}

async function pushTest(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) throw new Error('usage: remotly-bridge push-test <device_id>');
  // A push may legitimately take up to 25 s through the relay (its 20 s upstream budget) or 20 s directly (2 × 10 s).
  const result = await control<{ ok: boolean; status?: number; reason?: string }>({ cmd: 'push-test', id }, { timeoutMs: 30_000 });
  console.log(result.ok ? 'push sent' : `push failed: ${result.status} ${result.reason}`);
  if (!result.ok) process.exitCode = 1;
}

// ---- doctor -----------------------------------------------------------------------------------

async function doctor(): Promise<void> {
  let failures = 0;
  const ok = (msg: string) => console.log(`  ✔ ${msg}`);
  /** Every failing check says what to do about it. */
  const bad = (msg: string, fix: string, hard = true) => {
    console.log(`  ${hard ? '✖' : '⚠'} ${msg}`);
    console.log(`      fix: ${fix}`);
    if (hard) failures++;
  };
  const unit = unitFile(process.env['REMOTLY_SYSTEMD_UNIT'] ?? 'remotly-bridge');
  const user = os.userInfo().username;
  /** Paths in the printed fixes are meant to be pasted: quote anything a shell would split or expand. */
  const sh = (p: string): string => (/^[A-Za-z0-9_./~+:@=,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
  console.log(`remotly-bridge doctor (config dir ${configDir()})`);

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 24) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} — need ≥ 24`, 'install Node 24, or re-run the installer, which brings its own runtime: curl -fsSL https://remotly.dev/install.sh | sh');

  let config;
  try {
    config = loadConfig();
    ok(`config ${configPath()}`);
  } catch (err) {
    bad((err as Error).message, `correct the value in ${sh(configPath())}, or delete the file to start from the defaults`);
    process.exitCode = 1;
    return;
  }

  const sock = resolveSocketPath(config.herdr);
  if (!fs.existsSync(sock)) bad(`herdr socket missing: ${sock}`, `start herdr (run \`herdr\`); not installed yet? ${HERDR_INSTALL}`);
  else {
    try {
      const pong = await new HerdrClient({ socketPath: sock }).request<{ version: string; protocol: number }>('ping', {}, 3000);
      if (pong.protocol === 19) ok(`herdr ${pong.version} protocol ${pong.protocol} at ${sock}`);
      else bad(`herdr ${pong.version} protocol ${pong.protocol} (built against 19)`, 'update herdr or the bridge so the protocol versions match', false);
    } catch (err) {
      bad(`herdr ping failed: ${(err as Error).message}`, 'start herdr (run `herdr`); a stale socket from an old session is replaced when it starts');
    }
  }

  const tsRun = await spawn('tailscale', ['status', '--json']);
  const tsPresence = presenceFrom(tsRun); // the daemon's own reading: absent | down (stopped, logging in, no Self) | up
  const tsPresent = tsPresence !== 'absent';
  let ts: TailscaleStatus | null = null;
  try {
    ts = tsRun.code === 0 ? (JSON.parse(tsRun.stdout) as TailscaleStatus) : null;
  } catch {
    ts = null;
  }
  // Two independent things: the certificate (tls.mode) and the tailnet gate (security.require_tailnet). Tailscale is
  // optional only when the gate is off by configuration (`setup --lan`); a self-signed certificate alone does not make
  // it optional, and `auto` turns the gate on whenever tailscaled answers.
  const gateOff = config.security.require_tailnet === false;
  const needCert = config.tls.mode !== 'selfsigned';
  const strictTls = config.tls.mode === 'tailscale'; // serve refuses the self-signed fallback: the next restart needs Tailscale
  const lanMode = gateOff && !needCert && config.listen.host !== 'auto'; // the triple `setup --lan` writes
  const autoListenerNoGate = gateOff && !needCert && config.listen.host === 'auto'; // the same pair by hand, listener left to Tailscale
  const tailnet = classifyTailnet(ts, tsPresent, { cert: needCert });
  // Same rules as setup and serve: the gate is hard when required, or `auto` with Tailscale installed (up → the gate is
  // on; stopped → serve waits for it and then refuses to start rather than running with the gate off); a certificate
  // mode that tries Tailscale first needs it too (setup waits for it — iPhones refuse the fallback).
  const gateHard = config.security.require_tailnet === true || (config.security.require_tailnet === 'auto' && tsPresent);
  const tsHard = gateHard || needCert;
  const install = `${TAILSCALE_INSTALL}   then: sudo tailscale up`;
  if (lanMode) ok('tailscale not used: LAN mode (tls.mode "selfsigned", require_tailnet false) — neither the binary nor tailscaled matters here');
  else if (autoListenerNoGate)
    ok(
      tsPresence === 'up'
        ? 'tailscale not required (tls.mode "selfsigned", require_tailnet false), but listen.host "auto" binds its IPv4 while it runs — LAN peers cannot connect; set listen.host to "0.0.0.0" (what setup --lan writes) to serve them'
        : 'tailscale not required (tls.mode "selfsigned", require_tailnet false); listen.host "auto" binds every interface while Tailscale is absent or stopped — set listen.host to "0.0.0.0" to make that permanent',
    );
  else if (!tsPresent) {
    if (strictTls) bad('tailscale not installed — tls.mode is "tailscale", so the bridge does not start (again) without its certificate', `${install}   (or set tls.mode to "auto")`);
    else if (needCert) bad('tailscale not installed — iPhones refuse the self-signed fallback certificate', `${install}   (or, for a LAN-only host: remotly-bridge setup --lan)`);
    else if (config.security.require_tailnet === true) bad('tailscale not installed — require_tailnet is true, so the gate denies every request', `${install}   (or set security.require_tailnet to false for a LAN-only host)`);
    else bad('tailscale not installed — the automatic tailnet gate is off: any device that can reach this host may try to pair', `${install}   (or set security.require_tailnet to false to say so deliberately)`, false);
  } else if (!tailnet.ok) bad(tailnet.problem, tailnet.fix.join('; '), tsHard);
  else if (needCert) ok(`tailscale running as ${tailnet.name}${tailnet.ip ? ` ip=${tailnet.ip}` : ''}, HTTPS certificates enabled`);
  else ok(`tailscale running as ${tailnet.name ?? tailnet.ip ?? 'this node'}${gateOff ? ' (tailnet gate off by config)' : ': tailnet gate on'}`);

  // The daemon, if any, answers on this config dir's control socket; its TLS mode says which certificate pair is live.
  let daemon: ControlStatus | null = null;
  try {
    daemon = await controlRequest<ControlStatus>({ cmd: 'status' }, { timeoutMs: 3000 });
  } catch {
    daemon = null;
  }

  const paths = tlsPaths(tlsDir());
  const liveMode = daemon?.tls.mode ?? (config.tls.mode === 'auto' ? (fs.existsSync(paths.tsCert) ? 'tailscale' : 'selfsigned') : config.tls.mode);
  const [cert, key, kind] = liveMode === 'tailscale' ? [paths.tsCert, paths.tsKey, 'tailscale'] : [paths.selfCert, paths.selfKey, 'self-signed'];
  if (!fs.existsSync(cert)) bad(`no ${kind} certificate yet (created on the first start)`, 'remotly-bridge setup', false);
  else {
    const refresh = `systemctl --user restart ${unit}   (it requests or generates a fresh pair)`;
    try {
      const certPem = fs.readFileSync(cert);
      const info = certInfo(certPem);
      const days = Math.floor((info.notAfter.getTime() - Date.now()) / 86_400_000);
      if (!fs.existsSync(key)) bad(`${kind} certificate ${cert} has no key file ${key} — the daemon cannot use it`, `rm ${sh(cert)}; ${refresh}`);
      else if (!new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(key)))) bad(`${kind} certificate and key do not match (${cert}, ${key})`, `rm ${sh(cert)} ${sh(key)}; ${refresh}`);
      else if (days > 0) ok(`${kind} certificate valid ${days} more days (${info.hostnames.join(', ')})${daemon ? '' : ' — daemon down, judged from the files'}`);
      else bad(`${kind} certificate ${cert} expired`, refresh);
      if (kind === 'self-signed' && tailnet.ok && needCert) {
        bad('a self-signed certificate is in use although Tailscale is ready — iPhones refuse it', `remotly-bridge setup   (requests the Tailscale certificate; on "access denied": sudo tailscale set --operator=${user})`, false);
      }
    } catch (err) {
      bad(`certificate or key unreadable: ${(err as Error).message}`, `rm ${sh(cert)} ${sh(key)}; ${refresh}`);
    }
  }

  // Push: a platform sends directly when its secrets are configured, otherwise through the relay (if reachable).
  // Same predicates as `serve`: a platform sends directly only when `directApns/directFcm(...).ready`.
  const relayUrl = config.push.relay_url;
  const platforms: [string, string, 'apns' | 'fcm', ReturnType<typeof directApns>][] = [
    ['APNs key', config.push.apns.p8_path, 'apns', directApns(config)],
    ['FCM service account', config.push.fcm.service_account_path, 'fcm', directFcm(config)],
  ];
  const relayNeeded = platforms.some(([, , , d]) => !d.ready);
  const relay = relayUrl ? new RelayClient({ url: relayUrl, log: createLogger({ level: 'error', write: () => undefined }), version: VERSION, requestTimeoutMs: 3000 }) : null;
  const relayHealth = relay && relayNeeded ? await relay.health() : null;
  const relayFix = `check this host's internet access: curl -A remotly-bridge/manual ${sh(`${relayUrl}/health`)}`;
  if (relay && !relayNeeded) ok(`push relay ${relayUrl}: not needed, both platforms have local credentials`);
  else if (relay) {
    if (relayHealth) ok(`push relay ${relayUrl} reachable (apns=${relayHealth.apns ? 'yes' : 'no'} fcm=${relayHealth.fcm ? 'yes' : 'no'}, v${relayHealth.version})`);
    else bad(`push relay ${relayUrl} unreachable — platforms without local secrets get no notifications until it is`, relayFix, false);
  }
  for (const [label, file, platform, direct] of platforms) {
    const app = platform === 'apns' ? 'iOS' : 'Android';
    if (direct.ready) {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode === 0o600) ok(`${label} ${file} (0600, direct)`);
      else bad(`${label} ${file} has mode ${mode.toString(8)}`, `chmod 600 ${sh(file)}`);
      continue;
    }
    if (direct.intended) {
      // What actually happens meanwhile depends on the relay's real state, not on its being configured.
      const meanwhile = !relay
        ? `no ${app} notifications (push.relay_url is empty)`
        : !relayHealth
          ? `the relay is unreachable, so no ${app} notifications right now`
          : !relayHealth[platform]
            ? `the relay has no ${platform} credentials, so no ${app} notifications`
            : `${app} notifications go through the relay meanwhile`;
      bad(`${label}: direct mode incomplete — missing ${direct.missing.join(', ')}; ${meanwhile}`, `set the missing values in config.json, or clear push.${platform}.* to use the relay deliberately`);
      continue;
    }
    // Relay mode: green only on a positive health answer for this platform.
    if (!relay) bad(`${label} not configured (push.${platform}.* in config.json) and push.relay_url is empty — no ${app} notifications`, `set push.relay_url (default ${DEFAULT_RELAY_URL}) or the push.${platform}.* credentials`, false);
    else if (!relayHealth) bad(`${label}: not configured here and the relay is unreachable — no ${app} notifications until it answers`, relayFix, false);
    else if (!relayHealth[platform]) bad(`${label}: not configured here and the relay has no ${platform} credentials — no ${app} notifications`, `configure push.${platform}.* here, or ask the relay's operator`, false);
    else ok(`${label}: not configured here, ${app} notifications go through the relay`);
  }

  // The daemon must be running somehow: as the unit, or by hand (`serve` in a terminal). Both down is a hard failure,
  // as is an active unit whose daemon does not answer on this config dir (it serves another one).
  const active = (await spawn('systemctl', ['--user', 'is-active', unit])).stdout.trim() === 'active';
  const mainPid = Number((await spawn('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit])).stdout.trim()) || 0;
  if (active) ok(`systemd unit ${unit} active${mainPid ? ` (pid ${mainPid})` : ''}`);
  else if (daemon) bad(`systemd unit ${unit} is not active — the daemon answering here${daemon.pid !== undefined ? ` (pid ${daemon.pid})` : ''} was started by hand and does not come back after a reboot`, `stop that serve${daemon.pid !== undefined ? ` (kill ${daemon.pid})` : ''}, then: remotly-bridge setup   (setup does not install over it, and systemctl --user start ${unit} could not bind the socket it holds)`, false);
  else bad(`systemd unit ${unit} is not active`, `remotly-bridge setup   (installs and starts it), or: systemctl --user start ${unit}`);
  // The daemon answering here must be the unit's process (a pid-less answer is a daemon from before this version).
  if (daemon && active && daemon.pid !== undefined && mainPid > 0 && daemon.pid !== mainPid) {
    bad(`the daemon on this config dir (pid ${daemon.pid}) is not unit ${unit} (pid ${mainPid}) — the unit serves another config dir, so this one is not restored after a reboot`, `remotly-bridge setup --unit <name>   for this config dir (after stopping the manual daemon), or run doctor with the unit's REMOTLY_CONFIG_DIR`);
  }
  const linger = await spawn('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
  if (linger.stdout.trim() === 'yes') ok('linger on: the unit starts at boot and survives logout');
  else bad('linger off: the bridge stops when you log out', `sudo loginctl enable-linger ${user}`, false);
  if (daemon) ok(`daemon reachable: herdr ${daemon.herdr}, listening ${daemon.listen?.host}:${daemon.listen?.port}, tls ${daemon.tls.mode}, ${daemon.devices} device(s), ${daemon.clients} client(s)`);
  else if (active) bad(`unit ${unit} is active but no daemon answers at ${controlSocketPath()} — it runs with another REMOTLY_CONFIG_DIR`, `systemctl --user cat ${unit}   and run doctor with the same REMOTLY_CONFIG_DIR`);
  else bad(`daemon not reachable at ${controlSocketPath()}`, `systemctl --user start ${unit}; if it stops again: journalctl --user -u ${unit} -n 30`);

  console.log(failures === 0 ? 'doctor: no hard failures' : `doctor: ${failures} hard failure(s)`);
  if (failures > 0) process.exitCode = 1;
}

// ---- update -----------------------------------------------------------------------------------

async function update(): Promise<void> {
  const deps: UpdateDeps = {
    version: VERSION,
    mainPath: fileURLToPath(import.meta.url),
    // The runtime the unit was set up with (setup writes it into the update unit); by hand, the same reading of this
    // process's node as setup uses (an fnm alias stays an alias, `process.execPath` would pin the version behind it).
    nodePath: process.env['REMOTLY_NODE'] ?? stableNodePath(process.execPath, os.homedir()),
    env: process.env,
    pathDirs: (process.env['PATH'] ?? '').split(path.delimiter),
    unit: process.env['REMOTLY_SYSTEMD_UNIT'] ?? 'remotly-bridge',
    out: (line) => console.log(line),
    exec: spawn,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    heldLockFd: inheritedLockFd,
    relock: (cmd, args, env) =>
      new Promise((resolve) => {
        const child = spawnProcess(cmd, args, { stdio: 'inherit', env });
        child.on('error', (err) => resolve({ code: null, signal: null, error: err.message }));
        child.on('exit', (code, signal) => resolve({ code, signal }));
      }),
    // flock on the inherited descriptor, handed to it as fd 3: a lock is per open file, so what the child confirms (or
    // takes) on its fd 3 is held by this process's descriptor once the child is gone.
    confirmLock: (lockFd) =>
      new Promise((resolve) => {
        const child = spawnProcess('flock', ['-n', '-E', String(LOCK_TAKEN_EXIT), '3'], { stdio: ['ignore', 'inherit', 'inherit', lockFd] });
        child.on('error', (err) => resolve({ code: null, signal: null, error: err.message }));
        child.on('exit', (code, signal) => resolve({ code, signal }));
      }),
    // Node's fetch hands a `manual` redirect back as the 3xx response itself, Location included.
    latestTag: async (releases) => {
      try {
        const res = await fetch(`${releases}/latest`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        const loc = res.headers.get('location');
        return res.status >= 300 && res.status < 400 && loc ? loc : null;
      } catch {
        return null;
      }
    },
    download: async (url, dest) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
    },
    runInstaller: (script, args, env, lockFd) =>
      new Promise((resolve) => {
        // The lock descriptor goes along as fd 3 (`stdio` shares only 0–2 by itself): install.sh finds it under
        // /proc/self/fd and takes no lock of its own, and the lock outlives this process as long as the installer runs.
        const child = spawnProcess('sh', [script, ...args], { stdio: [0, 1, 2, lockFd], env });
        child.on('error', (err) => resolve({ code: null, signal: null, error: err.message }));
        child.on('exit', (code, signal) => resolve({ code, signal }));
      }),
    status: (timeoutMs) => controlRequest<ControlStatus>({ cmd: 'status' }, { timeoutMs }),
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-update-')),
  };
  process.exitCode = await runUpdate(deps);
}

// ---- dispatch ---------------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'setup':
      return setup(rest);
    case 'serve':
      return serve(createLogger({ level: parseLevel(process.env['REMOTLY_LOG_LEVEL']) }));
    case 'pair':
      return pair(rest);
    case 'devices':
      return devicesCmd(rest);
    case 'status':
      return status();
    case 'push-test':
      return pushTest(rest);
    case 'doctor':
      return doctor();
    case 'update':
      return update();
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.log(USAGE);
      if (cmd !== undefined && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error((err as Error).message ?? err);
  process.exit(1);
});
