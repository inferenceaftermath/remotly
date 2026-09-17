// M0 spike: measure herdr change signals against an isolated herdr session.
// Usage: HERDR_SOCKET_PATH=~/.config/herdr/sessions/remotly-dev/herdr.sock node scripts/spike.ts
import { performance } from 'node:perf_hooks';
import { HerdrClient, resolveSocketPath, type HerdrSubscription } from '../src/herdr/client.ts';
import type { HerdrEvent, PaneReadResult, SessionSnapshot, Subscription } from '../src/herdr/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const socketPath = resolveSocketPath();
log('socket', socketPath);
const c = new HerdrClient({ socketPath, requestTimeoutMs: 30_000 });
type Tapped = { t: number; ev: HerdrEvent };
const tapped: Tapped[] = [];
const subs: HerdrSubscription[] = [];
async function sub(s: Subscription[], tag: string) {
  const h = await c.subscribe(s, (ev) => tapped.push({ t: now(), ev: { ...ev, event: `${tag}:${ev.event}` } }));
  subs.push(h);
  return h;
}
const drain = (since: number, pred?: (e: HerdrEvent) => boolean) => tapped.slice(since).filter((x) => !pred || pred(x.ev));
function summarize(label: string, t0: number, events: Tapped[]) {
  const kinds = new Map<string, number>();
  for (const e of events) kinds.set(e.ev.event, (kinds.get(e.ev.event) ?? 0) + 1);
  const first = events[0];
  log(`${label}: ${events.length} events`, JSON.stringify([...kinds]), first ? `first after ${(first.t - t0).toFixed(1)} ms` : '');
}

// 0. latency micro-benchmark
{
  const lat = async (label: string, fn: () => Promise<unknown>, n = 20) => {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) { const t = now(); await fn(); xs.push(now() - t); }
    xs.sort((a, b) => a - b);
    log(`latency ${label}: min ${xs[0]!.toFixed(1)} median ${xs[n >> 1]!.toFixed(1)} p90 ${xs[Math.floor(n * 0.9)]!.toFixed(1)} max ${xs[n - 1]!.toFixed(1)} ms`);
  };
  await lat('ping', () => c.request('ping'));
  await lat('session.snapshot', () => c.request('session.snapshot'));
  await lat('pane.list', () => c.request('pane.list'));
  await lat('pane.read visible ansi', () => c.request('pane.read', { pane_id: 'w1:p1', source: 'visible', format: 'ansi', strip_ansi: false }));
  await lat('pane.send_text ""', () => c.request('pane.send_text', { pane_id: 'w1:p1', text: '' }));
  await lat('pane.get', () => c.request('pane.get', { pane_id: 'w1:p1' }));
  await lat('pane.layout', () => c.request('pane.layout', { pane_id: 'w1:p1' }));
}

const snap = (await c.request<{ snapshot: SessionSnapshot }>('session.snapshot')).snapshot;
log('snapshot', snap.version, 'protocol', snap.protocol, 'panes', snap.panes.map((p) => p.pane_id).join(','));
// close leftover experiment tabs from crashed runs (anything but the first tab)
for (const t of snap.tabs.slice(1)) { await c.request('tab.close', { tab_id: t.tab_id }).catch(() => {}); log('closed leftover tab', t.tab_id); }
const ws = snap.workspaces[0]!;
const created = await c.request<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>('tab.create', { workspace_id: ws.workspace_id });
const P = created.root_pane.pane_id;
const T = created.tab.tab_id;
log('experiment pane', P, 'tab', T);
await sleep(700);

async function run(cmd: string) {
  await c.request('pane.send_text', { pane_id: P, text: cmd });
  await c.request('pane.send_keys', { pane_id: P, keys: ['enter'] });
}
async function read(source = 'visible', format = 'ansi', lines?: number): Promise<PaneReadResult> {
  const params: Record<string, unknown> = { pane_id: P, source, format, strip_ansi: false };
  if (lines !== undefined) params['lines'] = lines;
  return (await c.request<{ read: PaneReadResult }>('pane.read', params)).read;
}
async function waitFor(marker: string, timeoutMs = 20_000) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    const r = await read('visible', 'text');
    if (r.text.includes(marker)) return now() - t0;
    await sleep(50);
  }
  return -1;
}
// paced generator: ~1500 lines over ~3 s
const PACED = `python3 -c 'import time,sys
for i in range(1500):
    print("paced line", i, "x"*40); sys.stdout.flush(); time.sleep(0.002)
print("PACED-DONE")'`;

