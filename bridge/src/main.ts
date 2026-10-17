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
import { AGENT_SETTINGS_RECORD, applyPendingAgents, claudeRunning } from './agent-settings.ts';
import { ApnsClient } from './push/apns.ts';
import { FcmClient } from './push/fcm.ts';
import { Notifier } from './push/notify.ts';
import { RelayClient } from './push/relay.ts';
import { startHttpServer } from './server/http.ts';
import { tailscaleHints } from './platform/hints.ts';
import { LOCK_FD_ENV, confirmCommand } from './platform/lock.ts';
import { herdrConfigHome, herdrUnit, serviceManagerFor, serviceUnitDir, type ServiceManager } from './platform/service.ts';
import { presenceFrom, waitForTailscale } from './server/tailscale-wait.ts';
import { classifyTailnet, describeHerdr, executableFile, HERDR_INSTALL, HERDR_UNIT_STATES_SETUP_OWNS, herdrArgv, herdrSessionFor, herdrStopCommand, herdrUnitFile, lintedPlist, listOf, otherHerdrUnits, parseSetupArgs, pidListeningOn, readProcessArgs, readProcessComm, readProcessConfigHome, readProcessUnit, reconcileHerdrEnv, runSetup, shellWord, stableNodePath, TERMINAL_APPS, keepOne, offPlan, otherPlan, startsHow, stopsEnd, unitSourceCheck, type OffPlan, type OtherHerdrUnit, type SetupDeps, type SetupOptions } from './setup.ts';
import crypto from 'node:crypto';
import { UploadStore } from './server/uploads.ts';
import { Hub } from './server/hub.ts';
import { buildQrPayload, PairingManager, pairFallbackHost, pairUrl } from './server/pairing.ts';
import { Session } from './server/session.ts';
import { certInfo, ensureTls, lanIPv4Addresses, startTlsRenewal, tlsPaths, type TlsMaterial } from './server/tls.ts';
import { execFile as spawn, tailscaleIp4, type TailscaleStatus } from './tailscale.ts';
import { inheritedLockFd, runUpdate, type UpdateDeps } from './update.ts';

export const VERSION: string = pkg.version;

const USAGE = `remotly-bridge ${VERSION}
usage: remotly-bridge <command>
  setup [--ttl N] [--no-pair] [--no-wait] [--lan] [--keep-mode] [--keep-stopped] [--no-auto-update]
        [--no-agent-settings] [--no-herdr-service] [--unit NAME] [--config-dir DIR] [--herdr-session NAME]
        [--herdr-socket PATH]
                              install a user service for herdr (back after a reboot — at login on a Mac) and start
                              it when herdr is not running, check herdr and Tailscale, set Claude Code and Codex to
                              keep their output in the scrollback, get the certificate, install and start the
                              bridge's user service and the daily update timer, print one pairing QR for all your
                              phones (what install.sh runs)
  serve                       run the daemon (what the user service runs)
  pair [--manual] [--ttl N]   create a single-use pairing code; prints a QR unless --manual
  devices list                list paired devices
  devices revoke <device_id>  revoke a device
  status                      daemon status (herdr, listener, TLS, devices, push)
  push-test <device_id>       send a test notification
  doctor                      environment checks
  update                      install the newest release when this is not it (what the daily timer runs); a bridge
                              that does not stay up on it gets the previous copy back when that copy can be verified,
                              otherwise the output says what to do by hand
env: REMOTLY_CONFIG_DIR (default ~/.config/remotly), REMOTLY_LOG_LEVEL (debug|info|warn|error), REMOTLY_SYSTEMD_UNIT (the unit setup installs and doctor checks;
     default remotly-bridge — a systemd user unit on Linux, the launchd agent dev.remotly.<name> on macOS), REMOTLY_TAILSCALE (the tailscale CLI, when not on PATH)`;

