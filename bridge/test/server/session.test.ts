import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { DeviceStore } from '../../src/auth/devices.ts';
import { defaultConfig } from '../../src/config.ts';
import { HerdrError } from '../../src/herdr/client.ts';
import type { PaneInfo, SessionSnapshot } from '../../src/herdr/types.ts';
import { silentLogger } from '../../src/log.ts';
import { PaneFitter } from '../../src/herdr/fit.ts';
import { Hub } from '../../src/server/hub.ts';
import { HELLO_TIMEOUT_CLOSE_CODE, HELLO_TIMEOUT_MS, Session } from '../../src/server/session.ts';

// ---- fakes ------------------------------------------------------------------------------------

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
  push(msg: object): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }
  async waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 1500): Promise<Record<string, unknown>> {
    const start = Date.now();
    for (;;) {
      const hit = this.sent.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${pred.toString()}; got ${JSON.stringify(this.sent)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

const pane: PaneInfo = {
  pane_id: 'w1:pA',
  terminal_id: 't1',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  focused: true,
  agent: 'claude',
  display_agent: 'Claude',
  agent_status: 'blocked',
  cwd: '/home/u/proj',
  title: 'Fixing tests',
  state_labels: { claude: 'Waiting for approval' },
  revision: 3,
};
/** herdr scrollback lines above the screen reported by `pane.get` (null → herdr omits `scroll`). */
let paneScrollback: number | null = 120;
/** Name of the program in the pane's foreground for `pane.process_info` (null → just the shell). */
let fgProgram: string | null = null;
const shell: PaneInfo = { ...pane, pane_id: 'w1:pB', agent: null, display_agent: null, agent_status: 'unknown', title: 'bash', state_labels: {}, focused: false };

const snapshot: SessionSnapshot = {
  version: '0.8.0',
  protocol: 19,
  workspaces: [{ workspace_id: 'w1', number: 1, label: 'main', focused: true, pane_count: 2, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'blocked' }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'proj', focused: true, pane_count: 2, agent_status: 'blocked' }],
  panes: [pane, shell],
  layouts: [
    {
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      zoomed: false,
      area: { x: 0, y: 0, width: 120, height: 40 },
      focused_pane_id: 'w1:pA',
      panes: [
        { pane_id: 'w1:pA', focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
        { pane_id: 'w1:pB', focused: false, rect: { x: 60, y: 0, width: 60, height: 40 } },
      ],
    },
  ],
  agents: [pane],
  focused_pane_id: 'w1:pA',
};

class FakeLink extends EventEmitter {
  isUp = true;
  hostInfo = { version: '0.8.0', protocol: 19 };
  currentSnapshot: SessionSnapshot = snapshot;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  screen = '\x1b[0m\x1b[1mhello\x1b[0m world\r\nline two';
  /** What successive `pane.read`s of the pane created by `tab.create` show (empty = shell not up yet). */
  newPaneScreens: string[] = ['$ '];
  /** Tabs' zoom state, so `pane.zoom` answers like herdr 0.8.0 (already_zoomed / already_unzoomed). */
  readonly zoomedPanes = new Set<string>();
  /** When set, the next `pane.zoom on` awaits this before answering — lets a test dispose a session mid-apply. */
  zoomApplyGate: Promise<void> | null = null;
  readonly client = { request: (m: string, p: Record<string, unknown> = {}) => this.request(m, p) };
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case 'pane.read':
        if (params['pane_id'] === 'w1:gone') throw new HerdrError({ code: 'pane_not_found', message: 'no such pane' });
        if (params['pane_id'] === 'w1:pNew') {
          const text = this.newPaneScreens.length > 1 ? this.newPaneScreens.shift()! : this.newPaneScreens[0]!;
          return { read: { text, pane_id: params['pane_id'], source: params['source'], format: params['format'], revision: 1, truncated: false } } as T;
        }
        return { read: { text: this.screen, pane_id: params['pane_id'], source: params['source'], format: params['format'], revision: 1, truncated: false } } as T;
      case 'pane.get':
        return { pane: paneScrollback === null ? pane : { ...pane, scroll: { offset_from_bottom: 0, max_offset_from_bottom: paneScrollback, viewport_rows: 40 } } } as T;
      case 'pane.process_info':
        return {
          process_info: {
            pane_id: params['pane_id'],
            shell_pid: 100,
            foreground_process_group_id: fgProgram ? 200 : 100,
            foreground_processes: fgProgram ? [{ pid: 200, name: fgProgram, argv: [fgProgram], cmdline: fgProgram, cwd: '/home/u' }] : [],
          },
        } as T;
      case 'agent.get':
        return { agent: { pane_id: 'w1:pA', agent_status: 'blocked', state_change_seq: 47 } } as T;
      case 'agent.list':
        if (this.agentListDelayMs > 0) await new Promise((r) => setTimeout(r, this.agentListDelayMs));
        return { agents: [{ pane_id: 'w1:pA', agent_status: 'blocked', state_change_seq: 47 }] } as T;
      case 'pane.zoom': {
        const zp = params['pane_id'] as string;
        if (params['mode'] === 'on' && this.zoomApplyGate) {
          const g = this.zoomApplyGate;
          this.zoomApplyGate = null;
          await g;
        }
        const was = this.zoomedPanes.has(zp);
        const want = params['mode'] === 'on' ? true : params['mode'] === 'off' ? false : !was;
        if (want) this.zoomedPanes.add(zp);
        else this.zoomedPanes.delete(zp);
        const reason = was === want ? (want ? 'already_zoomed' : 'already_unzoomed') : null;
        return { zoom: { changed: was !== want, zoom_changed: was !== want, focus_changed: false, pane_id: zp, focused_pane_id: zp, zoomed: want, reason } } as T;
      }
      case 'tab.create':
        return { tab: { tab_id: 't9', workspace_id: 'w1', number: 9, label: params['label'] ?? 'shell', focused: false, pane_count: 1 }, root_pane: { pane_id: 'w1:pNew', tab_id: 't9', workspace_id: 'w1' } } as T;
      case 'agent.prompt':
        if (params['target'] === 'w1:pB') throw new HerdrError({ code: 'invalid_request', message: 'not an active named agent' });
        return { type: 'agent_prompted' } as T;
      default:
        return { type: 'ok' } as T;
    }
  }
  /** The pane `tab.create` returns is not in the snapshot until the bridge asks for a refresh (`ensurePane`), like herdr's ~200 ms lag. */
  newPaneKnown = false;
  /** Slow `agent.list`, so a snapshot reconciliation can be caught mid-flight by the next snapshot. */
  agentListDelayMs = 0;
  pane(id: string): PaneInfo | undefined {
    if (id === 'w1:pNew') return this.newPaneKnown ? { ...pane, pane_id: 'w1:pNew', tab_id: 't9' } : undefined;
    return this.currentSnapshot.panes.find((p) => p.pane_id === id);
  }
  /** When set, the next `ensurePane` awaits this before answering — lets a test hold a sizing fit at its ensurePane. */
  ensurePaneGate: Promise<void> | null = null;
  /** How many times `ensurePane` has been entered — a test can watch this to see queued turns run (or not). */
  ensurePaneCalls = 0;
  async ensurePane(id: string): Promise<PaneInfo | undefined> {
    this.ensurePaneCalls++;
    if (this.ensurePaneGate) {
      const g = this.ensurePaneGate;
      this.ensurePaneGate = null;
      await g;
    }
    if (id === 'w1:pNew') this.newPaneKnown = true; // the refresh brings it in
    return this.pane(id);
  }
  layoutFor(id: string) {
    const layout = this.currentSnapshot.layouts[0]!;
    const rect = layout.panes.find((p) => p.pane_id === id)?.rect;
    return rect ? { layout, rect } : undefined;
  }
  /** Make the next `ptySize` (used by `paneSize` during a watch) reject, standing in for herdr failing mid-watch. */
  ptySizeThrows = false;
  async ptySize(): Promise<{ rows: number; cols: number } | null> {
    if (this.ptySizeThrows) throw new HerdrError({ code: 'internal', message: 'pane gone' });
    return { rows: 40, cols: 59 };
  }
  async ttyOf(id: string): Promise<string | null> {
    return id === 'w1:gone' ? null : `/dev/pts/${id.replace(/\W/g, '')}`;
  }
}
/** stty stand-in: remembers the size per tty, starts every tty at 40x59 (rows cols). */
const ptySizes = new Map<string, string>();
const sttyWrites: string[] = [];
/** Make the next stty write fail (a pane whose shell just exited), then behave again. */
let sttyFailsNextWrite = false;
/** When set, the next stty *write* awaits this before applying — lets a test hold a `leave` inside `fitter.release`. */
let sttyGateNextWrite: Promise<void> | null = null;
/** A one-shot promise a test can resolve on demand, to gate an awaited step in the fakes. */
function deferred<T = void>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fakeStty(tty: string, args: string[]): Promise<string> {
  if (args[0] === 'size') return ptySizes.get(tty) ?? '40 59';
  if (sttyFailsNextWrite) {
    sttyFailsNextWrite = false;
    throw new Error('stty: Input/output error');
  }
  if (sttyGateNextWrite) {
    const g = sttyGateNextWrite;
    sttyGateNextWrite = null;
    await g;
  }
  ptySizes.set(tty, `${args[1]} ${args[3]}`);
  sttyWrites.push(`${tty} rows=${args[1]} cols=${args[3]}`);
  return '';
}

// ---- setup ------------------------------------------------------------------------------------

let dir: string;
let devices: DeviceStore;
let token: string;
let link: FakeLink;
let hub: Hub;
const config = defaultConfig();

/** Every session made by a test; disposed in `after` so no watch timer keeps the process alive once the tests are done. */
const sessions: Session[] = [];

function connect(): { ws: FakeWs; session: Session } {
  const ws = new FakeWs();
  const session = new Session(ws as never, { hub, devices, config, log: silentLogger, remoteIp: '100.64.0.9' });
  sessions.push(session);
  return { ws, session };
}

async function connectAuthed(mode: 'full' | 'action' = 'full'): Promise<{ ws: FakeWs; session: Session }> {
  const c = connect();
  c.ws.push({ t: 'hello', token, client: { platform: 'ios', app_version: 't', device_name: 'x' }, mode });
  await c.ws.waitFor((m) => m['t'] === 'welcome');
  return c;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-session-test-'));
  devices = new DeviceStore(path.join(dir, 'devices.json'), { log: silentLogger }).load();
  token = devices.issueToken({ name: 'Test phone', platform: 'ios' }).token;
  link = new FakeLink();
  const fitter = new PaneFitter({ ttyOf: (p) => link.ttyOf(p), stty: fakeStty, log: silentLogger });
  hub = new Hub({ link: link as never, log: silentLogger, hostName: 'testhost', version: '0.0.0-test', fitter });
});