// 1. structural subscription: what fires on output? (expect nothing)
await sub([{ type: 'pane.updated' }, { type: 'pane.created' }, { type: 'pane.closed' }, { type: 'layout.updated' }, { type: 'pane.focused' }, { type: 'pane.exited' }, { type: 'pane.agent_detected' }, { type: 'pane.agent_status_changed', pane_id: P }], 'S');
await sleep(400);
{
  const i0 = tapped.length; const t0 = now();
  await run("printf 'structural-probe\\n'");
  await sleep(1200);
  summarize('1 structural subs after printf', t0, drain(i0));
  const pane = (await c.request<{ pane: { revision: number } }>('pane.get', { pane_id: P })).pane;
  log('   pane.get revision after output:', pane.revision);
}

// 2. output_matched variants
const variants: Array<[string, Subscription]> = [
  ['V1 recent lines=1 regex .', { type: 'pane.output_matched', pane_id: P, source: 'recent', lines: 1, match: { type: 'regex', value: '.' }, strip_ansi: false }],
  ['V2 visible lines=1 regex .', { type: 'pane.output_matched', pane_id: P, source: 'visible', lines: 1, match: { type: 'regex', value: '.' }, strip_ansi: false }],
  ['V3 detection regex .', { type: 'pane.output_matched', pane_id: P, source: 'detection', match: { type: 'regex', value: '.' } }],
  ['V4 visible regex .', { type: 'pane.output_matched', pane_id: P, source: 'visible', match: { type: 'regex', value: '.' }, strip_ansi: false }],
  ['V5 recent_unwrapped lines=2 substring ""', { type: 'pane.output_matched', pane_id: P, source: 'recent_unwrapped', lines: 2, match: { type: 'substring', value: '' } }],
];
for (const [name, s] of variants) {
  const i0 = tapped.length;
  const h = await sub([s], name.split(' ')[0]!).catch((e) => { log(`${name}: subscribe rejected: ${String(e)}`); return null; });
  if (!h) continue;
  await sleep(400);
  const initial = drain(i0);
  log(`${name}: initial events ${initial.length}`, initial[0] ? `read.text=${JSON.stringify((initial[0].ev.data as any).read?.text).slice(0, 80)} matched_line=${JSON.stringify((initial[0].ev.data as any).matched_line).slice(0, 60)}` : '');
  const i1 = tapped.length; const t1 = now();
  await run(`printf '${name.split(' ')[0]}-probe-A\\n'`);
  await sleep(800);
  const evsA = drain(i1);
  log(`   after printf A: ${evsA.length} events`, evsA[0] ? `first +${(evsA[0].t - t1).toFixed(1)}ms text=${JSON.stringify((evsA[0].ev.data as any).read?.text).slice(0, 80)}` : '');
  const i2 = tapped.length;
  await run(`printf '${name.split(' ')[0]}-probe-A\\n'`); // identical text again → dedupe?
  await sleep(800);
  log(`   after identical printf again: ${drain(i2).length} events`);
  const i3 = tapped.length; const t3 = now();
  await run(PACED);
  const took = await waitFor('PACED-DONE');
  await sleep(400);
  const evs = drain(i3);
  const gaps = evs.slice(1).map((e, i) => e.t - evs[i]!.t).sort((a, b) => a - b);
  log(`   paced burst (${took.toFixed(0)} ms): ${evs.length} events; gaps ms min ${gaps[0]?.toFixed(1)} median ${gaps[gaps.length >> 1]?.toFixed(1)} max ${gaps[gaps.length - 1]?.toFixed(1)}; payload chars ${evs[0] ? ((evs[0].ev.data as any).read?.text?.length) : '-'}`);
  h.close();
  await sleep(200);
}

