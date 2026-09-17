// Push notifier (§6.6, §9). Three feeds:
//  • approvals — debounce `blocked` per pane, skip panes a device is viewing, fan out to every registered device;
//  • "tell me when it's done" — per-device arming (DeviceStore.notify_done); fires once a working agent has
//    stayed idle/done/exited for `push.done_settle_ms`, then disarms;
//  • glanceable status — every status change to devices that opted in (`activity.register`): FCM `status`
//    data for Android's ongoing notification, APNs `liveactivity` start/update/end for iOS Live Activities.
// Dead tokens are forgotten. `info` logs never carry tokens or screen text.
import path from 'node:path';
import type { ApprovalDetails } from '../approvals/dialog.ts';
import { activityToken, type DeviceRecord, type DeviceStore, type Platform, type PushRegistration } from '../auth/devices.ts';
import type { FlowConfig } from '../config.ts';
import type { AgentStatus } from '../herdr/types.ts';
import type { Logger } from '../log.ts';
import type { ApnsClient } from './apns.ts';
import type { FcmClient } from './fcm.ts';
import {
  approvalSummary,
  buildApnsDonePayload,
  buildApnsPayload,
  buildFcmData,
  buildFcmDoneData,
  buildFcmStatusData,
  buildLiveActivityPayload,
  type ActivityEvent,
  type ApprovalNotice,
  type DoneNotice,
  type StatusNotice,
} from './payloads.ts';
import type { PushResult } from './types.ts';

export interface PaneSummary {
  agent_status: AgentStatus;
  agent: string | null;
  display_agent: string | null;
  title: string;
  cwd: string | null;
  prompt_id: string | null;
  approval?: ApprovalDetails | null;
}

/** What the apps call the session (DESIGN.md §4.3): the pane title, else the cwd's last path component, else the pane id. */
export function sessionTitle(s: Pick<PaneSummary, 'title' | 'cwd'> | undefined, pane: string): string {
  // `basename('/')` is empty; both apps show the root as `/`.
  return s?.title || (s?.cwd ? path.basename(s.cwd) || s.cwd : '') || pane;
}

export interface NotifierDeps {
  config: FlowConfig;
  devices: DeviceStore;
  log: Logger;
  hostName: string;
  /** null when not configured. `Pick` so tests can pass a plain `{send, close}` object. */
  apns: Pick<ApnsClient, 'send' | 'close'> | null;
  fcm: Pick<FcmClient, 'send' | 'close'> | null;
  /** A connected device (that device, when given) is looking at the pane right now. */
  isViewed: (pane: string, deviceId?: string) => boolean;
  paneState: (pane: string) => PaneSummary | undefined;
  /** Hub reads the screen; null when unavailable. */
  excerpt: (pane: string) => Promise<string | null>;
  /** The agent's closing words for the "finished" alert; falls back to `excerpt`. */
  finishedExcerpt?: (pane: string) => Promise<string | null>;
  /** Hub re-reads and parses the approval dialog just before the push goes out; null when it does not parse. */
  approval?: (pane: string) => Promise<ApprovalDetails | null>;
  /** The bridge disarmed a device's done alert itself (it fired); the session layer tells the phone (`notify.state`). */
  onArmChanged?: (deviceId: string, pane: string, done: boolean) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const FCM_TTL_SEC = 600;
/** A stale "working" state is worse than none. */
const STATUS_TTL_SEC = 60;
/** An `end` APNs refused for a passing reason is tried once more this much later; then the token goes either way. */
const END_RETRY_MS = 30_000;
/** Identities remembered for ended panes (bounded, most recent kept). */
const LAST_SEEN_LIMIT = 256;
const DEFAULT_BODY = 'Approval needed';
const DONE_BODY = 'Finished';
/** Statuses that end a stretch of work. */
const ENDED = new Set<AgentStatus>(['idle', 'done', 'unknown']);

export class Notifier {
  private readonly d: NotifierDeps;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** pane → approval debounce */
  private readonly timers = new Map<string, unknown>();
  /** pane → done settle */
  private readonly doneTimers = new Map<string, unknown>();
  /** pane → retry of an `end` APNs refused for a passing reason */
  private readonly endRetries = new Map<string, unknown>();
  /** pane → when its agent started the current stretch of work (ms) */
  private readonly since = new Map<string, number>();
  /**
   * pane → the identity its glanceable surfaces last showed, so an activity can end under the session's name after the pane
   * is gone. Never pruned early (a phone may report an activity's token seconds after its pane closed); bounded instead.
   */
  private readonly lastSeen = new Map<string, Pick<PaneSummary, 'agent' | 'display_agent' | 'title' | 'cwd'>>();
  private readonly warnedPlatforms = new Set<Platform>();
  private closed = false;