after(() => {
  for (const session of sessions) session.dispose();
  devices.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- tests ------------------------------------------------------------------------------------

test('hello with a bad token → error auth and close 4401', async () => {
  const { ws } = connect();
  ws.push({ t: 'hello', token: 'nope', client: {}, mode: 'full' });
  const err = await ws.waitFor((m) => m['t'] === 'error');
  assert.equal(err['code'], 'auth');
  assert.equal(ws.closed?.code, 4401);
});

test('no hello in time → close 4408 without an error frame (a stall, not a rejected token)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ws } = connect();
    mock.timers.tick(HELLO_TIMEOUT_MS - 1);
    assert.equal(ws.closed?.code, undefined, 'still open just before the timer');
    mock.timers.tick(1);
    assert.equal(ws.closed?.code, HELLO_TIMEOUT_CLOSE_CODE);
    assert.deepEqual(ws.sent, [], 'no `error auth`: the apps would latch "unpaired"');
  } finally {
    mock.timers.reset();
  }
});

test('messages before hello are rejected', async () => {
  const { ws } = connect();
  ws.push({ t: 'watch', id: '1', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'error' && m['code'] === 'auth');
  assert.equal(ws.closed?.code, 4401);
});

test('hello full → welcome with protocol snapshot incl. prompt_id for the blocked pane', async () => {
  const { ws, session } = await connectAuthed();
  const welcome = ws.sent[0]!;
  assert.equal(welcome['protocol'], 1);
  assert.deepEqual(welcome['host'], { name: 'testhost', herdr_version: '0.8.0', herdr_protocol: 19, flow_version: '0.0.0-test' });
  const snap = welcome['snapshot'] as Record<string, unknown>;
  assert.deepEqual(snap['workspaces'], [{ id: 'w1', name: 'main' }]);
  assert.deepEqual(snap['tabs'], [{ id: 'w1:t1', workspace_id: 'w1', name: 'proj' }]);
  const panes = snap['panes'] as Record<string, unknown>[];
  assert.equal(panes.length, 2);
  assert.equal(panes[0]!['state_label'], 'Waiting for approval');
  assert.equal(panes[0]!['agent_status'], 'blocked');
  assert.equal(typeof panes[0]!['since'], 'number', 'the elapsed clock of a working/blocked pane');
  assert.equal(panes[1]!['since'], null, 'a plain shell has no clock');
  assert.equal(snap['focused_pane_id'], 'w1:pA');
  assert.deepEqual(welcome['notify_done'], [], 'nothing armed yet');
  assert.equal(hub.clientCount, 1);
  session.dispose();
  assert.equal(hub.clientCount, 0);
});

test('action mode gets no snapshot and is not a viewer', async () => {
  const { ws, session } = await connectAuthed('action');
  assert.equal(ws.sent[0]!['snapshot'], undefined);
  assert.equal(hub.clientCount, 0);
  session.dispose();
});

test('watch → ok with size, then a full frame; identical screens send nothing; changes send partial frames', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  const ok = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  assert.deepEqual([ok['cols'], ok['rows']], [59, 40]);
  const frame = await ws.waitFor((m) => m['t'] === 'frame');
  assert.equal(frame['full'], true);
  assert.equal(frame['rows'], 40);
  const lines = frame['lines'] as { y: number; runs: { t: string; s: number }[] }[];
  assert.equal(lines.length, 40);
  assert.equal(lines[0]!.runs[0]!.t, 'hello');
  assert.equal(lines[1]!.runs[0]!.t, 'line two');
  assert.ok((frame['styles'] as Record<string, unknown>)['1'], 'bold style reported once');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(ws.sent.filter((m) => m['t'] === 'frame').length, 1, 'no frames while the screen is unchanged');
  link.screen = '\x1b[0m\x1b[1mhello\x1b[0m world\r\nline two changed';
  const partial = await ws.waitFor((m) => m['t'] === 'frame' && m['full'] === false);
  const changed = partial['lines'] as { y: number }[];
  assert.deepEqual(changed.map((l) => l.y), [1]);
  assert.deepEqual(partial['styles'], {}, 'no new styles in the partial frame');
  ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
  session.dispose();
  link.screen = '\x1b[0m\x1b[1mhello\x1b[0m world\r\nline two';
});

test('frames carry alt: false at a shell prompt (even a fresh one) and alt: true once an alternate-screen program runs', async () => {
  const { ws, session } = await connectAuthed();
  paneScrollback = 0; // fresh shell: nothing above the screen yet, but no program either
  fgProgram = null;
  try {
    ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
    const first = await ws.waitFor((m) => m['t'] === 'frame' && 'alt' in m);
    assert.equal(first['alt'], false);
    fgProgram = 'claude';
    await new Promise((r) => setTimeout(r, 1050)); // probes are throttled to one per second
    link.screen = '\x1b[0m\x1b[1mhello\x1b[0m world\r\nclaude drew this';
    const on = await ws.waitFor((m) => m['t'] === 'frame' && m['alt'] === true);
    assert.equal(on['alt'], true);
    ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pA' });
    await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
  } finally {
    paneScrollback = 120;
    fgProgram = null;
    link.screen = '\x1b[0m\x1b[1mhello\x1b[0m world\r\nline two';
  }
  session.dispose();
});

test('watch then unwatch sent back to back are handled in order: the socket ends watching nothing', async () => {
  // Handlers used to run concurrently, and `startWatch` awaits herdr before it takes the watch, so an `unwatch` could
  // overtake the `watch` it meant to undo: a phone leaving a pane right after (re)watching it was left with a watch
  // nobody looked at. `watch` / `unwatch` now run in arrival order.
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
  assert.deepEqual(ws.sent.filter((m) => m['t'] === 'ok').map((m) => m['id']), ['w', 'u'], 'replies in request order');
  assert.equal((session as unknown as { watch: unknown }).watch, null, 'the later unwatch wins');
  const readsOfA = () => link.calls.filter((c) => c.method === 'pane.read' && c.params['pane_id'] === 'w1:pA').length;
  const before = readsOfA();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(readsOfA(), before, "the abandoned watcher's polling stopped");
});