// 3. polling by content: cost and change cadence during paced burst
{
  const t0 = now();
  await run(PACED);
  let reads = 0, changes = 0, last = '', totalMs = 0, maxMs = 0, done = false;
  while (!done && now() - t0 < 20_000) {
    const ts = now();
    const r = await read('visible', 'ansi');
    const dt = now() - ts; totalMs += dt; maxMs = Math.max(maxMs, dt); reads++;
    if (r.text !== last) { changes++; last = r.text; }
    done = r.text.includes('PACED-DONE');
    await sleep(50);
  }
  log(`3 poll@50ms during paced burst: ${reads} reads, ${changes} content changes, avg read ${(totalMs / reads).toFixed(2)} ms, max ${maxMs.toFixed(1)} ms, ${(now() - t0).toFixed(0)} ms total`);
  const r = await read('visible', 'ansi');
  log(`   full screen read: ${r.text.length} chars, ${r.text.split('\n').length} lines (layout height 41), revision ${r.revision}`);
}

// 4. rows/cols semantics and history
{
  await run('clear; seq 1 200; echo SEQ-DONE');
  await waitFor('SEQ-DONE');
  await sleep(300);
  const v = await read('visible', 'ansi');
  const vt = await read('visible', 'text');
  const tl = vt.text.split('\n');
  log(`4 visible after clear;seq 1 200: ansi lines ${v.text.split('\n').length}, text lines ${tl.length}; first ${JSON.stringify(tl[0])} last two ${JSON.stringify(tl.slice(-2))}; ansi last two ${JSON.stringify(v.text.split('\n').slice(-2))}`);
  const v10 = await read('visible', 'ansi', 10);
  log(`   visible lines=10 -> ${v10.text.split('\n').length} lines, truncated ${v10.truncated}`);
  for (const n of [50, 500, 5000]) {
    const r = await read('recent', 'ansi', n);
    const u = await read('recent_unwrapped', 'ansi', n);
    log(`   recent lines=${n}: ${r.text.split('\n').length} lines truncated ${r.truncated}; recent_unwrapped: ${u.text.split('\n').length} lines truncated ${u.truncated}`);
  }
  const r0 = await read('recent', 'ansi');
  log(`   recent (no lines): ${r0.text.split('\n').length} lines`);
  const rt = (await c.request<{ read: PaneReadResult }>('pane.read', { pane_id: P, source: 'recent', format: 'ansi', strip_ansi: true, lines: 5 })).read;
  log(`   recent strip_ansi=true format=ansi sample: ${JSON.stringify(rt.text.split('\n')[0])}`);
  const pane = (await c.request<{ pane: { scroll: unknown; revision: number } }>('pane.get', { pane_id: P })).pane;
  log('   pane.get scroll after seq:', JSON.stringify(pane.scroll), 'revision', pane.revision);
}

