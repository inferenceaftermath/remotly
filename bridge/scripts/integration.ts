// M1 integration test against a real herdr session (use the isolated dev session, never the default one):
//   HERDR_SOCKET_PATH=$HOME/.config/herdr/sessions/remotly-dev/herdr.sock node scripts/integration.ts
// Starts a throwaway bridge (temp config dir, 127.0.0.1, random port, self-signed, no tailnet gate), creates a
// scratch tab in the herdr session, pairs, watches the pane, types printf sequences and asserts the frames.
// Exits 0 on success, 1 on failure; always kills only the bridge PID it started and closes its own tab.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HerdrClient } from '../src/herdr/client.ts';
import { controlRequest, type PairInfo } from '../src/control.ts';
import type { Frame, HistoryMessage } from '../src/terminal/types.ts';

const socketPath = process.env['HERDR_SOCKET_PATH'];
if (!socketPath || socketPath.endsWith('/.config/herdr/herdr.sock')) {
  console.error('refusing to run: set HERDR_SOCKET_PATH to an isolated herdr session socket (not the default session)');
  process.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures.push(msg);
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const herdr = new HerdrClient({ socketPath });
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-integration-'));
const port = await freePort();
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ listen: { host: '127.0.0.1', port }, tls: { mode: 'selfsigned' }, security: { require_tailnet: false }, herdr: { socket: socketPath } }),
  { mode: 0o600 },
);
const bridge = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'main.ts'), 'serve'], {
  env: { ...process.env, REMOTLY_CONFIG_DIR: configDir, REMOTLY_LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
let tabId: string | null = null;

async function cleanup(): Promise<void> {
  if (tabId) await herdr.request('tab.close', { tab_id: tabId }).catch(() => {});
  if (bridge.exitCode === null) bridge.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(configDir, { recursive: true, force: true });
}

try {
  // wait for the bridge to listen
  const started = Date.now();
  for (;;) {
    if (fs.existsSync(path.join(configDir, 'remotly.sock'))) break;
    if (Date.now() - started > 15_000) throw new Error('bridge did not start');
    await sleep(200);
  }
  await sleep(500);

  // scratch pane in the herdr session
  const created = await herdr.request<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>('tab.create', { label: 'flow-integration', focus: false });
  tabId = created.tab.tab_id;
  const pane = created.root_pane.pane_id;
  await sleep(1200);

  // pair via control socket + REST
  const info = await controlRequest<PairInfo>({ cmd: 'pair' }, { socketPath: path.join(configDir, 'remotly.sock') });
  check(/^[A-Z2-9]{8}$/.test(info.code) && !!info.fingerprint, 'pair: code and fingerprint issued');
  const https = await import('node:https');
  const pairResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: '/pair', method: 'POST', headers: { 'content-type': 'application/json' }, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ code: info.code, device: { name: 'integration', platform: 'android', app_version: 'test' } }));
  });
  check(pairResp.status === 200, `POST /pair → 200 (got ${pairResp.status})`);
  const { token } = JSON.parse(pairResp.body) as { token: string };

  // websocket session
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
  const inbox: Record<string, unknown>[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as Record<string, unknown>));
  const waitFor = async <T,>(pred: (m: Record<string, unknown>) => boolean, what: string, timeoutMs = 5000): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0] as T;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await sleep(10);
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ t: 'hello', token, client: { platform: 'android', app_version: 'test', device_name: 'integration' }, mode: 'full' }));
  const welcome = await waitFor<{ snapshot: { panes: { id: string }[] } }>((m) => m['t'] === 'welcome', 'welcome');
  check(welcome.snapshot.panes.some((p) => p.id === pane), 'welcome snapshot lists the scratch pane');

  const tWatch = Date.now();
  ws.send(JSON.stringify({ t: 'watch', id: 'w', pane }));
  const ok = await waitFor<{ cols: number; rows: number }>((m) => m['t'] === 'ok' && m['id'] === 'w', 'watch ok');
  const full = await waitFor<Frame>((m) => m['t'] === 'frame', 'first frame');
  check(full.full && full.rows === ok.rows && full.cols === ok.cols && full.lines.length === full.rows, `first frame is full ${full.cols}x${full.rows} (${Date.now() - tWatch} ms after watch)`);

  // styled output → partial frame with the right styles and text
  inbox.length = 0;
  const marker = `flow-int-${Date.now().toString(36)}`;
  ws.send(JSON.stringify({ t: 'text', id: 't', pane, text: `printf '\\e[1;31mRED\\e[0m \\e[38;2;10;200;10m${marker}\\e[0m 日本語\\n'` }));
  ws.send(JSON.stringify({ t: 'keys', id: 'k', pane, keys: ['enter'] }));
  const tSend = Date.now();
  const rowText = (l: Frame['lines'][number]) => l.runs.map((r) => r.t).join('');
  const isOutputRow = (l: Frame['lines'][number]) => rowText(l).includes(marker) && rowText(l).includes('RED') && !rowText(l).includes('printf');
  const frame = await waitFor<Frame>((m) => m['t'] === 'frame' && (m as unknown as Frame).lines.some(isOutputRow), 'frame with printed output', 8000);
  const lag = Date.now() - tSend;
  check(!frame.full, `output arrived as a partial frame (${lag} ms after Enter, rows ${frame.lines.map((l) => l.y).join(',')})`);
  const styleIds = new Map<number, { fg: string; a: number }>();
  for (const [id, s] of Object.entries({ ...full.styles, ...frame.styles })) styleIds.set(Number(id), s);
  const line = frame.lines.find(isOutputRow)!;
  const red = line.runs.find((r) => r.t === 'RED');
  const green = line.runs.find((r) => r.t.includes(marker));
  const cjk = line.runs.filter((r) => r.w === 2);
  check(!!red && (styleIds.get(red.s)?.fg === 'p1' || styleIds.get(red.s)?.fg === 'p9') && ((styleIds.get(red.s)?.a ?? 0) & 1) === 1, `bold red run (style ${red ? JSON.stringify(styleIds.get(red.s)) : 'missing'})`);
  check(!!green && styleIds.get(green.s)?.fg === '#0ac80a', `truecolour run (style ${green ? JSON.stringify(styleIds.get(green.s)) : 'missing'})`);
  check(cjk.length === 3 && cjk.map((r) => r.t).join('') === '日本語', `three wide runs for 日本語 (got ${JSON.stringify(cjk.map((r) => [r.t, r.w]))})`);
  const colsUsed = line.runs.reduce((acc, r) => Math.max(acc, r.c + r.w), 0);
  check(colsUsed <= frame.cols, `row fits in ${frame.cols} columns (used ${colsUsed})`);

  // history
  ws.send(JSON.stringify({ t: 'history', id: 'h', pane, lines: 50 }));
  const hist = await waitFor<HistoryMessage>((m) => m['t'] === 'history', 'history');
  check(hist.lines.some((l) => l.runs.some((r) => r.t.includes(marker))), `history contains the marker (${hist.lines.length} lines, has_more=${hist.has_more})`);

  // navigation keys as raw escapes + invalid key
  ws.send(JSON.stringify({ t: 'keys', id: 'nav', pane, keys: ['home', 'end', 'ctrl+u'] }));
  await waitFor((m) => m['t'] === 'ok' && m['id'] === 'nav', 'nav ok');
  check(true, 'home/end/ctrl+u accepted');
  ws.send(JSON.stringify({ t: 'keys', id: 'bad', pane, keys: ['shift+home'] }));
  const bad = await waitFor<{ code: string }>((m) => m['t'] === 'error' && m['id'] === 'bad', 'invalid key error');
  check(bad.code === 'invalid_key', 'unknown key → error invalid_key');

  // safety-net full frame within 10 s
  inbox.length = 0;
  const tFull = Date.now();
  const periodic = await waitFor<Frame>((m) => m['t'] === 'frame' && m['full'] === true, 'periodic full frame', 12_000);
  check(periodic.full, `periodic full frame after ${Date.now() - tFull} ms`);

  ws.close();
} catch (err) {
  check(false, `exception: ${(err as Error).message}`);
} finally {
  await cleanup();
}
console.log(failures.length === 0 ? 'integration: all checks passed' : `integration: ${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