test('two watches sent back to back are handled in order: the last pane is the one watched', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'a', pane: 'w1:pA' });
  ws.push({ t: 'watch', id: 'b', pane: 'w1:pB' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'b');
  assert.deepEqual(ws.sent.filter((m) => m['t'] === 'ok').map((m) => m['id']), ['a', 'b'], 'replies in request order');
  assert.equal((session as unknown as { watch: { pane: string } | null }).watch?.pane, 'w1:pB');
  ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pB' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
});

test('unwatch names the pane: a stale unwatch of a pane no longer watched is refused, the current watch survives', async () => {
  // A switch A→B leaves an unwatch(A) crossing on the wire; it must not stop the newer B watch (protocol §4).
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'a', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'a');
  ws.push({ t: 'watch', id: 'b', pane: 'w1:pB' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'b');
  ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pA' });
  const reply = await ws.waitFor((m) => m['id'] === 'u');
  assert.equal(reply['t'], 'error');
  assert.equal(reply['code'], 'not_watching');
  assert.equal((session as unknown as { watch: { pane: string } | null }).watch?.pane, 'w1:pB', 'the current watch is untouched');
  session.dispose(); // stop pB's watcher so its polling does not bleed into later tests
  await new Promise((r) => setTimeout(r, 20));
});

test('watch of an unknown pane → error unknown_pane', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:zz' });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'w');
  assert.equal(err['code'], 'unknown_pane');
  session.dispose();
});

test('history asks herdr for lines+1 and reports has_more', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  ws.push({ t: 'history', id: 'h', pane: 'w1:pA', lines: 2, unwrapped: true });
  const h = await ws.waitFor((m) => m['t'] === 'history');
  const call = link.calls.find((c) => c.method === 'pane.read')!;
  assert.equal(call.params['source'], 'recent_unwrapped');
  assert.equal(call.params['lines'], 3);
  assert.equal(h['id'], 'h');
  assert.equal(h['has_more'], true);
  assert.equal(h['scrollback'], 120);
  assert.equal((h['lines'] as unknown[]).length, 2);
  session.dispose();
});

test('history: a pane herdr holds no scrollback for (alternate screen / fresh shell) reports scrollback 0 and has_more false', async () => {
  const { ws, session } = await connectAuthed();
  paneScrollback = 0;
  try {
    ws.push({ t: 'history', id: 'h0', pane: 'w1:pA', lines: 2 });
    const h = await ws.waitFor((m) => m['t'] === 'history');
    assert.equal(h['scrollback'], 0);
    assert.equal(h['has_more'], false); // even though herdr returned the full count (the screen itself)
    assert.equal((h['lines'] as unknown[]).length, 2);
  } finally {
    paneScrollback = 120;
  }
  session.dispose();
});

test('history: without scroll info from herdr the reply omits scrollback and has_more falls back to the count', async () => {
  const { ws, session } = await connectAuthed();
  paneScrollback = null;
  try {
    ws.push({ t: 'history', id: 'h1', pane: 'w1:pA', lines: 2 });
    const h = await ws.waitFor((m) => m['t'] === 'history');
    assert.equal('scrollback' in h, false);
    assert.equal(h['has_more'], true);
  } finally {
    paneScrollback = 120;
  }
  session.dispose();
});

test('keys: herdr-native keys pass through, navigation keys become raw escapes, unknown keys are rejected', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  ws.push({ t: 'keys', id: 'k', pane: 'w1:pA', keys: ['ctrl+c', 'home', 'enter'] });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'k');
  assert.deepEqual(
    link.calls.map((c) => [c.method, c.params['keys'] ?? c.params['text']]),
    [
      ['pane.send_keys', ['ctrl+c']],
      ['pane.send_text', '\x1b[H'],
      ['pane.send_keys', ['enter']],
    ],
  );
  ws.push({ t: 'keys', id: 'k2', pane: 'w1:pA', keys: ['nope'] });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'k2');
  assert.equal(err['code'], 'invalid_key');
  // Object.prototype members are not key names either (`'constructor' in RAW_KEYS` is true; its "escape" is a function).
  const sends = () => link.calls.filter((c) => c.method.startsWith('pane.send')).length;
  const before = sends();
  for (const [i, key] of ['constructor', '__proto__', 'hasOwnProperty', 'toString'].entries()) {
    ws.push({ t: 'keys', id: `p${i}`, pane: 'w1:pA', keys: ['enter', key] });
    const e = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === `p${i}`);
    assert.equal(e['code'], 'invalid_key', key);
  }
  assert.equal(sends(), before, 'nothing reaches herdr when one key of the batch is invalid');
  session.dispose();
});

test('pane.create: new background tab, command typed once the shell has drawn its prompt, ok carries the pane id', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  ws.push({ t: 'pane.create', id: 'c1', label: '  build ', command: 'npm test\n' });
  const ok = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'c1');
  assert.equal(ok['pane'], 'w1:pNew');
  assert.equal(ok['tab'], 't9');
  assert.deepEqual(
    link.calls.map((c) => [c.method, c.params]),
    [
      ['tab.create', { focus: false, label: 'build' }],
      ['pane.read', { pane_id: 'w1:pNew', source: 'visible', format: 'text' }],
      ['pane.send_text', { pane_id: 'w1:pNew', text: 'npm test' }],
      ['pane.send_keys', { pane_id: 'w1:pNew', keys: ['enter'] }],
    ],
  );
  // No command: just the tab.
  link.calls = [];
  ws.push({ t: 'pane.create', id: 'c2' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'c2');
  assert.deepEqual(link.calls.map((c) => c.method), ['tab.create']);
  // Shell slow to start: the bridge polls the screen until something is drawn.
  link.calls = [];
  link.newPaneScreens = ['', '', '', '% '];
  ws.push({ t: 'pane.create', id: 'c3', command: 'claude' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'c3');
  assert.equal(link.calls.filter((c) => c.method === 'pane.read').length, 4);
  assert.equal(link.calls.at(-2)!.params['text'], 'claude');
  link.newPaneScreens = ['$ '];
  ws.push({ t: 'pane.create', id: 'c4', command: 'x'.repeat(5000) });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'c4');
  assert.equal(err['code'], 'bad_request');
  session.dispose();
});

test('a request without its pane is answered bad_request and the session lives on', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'nopane' });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'nopane');
  assert.equal(err['code'], 'bad_request');
  ws.push({ t: 'keys', id: 'nopane2', keys: ['enter'] });
  assert.equal((await ws.waitFor((m) => m['id'] === 'nopane2'))['code'], 'bad_request');
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  assert.equal((await ws.waitFor((m) => m['id'] === 'w'))['t'], 'ok');
  session.dispose();
});

test('pane.close: herdr pane.close after this connection\'s watch on it ends; unknown pane and missing pane are refused', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pB' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  await ws.waitFor((m) => m['t'] === 'frame' && m['pane'] === 'w1:pB');
  link.calls = [];
  ws.push({ t: 'pane.close', id: 'x1', pane: 'w1:pB' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'x1');
  const closeIdx = link.calls.findIndex((c) => c.method === 'pane.close');
  assert.deepEqual(link.calls[closeIdx]!.params, { pane_id: 'w1:pB' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(link.calls.slice(closeIdx + 1).filter((c) => c.method === 'pane.read').length, 0, 'the watcher stopped before herdr was asked');
  assert.equal(ws.sent.filter((m) => m['t'] === 'error').length, 0, 'the closing phone gets no unknown_pane from its own watcher');
  ws.push({ t: 'pane.close', id: 'x2', pane: 'w1:nope' });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'x2');
  assert.equal(err['code'], 'unknown_pane');
  ws.push({ t: 'pane.close', id: 'x3' });
  const bad = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'x3');
  assert.equal(bad['code'], 'bad_request');
  session.dispose();
});