/** The service manager of this host — systemd on Linux, launchd on macOS — for the unit setup installs and the others check. */
function serviceManager(): ServiceManager {
  const home = os.homedir();
  return serviceManagerFor(process.platform, { exec: spawn, unitDir: serviceUnitDir(process.platform, process.env, home), user: os.userInfo().username, uid: process.getuid?.() ?? -1, home });
}
/** The unit name every command shares: REMOTLY_SYSTEMD_UNIT, default `remotly-bridge`. */
const unitOf = (): string => process.env['REMOTLY_SYSTEMD_UNIT'] ?? 'remotly-bridge';

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
  const tailscaleUp = (await waitForTailscale(config, log, { platform: process.platform })) === 'up';
  const hostName = os.hostname();
  let tls: TlsMaterial = await ensureTls(config, log);
  const devices = new DeviceStore(statePath('devices.json'), { log }).load();
  const pairing = new PairingManager();
  const link = new HerdrLink({ socketPath: resolveSocketPath(config.herdr), log });
  const hub = new Hub({ link, log, hostName, version: VERSION, scrollbackLines: config.scrollback.max_lines });

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
  hub.scrollback.start();
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

  // The agents' settings an unattended update left to be made (agent-settings.ts): Claude Code's while a session of it
  // runs, either one after a failed edit. Looked at now and every 15 minutes while any is left; each line logged once.
  let agentsTimer: NodeJS.Timeout | undefined;
  const agentNotes = new Set<string>();
  const pendingAgentSettings = (): void => {
    agentsTimer = undefined;
    let state: ReturnType<typeof applyPendingAgents>;
    try {
      state = applyPendingAgents({
        env: process.env,
        home: os.homedir(),
        out: (line) => {
          if (agentNotes.has(line)) return;
          agentNotes.add(line);
          log.info('agents.settings', { note: line.trim() });
        },
        record: statePath(AGENT_SETTINGS_RECORD),
        claudeRunning: () => {
          const uid = process.getuid?.();
          return uid === undefined || claudeRunning(uid);
        },
      });
    } catch (err) {
      log.warn('agents.settings_failed', { error: (err as Error).message });
      return;
    }
    if (state === 'waiting' || state === 'failed') agentsTimer = setTimeout(pendingAgentSettings, 15 * 60_000).unref();
  };
  pendingAgentSettings();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('bridge.stopping', { signal });
    clearTimeout(agentsTimer);
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
        hub.scrollback.stop();
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
      throw new Error(`daemon not reachable at ${controlSocketPath()} — is remotly-bridge running? (${serviceManager().hints.status(unitOf())})`);
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
  const service = serviceManager();
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
    unitDir: service.unitDir,
    platform: process.platform,
    service,
    home,
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
  const sm = serviceManager();
  const unit = sm.unitName(unitOf());
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

  // herdr, and the service setup installs for it (`<unit>-herdr`): with one, "start herdr" means what its state calls
  // for, and whether herdr is back after a reboot is the unit's standing (enabled), not whether it runs now. The unit
  // counts only when it is setup's (the file it wrote: herdrUnitFile) and for the session the bridge follows — both
  // what a running one serves (its process's arguments: launchd tells them, /proc on Linux) and what its file starts
  // next; a bridge moved to another session, or to a socket that is no session, leaves the old unit behind until the
  // next setup, or until it is restarted.
  // The socket as `serve` follows it, not as this shell carries it: config.json's herdr.socket / herdr.session win over
  // a pane's HERDR_SOCKET_PATH / HERDR_SESSION (reconcileHerdrEnv, as setup does before writing the unit) — else doctor
  // run from a pane of another session would hold the unit to that session.
  reconcileHerdrEnv({} as SetupOptions, process.env, config.herdr);
  const sock = resolveSocketPath(config.herdr);
  const session = herdrSessionFor(sock, os.homedir());
  const cfg = herdrConfigHome(os.homedir()); // what the unit pins; the same session name under another directory is another socket
  const want = session?.session ? `session ${session.session}` : 'the default session';
  const hu = herdrUnit(unitOf());
  const huName = sm.unitName(hu);
  const hst = await sm.state(hu);
  const standing = await sm.enabledState(hu); // asked on its own: a masked systemd unit is not "loaded" to `state`
  const hidden = standing.state === 'masked' ? await sm.maskHides(hu) : null; // a mask over a unit file in another load path: a unit setup did not write, which unmasking would expose
  const masked = standing.state === 'masked' && hidden === null;
  const svc = hst !== null && hst.load === 'loaded' ? hst : null;
  // When an enabled unit starts: at login on a Mac; at boot under a systemd user manager with linger, at login without
  // (the manager itself starts then — the linger check further down says so and how to turn it on).
  const boot = sm.kind === 'launchd' ? 'login' : (await sm.persistenceCheck(hu)).ok ? 'boot' : 'login (linger is off, so the user manager starts then)';
  const renderFor = (a: { herdrPath: string; session?: string; configHome?: string }): string => sm.renderHerdrUnit({ unit: unitOf(), herdrPath: a.herdrPath, session: a.session, configHome: a.configHome ?? '' });
  const file = await lintedPlist(herdrUnitFile(sm.unitPath(hu), huName, renderFor), sm.unitPath(hu), sm, spawn);
  const owned = file.kind === 'owned' ? file.args : null;
  const gone = owned !== null && !executableFile(owned.herdrPath) ? owned.herdrPath : null; // the herdr the file starts is not there to run (moved since setup wrote it): the next start fails, whatever runs now
  // Not setup's, whatever the manager makes of the name: something else at the path (a symlink, another file — setup
  // leaves those alone even when nothing is loaded), a standing setup does not take over (`linked`, `static`, a label
  // another plist declares — the same test setup applies), a loaded unit without a file of ours, one loaded from
  // another path, or one with a drop-in changing what it runs.
  const foreign =
    hidden !== null
      ? `masked, and the mask hides ${hidden}`
      : masked
        ? null // the mask itself (a link to /dev/null at the unit's path) is the user's choice, said below, not a unit taking the name
        : file.kind === 'foreign'
          ? file.why
          : !standing.unreadable && !HERDR_UNIT_STATES_SETUP_OWNS.has(standing.state)
            ? standing.state
            : svc === null
              ? null
              : file.kind === 'absent'
                ? `no file at ${sm.unitPath(hu)}`
                : unitSourceCheck(await sm.source(hu), sm.unitPath(hu), sm.name);
  const argv = svc?.active === 'active' ? (svc.args ?? (svc.pid ? await readProcessArgs(svc.pid, process.platform, spawn) : null)) : null;
  const programOff = svc?.program !== undefined && argv !== null && svc.program !== argv[0]; // launchd runs `program` with the arguments as argv (a Program key): not what the arguments say
  let parsedNow = argv === null || programOff ? null : herdrArgv(argv);
  if (parsedNow !== null && parsedNow.configHome === undefined && svc?.pid) {
    const dir = readProcessConfigHome(svc.pid, process.platform); // a process's own arguments carry no directory: its environment does
    if (dir !== null) parsedNow = { ...parsedNow, configHome: dir };
  }
  const runsNow: typeof owned | 'unknown' = argv === null ? (svc?.active === 'active' ? owned : null) : (parsedNow ?? 'unknown'); // what the unit runs now (the file stands in when the process cannot be read); 'unknown': a process that is not herdr's shape
  const sameSessionName = (a: typeof owned | 'unknown'): boolean => session !== null && a !== null && a !== 'unknown' && (a.session ?? '') === (session.session ?? '');
  const sameSession = (a: typeof owned | 'unknown'): boolean => sameSessionName(a) && (a as { configHome?: string }).configHome === cfg;
  // The unit's process serves the session name, under a directory that could not be read: not established as the one the bridge follows, not said to be another.
  const dirUnknownNow = svc?.active === 'active' && sameSessionName(runsNow) && (runsNow as { configHome?: string }).configHome === undefined;
  const nowOk = svc?.active !== 'active' || sameSession(runsNow);
  const nextOk = sameSession(owned) && gone === null; // what the next start runs
  const serves = foreign === null && nowOk && nextOk;
  const describe = (a: typeof owned | 'unknown'): string => (a === 'unknown' ? `something that cannot be told from its process (${programOff ? `program ${svc?.program}, arguments ` : ''}${(argv ?? []).join(' ')})` : `${describeHerdr(a, cfg)}${a !== null && a.configHome === undefined ? ' under a directory that cannot be told from its process' : ''}`);
  const offSession = [...(nowOk ? [] : [`runs ${describe(runsNow)}`]), ...(nextOk ? [] : [`starts ${describe(owned)} at ${boot}`])].join(' and ');
  const svcLogs = `if it stops again: ${sm.hints.logs(hu, 30)}`;
  const unmaskThenSetup = `${sm.hints.unmask(standing.masked ?? [huName])}, then remotly-bridge setup`;
  // The restart printed for the herdr unit: one that runs its file as it is now (setup rewrites it on every run and
  // never restarts a running herdr unit, so on a Mac the loaded definition may be older than the plist — `kickstart`
  // would respawn that); a failed unit's start-rate limit cleared first (systemd); a disabled agent that launchd would
  // not bootstrap again turned on, since nothing else runs its file.
  const stopHerdr = herdrStopCommand(session?.session, cfg, owned?.herdrPath ?? 'herdr'); // through the herdr the unit runs when there is one (its path may be off this shell's PATH); else whatever `herdr` the shell finds, as the user would type
  // Other bridges' enabled herdr units for this very session (one provider per session is the rule — setup installs
  // none beside one; two already there are each from before the other followed it): with none of ours here they are
  // what starts herdr at boot; with ours disabled, turning ours on beside them would make two; with ours enabled too,
  // they race at boot. So every start or restart of ours printed beside them turns them off first (their
  // Restart=always would bring their herdr back against ours) — and for a disabled unit of ours that line is the
  // hand-over setup prints: theirs off, ours on and restarted (a restart of ours alone would run it against theirs).
  const others = session !== null ? await otherHerdrUnits(sm, unitOf(), session.session, cfg) : [];
  const shared = others.filter((o) => o.role === 'provider');
  const possibles = others.filter((o) => o.role === 'possible'); // another bridge's unit, not enabled, that a timer or target of the user's own may start: turned off with its timer in the hand-over lines as far as a line can, said with the keep-one line, and no take-over at boot is claimed beside it
  const runners = others.filter((o) => o.role === 'runner'); // running the session without being its provider (disabled without --now, say): stopped through the manager in the hand-over lines
  const plans = new Map<string, OffPlan>(); // how each is turned off: now, from the next boot, and what no line undoes
  for (const o of others) plans.set(o.unit, await otherPlan(sm, o));
  const planOf = (o: OtherHerdrUnit): OffPlan => plans.get(o.unit) as OffPlan;
  const laterOf = (o: OtherHerdrUnit): string => planOf(o).later ?? sm.hints.disable(o.unit);
  const notes = (os: OtherHerdrUnit[]): string => os.map((o) => (planOf(o).unheld.length > 0 ? ` (${sm.unitName(o.unit)}: ${planOf(o).unheld.join('; ')} — which no line here undoes)` : '')).join('');
  const many = shared.length > 1;
  const sharedName = listOf(shared.map((s) => `${sm.unitName(s.unit)} (bridge unit ${s.bridge}'s)`));
  const sharedUnits = listOf(shared.map((s) => sm.unitName(s.unit)));
  const withOurs = svc !== null && foreign === null; // ours is setup's and loaded
  const beside = shared.length > 0 && withOurs; // … beside their provider
  const theirsFirst = withOurs && others.length > 0 ? `${[...shared.map((s) => planOf(s).now), ...possibles.map((p) => planOf(p).now), ...runners.map((r) => sm.hints.stop(r.unit))].join('; ')}; ` : '';
  const theirsToo = theirsFirst ? stopsEnd(others.map(planOf), ', and ', ' now') : ''; // each unit those lines stop as a whole, a timer among them, and what the manager stops with them
  // What runs the herdr that answers, when it is a service of the user's own (Linux: the socket's listener and its
  // cgroup, a terminal being a scope; macOS: lsof and launchctl list — a client of the socket may be named by its path
  // there, so the bridge's own unit counts as nobody's): the hand-over stops it through the manager — a `herdr server
  // stop` alone would have its Restart=always bring it back — and whether it starts herdr at boot too is asked of the
  // manager (enabled: yes; disabled and nothing pulling it in: no; else its own arrangement, said as a possibility).
  const answering = fs.existsSync(sock) ? await pidListeningOn(sock, process.platform, spawn) : null;
  const underUnit = answering === null ? null : await readProcessUnit(answering, process.platform, spawn);
  const candidate = underUnit !== null && underUnit !== huName && underUnit !== unit && !others.some((o) => sm.unitName(o.unit) === underUnit) ? { name: underUnit, ...(await sm.startsAtBoot(underUnit)), ...(await sm.unitFacts(underUnit)) } : null;
  // A terminal's kind (no supervisor): one that neither brings herdr back nor may start it at boot, and has herdr for its main process (a plain systemd-run) or is a desktop app's transient unit (app-…, under KDE) whose main process is a terminal emulator. Anything else — a wrapper that may start herdr again, whatever Restart= reads — is stopped as a unit.
  const terminalApp = candidate !== null && candidate.transient === true && /^app-/.test(candidate.name) && candidate.mainPid !== null && candidate.mainPid !== answering ? TERMINAL_APPS.has((await readProcessComm(candidate.mainPid, process.platform, spawn)) ?? '') : false;
  const supervisor = candidate !== null && !(candidate.restarts === false && candidate.atBoot === false && (candidate.mainPid === answering || terminalApp)) ? candidate : null;
  const supMayStart = supervisor !== null && supervisor.atBoot !== false; // enabled, or its own arrangement (static, pulled in, an agent's RunAtLoad)
  const mayStart = supMayStart || possibles.length > 0; // something besides setup's units may start the session at boot: no take-over at boot is claimed
  // How the supervisor is turned off: with its triggers and upholders (the unit alone, they would start it again), each named where the line says what it ends; what pulls it in is named as not undone.
  const supPlan = supervisor === null ? null : await offPlan(sm, supervisor.name, supervisor);
  const stopOutside = supPlan === null ? stopHerdr : supPlan.now;
  const outsideWhere = supervisor === null ? '' : ` (under ${supervisor.name}, a unit setup did not write${supervisor.atBoot === true ? `, enabled: it starts herdr at ${boot} on its own terms` : ''}${supervisor.activators.length + supervisor.pullers.length > 0 ? `; ${startsHow(supervisor)}` : ''}${supervisor.atBoot === null ? `; whether it starts herdr at ${boot} is its own arrangement` : ''})`;
  const outsideToo = supPlan === null ? '' : stopsEnd([supPlan], ', and ', '', 'else '); // units stopped as a whole, and what the manager stops with them
  // The setup-owned units that start the session at boot: this bridge's, when enabled; the providers shared with it.
  const starters = [...(withOurs && standing.state === 'enabled' ? [{ name: huName, off: sm.hints.disable(hu) }] : []), ...shared.map((s) => ({ name: sm.unitName(s.unit), off: laterOf(s) }))];
  const startersOff = starters.map((s) => s.off).join('; ');
  const startersWho = listOf(starters.map((s) => s.name));
  const restartSvc = standing.state === 'disabled' ? (beside ? sm.hints.enableRestart(hu) : sm.hints.restartDisabled(hu)) : svc?.active === 'failed' ? sm.hints.resetAndRestart(hu) : sm.hints.reloadRestart(hu);
  // What the manager stops along with setup's unit when it stops or restarts (a unit of the user's with PartOf= or Requires= on it), and what it stops when ours starts (Conflicts=): named in every line that starts, restarts or stops it.
  const ownDeps = svc !== null && svc.load === 'loaded' ? await sm.dependents(huName) : { stopped: [], conflicting: [] };
  const stoppedWithOurs = (units: string[]): string => (units.length === 0 ? '' : `, and ${listOf(units)}, which the manager stops with ${huName} (and whatever depends on those)`);
  const ownEnds = stoppedWithOurs([...new Set([...ownDeps.stopped, ...ownDeps.conflicting])]);
  const ownStarts = stoppedWithOurs(ownDeps.conflicting);
  const restartNote =
    standing.state === 'disabled' && beside
      ? `; turns this unit on as the session's one and ${sharedUnits} off (two enabled would race at ${boot})`
      : beside
        ? `; turns ${sharedUnits} off first, since two services for ${want} would race at ${boot}`
        : standing.state === 'disabled' && sm.hints.restartNeedsEnabled
          ? '; turns the agent on, since a disabled one is bootstrapped only once enabled'
          : '';
  // The lines that put the unit on the session the bridge follows: setup rewrites the file; a restart starts what the
  // file says — after stopping the herdr that answers for that session when one does (it runs outside the unit and
  // holds the socket: the unit's replacement could not bind it, and would start against it forever).
  const realign = (answers: boolean): string => `${nextOk ? '' : 'remotly-bridge setup   (rewrites the unit)'}${nextOk || nowOk ? '' : '; then '}${nowOk ? '' : `${theirsFirst}${answers ? `${stopOutside}; ` : ''}${restartSvc}   (ends the panes it runs${answers ? ` and this herdr's${outsideToo}` : ''}${beside ? ` and ${sharedUnits}'${many ? '' : 's'}` : ''}${ownEnds} and starts ${want}${restartNote})`}`;
  // A unit under the service's name that setup did not write is said on its own, whatever herdr does: setup leaves it alone, and nothing below speaks for it.
  if (foreign !== null) bad(`the herdr service name ${huName} is taken by a unit setup did not write (${foreign}); whether it starts herdr at ${boot} is its own arrangement, and setup leaves it alone`, `${sm.hints.cat(hu)}   and ${sm.hints.status(hu)}`, false);
  // Two (or more) enabled for the session, ours among them — starting it at boot (they race for the socket, and the
  // loser restarts against the winner), or running it now with a file for another (the setup line below rewrites that
  // file, and then they race): said whether herdr answers or not.
  // A setup-owned unit that starts the session at boot (ours enabled, a provider shared with this bridge) beside a unit of the user's own that runs herdr and may start it at boot too: said whether herdr's process is on the session the file names or not (the hand-over lines turn that unit off first).
  // Another bridge's unit for the session, not enabled, that a timer or target of the user's own may start: beside a setup-owned starter it may race at boot too, said with the line that keeps one (the timer goes with it; what no line undoes is said).
  if (starters.length > 0) for (const p of possibles) bad(`herdr service ${sm.unitName(p.unit)} (bridge unit ${p.bridge}'s) is not enabled, but ${startsHow(p)}: if that starts ${want} at ${boot} too, it and the herdr service ${startersWho} race for the socket there`, `keep one, from the next ${boot}:  ${keepOne(sm.unitName(p.unit), planOf(p), startersOff)}`, false);
  if (beside && standing.state === 'enabled' && (nextOk || (nowOk && svc?.active === 'active'))) bad(nextOk ? `${many ? shared.length + 1 : 'two'} herdr services for ${want}: ${listOf([huName, ...shared.map((s) => `${sm.unitName(s.unit)} (bridge unit ${s.bridge}'s)`)])}, ${many ? 'all' : 'both'} enabled — at ${boot} they race for the socket` : `${many ? shared.length + 1 : 'two'} herdr services enabled for ${want}: ${listOf([`${huName} (which runs it now; its file starts ${describe(owned)}, until setup rewrites it)`, ...shared.map((s) => `${sm.unitName(s.unit)} (bridge unit ${s.bridge}'s)`)])}`, `keep one, from the next ${boot}:  ${shared.map(laterOf).join('; ')}   (what runs now keeps running)${notes(shared)}`, false);
  const startHerdr =
    session === null
      ? 'start herdr yourself (run `herdr`): the bridge follows a socket that is not a herdr session under ~/.config/herdr, so no service starts it'
      : masked
        ? `${unmaskThenSetup}   (the herdr service ${huName} is masked)`
        : !svc || foreign !== null
          ? 'start herdr (run `herdr`)'
          : gone !== null
            ? `remotly-bridge setup   (rewrites ${huName}, which starts ${gone}: not an executable file now)`
          : !serves
            ? `${realign(false)}   (${huName} ${offSession}, not the one the bridge follows)`
            : svc.active === 'failed'
              ? `${theirsFirst}${restartSvc}   (the herdr service failed${ownEnds ? `; a restart ends nothing of its own${ownEnds}` : ''}${theirsToo ? `; ends ${theirsToo.slice(', and '.length)}` : ''}${restartNote}; ${svcLogs})`
              : svc.active === 'inactive' && standing.state === 'disabled'
                ? `${theirsFirst}${sm.hints.enableNow(hu)}   (the herdr service, disabled${beside ? `; turns it on as the session's one and ${sharedUnits} off` : ''}${theirsToo ? `; ends ${theirsToo.slice(', and '.length)}` : ''}${ownStarts ? `; ends nothing of its own${ownStarts}` : ''}; ${svcLogs})`
                : svc.active === 'inactive'
                  ? `${theirsFirst}${sm.hints.start(hu)}   (the herdr service${theirsToo ? `; ends ${theirsToo.slice(', and '.length)}` : ''}${ownStarts ? `; ends nothing of its own${ownStarts}` : ''}${restartNote}; ${svcLogs})`
                  : `${theirsFirst}${restartSvc}   (the herdr service is ${svc.active}; a restart ends its panes' processes${ownEnds}${theirsToo}${restartNote}; ${svcLogs})`;
  let herdrAnswers = false;
  if (!fs.existsSync(sock)) bad(`herdr socket missing: ${sock}`, (svc && foreign === null) || masked ? startHerdr : `${startHerdr}; not installed yet? ${HERDR_INSTALL}`);
  else {
    try {
      const pong = await new HerdrClient({ socketPath: sock }).request<{ version: string; protocol: number }>('ping', {}, 3000);
      herdrAnswers = true;
      if (pong.protocol === 19) ok(`herdr ${pong.version} protocol ${pong.protocol} at ${sock}`);
      else bad(`herdr ${pong.version} protocol ${pong.protocol} (built against 19)`, 'update herdr or the bridge so the protocol versions match', false);
    } catch (err) {
      bad(`herdr ping failed: ${(err as Error).message}`, `${startHerdr}; a stale socket from an old session is replaced when it starts`);
    }
  }
  if (herdrAnswers) {
    // (Said only once herdr answered: the socket's listener is attributed to a unit of the user's own as herdr's supervisor, and that holds for herdr, not for whatever else might hold the path.)
    if (supervisor !== null && supPlan !== null && supMayStart && starters.length > 0) bad(`herdr runs under ${supervisor.name}, a unit setup did not write${supervisor.activators.length + supervisor.pullers.length > 0 ? ` (${startsHow(supervisor)})` : ''}${supervisor.atBoot === true ? ` and enabled too: at ${boot} it and the herdr service ${startersWho} race for the socket` : `: if it starts herdr at ${boot} too, it and the herdr service ${startersWho} race for the socket there`}`, `keep one, from the next ${boot}:  ${keepOne(supervisor.name, supPlan, startersOff)}`, false);
    // Does herdr come back after a reboot: the service for this session is enabled (it starts herdr at boot; which
    // process answered is not established here), or not — herdr started from a terminal with no service, or one that
    // is not enabled (`--no-herdr-service` leaves a running one so). A service enabled but not running is the normal
    // state after a setup over a herdr started by hand: it takes over at the next boot.
    const pid = svc?.pid ? ` (pid ${svc.pid})` : '';
    const handOver = `${theirsFirst}${stopOutside}; ${svc?.active === 'inactive' ? sm.hints.start(hu) : restartSvc}   (ends this herdr's panes${outsideToo}${theirsToo}${svc?.active === 'inactive' ? ownStarts : ownEnds}; herdr restores the layout${theirsToo ? 's' : ''}${restartNote})`;
    // A standing that is neither enabled nor disabled (the ones setup does not own were said above as taken): what it means for the next boot, and the line that helps.
    const oddStanding = (state: string): [string, string] =>
      state === 'enabled-runtime'
        ? ['enabled until the next boot only', shared.length > 0 ? `${shared.map(laterOf).join('; ')}; ${sm.hints.enable(hu)}   (makes it permanent and the session's one; ${sharedName} start${many ? '' : 's'} ${want} at ${boot} otherwise, and two would race)` : `${sm.hints.enable(hu)}   (makes it permanent)`]
        : [`${state || 'of unknown standing'}: whether it starts at ${boot} is that unit's own arrangement`, `${sm.hints.cat(hu)}   and ${sm.hints.status(hu)}`];
    // Who started the herdr that answered — a terminal, a unit of the user's own under another name — is not known
    // here: "runs outside the service" is all that is said of it, and nothing about its coming back unless a service
    // of setup's is in place for it.
    // Another bridge unit's herdr service for this very session (one provider per session: setup installs none here then).
    const taken = foreign !== null; // said above; not setup's to speak for — nor is what it does at boot
    if (taken) bad(`no service of setup's is established as starting herdr: the name ${huName} is taken (above); whether this herdr comes back after a reboot is that unit's own arrangement`, `free the name ${huName}, then remotly-bridge setup`, false);
    else if (session === null) bad(`herdr runs outside any service of setup's: the bridge follows ${sock}, not a herdr session under ~/.config/herdr, so setup installs none for it, and whether it comes back after a reboot is not established here${svc && owned ? ` (${huName} starts its own session; off:  ${sm.hints.disableNow(hu)}${ownDeps.stopped.length > 0 ? `, which stops ${listOf(ownDeps.stopped)} with it, and whatever depends on those` : ''})` : ''}`, 'start that herdr yourself after a reboot, or follow a session instead:  remotly-bridge setup --herdr-session NAME', false);
    else if (hst === null || standing.unreadable) bad(`cannot tell whether herdr comes back after a reboot: ${standing.unreadable ?? `${sm.hints.query(hu)} gave no answer`}`, `ask again:  ${sm.hints.status(hu)}`, false);
    else if (svc && dirUnknownNow && foreign === null) bad(`herdr service ${huName} runs ${want} under a directory that cannot be told from its process (its environment could not be read), so whether the herdr that answers is its own is not established${nextOk ? '' : `; its file starts ${describe(owned)} at ${boot}`}`, nextOk ? `${theirsFirst}${restartSvc}   (starts ${want} under ${path.join(cfg, 'herdr')} for certain; ends its panes${ownEnds}${restartNote})` : realign(true), false);
    else if (svc && foreign === null && gone !== null) bad(`herdr service ${huName} starts ${gone} at ${boot}, which is not an executable file now (herdr moved since setup?)${svc.active === 'active' ? `; the one it runs${pid} goes on until it exits` : ''}`, 'remotly-bridge setup   (rewrites the unit for the herdr found now)', false);
    else if (svc && !serves) bad(`herdr service ${huName} ${offSession}, not the one the bridge follows (${want}); this herdr runs outside it`, realign(true), false);
    else if (svc?.active === 'active' && standing.state === 'enabled') ok(`herdr service ${huName} active${pid}: starts herdr at ${boot}`);
    else if (svc?.active === 'active' && standing.state === 'disabled') ok(`herdr service ${huName} active${pid} but disabled (your choice): not started at ${boot}${shared.length > 0 ? `, when ${sharedName} start${many ? '' : 's'} ${want} instead` : ''}; on:  ${shared.length > 0 ? `${shared.map(laterOf).join('; ')}; ${sm.hints.enable(hu)}   (this unit the session's at ${boot}; nothing stops now)${notes(shared)}` : sm.hints.enableNow(hu)}`);
    else if (svc?.active === 'active') bad(`herdr service ${huName} is active${pid} but ${oddStanding(standing.state)[0]}`, oddStanding(standing.state)[1], false);
    else if (masked) ok(`herdr service ${huName} is masked (your choice; on:  ${unmaskThenSetup}); this herdr runs outside it`);
    else if (!svc && shared.length > 0) ok(`herdr service ${sharedName} start${many ? '' : 's'} ${want} at ${boot}, shared with this bridge`);
    else if (!svc) bad(`no herdr service of setup's: herdr runs outside one${outsideWhere}${supervisor === null ? ', and whether it comes back after a reboot is not established here' : ''}`, `remotly-bridge setup   (installs ${huName}, which starts herdr at ${boot}${supervisor !== null && supPlan !== null && supMayStart ? `; then keep one of the two:  ${keepOne(supervisor.name, supPlan, sm.hints.disable(hu))}` : ''}${possibles.map((p) => `; then keep one of the two, this or ${sm.unitName(p.unit)} (bridge unit ${p.bridge}'s, not enabled, but ${startsHow(p)}):  ${keepOne(sm.unitName(p.unit), planOf(p), sm.hints.disable(hu))}`).join('')})`, false);
    else if (standing.state === 'disabled' && shared.length > 0) ok(`herdr service ${huName} is disabled (your choice); ${sharedName} start${many ? '' : 's'} ${want} at ${boot}, shared with this bridge — this unit the session's one instead:  ${theirsFirst}${stopOutside}; ${sm.hints.enableNow(hu)}   (ends every pane of ${want}${outsideToo}${theirsToo}${ownStarts}; herdr restores the layouts)`);
    // Turned on while this herdr holds the socket, the unit would start against it (and again, and again): the hand-over stops it first, as setup's on-line does.
    else if (standing.state === 'disabled') ok(`herdr service ${huName} is disabled (your choice); this herdr runs outside it${outsideWhere} — on, taking over now:  ${theirsFirst}${stopOutside}; ${sm.hints.enableNow(hu)}   (ends this herdr's panes${outsideToo}${theirsToo}${ownStarts}; herdr restores the layout${theirsToo ? 's' : ''})`);
    else if (standing.state === 'enabled' && svc.active === 'inactive') ok(`herdr runs outside the herdr service ${huName}${outsideWhere}, which is enabled${mayStart ? ' — hand over to it now' : ` and takes over at the next ${boot} — now`}:  ${handOver}`);
    else if (standing.state === 'enabled') bad(`herdr runs outside the herdr service ${huName}, which is enabled (so it starts herdr at ${boot}) but ${svc.active} now`, `${sm.hints.logs(hu, 30)}; hand over:  ${handOver}`, false);
    else bad(`herdr runs outside the herdr service ${huName}, which is ${oddStanding(standing.state)[0]}`, oddStanding(standing.state)[1], false);
  } else if (standing.unreadable) {
    // herdr does not answer, and what stands under the service's name is unknown: said here, so the start line above is not the whole story.
    bad(`cannot tell whether a herdr service of setup's starts herdr at ${boot}: ${standing.unreadable}`, `ask again:  ${sm.hints.status(hu)}`, false);
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
  const tailnet = classifyTailnet(ts, tsPresent, { cert: needCert, platform: process.platform });
  // Same rules as setup and serve: the gate is hard when required, or `auto` with Tailscale installed (up → the gate is
  // on; stopped → serve waits for it and then refuses to start rather than running with the gate off); a certificate
  // mode that tries Tailscale first needs it too (setup waits for it — iPhones refuse the fallback).
  const gateHard = config.security.require_tailnet === true || (config.security.require_tailnet === 'auto' && tsPresent);
  const tsHard = gateHard || needCert;
  const install = tailscaleHints(process.platform).installThenUp;
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
    const refresh = `${sm.hints.restart(unitOf())}   (it requests or generates a fresh pair)`;
    try {
      const certPem = fs.readFileSync(cert);
      const info = certInfo(certPem);
      const days = Math.floor((info.notAfter.getTime() - Date.now()) / 86_400_000);
      if (!fs.existsSync(key)) bad(`${kind} certificate ${cert} has no key file ${key} — the daemon cannot use it`, `rm ${sh(cert)}; ${refresh}`);
      else if (!new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(key)))) bad(`${kind} certificate and key do not match (${cert}, ${key})`, `rm ${sh(cert)} ${sh(key)}; ${refresh}`);
      else if (days > 0) ok(`${kind} certificate valid ${days} more days (${info.hostnames.join(', ')})${daemon ? '' : ' — daemon down, judged from the files'}`);
      else bad(`${kind} certificate ${cert} expired`, refresh);
      if (kind === 'self-signed' && tailnet.ok && needCert) {
        bad('a self-signed certificate is in use although Tailscale is ready — iPhones refuse it', `remotly-bridge setup   (requests the Tailscale certificate; on "access denied": ${tailscaleHints(process.platform).certDenied(os.userInfo().username)})`, false);
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
  const active = (await sm.activeState(unitOf())).state === 'active';
  const mainPid = (await sm.mainPid(unitOf())) ?? 0;
  if (active) ok(`${sm.noun} ${unit} active${mainPid ? ` (pid ${mainPid})` : ''}`);
  else if (daemon) bad(`${sm.noun} ${unit} is not active — the daemon answering here${daemon.pid !== undefined ? ` (pid ${daemon.pid})` : ''} was started by hand and does not come back after a reboot`, `stop that serve${daemon.pid !== undefined ? ` (kill ${daemon.pid})` : ''}, then: remotly-bridge setup   (setup does not install over it, and ${sm.hints.start(unitOf())} could not bind the socket it holds)`, false);
  else bad(`${sm.noun} ${unit} is not active`, `remotly-bridge setup   (installs and starts it), or: ${sm.hints.start(unitOf())}`);
  // The daemon answering here must be the unit's process (a pid-less answer is a daemon from before this version).
  if (daemon && active && daemon.pid !== undefined && mainPid > 0 && daemon.pid !== mainPid) {
    bad(`the daemon on this config dir (pid ${daemon.pid}) is not unit ${unit} (pid ${mainPid}) — the unit serves another config dir, so this one is not restored after a reboot`, `remotly-bridge setup --unit <name>   for this config dir (after stopping the manual daemon), or run doctor with the unit's REMOTLY_CONFIG_DIR`);
  }
  const persistence = await sm.persistenceCheck(unitOf());
  if (persistence.ok) ok(persistence.message);
  else bad(persistence.message, persistence.fix ?? 'remotly-bridge setup', false);
  if (daemon) ok(`daemon reachable: herdr ${daemon.herdr}, listening ${daemon.listen?.host}:${daemon.listen?.port}, tls ${daemon.tls.mode}, ${daemon.devices} device(s), ${daemon.clients} client(s)`);
  else if (active) bad(`unit ${unit} is active but no daemon answers at ${controlSocketPath()} — it runs with another REMOTLY_CONFIG_DIR`, `${sm.hints.cat(unitOf())}   and run doctor with the same REMOTLY_CONFIG_DIR`);
  else bad(`daemon not reachable at ${controlSocketPath()}`, `${sm.hints.start(unitOf())}; if it stops again: ${sm.hints.logs(unitOf(), 30)}`);

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
    unit: unitOf(),
    platform: process.platform,
    service: serviceManager(),
    out: (line) => console.log(line),
    exec: spawn,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    heldLockFd: (lock) => inheritedLockFd(lock, process.env),
    relock: (cmd, args, env) =>
      new Promise((resolve) => {
        const child = spawnProcess(cmd, args, { stdio: 'inherit', env });
        child.on('error', (err) => resolve({ code: null, signal: null, error: err.message }));
        child.on('exit', (code, signal) => resolve({ code, signal }));
      }),
    // flock on the inherited descriptor (perl's on macOS), handed to it as fd 3: a lock is per open file, so what the
    // child confirms (or takes) on its fd 3 is held by this process's descriptor once the child is gone.
    confirmLock: (lockFd) =>
      new Promise((resolve) => {
        const confirm = confirmCommand(process.platform, 3);
        const child = spawnProcess(confirm.cmd, confirm.args, { stdio: ['ignore', 'inherit', 'inherit', lockFd] });
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
        // /proc/self/fd (by REMOTLY_UPDATE_LOCK_FD where there is no /proc) and takes no lock of its own, and the lock
        // outlives this process as long as the installer runs.
        const child = spawnProcess('sh', [script, ...args], { stdio: [0, 1, 2, lockFd], env: { ...env, [LOCK_FD_ENV]: '3' } });
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