// 5. split + zoom (correct param is target_pane_id): layout events, background-tab rect staleness
{
  const i0 = tapped.length;
  const split = await c.request<any>('pane.split', { target_pane_id: P, direction: 'right', focus: false });
  const P2: string = split.pane?.pane_id ?? split.root_pane?.pane_id ?? JSON.stringify(split).slice(0, 80);
  await sleep(600);
  const evs = drain(i0);
  summarize('5 events after split', now(), evs);
  const lu = evs.find((e) => e.ev.event.endsWith('layout_updated'));
  if (lu) log('   layout_updated payload rects:', JSON.stringify((lu.ev.data as any).layout?.panes?.map((p: any) => [p.pane_id, p.rect])), 'tab', (lu.ev.data as any).layout?.tab_id);
  const lay = (await c.request<{ layout: any }>('pane.layout', { pane_id: P })).layout;
  log('   pane.layout (tab NOT focused):', JSON.stringify(lay.panes.map((p: any) => [p.pane_id, p.rect])), 'zoomed', lay.zoomed);
  const snapL = (await c.request<{ snapshot: SessionSnapshot }>('session.snapshot')).snapshot.layouts.find((l) => l.tab_id === T);
  log('   snapshot.layouts for tab (NOT focused):', JSON.stringify(snapL?.panes.map((p) => [p.pane_id, p.rect])));
  await run('clear; printf "%0.s=" $(seq 1 200); echo; echo WIDTH-DONE');
  await waitFor('WIDTH-DONE');
  await sleep(300);
  const vr = await read('visible', 'text');
  log(`   visible width probe (200 '=' wrapped): longest line ${Math.max(...vr.text.split('\n').map((l) => l.length))} cols → PTY cols after split`);
  await c.request('tab.focus', { tab_id: T }).catch((e) => log('tab.focus err', String(e)));
  await sleep(600);
  const lay2 = (await c.request<{ layout: any }>('pane.layout', { pane_id: P })).layout;
  log('   pane.layout (tab focused):', JSON.stringify(lay2.panes.map((p: any) => [p.pane_id, p.rect])));
  const i1 = tapped.length;
  const z = await c.request<{ zoom: any }>('pane.zoom', { pane_id: P, mode: 'on' });
  await sleep(600);
  log('   zoom on ->', JSON.stringify({ changed: z.zoom.changed, zoomed: z.zoom.zoomed, reason: z.zoom.reason, rects: z.zoom.layout.panes.map((p: any) => [p.pane_id, p.rect]) }));
  summarize('   events after zoom on', now(), drain(i1));
  await run('clear; printf "%0.s=" $(seq 1 200); echo; echo WIDTH2-DONE');
  await waitFor('WIDTH2-DONE');
  await sleep(300);
  const vz = await read('visible', 'text');
  log(`   visible width when zoomed: longest ${Math.max(...vz.text.split('\n').map((l) => l.length))} cols`);
  const z2 = await c.request<{ zoom: any }>('pane.zoom', { pane_id: P, mode: 'off' });
  log('   zoom off ->', JSON.stringify({ changed: z2.zoom.changed, zoomed: z2.zoom.zoomed }));
  await sleep(300);
  await c.request('pane.close', { pane_id: P2 }).catch((e) => log('pane.close err', String(e)));
  await c.request('tab.focus', { tab_id: snap.tabs[0]!.tab_id }).catch(() => {});
  await sleep(400);
}

// 5b. what makes pane_updated fire? title change, cwd change
{
  let i0 = tapped.length;
  await run("printf '\\033]0;FLOW-TITLE-PROBE\\007'");
  await sleep(800);
  let evs = drain(i0, (e) => e.event === 'S:pane_updated');
  log(`5b pane_updated after OSC title change: ${evs.length}`, evs[0] ? JSON.stringify((evs[0].ev.data as any).pane?.terminal_title) : '');
  i0 = tapped.length;
  await run('cd /tmp');
  await sleep(800);
  evs = drain(i0, (e) => e.event === 'S:pane_updated');
  log(`   pane_updated after cd: ${evs.length}`, evs[0] ? JSON.stringify({ cwd: (evs[0].ev.data as any).pane?.cwd, fg: (evs[0].ev.data as any).pane?.foreground_cwd, rev: (evs[0].ev.data as any).pane?.revision }) : '');
  i0 = tapped.length;
  await run('sleep 0.3');
  await sleep(900);
  evs = drain(i0, (e) => e.event === 'S:pane_updated');
  log(`   pane_updated after running 'sleep 0.3' (foreground process change): ${evs.length}`);
  const one = tapped.find((e) => e.ev.event === 'S:pane_updated');
  if (one) log('   pane_updated data keys:', Object.keys(one.ev.data), 'pane keys:', Object.keys((one.ev.data as any).pane ?? {}));
}

// 6. raw escape passthrough & send_input
{
  await run('cat -v');
  await sleep(1000);
  await c.request('pane.send_text', { pane_id: P, text: '\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~' });
  await sleep(600);
  const r = await read('visible', 'text');
  log('6 send_text raw ESC passthrough (cat -v shows):', JSON.stringify(r.text.split('\n').filter((l) => l.includes('^[')).slice(0, 2)));
  await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] });
  await sleep(200);
}

// 7. cleanup
await c.request('tab.close', { tab_id: T }).then(() => log('closed experiment tab', T)).catch((e) => log('tab.close err', String(e)));
log('total events tapped:', tapped.length, 'kinds:', JSON.stringify([...new Set(tapped.map((x) => x.ev.event))]));
for (const h of subs) h.close();
process.exit(0);