test('watching a pane created a moment ago succeeds: the bridge refreshes its snapshot instead of answering unknown_pane', async () => {
  const { ws, session } = await connectAuthed();
  link.newPaneKnown = false;
  try {
    ws.push({ t: 'pane.create', id: 'c1' });
    const created = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'c1');
    assert.equal(created['pane'], 'w1:pNew');
    assert.equal(link.newPaneKnown, true, 'pane.create waited for the pane to be in the snapshot before replying');
    link.newPaneKnown = false; // a phone that raced ahead of the refresh still gets its watch
    ws.push({ t: 'watch', id: 'w', pane: 'w1:pNew' });
    const ok = await ws.waitFor((m) => (m['t'] === 'ok' || m['t'] === 'error') && m['id'] === 'w');
    assert.equal(ok['t'], 'ok');
    assert.deepEqual([ok['cols'], ok['rows']], [59, 40]);
    const frame = await ws.waitFor((m) => m['t'] === 'frame' && m['pane'] === 'w1:pNew');
    assert.equal(frame['full'], true);
    ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pNew' });
    await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
  } finally {
    link.newPaneKnown = false;
  }
  session.dispose();
});

test('scroll: wheel mode sends SGR wheel reports at the touch cell, arrows mode sends arrow keys, bad input is rejected', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  ws.push({ t: 'scroll', id: 's1', pane: 'w1:pA', direction: 'up', lines: 3, col: 12, row: 7 });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 's1');
  assert.deepEqual(link.calls, [{ method: 'pane.send_text', params: { pane_id: 'w1:pA', text: '\x1b[<64;12;7M'.repeat(3) } }]);
  link.calls = [];
  ws.push({ t: 'scroll', id: 's2', pane: 'w1:pA', direction: 'down' }); // defaults: 1 line at 1;1
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 's2');
  assert.deepEqual(link.calls, [{ method: 'pane.send_text', params: { pane_id: 'w1:pA', text: '\x1b[<65;1;1M' } }]);
  link.calls = [];
  ws.push({ t: 'scroll', id: 's3', pane: 'w1:pA', direction: 'down', lines: 2, mode: 'arrows' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 's3');
  assert.deepEqual(link.calls, [{ method: 'pane.send_keys', params: { pane_id: 'w1:pA', keys: ['down', 'down'] } }]);
  link.calls = [];
  ws.push({ t: 'scroll', id: 's4', pane: 'w1:pA', direction: 'up', lines: 500 }); // clamped to 50
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 's4');
  assert.equal((link.calls[0]!.params['text'] as string).length, '\x1b[<64;1;1M'.length * 50);
  link.calls = [];
  ws.push({ t: 'scroll', id: 's5', pane: 'w1:pA', direction: 'left' });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 's5');
  assert.equal(err['code'], 'bad_request');
  assert.equal(link.calls.length, 0);
  session.dispose();
});

test('prompt uses agent.prompt for agent panes and send_text+enter for shells', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  ws.push({ t: 'prompt', id: 'p1', pane: 'w1:pA', text: 'fix it\nplease' });
  const ok1 = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'p1');
  assert.equal(ok1['via'], 'agent.prompt');
  assert.deepEqual(link.calls[0], { method: 'agent.prompt', params: { target: 'w1:pA', text: 'fix it\nplease' } });
  link.calls = [];
  ws.push({ t: 'prompt', id: 'p2', pane: 'w1:pB', text: 'ls' });
  const ok2 = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'p2');
  assert.equal(ok2['via'], 'send_text');
  assert.deepEqual(
    link.calls.map((c) => c.method),
    ['pane.send_text', 'pane.send_keys'],
  );
  session.dispose();
});

test('approve → ok immediately, then approval.result sent with status_after', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  link.screen = 'Do you want to proceed?\n ❯ 1. Yes';
  ws.push({ t: 'approve', id: 'a', pane: 'w1:pA', prompt_id: 'w1:pA@47', action: 'approve' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'a');
  const result = await ws.waitFor((m) => m['t'] === 'approval.result', 4000);
  assert.equal(result['outcome'], 'sent');
  assert.equal(result['prompt_id'], 'w1:pA@47');
  assert.deepEqual(link.calls.filter((c) => c.method === 'pane.send_keys').map((c) => c.params['keys']), [['1']]);
  session.dispose();
});

test('approve with a stale prompt id → approval.result stale, nothing sent', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  ws.push({ t: 'approve', id: 'a', pane: 'w1:pA', prompt_id: 'w1:pA@1', action: 'deny' });
  const result = await ws.waitFor((m) => m['t'] === 'approval.result');
  assert.equal(result['outcome'], 'stale');
  assert.equal(link.calls.filter((c) => c.method.startsWith('pane.send')).length, 0);
  session.dispose();
});

test('choose → ok, then Enter on the already-marked option; a changed label sends nothing; bad arguments are rejected', async () => {
  const { ws, session } = await connectAuthed();
  link.calls = [];
  link.screen = 'Which database should the service use?\n ❯ 1. Postgres\n   2. SQLite\n   3. Other';
  ws.push({ t: 'choose', id: 'c0', pane: 'w1:pA', prompt_id: 'w1:pA@47', option: 0, label: 'Postgres' });
  assert.equal((await ws.waitFor((m) => m['id'] === 'c0'))['code'], 'bad_request');
  ws.push({ t: 'choose', id: 'c1', pane: 'w1:pA', prompt_id: 'w1:pA@47', option: 2, label: 'Postgres' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'c1');
  const changed = await ws.waitFor((m) => m['t'] === 'approval.result', 4000);
  assert.equal(changed['outcome'], 'dialog_changed', 'option 2 reads SQLite, not Postgres');
  assert.equal(link.calls.filter((c) => c.method === 'pane.send_keys').length, 0);
  ws.push({ t: 'choose', id: 'c2', pane: 'w1:pA', prompt_id: 'w1:pA@47', option: 1, label: 'Postgres' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'c2');
  const sent = await ws.waitFor((m) => m['t'] === 'approval.result' && m['outcome'] !== 'dialog_changed', 4000);
  assert.equal(sent['outcome'], 'sent');
  assert.equal(sent['prompt_id'], 'w1:pA@47');
  assert.deepEqual(link.calls.filter((c) => c.method === 'pane.send_keys').map((c) => c.params['keys']), [['enter']]);
  session.dispose();
});

test('zoom → ok with zoomed flag; viewing is recorded; push.register stores the token', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'zoom', id: 'z', pane: 'w1:pA', mode: 'on' });
  const ok = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'z');
  assert.equal(ok['zoomed'], true);
  ws.push({ t: 'viewing', pane: 'w1:pA' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(session.viewing, 'w1:pA');
  assert.equal(hub.isViewed('w1:pA'), true);
  ws.push({ t: 'push.register', id: 'r', platform: 'ios', token: 'abc123', env: 'sandbox' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'r');
  assert.deepEqual(devices.list()[0]!.push, { platform: 'ios', token: 'abc123', env: 'sandbox' });
  ws.push({ t: 'push.unregister', id: 'ur' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'ur');
  assert.equal(devices.list()[0]!.push, undefined);
  session.dispose();
});

test('notify arms and disarms the done alert per device; prompt {notify:true} arms it; welcome lists armed panes', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'notify', id: 'n1', pane: 'w1:pA', done: true });
  const ok = await ws.waitFor((m) => m['id'] === 'n1');
  assert.equal(ok['t'], 'ok');
  assert.equal(ok['done'], true);
  assert.deepEqual(devices.list()[0]!.notify_done, ['w1:pA']);
  ws.push({ t: 'notify', id: 'n2', pane: 'w1:nope', done: true });
  assert.equal((await ws.waitFor((m) => m['id'] === 'n2'))['code'], 'unknown_pane');
  ws.push({ t: 'notify', id: 'n3', pane: 'w1:pA' });
  assert.equal((await ws.waitFor((m) => m['id'] === 'n3'))['code'], 'bad_request');
  ws.push({ t: 'prompt', id: 'p', pane: 'w1:pB', text: 'ls', notify: true });
  await ws.waitFor((m) => m['id'] === 'p' && m['t'] === 'ok');
  assert.deepEqual(new Set(devices.list()[0]!.notify_done), new Set(['w1:pA', 'w1:pB']));
  const second = await connectAuthed();
  assert.deepEqual(new Set(second.ws.sent[0]!['notify_done'] as string[]), new Set(['w1:pA', 'w1:pB']));
  second.session.dispose();
  ws.push({ t: 'notify', id: 'n4', pane: 'w1:pA', done: false });
  await ws.waitFor((m) => m['id'] === 'n4');
  ws.push({ t: 'notify', id: 'n5', pane: 'w1:pB', done: false });
  await ws.waitFor((m) => m['id'] === 'n5');
  assert.equal(devices.list()[0]!.notify_done, undefined);
  session.dispose();
});