  constructor(deps: NotifierDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Called by the hub on every verified agent status change. Never throws. */
  onStatusChange(pane: string, status: AgentStatus): void {
    try {
      this.cancel(this.timers, pane);
      if (this.closed) return;
      if (status === 'blocked') {
        const handle = this.setTimer(() => {
          this.timers.delete(pane);
          this.fire(pane).catch((err) => this.d.log.warn('push.failed', { error: err }));
        }, this.d.config.push.debounce_ms);
        this.timers.set(pane, handle);
      }
      if (ENDED.has(status)) {
        if (!this.doneTimers.has(pane) && this.d.devices.armedFor(pane).length > 0) {
          const handle = this.setTimer(() => {
            this.doneTimers.delete(pane);
            this.fireDone(pane).catch((err) => this.d.log.warn('push.failed', { kind: 'done', error: err }));
          }, this.d.config.push.done_settle_ms);
          this.doneTimers.set(pane, handle);
        }
      } else {
        this.cancel(this.doneTimers, pane);
        if (!this.since.has(pane)) this.since.set(pane, this.now());
      }
      this.updateActivities(pane, status).catch((err) => this.d.log.warn('push.failed', { kind: 'status', error: err }));
    } catch (err) {
      this.d.log.warn('push.schedule_failed', { error: err });
    }
  }

  /**
   * The pane was renamed while its status stood still (Claude names the session a moment after it starts working):
   * refresh the glanceable surfaces so they carry the session's name. Updates only — never a push-to-start. Never throws.
   */
  onTitleChange(pane: string): void {
    try {
      if (this.closed) return;
      const status = this.d.paneState(pane)?.agent_status ?? 'unknown';
      if (ENDED.has(status)) return;
      this.updateActivities(pane, status, { start: false }).catch((err) => this.d.log.warn('push.failed', { kind: 'status', error: err }));
    } catch (err) {
      this.d.log.warn('push.schedule_failed', { error: err });
    }
  }

  /** The pane left herdr's snapshot: end its Live Activities, drop its arms and timers. */
  onPaneGone(pane: string): void {
    try {
      this.cancel(this.timers, pane);
      this.cancel(this.doneTimers, pane);
      for (const dev of this.d.devices.armedFor(pane)) this.d.devices.setNotifyDone(dev.id, pane, false);
      this.updateActivities(pane, 'unknown').catch((err) => this.d.log.warn('push.failed', { kind: 'status', error: err }));
    } catch (err) {
      this.d.log.warn('push.schedule_failed', { error: err });
    }
  }

  /** `remotly-bridge push-test <device_id>`: synthetic approval notice to one device. */
  async pushTest(deviceId: string): Promise<PushResult> {
    const dev = this.d.devices.get(deviceId);
    if (!dev) throw new Error('unknown_device');
    if (!dev.push) throw new Error('no_push_registration');
    if (!this.configured(dev.push.platform)) throw new Error('push_not_configured');
    const notice: ApprovalNotice = {
      host: this.d.hostName,
      pane: 'flow-test',
      promptId: `flow-test@${this.now()}`,
      agent: 'flow',
      displayAgent: 'Remotly',
      subtitle: 'Push test',
      body: 'If you can read this, push notifications work.',
    };
    const result = await this.sendApproval(dev.push, notice);
    this.record(dev, result);
    return result;
  }

  close(): void {
    this.closed = true;
    for (const h of this.timers.values()) this.clearTimer(h);
    for (const h of this.doneTimers.values()) this.clearTimer(h);
    for (const h of this.endRetries.values()) this.clearTimer(h);
    this.timers.clear();
    this.doneTimers.clear();
    this.endRetries.clear();
    this.d.apns?.close();
    this.d.fcm?.close();
  }

  private cancel(timers: Map<string, unknown>, pane: string): void {
    const h = timers.get(pane);
    if (h === undefined) return;
    this.clearTimer(h);
    timers.delete(pane);
  }

  private configured(platform: Platform): boolean {
    return platform === 'ios' ? this.d.apns !== null : this.d.fcm !== null;
  }

  /**
   * What names the session in a push: the session title — or, with `push.include_excerpt` off, only the host name. A pane
   * title or a directory name is pane text too; with the option off nothing but ids, the host name, the agent kind and the
   * status leaves the host (SECURITY.md).
   */
  private label(s: Pick<PaneSummary, 'title' | 'cwd'> | undefined, pane: string): string {
    return this.d.config.push.include_excerpt ? sessionTitle(s, pane) : this.d.hostName;
  }

  // ---- approvals ------------------------------------------------------------------------------

  private async fire(pane: string): Promise<void> {
    const state = this.d.paneState(pane);
    if (!state || state.agent_status !== 'blocked') return;
    if (this.d.isViewed(pane)) {
      this.d.log.debug('push.suppressed', { pane, reason: 'viewed' });
      return;
    }
    const notice = await this.buildNotice(pane, state);
    // The reads are async; the prompt may have been answered meanwhile.
    if (this.d.paneState(pane)?.agent_status !== 'blocked') return;
    const jobs: Promise<void>[] = [];
    for (const dev of this.d.devices.list()) {
      const reg = dev.push;
      if (!reg) continue;
      if (!this.configured(reg.platform)) {
        this.warnUnconfigured(reg.platform);
        continue;
      }
      jobs.push(this.deliver(dev, reg, () => this.sendApproval(reg, notice)));
    }
    await Promise.all(jobs);
  }

  private async buildNotice(pane: string, s: PaneSummary): Promise<ApprovalNotice> {
    const agent = s.agent ?? 'unknown';
    let approval = s.approval ?? null;
    if (this.d.approval) {
      try {
        approval = (await this.d.approval(pane)) ?? approval;
      } catch (err) {
        this.d.log.debug('push.approval_failed', { pane, error: err });
      }
    }
    let body = DEFAULT_BODY;
    if (this.d.config.push.include_excerpt) {
      if (approval) body = approvalSummary(approval);
      else {
        try {
          body = (await this.d.excerpt(pane)) ?? DEFAULT_BODY;
        } catch (err) {
          this.d.log.debug('push.excerpt_failed', { pane, error: err });
        }
      }
    }
    return {
      host: this.d.hostName,
      pane,
      promptId: s.prompt_id ?? pane,
      agent,
      displayAgent: s.display_agent ?? agent,
      subtitle: this.label(s, pane),
      body,
      ...(approval && this.d.config.push.include_excerpt ? { approval } : {}),
    };
  }

  private sendApproval(reg: PushRegistration, notice: ApprovalNotice): Promise<PushResult> {
    if (reg.platform === 'ios') {
      if (!this.d.apns) throw new Error('push_not_configured');
      return this.d.apns.send({ token: reg.token, env: reg.env, collapseId: notice.pane, payload: buildApnsPayload(notice) });
    }
    if (!this.d.fcm) throw new Error('push_not_configured');
    return this.d.fcm.send({ token: reg.token, collapseKey: notice.pane, ttlSec: FCM_TTL_SEC, data: buildFcmData(notice) });
  }

  // ---- "tell me when it's done" ---------------------------------------------------------------

  private async fireDone(pane: string): Promise<void> {
    const state = this.d.paneState(pane);
    if (state && !ENDED.has(state.agent_status)) return; // back at work during the settle
    const armed = this.d.devices.armedFor(pane);
    if (armed.length === 0) return;
    const notice = await this.buildDone(pane, state);
    const after = this.d.paneState(pane);
    if (after && !ENDED.has(after.agent_status)) return;
    const jobs: Promise<void>[] = [];
    for (const dev of armed) {
      // One alert per arming: disarm first, whatever happens to the delivery.
      this.d.devices.setNotifyDone(dev.id, pane, false);
      this.d.onArmChanged?.(dev.id, pane, false);
      if (this.d.isViewed(pane, dev.id)) {
        this.d.log.debug('push.suppressed', { pane, reason: 'viewed', kind: 'done' });
        continue;
      }
      const reg = dev.push;
      if (!reg) continue;
      if (!this.configured(reg.platform)) {
        this.warnUnconfigured(reg.platform);
        continue;
      }
      jobs.push(this.deliver(dev, reg, () => this.sendDone(reg, notice), 'done'));
    }
    await Promise.all(jobs);
  }

  private async buildDone(pane: string, s: PaneSummary | undefined): Promise<DoneNotice> {
    const agent = s?.agent ?? 'unknown';
    let body = DONE_BODY;
    if (this.d.config.push.include_excerpt) {
      try {
        body = (await (this.d.finishedExcerpt ?? this.d.excerpt)(pane)) ?? DONE_BODY;
      } catch (err) {
        this.d.log.debug('push.excerpt_failed', { pane, error: err });
      }
    }
    return { host: this.d.hostName, pane, agent, displayAgent: s?.display_agent ?? (s?.agent ?? 'Agent'), subtitle: this.label(s, pane), body };
  }

  private sendDone(reg: PushRegistration, notice: DoneNotice): Promise<PushResult> {
    if (reg.platform === 'ios') {
      if (!this.d.apns) throw new Error('push_not_configured');
      return this.d.apns.send({ token: reg.token, env: reg.env, collapseId: notice.pane, payload: buildApnsDonePayload(notice) });
    }
    if (!this.d.fcm) throw new Error('push_not_configured');
    return this.d.fcm.send({ token: reg.token, collapseKey: notice.pane, ttlSec: FCM_TTL_SEC, data: buildFcmDoneData(notice) });
  }

  // ---- glanceable status ----------------------------------------------------------------------

  /**
   * A device handed over an activity's update token after the fact (iOS wakes the app in the background when a
   * push-to-start activity begins; the token reaches us only then): bring that one activity up to date, or end it
   * when the pane has already stopped.
   */
  syncActivity(deviceId: string, pane: string): void {
    const dev = this.d.devices.get(deviceId);
    const reg = dev?.push;
    const token = activityToken(reg, pane);
    if (!dev || !reg || !token || reg.platform !== 'ios' || !this.configured('ios')) return;
    const status: AgentStatus = this.d.paneState(pane)?.agent_status ?? 'unknown';
    const ended = ENDED.has(status);
    this.sendActivity(dev, reg, token, this.statusNotice(pane, status), ended ? 'end' : 'update')
      .then((res) => {
        if ((ended && res.ok) || (!res.ok && res.dropToken)) this.dropActivityToken(dev, pane, token);
        if (ended && !res.ok && !res.dropToken) this.scheduleEndRetry(pane);
        if (ended) this.since.delete(pane);
      })
      .catch((err) => this.d.log.warn('push.failed', { kind: 'status', error: err }));
  }

  private statusNotice(pane: string, status: AgentStatus): StatusNotice {
    const s = this.d.paneState(pane);
    // A pane that just left the snapshot ends its activity under the name it had, not its id.
    if (s) this.remember(pane, { agent: s.agent, display_agent: s.display_agent, title: s.title, cwd: s.cwd });
    const seen = s ?? this.lastSeen.get(pane);
    return {
      host: this.d.hostName,
      pane,
      agent: seen?.agent ?? 'unknown',
      displayAgent: seen?.display_agent ?? (seen?.agent ?? 'Agent'),
      title: this.label(seen, pane),
      status,
      sinceMs: this.since.get(pane) ?? this.now(),
      promptId: status === 'blocked' ? (s?.prompt_id ?? null) : null,
      detail: status === 'blocked' && s?.approval && this.d.config.push.include_excerpt ? approvalSummary(s.approval, 120) : null,
      kind: status === 'blocked' ? (s?.approval?.kind ?? null) : null,
    };
  }

  /** `start:false` (a title change) updates running activities only; a push-to-start is reserved for status changes. */
  private async updateActivities(pane: string, status: AgentStatus, { start = true }: { start?: boolean } = {}): Promise<void> {
    const ended = ENDED.has(status);
    const devices = this.d.devices.list().filter((dev) => dev.push?.activity);
    if (devices.length === 0) {
      if (ended) this.since.delete(pane);
      return;
    }
    const notice = this.statusNotice(pane, status);
    const jobs: Promise<void>[] = [];
    for (const dev of devices) {
      const reg = dev.push!;
      if (!this.configured(reg.platform)) continue;
      if (reg.platform === 'android') {
        jobs.push(this.deliver(dev, reg, () => this.d.fcm!.send({ token: reg.token, collapseKey: `status:${pane}`, ttlSec: STATUS_TTL_SEC, data: buildFcmStatusData(notice) }), 'status'));
        continue;
      }
      const updateToken = activityToken(reg, pane);
      if (updateToken) {
        const event: ActivityEvent = ended ? 'end' : 'update';
        jobs.push(
          this.sendActivity(dev, reg, updateToken, notice, event).then(async (res) => {
            // A delivered end (or a dead token) forgets the token; an end APNs refused for a passing reason keeps it and is
            // retried once (`scheduleEndRetry`), so the activity still comes down under the session's name.
            if ((ended && res.ok) || (!res.ok && res.dropToken)) this.dropActivityToken(dev, pane, updateToken);
            if (ended && !res.ok && !res.dropToken) this.scheduleEndRetry(pane);
            // The activity is gone from the phone (dismissed, expired, a reused pane id) while the pane works: start afresh now.
            if (!ended && !res.ok && res.dropToken && start) {
              // From the registration as it is now: while the update was in flight the phone may have reported a fresh token
              // (a new activity already runs) or opted out.
              const now = this.d.devices.get(dev.id)?.push;
              if (now?.activity && now.la_start && !activityToken(now, pane)) await this.startActivity(dev, now, now.la_start, notice);
            }
          }),
        );
      } else if (!ended && start && reg.la_start) {
        jobs.push(this.startActivity(dev, reg, reg.la_start, notice));
      }
    }
    await Promise.all(jobs);
    if (ended) this.since.delete(pane);
  }

  private remember(pane: string, identity: Pick<PaneSummary, 'agent' | 'display_agent' | 'title' | 'cwd'>): void {
    this.lastSeen.delete(pane); // re-insert last: the map's order is age
    this.lastSeen.set(pane, identity);
    if (this.lastSeen.size > LAST_SEEN_LIMIT) this.lastSeen.delete(this.lastSeen.keys().next().value as string);
  }

  /** Forget `token` for `pane` on this device — unless the phone has reported a newer one meanwhile (a fresh activity). */
  private dropActivityToken(dev: DeviceRecord, pane: string, token: string): void {
    if (activityToken(this.d.devices.get(dev.id)?.push, pane) === token) this.d.devices.setActivityToken(dev.id, pane, null);
  }

  private async startActivity(dev: DeviceRecord, reg: PushRegistration, startToken: string, notice: StatusNotice): Promise<void> {
    const res = await this.sendActivity(dev, reg, startToken, notice, 'start');
    if (!res.ok && res.dropToken) this.d.devices.updatePush(dev.id, { la_start: undefined });
  }

  /** An `end` APNs refused for a passing reason: once more after `END_RETRY_MS`; then, whatever the answer, the token goes. */
  private scheduleEndRetry(pane: string): void {
    if (this.closed || this.endRetries.has(pane)) return;
    const handle = this.setTimer(() => {
      this.endRetries.delete(pane);
      this.retryEnd(pane).catch((err) => this.d.log.warn('push.failed', { kind: 'status', error: err }));
    }, END_RETRY_MS);
    this.endRetries.set(pane, handle);
  }

  private async retryEnd(pane: string): Promise<void> {
    const status: AgentStatus = this.d.paneState(pane)?.agent_status ?? 'unknown';
    if (!ENDED.has(status)) return; // working again (or a new pane with this id): the live flow owns the activity now
    const notice = this.statusNotice(pane, status);
    const jobs: Promise<void>[] = [];
    for (const dev of this.d.devices.list()) {
      const reg = dev.push;
      const token = activityToken(reg, pane);
      if (!reg || !token || reg.platform !== 'ios' || !this.configured('ios')) continue;
      jobs.push(this.sendActivity(dev, reg, token, notice, 'end').then(() => this.dropActivityToken(dev, pane, token)));
    }
    await Promise.all(jobs);
    this.since.delete(pane);
  }

  private async sendActivity(dev: DeviceRecord, reg: PushRegistration, token: string, notice: StatusNotice, event: ActivityEvent): Promise<PushResult> {
    if (!this.d.apns) return { ok: false, status: 0, reason: 'push_not_configured', dropToken: false };
    const priority = event === 'update' && notice.status === 'working' ? 5 : 10;
    let result: PushResult;
    try {
      result = await this.d.apns.send({ token, env: reg.env, collapseId: `la:${notice.pane}`, payload: buildLiveActivityPayload(notice, event, this.now()), pushType: 'liveactivity', priority });
    } catch (err) {
      this.d.log.info('push.failed', { device_id: dev.id, platform: 'ios', kind: 'activity', la_event: event, error: err });
      return { ok: false, status: 0, reason: (err as Error).message, dropToken: false };
    }
    if (result.ok) this.d.log.info('push.sent', { device_id: dev.id, platform: 'ios', kind: 'activity', la_event: event });
    else this.d.log.info('push.failed', { device_id: dev.id, platform: 'ios', kind: 'activity', la_event: event, status: result.status, reason: result.reason });
    return result;
  }

  // ---- delivery bookkeeping -------------------------------------------------------------------

  private async deliver(dev: DeviceRecord, reg: PushRegistration, send: () => Promise<PushResult>, kind = 'approval'): Promise<void> {
    try {
      this.record(dev, await send(), kind);
    } catch (err) {
      this.d.log.info('push.failed', { device_id: dev.id, platform: reg.platform, kind, error: err });
    }
  }

  private record(dev: DeviceRecord, result: PushResult, kind = 'approval'): void {
    const platform = dev.push?.platform;
    if (result.ok) {
      this.d.log.info('push.sent', { device_id: dev.id, platform, kind });
      return;
    }
    this.d.log.info('push.failed', { device_id: dev.id, platform, kind, status: result.status, reason: result.reason });
    if (result.dropToken) {
      this.d.devices.setPush(dev.id, null);
      this.d.log.info('push.token_dropped', { device_id: dev.id, platform, reason: result.reason });
    }
  }

  private warnUnconfigured(platform: Platform): void {
    if (this.warnedPlatforms.has(platform)) return;
    this.warnedPlatforms.add(platform);
    this.d.log.warn('push.not_configured', { platform });
  }
}
