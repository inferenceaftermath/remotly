// One connected phone: authentication, the single watched pane (poll → parse → diff → frame),
// history, input, approvals, zoom, push / Live Activity registration and "notify when done" arming
// (shared/protocol/remotly-protocol.md).
import type { WebSocket } from 'ws';
import { performApproval, UnsupportedAgentError, type ApprovalAction } from '../approvals/approve.ts';
import { performChoice } from '../approvals/choose.ts';
import type { ApprovalResult } from '../approvals/approve.ts';
import type { DeviceRecord, DeviceStore } from '../auth/devices.ts';
import type { FlowConfig } from '../config.ts';
import { HerdrError } from '../herdr/client.ts';
import { FitUnavailableError, parseFitSize, type FitSize } from '../herdr/fit.ts';
import { planKeys, wheelReport } from '../herdr/keys.ts';
import type { PaneInfo, PaneReadResult, PaneZoomResult, SessionSnapshot, TabCreateResult } from '../herdr/types.ts';
import { PaneWatcher } from '../herdr/watcher.ts';
import type { Logger } from '../log.ts';
import { parseScreen } from '../terminal/ansi.ts';
import { diffRows } from '../terminal/differ.ts';
import { encodeFrame, encodeHistory, StyleTable } from '../terminal/encode.ts';
import type { Row } from '../terminal/types.ts';
import type { Hub, Viewer } from './hub.ts';
import { PROTOCOL, type ErrorCode } from './protocol.ts';

export const FRAME_MIN_INTERVAL_MS = 33;
/** Frame cadence and pane-poll boost window after a forwarded `scroll`: the wheel's redraw should reach the phone within ~20 ms. */
export const BOOST_FRAME_MIN_INTERVAL_MS = 16;
export const SCROLL_BOOST_MS = 600;
export const FULL_FRAME_INTERVAL_MS = 10_000;
export const HELLO_TIMEOUT_MS = 5_000;
/** Close code for a socket that sent no `hello` in time: a stall, not a bad token, so clients reconnect (protocol §1). */
export const HELLO_TIMEOUT_CLOSE_CODE = 4408;
export const MAX_HISTORY_LINES = 999;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_KEYS = 32;
/** Wheel lines per `scroll` request; the apps coalesce a swipe into a handful of these. */
const MAX_SCROLL_LINES = 50;
const MAX_COMMAND_BYTES = 4096;
/** `pane.create` with a command: how long to wait for the new shell to draw its prompt before typing. */
const SHELL_READY_TIMEOUT_MS = 5000;
const SHELL_POLL_MS = 100;
/** Extra settle time after the prompt shows (bracketed-paste mode is enabled by the shell's line editor). */
const SHELL_SETTLE_MS = 150;
/**
 * How often a watched pane is asked (pane.get + pane.process_info) whether an alternate-screen program
 * is in the foreground; the answer rides on frames as `alt` and drives the phones' automatic scroll mode.
 */
const ALT_PROBE_MIN_INTERVAL_MS = 1000;
const APPROVAL_ACTIONS = new Set<ApprovalAction>(['approve', 'approve_session', 'deny', 'deny_feedback', 'interrupt']);

interface Watch {
  pane: string;
  watcher: PaneWatcher;
  cols: number;
  rows: number;
  rectHeight: number | null;
  rev: number;
  sent: Row[] | null;
  latest: Row[] | null;
  forceFull: boolean;
  lastSentAt: number;
  flushTimer: NodeJS.Timeout | null;
  fullTimer: NodeJS.Timeout;
  /** Last probed alternate-screen state (null until the first probe answers). */
  alt: boolean | null;
  /** `alt` changed since the last frame: send one even if no row changed. */
  altDirty: boolean;
  altProbe: Promise<void> | null;
  altProbedAt: number;
}

export interface SessionDeps {
  hub: Hub;
  devices: DeviceStore;
  config: FlowConfig;
  log: Logger;
  remoteIp: string;
  now?: () => number;
}

type Msg = Record<string, unknown>;

export class Session implements Viewer {
  viewing: string | null = null;
  device: DeviceRecord | null = null;
  mode: 'full' | 'action' = 'full';
  private watch: Watch | null = null;
  private readonly styles = new StyleTable();
  private readonly ws: WebSocket;
  private readonly hub: Hub;
  private readonly devices: DeviceStore;
  private readonly config: FlowConfig;
  private readonly log: Logger;
  private readonly remoteIp: string;
  private readonly now: () => number;
  private helloTimer: NodeJS.Timeout | null;
  private disposed = false;
  private readonly onHerdrState = (state: 'up' | 'down'): void => {
    if (!this.watch) return;
    if (state === 'down') this.watch.watcher.stop();
    else void this.restartWatch();
  };
  private readonly onSnapshot = (): void => {
    void this.checkResize();
  };
  /** A phone (this one or another) changed the PTY size of a pane: our frames must follow. */
  private readonly onFitted = (pane: string, size: FitSize): void => {
    const w = this.watch;
    if (!w || w.pane !== pane) return;
    if (w.cols === size.cols && w.rows === size.rows) return;
    w.cols = size.cols;
    w.rows = size.rows;
    w.forceFull = true;
    w.watcher.invalidate();
    this.flush();
  };