test('activity.register: iOS start and per-pane tokens survive a push.register refresh; Android opts its FCM token in; unregister forgets', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'activity.register', id: 'a0', token: 'start-tok' });
  assert.equal((await ws.waitFor((m) => m['id'] === 'a0'))['code'], 'bad_request', 'needs a push registration first');
  ws.push({ t: 'push.register', id: 'r', platform: 'ios', token: 'abc123', env: 'sandbox' });
  await ws.waitFor((m) => m['id'] === 'r');
  ws.push({ t: 'activity.register', id: 'a1', token: 'start-tok' });
  await ws.waitFor((m) => m['id'] === 'a1' && m['t'] === 'ok');
  ws.push({ t: 'activity.register', id: 'a2', pane: 'w1:pA', token: 'upd-tok' });
  await ws.waitFor((m) => m['id'] === 'a2' && m['t'] === 'ok');
  assert.deepEqual(devices.list()[0]!.push, { platform: 'ios', token: 'abc123', env: 'sandbox', activity: true, la_start: 'start-tok', la_panes: { 'w1:pA': 'upd-tok' } });
  ws.push({ t: 'push.register', id: 'r2', platform: 'ios', token: 'newtoken', env: 'sandbox' });
  await ws.waitFor((m) => m['id'] === 'r2');
  assert.equal(devices.list()[0]!.push?.token, 'newtoken');
  assert.equal(devices.list()[0]!.push?.la_start, 'start-tok');
  assert.deepEqual(devices.list()[0]!.push?.la_panes, { 'w1:pA': 'upd-tok' });
  ws.push({ t: 'activity.unregister', id: 'u1', pane: 'w1:pA' });
  await ws.waitFor((m) => m['id'] === 'u1');
  assert.equal(devices.list()[0]!.push?.la_panes, undefined);
  ws.push({ t: 'activity.register', id: 'a3' });
  assert.equal((await ws.waitFor((m) => m['id'] === 'a3'))['code'], 'bad_request', 'iOS must send a token');
  ws.push({ t: 'activity.unregister', id: 'u2' });
  await ws.waitFor((m) => m['id'] === 'u2');
  assert.deepEqual(devices.list()[0]!.push, { platform: 'ios', token: 'newtoken', env: 'sandbox', activity: false });
  ws.push({ t: 'push.unregister', id: 'ur' });
  await ws.waitFor((m) => m['id'] === 'ur');
  session.dispose();

  const android = devices.issueToken({ name: 'Pixel', platform: 'android' });
  const c = connect();
  c.ws.push({ t: 'hello', token: android.token, client: { platform: 'android', app_version: 't', device_name: 'x' }, mode: 'full' });
  await c.ws.waitFor((m) => m['t'] === 'welcome');
  c.ws.push({ t: 'push.register', id: 'r', platform: 'android', token: 'fcm-tok' });
  await c.ws.waitFor((m) => m['id'] === 'r');
  c.ws.push({ t: 'activity.register', id: 'a' });
  await c.ws.waitFor((m) => m['id'] === 'a' && m['t'] === 'ok');
  assert.deepEqual(devices.get(android.device.id)?.push, { platform: 'android', token: 'fcm-tok', env: 'production', activity: true });
  c.session.dispose();
  devices.revoke(android.device.id);
});

test('hub broadcasts pane.status with prompt_id, the parsed approval dialog and herdr state to full-mode sessions', async () => {
  const { ws, session } = await connectAuthed();
  const plainScreen = link.screen;
  link.screen = fs.readFileSync(path.join(import.meta.dirname, '../../../shared/fixtures/reads/claude-permission-prompt.txt'), 'utf8');
  link.emit('pane.status', { pane_id: 'w1:pA', agent_status: 'blocked', agent: 'claude', display_agent: 'Claude', title: 'Fixing tests' });
  const status = await ws.waitFor((m) => m['t'] === 'pane.status');
  assert.equal(status['prompt_id'], 'w1:pA@47');
  assert.equal(status['state_label'], 'Waiting for approval');
  assert.equal(typeof status['since'], 'number');
  const approval = status['approval'] as Record<string, unknown>;
  assert.equal(approval['tool'], 'Bash');
  assert.equal(approval['command'], 'touch /tmp/flow-capture-marker-claude.txt');
  assert.equal(approval['question'], 'Do you want to proceed?');
  assert.deepEqual(hub.paneState('w1:pA')?.approval, approval);
  const fresh = await connectAuthed();
  const panes = (fresh.ws.sent[0]!['snapshot'] as { panes: Record<string, unknown>[] }).panes;
  assert.deepEqual(panes.find((p) => p['id'] === 'w1:pA')!['approval'], approval, 'the snapshot carries it too');
  fresh.session.dispose();
  link.screen = plainScreen;
  assert.equal(ws.sent.find((m) => m['t'] === 'herdr')?.['state'], 'up', 'current herdr state is sent right after welcome');
  link.emit('state', 'down');
  const down = await ws.waitFor((m) => m['t'] === 'herdr' && m['state'] === 'down');
  assert.equal(down['state'], 'down');
  link.emit('state', 'up');
  session.dispose();
});

test('malformed messages → bad_request / unsupported without closing', async () => {
  const { ws, session } = await connectAuthed();
  ws.emit('message', Buffer.from('{not json'), false);
  await ws.waitFor((m) => m['t'] === 'error' && m['code'] === 'bad_request');
  ws.push({ t: 'dance', id: 'd' });
  const err = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'd');
  assert.equal(err['code'], 'unsupported');
  ws.push({ t: 'keys', id: 'k', keys: ['enter'] });
  const err2 = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'k');
  assert.equal(err2['code'], 'bad_request', 'a missing pane is a malformed request, not a herdr failure');
  // Names inherited from Object.prototype are not message types (a `constructor` lookup on the handler table
  // would call `Object(id, m)`, which returns a non-promise, and the `.catch` on it would crash the bridge).
  for (const [i, t] of ['constructor', 'toString', 'hasOwnProperty', '__proto__'].entries()) {
    ws.push({ t, id: `p${i}` });
    const e = await ws.waitFor((m) => m['t'] === 'error' && m['id'] === `p${i}`);
    assert.equal(e['code'], 'unsupported', `${t} is unsupported, not a handler`);
  }
  assert.equal(ws.closed, null);
  session.dispose();
});

// ---- fit ----------------------------------------------------------------------------------------

test('fit resizes the watched pane\'s PTY, the next frame carries the new grid, and unwatch restores it', async () => {
  const { ws } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  await ws.waitFor((m) => m['t'] === 'frame');
  sttyWrites.length = 0;
  ws.push({ t: 'fit', id: 'f', pane: 'w1:pA', cols: 60, rows: 30 });
  const ok = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'f');
  assert.equal(ok['cols'], 60);
  assert.equal(ok['rows'], 40, "herdr's row count is kept");
  assert.deepEqual(sttyWrites, ['/dev/pts/w1pA rows=40 cols=60'], "the phone's columns, herdr's rows");
  const frame = await ws.waitFor((m) => m['t'] === 'frame' && m['cols'] === 60);
  assert.equal(frame['full'], true);
  assert.equal(frame['rows'], 40);
  ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
  for (let i = 0; i < 50 && sttyWrites.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sttyWrites.at(-1), '/dev/pts/w1pA rows=40 cols=59', 'herdr\'s size is back');
});

test('fit validation: bad sizes, unknown pane, no tty', async () => {
  const { ws } = await connectAuthed();
  ws.push({ t: 'fit', id: '1', pane: 'w1:pA', cols: 5, rows: 30 });
  assert.equal((await ws.waitFor((m) => m['id'] === '1'))['code'], 'bad_request');
  ws.push({ t: 'fit', id: '2', pane: 'w1:nope', cols: 60, rows: 30 });
  assert.equal((await ws.waitFor((m) => m['id'] === '2'))['code'], 'unknown_pane');
  link.currentSnapshot = { ...snapshot, panes: [...snapshot.panes, { ...shell, pane_id: 'w1:gone' }] };
  ws.push({ t: 'fit', id: '3', pane: 'w1:gone', cols: 60, rows: 30 });
  assert.equal((await ws.waitFor((m) => m['id'] === '3'))['code'], 'fit_unavailable');
  link.currentSnapshot = snapshot;
});

test('closing the socket and looking away both give the pane back', async () => {
  const a = await connectAuthed();
  a.ws.push({ t: 'fit', id: 'f', pane: 'w1:pB', cols: 60, rows: 30 });
  await a.ws.waitFor((m) => m['id'] === 'f' && m['t'] === 'ok');
  assert.equal(hub.fitter.active('w1:pB')?.cols, 60);
  a.ws.push({ t: 'viewing', pane: 'w1:pA' });
  for (let i = 0; i < 50 && hub.fitter.active('w1:pB'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(hub.fitter.active('w1:pB'), null, 'viewing another pane released the fit');
  a.ws.push({ t: 'fit', id: 'g', pane: 'w1:pB', cols: 60, rows: 30 });
  await a.ws.waitFor((m) => m['id'] === 'g' && m['t'] === 'ok');
  a.ws.close(1000, 'bye');
  for (let i = 0; i < 50 && hub.fitter.active('w1:pB'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(hub.fitter.active('w1:pB'), null, 'socket close released the fit');
});

// ---- zoom while viewing ------------------------------------------------------------------------------

test('a fit still in flight when the socket closes does not outlive the session', async () => {
  // `fit` awaits herdr before it takes the lease; `dispose()` releases what the session owns at that moment, so a fit
  // landing after it would resize the desktop pane for nobody, until another device fits it.
  const tty = '/dev/pts/w1pA';
  for (const microtasks of [0, 2, 4]) {
    const { ws } = await connectAuthed();
    ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
    await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
    ws.push({ t: 'fit', id: 'f', pane: 'w1:pA', cols: 60, rows: 30 });
    for (let i = 0; i < microtasks; i++) await Promise.resolve();
    ws.close(1000, 'gone');
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual(ptySizes.get(tty), '40 60', `fit closed after ${microtasks} microtasks left the pane at the phone's width`);
  }
});

test('a fit whose stty write fails after the socket closed leaves no lease behind', async () => {
  // The fitter records the owner before it writes; a write that fails after `dispose()` used to leave a ghost fit
  // that the next viewer's release would then "restore".
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  sttyFailsNextWrite = true;
  try {
    ws.push({ t: 'fit', id: 'f', pane: 'w1:pA', cols: 61, rows: 30 });
    ws.close(1000, 'gone');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(hub.fitter.panesOf(session), [], 'the dead session owns no fit');
    assert.equal(hub.fitter.active('w1:pA'), null, 'nothing is imposed on the pane');
  } finally {
    sttyFailsNextWrite = false;
  }
});

test('disposal drops the backlog of queued watch/fit turns instead of running each against herdr', async () => {
  // The watch/fit queue is unbounded; once the socket is gone, queued turns must not each go on to spend herdr time
  // (ensurePane, watch setup) and keep the dead session working through an arbitrarily long backlog.
  const { ws, session } = await connectAuthed();
  const gate = deferred();
  link.ensurePaneGate = gate.promise; // hold the first fit at ensurePane, so the rest queue behind it
  ws.push({ t: 'fit', id: 'f1', pane: 'w1:pA', cols: 100, rows: 30 });
  await new Promise((r) => setTimeout(r, 20));
  ws.push({ t: 'fit', id: 'f2', pane: 'w1:pA', cols: 101, rows: 30 }); // queued behind f1
  ws.push({ t: 'fit', id: 'f3', pane: 'w1:pA', cols: 102, rows: 30 }); // queued behind f2
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pB' }); // queued too
  await new Promise((r) => setTimeout(r, 20));
  ws.close(1000, 'gone'); // dispose: the queued turns must now be skipped
  const callsAtClose = link.ensurePaneCalls; // f1 already reached ensurePane before the close
  gate.release(); // let f1 unwind; f2/f3/w must not run their bodies
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(link.ensurePaneCalls, callsAtClose, 'no queued turn reached ensurePane after disposal');
});

test('a fit and a release keep arrival order: a release is not overtaken by an earlier fit', async () => {
  // A sizing fit yields at `ensurePane`; a later `release` must not reach the fitter first and let the fit then resume
  // and re-impose the phone width on a pane the user stopped fitting. Both must run in arrival order.
  const tty = '/dev/pts/w1pA';
  ptySizes.set(tty, '40 59');
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  ws.push({ t: 'fit', id: 'f0', pane: 'w1:pA', cols: 100, rows: 30 }); // an initial fit is in force
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'f0');
  assert.ok(hub.fitter.active('w1:pA'), 'fitted to start');
  const gate = deferred();
  link.ensurePaneGate = gate.promise; // hold the next sizing fit at ensurePane
  ws.push({ t: 'fit', id: 'f1', pane: 'w1:pA', cols: 120, rows: 30 }); // a re-fit that yields at ensurePane
  await new Promise((r) => setTimeout(r, 20));
  ws.push({ t: 'fit', id: 'f2', pane: 'w1:pA', release: true }); // the user leaves the pane: release the fit
  await new Promise((r) => setTimeout(r, 20));
  gate.release(); // let the stalled re-fit proceed
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'f1');
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'f2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hub.fitter.active('w1:pA'), null, 'the release won: the pane is back at herdr size, not the re-fit width');
  assert.deepEqual(hub.fitter.panesOf(session), [], 'the session holds no fit');
  session.dispose();
  await new Promise((r) => setTimeout(r, 20));
});

test('turning zoom off while watching the same pane restores the split', async () => {
  // The phone re-watches the pane with zoom:false when the setting is toggled off; the bridge must drop the lease it
  // holds, or leaving/reconnecting would never restore the split.
  link.zoomedPanes.clear();
  const { ws } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  assert.ok(hub.zoomer.owns('w1:pA'));
  link.calls.length = 0;
  ws.push({ t: 'watch', id: 'w2', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w2');
  assert.equal(hub.zoomer.owns('w1:pA'), false, 'the phone released its zoom');
  assert.deepEqual(link.calls.filter((c) => c.method === 'pane.zoom').map((c) => c.params), [{ pane_id: 'w1:pA', mode: 'off' }]);
  assert.equal(link.zoomedPanes.has('w1:pA'), false, 'the split is back');
});

test('a watch whose paneSize lookup fails after the zoom was taken leaves no zoom lease', async () => {
  link.zoomedPanes.clear();
  const { ws } = await connectAuthed();
  link.ptySizeThrows = true;
  try {
    ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
    await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'w');
    assert.equal(hub.zoomer.owns('w1:pA'), false, 'the failed watch released its zoom');
    assert.equal(link.zoomedPanes.has('w1:pA'), false, 'the split is back');
  } finally {
    link.ptySizeThrows = false;
  }
});

test('a same-pane re-watch that fails leaves the existing watch in place', async () => {
  // Re-watching the pane already watched (e.g. a zoom toggle) tears the current watcher down only once the new size
  // is in hand; a failure before that must not leave the socket watching nothing.
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  link.ptySizeThrows = true;
  try {
    ws.push({ t: 'watch', id: 'w2', pane: 'w1:pA', zoom: true });
    await ws.waitFor((m) => m['t'] === 'error' && m['id'] === 'w2');
    assert.equal((session as unknown as { watch: { pane: string } | null }).watch?.pane, 'w1:pA', 'the original watch survived');
  } finally {
    link.ptySizeThrows = false;
  }
  session.dispose(); // the failed zoom is still held by the live watch; drop it so it does not leak into the next test
  await new Promise((r) => setTimeout(r, 30));
});

test('switching A → B → A keeps the pane it ends on zoomed (the abandoned leave cannot drop it)', async () => {
  link.zoomedPanes.clear();
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: '1', pane: 'w1:pA', zoom: true });
  await ws.waitFor((m) => m['id'] === '1' && m['t'] === 'ok');
  ws.push({ t: 'watch', id: '2', pane: 'w1:pB', zoom: true });
  await ws.waitFor((m) => m['id'] === '2' && m['t'] === 'ok');
  ws.push({ t: 'watch', id: '3', pane: 'w1:pA', zoom: true });
  await ws.waitFor((m) => m['id'] === '3' && m['t'] === 'ok');
  await new Promise((r) => setTimeout(r, 40)); // let any deferred cleanup run
  assert.ok(hub.zoomer.owns('w1:pA'), 'the pane we ended on is still zoomed by us');
  assert.equal(link.zoomedPanes.has('w1:pA'), true, 'A is zoomed on the desktop');
  assert.equal(hub.zoomer.owns('w1:pB'), false, 'B was released when we left it');
  session.dispose();
  await new Promise((r) => setTimeout(r, 30));
});

test('a stale viewing-cleanup leave cannot unzoom a pane a concurrent re-watch just re-took', async () => {
  // The `viewing` cleanup releases the panes this session fitted/zoomed. It must run through the same per-session queue
  // as watch/unwatch: otherwise, while it is suspended in `fitter.release`, a re-watch of the same pane can re-acquire
  // the zoom, and the cleanup's later `zoomer.release` then drops that fresh lease — a pane still being viewed ends up
  // unzoomed.
  link.zoomedPanes.clear();
  ptySizes.set('/dev/pts/w1pA', '40 59'); // deterministic native size so the fit and its restore both write stty
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  ws.push({ t: 'fit', id: 'f', pane: 'w1:pA', cols: 100, rows: 30 });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'f');
  assert.ok(hub.zoomer.owns('w1:pA'), 'the pane is zoomed by us to start');
  const gate = deferred();
  sttyGateNextWrite = gate.promise; // hold the fit-restore stty write inside the leave, before the zoom is released
  ws.push({ t: 'viewing', pane: null }); // start leaving A: release the fit (now gated), then it would release the zoom
  await new Promise((r) => setTimeout(r, 20)); // let the leave reach the gated stty write
  ws.push({ t: 'watch', id: 'w2', pane: 'w1:pA', zoom: true }); // re-watch the same pane while the leave is mid-flight
  await new Promise((r) => setTimeout(r, 20));
  gate.release(); // let the stalled leave finish (its zoom release would now fire)
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w2');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(hub.zoomer.owns('w1:pA'), 'the re-watch kept the pane zoomed; the stale leave did not drop its lease');
  assert.equal(link.zoomedPanes.has('w1:pA'), true, 'A is still zoomed on the desktop');
  session.dispose();
  await new Promise((r) => setTimeout(r, 30));
});