  constructor(ws: WebSocket, deps: SessionDeps) {
    this.ws = ws;
    this.hub = deps.hub;
    this.devices = deps.devices;
    this.config = deps.config;
    this.log = deps.log;
    this.remoteIp = deps.remoteIp;
    this.now = deps.now ?? Date.now;
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.dispose());
    ws.on('error', (err) => this.log.debug('session.socket_error', { error: err.message }));
    this.helloTimer = setTimeout(() => this.helloTimedOut(), HELLO_TIMEOUT_MS);
    this.hub.link.on('state', this.onHerdrState);
    this.hub.link.on('snapshot', this.onSnapshot);
    this.hub.fitter.on('fitted', this.onFitted);
  }

  get deviceId(): string | null {
    return this.device?.id ?? null;
  }

  send(msg: object): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ok(id: string | undefined, extra: object = {}): void {
    this.send({ t: 'ok', ...(id !== undefined ? { id } : {}), ...extra });
  }

  private error(id: string | undefined, code: ErrorCode, message: string): void {
    // The message may quote what the client sent (an unknown key name, a JSON fragment): only a `debug` logger keeps it.
    this.log.info('reply.error', { code, device_id: this.device?.id ?? null, ...(this.log.debugEnabled ? { message } : {}) });
    this.send({ t: 'error', ...(id !== undefined ? { id } : {}), code, message });
  }

  /** No `hello` within HELLO_TIMEOUT_MS. Not an auth failure: a slow path (a phone waking up on Tailscale) must not
   *  read as "re-pair", so no `error auth` and a close code the apps treat like any other drop. */
  private helloTimedOut(): void {
    this.helloTimer = null;
    this.log.info('session.hello_timeout', { remote_ip: this.remoteIp });
    this.ws.close(HELLO_TIMEOUT_CLOSE_CODE, 'hello timeout');
  }

  private fail(code: ErrorCode, message: string): void {
    this.error(undefined, code, message);
    this.ws.close(4401, message);
  }

  private herdrFailure(id: string | undefined, err: unknown): void {
    if (err instanceof HerdrError) this.error(id, 'herdr_error', `${err.code}: ${err.message}`);
    else if (!this.hub.link.isUp) this.error(id, 'herdr_down', 'herdr is not reachable');
    else this.error(id, 'herdr_error', (err as Error).message);
  }

  private onMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) return this.error(undefined, 'bad_request', 'binary frames are not supported');
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return this.error(undefined, 'bad_request', 'invalid JSON');
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as Msg)['t'] !== 'string') {
      return this.error(undefined, 'bad_request', 'expected {"t": ...}');
    }
    const m = msg as Msg;
    const rawId = m['id'];
    const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : undefined;
    if (!this.device) {
      if (m['t'] !== 'hello') return this.fail('auth', 'hello required first');
      return this.hello(m);
    }
    // Own keys only: the table is a plain object, so `{"t":"constructor"}` or `{"t":"toString"}` would otherwise
    // resolve to an Object.prototype function that returns a non-promise and crash the listener below.
    const type = m['t'] as string;
    const handler = Object.hasOwn(this.handlers, type) ? this.handlers[type] : undefined;
    if (!handler) return this.error(id, 'unsupported', `unknown message type ${type}`);
    // Validation may throw before the handler's first await (e.g. `paneArg`), so guard both paths: an
    // exception escaping the ws 'message' listener would take the whole bridge down.
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(handler(id, m));
    } catch (err) {
      return this.requestFailed(id, m, err);
    }
    pending.catch((err: unknown) => this.requestFailed(id, m, err));
  }

  private requestFailed(id: string | undefined, m: Msg, err: unknown): void {
    if (err instanceof BadRequest) return this.error(id, 'bad_request', err.message);
    this.log.warn('session.handler_failed', { type: m['t'], error: (err as Error).message });
    this.herdrFailure(id, err);
  }

  /**
   * `watch` and `unwatch` run one at a time, in arrival order. Handlers are otherwise concurrent, and two
   * `startWatch`es in flight would each pass `stopWatch()` and the later one overwrite `this.watch`, leaving the
   * first watcher and its full-frame timer running (and feeding another pane's screen into the current watch);
   * an `unwatch` overtaking a `watch` would leave the socket watching a pane nobody looks at.
   */
  private watchControl: Promise<void> = Promise.resolve();

  private inWatchOrder(run: () => Promise<void>): Promise<void> {
    // Skip a queued turn once the socket is gone: `dispose()` has already stopped the watcher and released the
    // session's leases, so a backlog of watch/unwatch/fit turns must not each go on to spend herdr time (an
    // unknown-pane fit polls `ensurePane`, a watch runs its whole setup) and keep the dead session working. The turn
    // in flight when disposal landed is past this point and finishes under its own `disposed` checks.
    const turn = this.watchControl.then(() => (this.disposed ? undefined : run()));
    this.watchControl = turn.catch(() => undefined);
    return turn;
  }

  private readonly handlers: Record<string, (id: string | undefined, m: Msg) => Promise<void>> = {
    watch: (id, m) => {
      const pane = this.paneArg(m);
      const zoom = m['zoom'] === true;
      return this.inWatchOrder(() => this.startWatch(id, pane, zoom));
    },
    unwatch: (id, m) => {
      const pane = this.paneArg(m);
      return this.inWatchOrder(async () => {
        // Honour the named pane (protocol §4): a stale unwatch — one that crossed a switch to another pane — must not
        // stop the newer watch. `not_watching` for a pane we are not on.
        if (this.watch?.pane !== pane) return this.error(id, 'not_watching', `not watching ${pane}`);
        await this.leave(this.watch.pane);
        this.stopWatch();
        this.ok(id);
      });
    },
    // `fit` (size) and `fit {release:true}` are last-write-wins on the same lease, so they must keep arrival order:
    // run them through the same per-session queue as watch/unwatch/viewing. Otherwise a sizing fit that yields at
    // `ensurePane` lets a later release reach the fitter first, and the fit then resumes and re-imposes the phone's
    // width on a pane the user has stopped fitting — stuck until unwatch or disconnect. Serialising with the lease
    // lifecycle also stops a fit re-applying after a `leave` (unwatch/viewing) released it.
    fit: (id, m) => this.inWatchOrder(() => this.fit(id, m)),
    history: (id, m) => this.history(id, m),
    keys: (id, m) => this.keys(id, m),
    scroll: (id, m) => this.scroll(id, m),
    'pane.create': (id, m) => this.createPane(id, m),
    'pane.close': (id, m) => this.closePane(id, m),
    text: (id, m) => this.text(id, m),
    prompt: (id, m) => this.prompt(id, m),
    approve: (id, m) => this.approve(id, m),
    choose: (id, m) => this.choose(id, m),
    zoom: (id, m) => this.zoom(id, m),
    viewing: async (id, m) => {
      const pane = m['pane'];
      this.viewing = typeof pane === 'string' ? pane : null;
      // Looking elsewhere (or at nothing): give the panes we fitted or zoomed back to herdr — but through the same
      // per-session queue as watch/unwatch, and re-reading `this.viewing` when the turn runs. A bare `await leave`
      // here raced the watch FIFO: a re-watch of the same pane could re-acquire its zoom while this cleanup was
      // suspended in `fitter.release`, and the later `zoomer.release` would then drop the new watch's lease, leaving a
      // pane still being viewed unexpectedly unzoomed.
      await this.inWatchOrder(async () => {
        for (const p of new Set([...this.hub.fitter.panesOf(this), ...this.hub.zoomer.panesOf(this)])) {
          if (p !== this.viewing) await this.leave(p);
        }
      });
      if (id !== undefined) this.ok(id);
    },
    'push.register': async (id, m) => {
      const device = this.device!;
      const token = m['token'];
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return this.error(id, 'bad_request', 'token required');
      const env = m['env'] === 'sandbox' ? 'sandbox' : 'production';
      // A refreshed alert token keeps the device's Live Activity / status opt-in and tokens.
      const { activity, la_start, la_panes } = this.devices.get(device.id)?.push ?? {};
      this.devices.setPush(device.id, {
        platform: device.platform,
        token,
        env,
        ...(activity !== undefined ? { activity } : {}),
        ...(la_start !== undefined ? { la_start } : {}),
        ...(la_panes !== undefined ? { la_panes } : {}),
      });
      this.log.info('push.registered', { device_id: device.id, platform: device.platform, env });
      this.ok(id);
    },
    'push.unregister': async (id) => {
      this.devices.setPush(this.device!.id, null);
      this.ok(id);
    },
    notify: async (id, m) => {
      const pane = this.paneArg(m);
      const done = m['done'];
      if (typeof done !== 'boolean') return this.error(id, 'bad_request', 'done must be a boolean');
      if (done && !this.hub.link.pane(pane)) return this.error(id, 'unknown_pane', `no pane ${pane}`);
      this.devices.setNotifyDone(this.device!.id, pane, done);
      this.log.info('notify.done', { device_id: this.device!.id, pane, done });
      this.ok(id, { done });
    },
    'activity.register': (id, m) => this.registerActivity(id, m),
    'activity.unregister': async (id, m) => {
      const device = this.device!;
      const pane = m['pane'] !== undefined && m['pane'] !== null ? this.paneArg(m) : undefined;
      if (pane) this.devices.setActivityToken(device.id, pane, null);
      else this.devices.updatePush(device.id, { activity: false, la_start: undefined, la_panes: undefined });
      this.log.info('activity.unregistered', { device_id: device.id, pane: pane ?? null });
      this.ok(id);
    },
  };

  /**
   * `activity.register`: iOS sends ActivityKit tokens — without `pane` the push-to-start token (the bridge may
   * then start a Live Activity for any pane that begins working), with `pane` the update token of the activity
   * running for that pane. Android sends neither: it opts its FCM token into `status` data messages.
   */
  private async registerActivity(id: string | undefined, m: Msg): Promise<void> {
    const device = this.device!;
    if (!this.devices.get(device.id)?.push) return this.error(id, 'bad_request', 'push.register first');
    const token = optionalString(m, 'token', 4096);
    if (token === false) return this.error(id, 'bad_request', 'token must be a string up to 4096 chars');
    const pane = m['pane'] !== undefined && m['pane'] !== null ? this.paneArg(m) : undefined;
    if (device.platform === 'ios') {
      if (!token) return this.error(id, 'bad_request', 'token required');
      if (pane) {
        this.devices.setActivityToken(device.id, pane, token);
        this.hub.emit('activity.token', device.id, pane); // the notifier brings that activity up to date at once
      } else {
        this.devices.updatePush(device.id, { activity: true, la_start: token });
      }
    } else {
      this.devices.updatePush(device.id, { activity: true });
    }
    this.log.info('activity.registered', { device_id: device.id, platform: device.platform, pane: pane ?? null });
    this.ok(id);
  }

  private paneArg(m: Msg): string {
    const pane = m['pane'];
    if (typeof pane !== 'string' || pane.length === 0 || pane.length > 64) throw new BadRequest('pane required');
    return pane;
  }

  private hello(m: Msg): void {
    const token = m['token'];
    const device = typeof token === 'string' ? this.devices.authenticate(token) : null;
    if (!device) {
      this.log.warn('session.auth_failed', { ip: this.remoteIp });
      return this.fail('auth', 'invalid token');
    }
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.device = device;
    this.mode = m['mode'] === 'action' ? 'action' : 'full';
    this.devices.touch(device.id);
    const client = (typeof m['client'] === 'object' && m['client']) as Msg | null;
    const host = this.hub.link.hostInfo;
    const welcome: Record<string, unknown> = {
      t: 'welcome',
      protocol: PROTOCOL,
      host: { name: this.hub.hostName, herdr_version: host?.version ?? null, herdr_protocol: host?.protocol ?? null, flow_version: this.hub.version },
      device: { id: device.id, name: device.name },
    };
    if (this.mode === 'full') {
      const snapshot = this.hub.snapshotMessage();
      if (snapshot) welcome['snapshot'] = snapshot;
      welcome['notify_done'] = this.devices.notifyDone(device.id);
    }
    this.send(welcome);
    if (this.mode === 'full') this.hub.addViewer(this);
    this.send({ t: 'herdr', state: this.hub.link.isUp ? 'up' : 'down' });
    this.log.info('session.open', { device_id: device.id, platform: device.platform, mode: this.mode, app_version: client?.['app_version'] ?? null });
  }

  // ---- watch ----------------------------------------------------------------------------------

  private async paneSize(pane: string): Promise<{ rows: number; cols: number; rectHeight: number | null }> {
    const layout = this.hub.link.layoutFor(pane);
    const pty = await this.hub.link.ptySize(pane);
    if (pty) return { ...pty, rectHeight: layout?.rect.height ?? null };
    if (layout) return { rows: layout.rect.height, cols: Math.max(1, layout.rect.width - 1), rectHeight: layout.rect.height };
    return { rows: 24, cols: 80, rectHeight: null };
  }

  /**
   * This device stopped looking at `pane`: its fit goes first (so the PTY is back at herdr's size for
   * the layout herdr restores), then the zoom the bridge holds for it, if any.
   */
  private async leave(pane: string): Promise<void> {
    // Fit first (the PTY is back at herdr's size for the layout it restores), then the zoom we hold. Awaited by its
    // callers so a leave finishes before the next watch can re-acquire the same lease: a stale release still running
    // in the background would otherwise drop a newer watch's zoom and unzoom the pane being watched.
    try {
      await this.hub.fitter.release(pane, this);
    } catch {
      /* pane or tty gone: nothing to restore */
    }
    await this.hub.zoomer.release(pane, this);
  }

  private async startWatch(id: string | undefined, pane: string, zoom = false): Promise<void> {
    if (this.disposed) return;
    if (!this.hub.link.isUp) return this.error(id, 'herdr_down', 'herdr is not reachable');
    if (!(await this.hub.link.ensurePane(pane))) return this.error(id, 'unknown_pane', `no pane ${pane}`);
    if (this.disposed) return; // the socket closed meanwhile: nothing to start (and nothing to stop it later)
    // Give up a different pane before zooming the new one (so a same-tab switch unzooms the old pane before it zooms
    // the new one). The current watcher is stopped further down, only once the new size is in hand, so a failure
    // before that leaves it running rather than dropping it (a same-pane re-watch, e.g. a zoom toggle, that fails).
    if (this.watch && this.watch.pane !== pane) await this.leave(this.watch.pane);
    if (this.disposed) return; // the socket closed while leaving the old pane: take nothing new
    // `watch {zoom:true}`: fill the desktop tab with this pane while the phone looks at it (§4). Zoomed
    // first so the size below is the zoomed pane's; a failure (old herdr) leaves `zoomed` out of the reply.
    let zoomed: boolean | undefined;
    if (zoom) {
      try {
        zoomed = await this.hub.zoomer.apply(pane, this);
      } catch (err) {
        this.log.warn('zoom.failed', { pane, error: (err as Error).message });
      }
    } else {
      // Watching without zoom (the phone turned the setting off while on the pane, or never had it on): drop a zoom
      // this viewer holds on the pane. A no-op when it holds none, so a zoom the desktop user made is left alone.
      await this.hub.zoomer.release(pane, this);
    }
    // A close during the zoom round-trip means the zoom above was taken after `dispose()`'s release swept (its
    // `panesOf` snapshot ran before `apply` recorded the owner, so `releaseAll` missed it): release it here before
    // returning. This early return is above the `try`/`finally` below, so the `finally` would NOT give it back —
    // without this the desktop pane stays zoomed until another device touches it.
    if (this.disposed) {
      await this.leave(pane);
      return;
    }
    // The zoom is taken above; from here anything that stops the watch from taking hold (the socket closing, or herdr
    // failing on `paneSize`) must release it in the `finally`, or the lease outlives the socket and the desktop pane
    // stays zoomed/resized until another device touches it.
    let established = false;
    try {
      const size = await this.paneSize(pane);
      if (this.disposed) return;
      this.stopWatch(); // drop the previous watcher only now the new size is in hand; a failure above left it running
      const watch: Watch = {
        pane,
        watcher: new PaneWatcher({
          client: this.hub.link.client,
          paneId: pane,
          onScreen: (read) => this.onScreen(read),
          onError: (err) => this.onWatchError(err),
        }),
        cols: size.cols,
        rows: size.rows,
        rectHeight: size.rectHeight,
        rev: 0,
        sent: null,
        latest: null,
        forceFull: true,
        lastSentAt: 0,
        flushTimer: null,
        alt: null,
        altDirty: false,
        altProbe: null,
        altProbedAt: 0,
        fullTimer: setInterval(() => {
          if (this.watch) {
            this.watch.forceFull = true;
            this.flush();
          }
        }, FULL_FRAME_INTERVAL_MS),
      };
      this.watch = watch;
      established = true; // from here `this.watch`/`dispose()`/`leave()` own the fit and zoom
      this.ok(id, { cols: size.cols, rows: size.rows, ...(zoomed !== undefined ? { zoomed } : {}) });
      this.log.debug('watch.start', { pane, cols: size.cols, rows: size.rows, zoom, zoomed: zoomed ?? null });
      await this.probeAlt(watch); // so the first frame already says whether a full-screen program has the pane
      if (this.watch !== watch) return; // unwatched or re-watched meanwhile
      watch.watcher.start();
    } finally {
      // The new watch never took hold (disposal, or herdr failing on `paneSize`). If the old same-pane watch is still
      // live, leave it be; otherwise release the fit/zoom taken for the attempt so no lease outlives it.
      if (!established && this.watch?.pane !== pane) await this.leave(pane);
    }
  }

  /**
   * Is an alternate-screen program in the foreground? herdr reports `scroll.max_offset_from_bottom: 0`
   * while a program owns the alternate screen (Claude Code, vim, less, tmux) and restores the count when
   * it exits (docs/herdr-findings.md §8); `pane.process_info` says whether anything but the shell runs.
   * Both together avoid calling a fresh, empty shell "alternate screen". A change is pushed on the next
   * frame (an empty one if the screen itself did not change).
   */
  private probeAlt(w: Watch): Promise<void> {
    if (w.altProbe) return w.altProbe;
    w.altProbedAt = this.now();
    w.altProbe = (async () => {
      try {
        const [{ pane }, { process_info }] = await Promise.all([
          this.hub.link.request<{ pane: PaneInfo }>('pane.get', { pane_id: w.pane }),
          this.hub.link.request<{ process_info: { shell_pid: number; foreground_process_group_id?: number | null } }>('pane.process_info', { pane_id: w.pane }),
        ]);
        if (this.watch !== w) return;
        const scrollback = pane.scroll?.max_offset_from_bottom;
        const fg = process_info.foreground_process_group_id;
        const programRunning = typeof fg === 'number' && fg !== process_info.shell_pid;
        const alt = scrollback === 0 && programRunning;
        if (w.alt !== alt) {
          w.alt = alt;
          w.altDirty = true;
          this.log.info('pane.alt', { pane: w.pane, alt });
          this.flush();
        }
      } catch (err) {
        if (this.hub.link.isUp) this.log.debug('watch.alt_probe_failed', { error: (err as Error).message });
      } finally {
        w.altProbe = null;
      }
    })();
    return w.altProbe;
  }

  private stopWatch(): void {
    const w = this.watch;
    if (!w) return;
    w.watcher.stop();
    clearInterval(w.fullTimer);
    if (w.flushTimer) clearTimeout(w.flushTimer);
    this.watch = null;
  }

  private async restartWatch(): Promise<void> {
    const w = this.watch;
    if (!w || this.disposed) return;
    const size = await this.paneSize(w.pane);
    w.cols = size.cols;
    w.rows = size.rows;
    w.rectHeight = size.rectHeight;
    w.sent = null;
    w.forceFull = true;
    w.watcher.invalidate();
    w.watcher = new PaneWatcher({ client: this.hub.link.client, paneId: w.pane, onScreen: (r) => this.onScreen(r), onError: (e) => this.onWatchError(e) });
    if (this.watch === w) w.watcher.start();
  }

  /** Layout changed: re-probe the PTY when the pane's rect height changed (the only visible resize signal). */
  private async checkResize(): Promise<void> {
    const w = this.watch;
    if (!w) return;
    const layout = this.hub.link.layoutFor(w.pane);
    if (!layout) return;
    if (w.rectHeight === layout.rect.height) return;
    const size = await this.paneSize(w.pane);
    if (this.watch !== w) return;
    w.rectHeight = size.rectHeight;
    if (size.rows !== w.rows || size.cols !== w.cols) {
      w.rows = size.rows;
      w.cols = size.cols;
      w.forceFull = true;
      w.watcher.invalidate();
      this.flush();
    }
  }

  private onWatchError(err: Error): void {
    const w = this.watch;
    if (!w) return;
    if (err instanceof HerdrError && /pane|not_found|unknown/i.test(err.code)) {
      this.stopWatch();
      this.error(undefined, 'unknown_pane', `${w.pane}: ${err.code}`);
      return;
    }
    if (this.hub.link.isUp) this.log.debug('watch.read_failed', { error: err.message });
  }

  private onScreen(read: PaneReadResult): void {
    const w = this.watch;
    if (!w) return;
    const rows = parseScreen(read.text);
    if (rows.length > w.rows) {
      // more rows than we believed the pane had: the grid grew
      w.rows = rows.length;
      w.forceFull = true;
    }
    w.latest = rows;
    if (this.now() - w.altProbedAt >= ALT_PROBE_MIN_INTERVAL_MS) void this.probeAlt(w);
    const elapsed = this.now() - w.lastSentAt;
    const minInterval = w.watcher.boosted ? BOOST_FRAME_MIN_INTERVAL_MS : FRAME_MIN_INTERVAL_MS;
    if (elapsed >= minInterval) this.flush();
    else if (!w.flushTimer) w.flushTimer = setTimeout(() => this.flush(), minInterval - elapsed);
  }

  private flush(): void {
    const w = this.watch;
    if (!w) return;
    if (w.flushTimer) {
      clearTimeout(w.flushTimer);
      w.flushTimer = null;
    }
    if (!w.latest) return;
    if (this.ws.bufferedAmount > 512 * 1024) {
      // client is not keeping up: skip this frame, the next flush sends a full one
      w.forceFull = true;
      return;
    }
    const prev = w.forceFull ? null : w.sent;
    const { changed, full } = diffRows(prev, w.latest, w.rows);
    if (!full && changed.length === 0 && !w.altDirty) return;
    w.rev++;
    this.send(encodeFrame({ pane: w.pane, rev: w.rev, cols: w.cols, rows: w.rows, full, rows_: w.latest, changed, table: this.styles, alt: w.alt }));
    w.sent = w.latest;
    w.altDirty = false;
    w.forceFull = false;
    w.lastSentAt = this.now();
  }

  // ---- other requests -------------------------------------------------------------------------

  private async history(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const requested = typeof m['lines'] === 'number' && Number.isFinite(m['lines']) ? Math.floor(m['lines']) : 200;
    const n = Math.min(Math.max(requested, 1), MAX_HISTORY_LINES);
    const source = m['unwrapped'] === true ? 'recent_unwrapped' : 'recent';
    // herdr returns N-1 lines for lines=N (docs/herdr-findings.md §2), so ask for one more. `pane.get`
    // says how many lines herdr actually holds above the screen: 0 for a program on the alternate
    // screen (Claude Code, vim, tmux) or a fresh shell — then `recent` is just the screen again and the
    // phone should say so instead of showing a frozen copy of the live view.
    const [{ read }, info] = await Promise.all([
      this.hub.link.request<{ read: PaneReadResult }>('pane.read', {
        pane_id: pane,
        source,
        lines: Math.min(n + 1, MAX_HISTORY_LINES),
        format: 'ansi',
        strip_ansi: false,
      }),
      this.hub.link.request<{ pane: PaneInfo }>('pane.get', { pane_id: pane }).catch(() => null),
    ]);
    const scrollback = info?.pane?.scroll?.max_offset_from_bottom ?? null;
    const rows_ = parseScreen(read.text);
    const has_more = rows_.length >= n && scrollback !== 0;
    this.log.info('history', { pane, source, requested: n, returned: rows_.length, scrollback });
    this.send(encodeHistory({ id: id ?? '', pane, rows_, has_more, scrollback, table: this.styles }));
  }

  private async keys(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const keys = m['keys'];
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || !keys.every((k) => typeof k === 'string')) {
      return this.error(id, 'bad_request', 'keys must be a non-empty string array');
    }
    const plan = planKeys(keys as string[]);
    if (!plan) return this.error(id, 'invalid_key', `unknown key in ${JSON.stringify(keys)}`);
    for (const batch of plan) {
      if (batch.kind === 'keys') await this.hub.link.request('pane.send_keys', { pane_id: pane, keys: batch.keys });
      else await this.hub.link.request('pane.send_text', { pane_id: pane, text: batch.text });
    }
    this.ok(id);
  }

  /**
   * Touch scrolling forwarded to the program instead of the phone's scrollback: `wheel` sends SGR
   * mouse-wheel reports (for tmux, vim, less with mouse on …), `arrows` sends Up/Down keys. herdr
   * cannot tell us whether the program has mouse tracking on, so the phone chooses the mode.
   */
  private async scroll(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const direction = m['direction'];
    if (direction !== 'up' && direction !== 'down') return this.error(id, 'bad_request', "direction must be 'up' or 'down'");
    const lines = typeof m['lines'] === 'number' && Number.isFinite(m['lines']) ? Math.min(Math.max(Math.floor(m['lines']), 1), MAX_SCROLL_LINES) : 1;
    const mode = m['mode'];
    if (mode !== undefined && mode !== 'wheel' && mode !== 'arrows') return this.error(id, 'bad_request', "mode must be 'wheel' or 'arrows'");
    const col = typeof m['col'] === 'number' ? m['col'] : 1;
    const row = typeof m['row'] === 'number' ? m['row'] : 1;
    if (mode === 'arrows') {
      await this.hub.link.request('pane.send_keys', { pane_id: pane, keys: Array.from({ length: lines }, () => direction) });
    } else {
      await this.hub.link.request('pane.send_text', { pane_id: pane, text: wheelReport(direction, col, row).repeat(lines) });
    }
    // The program redraws right after this: poll it fast and let frames out sooner for a moment.
    if (this.watch?.pane === pane) this.watch.watcher.boost(SCROLL_BOOST_MS);
    this.log.info('scroll', { pane, mode: mode ?? 'wheel', direction, lines, col, row });
    this.ok(id);
  }

  /**
   * New herdr tab (one shell pane) and, optionally, a command typed into it. herdr's `tab.create`
   * returns before the shell has started, so with a command the bridge first waits for the shell to
   * draw its prompt (anything on screen), then `send_text` + Enter. Reply `ok {pane, tab}`.
   */
  private async createPane(id: string | undefined, m: Msg): Promise<void> {
    const label = optionalString(m, 'label', 64);
    const command = optionalString(m, 'command', MAX_COMMAND_BYTES);
    const cwd = optionalString(m, 'cwd', 1024);
    if (label === false) return this.error(id, 'bad_request', 'label must be a string up to 64 chars');
    if (command === false) return this.error(id, 'bad_request', `command must be a string up to ${MAX_COMMAND_BYTES} bytes`);
    if (cwd === false) return this.error(id, 'bad_request', 'cwd must be a string up to 1024 chars');
    const params: Record<string, unknown> = { focus: false };
    if (label) params['label'] = label;
    if (cwd) params['cwd'] = cwd;
    const created = await this.hub.link.request<TabCreateResult>('tab.create', params);
    const pane = created.root_pane.pane_id;
    // Reply only once the pane is in our snapshot: the phone opens (watches, fits) it the moment `ok` arrives.
    if (!(await this.hub.link.ensurePane(pane, 3000))) this.log.warn('pane.create.not_in_snapshot', { pane });
    const text = (command ?? '').replace(/\s+$/, '');
    if (text.length > 0) {
      await this.awaitShellPrompt(pane);
      await this.hub.link.request('pane.send_text', { pane_id: pane, text });
      await this.hub.link.request('pane.send_keys', { pane_id: pane, keys: ['enter'] });
    }
    this.log.info('pane.created', { pane, tab: created.tab.tab_id, labelled: Boolean(label), command: text.length > 0 });
    this.ok(id, { pane, tab: created.tab.tab_id });
  }

  /**
   * Close a pane on the desktop (herdr `pane.close`): its shell and whatever runs in it end, and herdr
   * closes the tab too when this was its last pane. This connection's own watch on it ends first, so the
   * phone gets a plain `ok`; other devices watching it get `error unknown_pane` from their watcher and a
   * `snapshot` without the pane, exactly as when the user types `exit`.
   */
  private async closePane(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    if (!(await this.hub.link.ensurePane(pane))) return this.error(id, 'unknown_pane', `no pane ${pane}`);
    // Drop our own watch first, but through the same FIFO as watch/unwatch/fit rather than inline: a bare
    // leave/stopWatch here raced those turns — a switch establishing a watch on this pane could overlap this
    // tear-down, leaving a watcher and its leases running for a pane about to close, or dropping the newer watch's
    // lease. Revalidate the pane inside the turn; a switch may have moved us off it while `ensurePane` polled.
    await this.inWatchOrder(async () => {
      if (this.watch?.pane === pane) {
        await this.leave(pane);
        this.stopWatch();
      }
    });
    try {
      await this.hub.link.request('pane.close', { pane_id: pane });
    } catch (err) {
      if (err instanceof HerdrError && /not_found/.test(err.code)) return this.error(id, 'unknown_pane', `no pane ${pane}`);
      throw err;
    }
    this.log.info('pane.close', { pane, device_id: this.device?.id ?? null });
    this.ok(id);
  }

  private async awaitShellPrompt(pane: string): Promise<void> {
    const deadline = this.now() + SHELL_READY_TIMEOUT_MS;
    for (;;) {
      const { read } = await this.hub.link.request<{ read: PaneReadResult }>('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
      if (/\S/.test(read.text)) break;
      if (this.now() >= deadline) {
        this.log.warn('pane.create.prompt_timeout', { pane });
        return;
      }
      await new Promise((r) => setTimeout(r, SHELL_POLL_MS));
    }
    await new Promise((r) => setTimeout(r, SHELL_SETTLE_MS));
  }

  private textArg(m: Msg): string {
    const text = m['text'];
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new BadRequest('text must be a string up to 64 KiB');
    return text;
  }

  private async text(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const text = this.textArg(m);
    if (text.length > 0) await this.hub.link.request('pane.send_text', { pane_id: pane, text });
    this.ok(id);
  }

  private async prompt(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const text = this.textArg(m);
    const info = this.hub.link.pane(pane);
    if (!info) return this.error(id, 'unknown_pane', `no pane ${pane}`);
    // `notify:true` — "tell me when it's done" for this device, armed before the text goes in.
    if (m['notify'] === true) this.devices.setNotifyDone(this.device!.id, pane, true);
    if (info.agent) {
      try {
        await this.hub.link.request('agent.prompt', { target: pane, text });
        return this.ok(id, { via: 'agent.prompt' });
      } catch (err) {
        // "not an active named agent" right after launch, or a plain shell mis-detected: fall through
        this.log.debug('prompt.agent_prompt_failed', { error: (err as Error).message });
      }
    }
    await this.hub.link.request('pane.send_text', { pane_id: pane, text });
    if (info.agent) await this.confirmTyped(pane, text);
    await this.hub.link.request('pane.send_keys', { pane_id: pane, keys: ['enter'] });
    this.ok(id, { via: 'send_text' });
  }

  /**
   * Agent TUIs that are still starting up drop typed text (Codex within ~1 s of becoming idle,
   * docs/herdr-findings.md §7). Check that the composer shows the text and type it once more if not.
   */
  private async confirmTyped(pane: string, text: string): Promise<void> {
    const probe = text.split('\n')[0]?.trim().slice(0, 24) ?? '';
    if (probe.length < 4) return;
    const visible = async (): Promise<boolean> => {
      const { read } = await this.hub.link.request<{ read: PaneReadResult }>('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
      return read.text.replace(/\s+/g, ' ').includes(probe.replace(/\s+/g, ' '));
    };
    await new Promise((r) => setTimeout(r, 250));
    if (await visible().catch(() => true)) return;
    this.log.debug('prompt.retyping', { pane });
    await new Promise((r) => setTimeout(r, 1200));
    if (await visible().catch(() => true)) return;
    await this.hub.link.request('pane.send_text', { pane_id: pane, text });
    await new Promise((r) => setTimeout(r, 250));
  }

  private async approve(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const action = m['action'];
    const promptId = m['prompt_id'];
    if (typeof action !== 'string' || !APPROVAL_ACTIONS.has(action as ApprovalAction)) return this.error(id, 'bad_request', 'unknown action');
    if (typeof promptId !== 'string') return this.error(id, 'bad_request', 'prompt_id required');
    const feedback = typeof m['feedback'] === 'string' ? m['feedback'] : undefined;
    const force = m['force'] === true;
    this.ok(id);
    let result;
    try {
      result = await performApproval(
        {
          request: (method, params) => this.hub.link.request(method, params),
          currentPromptId: (p) => this.hub.refreshPromptId(p),
          strictVerify: this.config.approvals.strict_verify,
        },
        { pane, promptId, action: action as ApprovalAction, ...(feedback !== undefined ? { feedback } : {}), force },
      );
    } catch (err) {
      if (err instanceof UnsupportedAgentError) return this.error(id, 'unsupported_agent', err.message);
      result = { outcome: 'failed' as const, detail: (err as Error).message };
    }
    this.log.info('approval', { device_id: this.device?.id, action, outcome: result.outcome, status_after: result.status_after ?? null });
    this.send({ t: 'approval.result', pane, prompt_id: promptId, ...result });
  }

  /**
   * `choose {pane, prompt_id, option, label}`: answer the dialog on screen by moving its cursor to option N and
   * pressing Enter (approvals/choose.ts). Replies `ok` at once, then `approval.result`.
   */
  private async choose(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const promptId = m['prompt_id'];
    const option = m['option'];
    const label = m['label'];
    if (typeof promptId !== 'string') return this.error(id, 'bad_request', 'prompt_id required');
    if (typeof option !== 'number' || !Number.isInteger(option) || option < 1 || option > 50) return this.error(id, 'bad_request', 'option must be an integer 1-50');
    if (typeof label !== 'string' || label.length === 0 || label.length > 400) return this.error(id, 'bad_request', 'label required');
    this.ok(id);
    let result: ApprovalResult;
    try {
      result = await performChoice(
        {
          request: (method, params) => this.hub.link.request(method, params),
          currentPromptId: (p) => this.hub.refreshPromptId(p),
          strictVerify: this.config.approvals.strict_verify,
        },
        { pane, promptId, option, label },
      );
    } catch (err) {
      result = { outcome: 'failed', detail: (err as Error).message };
    }
    this.log.info('choice', { device_id: this.device?.id, option, outcome: result.outcome, status_after: result.status_after ?? null });
    this.send({ t: 'approval.result', pane, prompt_id: promptId, ...result });
  }

  /** `fit {pane, cols, rows}` → impose the phone's grid on the pane's PTY; `fit {pane, release:true}` → give it back. */
  private async fit(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    if (m['release'] === true) {
      await this.hub.fitter.release(pane, this);
      return this.ok(id);
    }
    const size = parseFitSize(m);
    if (typeof size === 'string') return this.error(id, 'bad_request', size);
    if (!this.hub.link.isUp) return this.error(id, 'herdr_down', 'herdr is not reachable');
    if (!(await this.hub.link.ensurePane(pane))) return this.error(id, 'unknown_pane', `no pane ${pane}`);
    if (this.disposed) return; // the socket closed meanwhile: a fit taken now would outlive its owner
    try {
      const applied = await this.hub.fitter.apply(pane, this, size);
      if (!this.disposed) this.ok(id, { cols: applied.cols, rows: applied.rows });
    } catch (err) {
      if (this.disposed) return;
      if (err instanceof FitUnavailableError) return this.error(id, 'fit_unavailable', err.message);
      throw err;
    } finally {
      // `dispose()` released what the session owned at that moment. A fit that landed after it, or half-landed (the
      // fitter records the owner before the stty write), must go too, or the desktop pane stays at the phone's width
      // until another device fits it.
      if (this.disposed) await this.hub.fitter.release(pane, this).catch(() => undefined);
    }
  }

  private async zoom(id: string | undefined, m: Msg): Promise<void> {
    const pane = this.paneArg(m);
    const mode = m['mode'] === 'on' || m['mode'] === 'off' ? m['mode'] : 'toggle';
    const { zoom } = await this.hub.link.request<{ zoom: PaneZoomResult }>('pane.zoom', { pane_id: pane, mode });
    this.ok(id, { zoomed: zoom.zoomed });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.stopWatch();
    void this.hub.fitter.releaseAll(this).catch(() => undefined).finally(() => void this.hub.zoomer.releaseAll(this));
    this.hub.fitter.off('fitted', this.onFitted);
    this.hub.removeViewer(this);
    this.hub.link.off('state', this.onHerdrState);
    this.hub.link.off('snapshot', this.onSnapshot);
    if (this.device) this.log.info('session.close', { device_id: this.device.id });
  }
}

/** Optional string field: undefined when absent/blank, the trimmed value, or false when invalid. */
function optionalString(m: Msg, key: string, maxBytes: number): string | undefined | false {
  const v = m[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || Buffer.byteLength(v) > maxBytes) return false;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export type { SessionSnapshot };