test("a pane.close's own watch tear-down runs in the watch queue: it cannot clobber a concurrent re-watch", async () => {
  // `pane.close` drops this connection's own watch first. That leave/stopWatch must run through the same per-session
  // queue as watch/unwatch, not inline: otherwise, while it is suspended in `fitter.release`, a re-watch of the pane
  // re-takes the zoom and installs a fresh watcher, and the close's later `zoomer.release` + unconditional
  // `stopWatch()` then drop that fresh lease and stop the new watcher — a pane the user is watching ends up unzoomed
  // and unwatched.
  link.zoomedPanes.clear();
  ptySizes.set('/dev/pts/w1pA', '40 59'); // deterministic native size so the fit and its restore both write stty
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  ws.push({ t: 'fit', id: 'f', pane: 'w1:pA', cols: 100, rows: 30 });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'f');
  assert.ok(hub.zoomer.owns('w1:pA'), 'the pane is zoomed by us to start');
  const gate = deferred();
  sttyGateNextWrite = gate.promise; // hold the close's fit-restore stty write inside its leave, before the zoom release
  ws.push({ t: 'pane.close', id: 'x', pane: 'w1:pA' }); // start closing: drop our watch (now gated), then close on herdr
  await new Promise((r) => setTimeout(r, 20)); // let the tear-down reach the gated stty write
  ws.push({ t: 'watch', id: 'w2', pane: 'w1:pA', zoom: true }); // re-watch the pane while the tear-down is mid-flight
  await new Promise((r) => setTimeout(r, 20));
  gate.release(); // let the stalled tear-down finish
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w2');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(hub.zoomer.owns('w1:pA'), 'the re-watch kept the pane zoomed; the close tear-down did not drop its lease');
  assert.equal(link.zoomedPanes.has('w1:pA'), true, 'A is still zoomed on the desktop');
  assert.ok(link.calls.some((c) => c.method === 'pane.close'), 'the close still reached herdr');
  session.dispose();
  await new Promise((r) => setTimeout(r, 30));
});

test('a zoom taken after the socket closed does not outlive the session', async () => {
  // `zoomer.apply` awaits herdr before it records the owner; `dispose()`'s `releaseAll` snapshots owners before that,
  // so a zoom landing after it would keep the desktop pane zoomed for nobody. The disposed path in `startWatch` must
  // release it explicitly (the early return there is above the try/finally that would otherwise give it back).
  link.zoomedPanes.clear();
  const { ws, session } = await connectAuthed();
  const gate = deferred();
  link.zoomApplyGate = gate.promise; // hold `pane.zoom on` mid-apply, before the owner is recorded
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
  await new Promise((r) => setTimeout(r, 20)); // let startWatch reach the gated zoom apply
  ws.close(1000, 'gone'); // dispose runs releaseAll now — before apply records the owner
  await new Promise((r) => setTimeout(r, 10));
  gate.release(); // apply now records the owner, after the release already swept
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(hub.zoomer.owns('w1:pA'), false, 'the late zoom was released on the disposed path');
  assert.equal(link.zoomedPanes.has('w1:pA'), false, 'the desktop split is back');
  session.dispose();
  await new Promise((r) => setTimeout(r, 20));
});

test('watch {zoom:true} zooms the pane on the desktop, the ok says so, and looking elsewhere unzooms it', async () => {
  link.zoomedPanes.clear();
  const { ws } = await connectAuthed();
  link.calls.length = 0;
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
  const ok = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  assert.equal(ok['zoomed'], true);
  assert.deepEqual(link.calls.filter((c) => c.method === 'pane.zoom').map((c) => c.params), [{ pane_id: 'w1:pA', mode: 'on' }]);
  assert.ok(hub.zoomer.owns('w1:pA'));
  ws.push({ t: 'viewing', pane: 'w1:pB' });
  for (let i = 0; i < 50 && hub.zoomer.owns('w1:pA'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(hub.zoomer.owns('w1:pA'), false);
  assert.deepEqual(link.calls.filter((c) => c.method === 'pane.zoom').at(-1)?.params, { pane_id: 'w1:pA', mode: 'off' });
  assert.equal(link.zoomedPanes.has('w1:pA'), false, 'the split is back');
});

test('watch without zoom never calls pane.zoom; a zoom the desktop user made survives the phone leaving', async () => {
  link.zoomedPanes.clear();
  const { ws, session } = await connectAuthed();
  link.calls.length = 0;
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  const ok = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  assert.equal(ok['zoomed'], undefined);
  assert.equal(link.calls.some((c) => c.method === 'pane.zoom'), false);
  link.zoomedPanes.add('w1:pB'); // zoomed on the desktop by the user
  ws.push({ t: 'watch', id: 'w2', pane: 'w1:pB', zoom: true });
  const ok2 = await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w2');
  assert.equal(ok2['zoomed'], true);
  assert.equal(hub.zoomer.owns('w1:pB'), false, 'already zoomed by the desktop: not ours to undo');
  session.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.zoomedPanes.has('w1:pB'), true, 'the desktop keeps its zoom');
});

test('the connection ending (app backgrounded) releases the zoom the bridge held', async () => {
  link.zoomedPanes.clear();
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA', zoom: true });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  assert.ok(hub.zoomer.owns('w1:pA'));
  session.dispose();
  for (let i = 0; i < 50 && hub.zoomer.owns('w1:pA'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(hub.zoomer.owns('w1:pA'), false);
  assert.equal(link.zoomedPanes.has('w1:pA'), false);
});

test('scroll boosts the watched pane\'s poll cadence for a moment', async () => {
  const { ws, session } = await connectAuthed();
  ws.push({ t: 'watch', id: 'w', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'w');
  const watcher = () => (session as unknown as { watch: { watcher: { boosted: boolean } } | null }).watch?.watcher;
  assert.equal(watcher()?.boosted, false);
  ws.push({ t: 'scroll', id: 's', pane: 'w1:pA', direction: 'down', lines: 3 });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 's');
  assert.equal(watcher()?.boosted, true, 'polling is boosted right after a scroll');
  ws.push({ t: 'scroll', id: 's2', pane: 'w1:pB', direction: 'down', lines: 1 });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 's2');
  ws.push({ t: 'unwatch', id: 'u', pane: 'w1:pA' });
  await ws.waitFor((m) => m['t'] === 'ok' && m['id'] === 'u');
});

test('since: the clock starts with work, survives blocked, ends with the turn', async () => {
  const { ws, session } = await connectAuthed();
  assert.equal(typeof hub.snapshotMessage()!.panes.find((p) => p.id === 'w1:pA')!.since, 'number');
  link.currentSnapshot = { ...snapshot, panes: [{ ...pane, agent_status: 'idle', state_labels: {} }, shell] };
  link.emit('snapshot', link.currentSnapshot);
  const idle = await ws.waitFor((m) => m['t'] === 'pane.status' && m['agent_status'] === 'idle');
  assert.equal(idle['since'], null, 'idle has no clock');
  const snap = await ws.waitFor((m) => m['t'] === 'snapshot');
  assert.equal((snap['panes'] as Record<string, unknown>[]).find((p) => p['id'] === 'w1:pA')!['since'], null);
  link.currentSnapshot = { ...snapshot, panes: [{ ...pane, agent_status: 'working', state_labels: {} }, shell] };
  link.emit('snapshot', link.currentSnapshot);
  const working = await ws.waitFor((m) => m['t'] === 'pane.status' && m['agent_status'] === 'working');
  assert.equal(typeof working['since'], 'number', 'working starts the clock');
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  const blocked = await ws.waitFor((m) => m['t'] === 'pane.status' && m['agent_status'] === 'blocked');
  assert.equal(blocked['since'], working['since'], 'blocked keeps the clock that started with working');
  link.emit('state', 'down');
  link.emit('state', 'up');
  assert.equal(hub.snapshotMessage()!.panes.find((p) => p.id === 'w1:pA')!.since, working['since'], 'a herdr blip does not restart a clock that never stopped');
  ws.sent.length = 0; // waitFor scans everything received so far: look only at what follows
  link.currentSnapshot = { ...snapshot, panes: [shell] };
  link.emit('snapshot', link.currentSnapshot);
  await ws.waitFor((m) => m['t'] === 'snapshot');
  await new Promise((r) => setTimeout(r, 5)); // the new clock must land in a later millisecond to be told apart
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  const back = await ws.waitFor((m) => m['t'] === 'pane.status' && m['agent_status'] === 'blocked');
  assert.ok((back['since'] as number) > (working['since'] as number), 'a pane that left and came back starts a new clock');
  session.dispose();
});

test('pane.title: renaming a working/blocked pane with its status unchanged reaches the notifier, not the apps as pane.status', async () => {
  const { ws, session } = await connectAuthed();
  const renamed: [string, string][] = [];
  const onTitle = (p: string, t: string) => { renamed.push([p, t]); };
  hub.on('pane.title', onTitle);
  ws.sent.length = 0;
  link.currentSnapshot = { ...snapshot, panes: [{ ...pane, title: '◑ Fixing the flaky tests' }, shell] };
  link.emit('snapshot', link.currentSnapshot);
  const snap = await ws.waitFor((m) => m['t'] === 'snapshot');
  assert.equal((snap['panes'] as Record<string, unknown>[]).find((p) => p['id'] === 'w1:pA')!['title'], 'Fixing the flaky tests', 'the apps get the cleaned title in the snapshot');
  assert.deepEqual(renamed, [['w1:pA', 'Fixing the flaky tests']]);
  assert.ok(!ws.sent.some((m) => m['t'] === 'pane.status'), 'a rename is not a status change');
  // A plain shell's title churn is not a session rename.
  ws.sent.length = 0;
  link.currentSnapshot = { ...snapshot, panes: [{ ...pane, title: '◑ Fixing the flaky tests' }, { ...shell, title: 'vim notes.md' }] };
  link.emit('snapshot', link.currentSnapshot);
  await ws.waitFor((m) => m['t'] === 'snapshot');
  assert.equal(renamed.length, 1);
  hub.off('pane.title', onTitle);
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  await ws.waitFor((m) => m['t'] === 'snapshot');
  session.dispose();
});

test('pane.gone: a pane that vanished during a herdr outage still leaves', async () => {
  const { ws, session } = await connectAuthed();
  const gone: string[] = [];
  const onGone = (p: string) => { gone.push(p); };
  hub.on('pane.gone', onGone);
  link.emit('state', 'down');
  link.emit('state', 'up');
  ws.sent.length = 0;
  link.currentSnapshot = { ...snapshot, panes: [pane] };
  link.emit('snapshot', link.currentSnapshot);
  await ws.waitFor((m) => m['t'] === 'snapshot');
  assert.deepEqual(gone, ['w1:pB']);
  hub.off('pane.gone', onGone);
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  await ws.waitFor((m) => m['t'] === 'snapshot');
  session.dispose();
});

test('snapshots reconcile one at a time and in full: a run caught mid-flight announces nothing stale, and no removal is skipped', async () => {
  const { ws, session } = await connectAuthed();
  const events: string[] = [];
  const onStatus = (p: string, s: string) => { events.push(`status ${p} ${s}`); };
  const onGone = (p: string) => { events.push(`gone ${p}`); };
  hub.on('pane.status', onStatus);
  hub.on('pane.gone', onGone);
  link.emit('state', 'down'); // clears the prompt ids, so the next blocked snapshot asks herdr (`agent.list`) and awaits
  link.emit('state', 'up');
  link.agentListDelayMs = 30;
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  await new Promise((r) => setImmediate(r)); // the run starts and parks on agent.list
  link.currentSnapshot = { ...snapshot, panes: [shell] };
  link.emit('snapshot', link.currentSnapshot); // w1:pA is gone
  await ws.waitFor((m) => m['t'] === 'snapshot' && !(m['panes'] as { id: string }[]).some((p) => p.id === 'w1:pA'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events.filter((e) => e.includes('w1:pA')), ['gone w1:pA'], 'the parked run announced nothing from its stale data');

  // Every snapshot is reconciled: a removal followed at once by the pane's return is a leave and a fresh arrival.
  link.agentListDelayMs = 0;
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  await ws.waitFor((m) => m['t'] === 'pane.status' && m['pane'] === 'w1:pA' && m['agent_status'] === 'blocked');
  events.length = 0;
  ws.sent.length = 0;
  link.emit('snapshot', { ...snapshot, panes: [shell] });
  link.emit('snapshot', snapshot);
  await ws.waitFor((m) => m['t'] === 'pane.status' && m['pane'] === 'w1:pA' && m['agent_status'] === 'blocked');
  assert.deepEqual(events.filter((e) => e.includes('w1:pA')), ['gone w1:pA', 'status w1:pA blocked']);

  hub.off('pane.status', onStatus);
  hub.off('pane.gone', onGone);
  session.dispose();
});

test('snapshots queued before a herdr outage never run: nothing from before it is published after it', async () => {
  const { ws, session } = await connectAuthed();
  link.emit('state', 'down'); // clears the prompt ids, so the next blocked snapshot asks herdr and parks
  link.emit('state', 'up');
  link.agentListDelayMs = 30;
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot); // parks on agent.list
  await new Promise((r) => setImmediate(r));
  link.emit('snapshot', { ...snapshot, panes: [shell] }); // queued behind it
  link.emit('state', 'down'); // both are history now
  await new Promise((r) => setTimeout(r, 80));
  const down = ws.sent.findIndex((m) => m['t'] === 'herdr' && m['state'] === 'down');
  assert.ok(down >= 0);
  assert.deepEqual(ws.sent.slice(down + 1).filter((m) => m['t'] === 'snapshot' || m['t'] === 'pane.status'), [], 'the parked run and the queued one stayed silent');
  link.agentListDelayMs = 0;
  link.emit('state', 'up');
  ws.sent.length = 0;
  link.currentSnapshot = snapshot;
  link.emit('snapshot', snapshot);
  await ws.waitFor((m) => m['t'] === 'pane.status' && m['pane'] === 'w1:pA' && m['agent_status'] === 'blocked');
  session.dispose();
});
