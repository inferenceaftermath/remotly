#!/usr/bin/env node
// Remotly verification client (M1): pairs with a bridge, lists panes and renders frames in this terminal.
// Standalone on purpose: no imports from src/, only `ws` and Node built-ins. Run from bridge/; see USAGE.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ClientRequestArgs } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';
import WebSocket from 'ws';

const USAGE = `usage: node scripts/tui-client.ts [--url wss://host:port] [--pair CODE] [--fp B64URL] [--qr 'remotly://pair?…']
                                  [--state FILE] [--pane ID] [--insecure]
  --url      bridge origin (required unless stored in the state file)
  --pair     redeem a pairing code via POST /pair and store the token
  --fp       pin the server leaf certificate: base64url(SHA-256(DER)); self-signed mode
  --qr       remotly://pair?… payload from \`remotly-bridge pair\`; sets --url, --fp and --pair
  --state    state file (default \${REMOTLY_CONFIG_DIR ?? ~/.config/remotly}/tui-client.json, mode 0600)
  --pane     watch this pane id immediately
  --insecure skip TLS verification entirely (LAN testing only)
env:  REMOTLY_TUI_LOG=1 appends every incoming message to <state dir>/tui-client.log
keys: pane list: the digit/letter in brackets watches that pane · Ctrl+Q quit
      pane view: typing → text · Enter/Esc/Tab/arrows/Backspace(0x7f)/Home/End/PgUp/PgDn/Delete → keys · Ctrl+C keys ["ctrl+c"]
                 Ctrl+P prompt composer · Ctrl+H history (needs Backspace=0x7f) · Ctrl+L pane list · Ctrl+A/Ctrl+D approve/deny`;

// ---------- wire types (mirror shared/protocol/remotly-protocol.md) ----------
interface WireRun { c: number; w: number; s: number; t: string }
interface WireLine { y: number; runs: WireRun[] }
interface Style { fg: string; bg: string; a: number }
interface Frame { t: 'frame'; pane: string; rev: number; cols: number; rows: number; full: boolean; lines: WireLine[]; styles: Record<string, Style> }
interface PaneStatusInfo { agent_status: string; agent: string | null; display_agent: string | null; title: string; state_label: string; prompt_id?: string }
interface PaneInfo extends PaneStatusInfo { id: string; tab_id: string; workspace_id: string; cwd: string; focused: boolean }
interface Snapshot { panes: PaneInfo[]; focused_pane_id: string | null }
interface Welcome { t: 'welcome'; protocol: number; host: { name: string; herdr_version: string; herdr_protocol: number; flow_version: string }; device: { id: string; name: string }; snapshot?: Snapshot }
interface HistoryMsg { t: 'history'; id: string; pane: string; lines: { runs: WireRun[] }[]; styles: Record<string, Style>; has_more: boolean }
type ServerMsg =
  | Welcome
  | (Snapshot & { t: 'snapshot' })
  | (PaneStatusInfo & { t: 'pane.status'; pane: string })
  | Frame
  | HistoryMsg
  | { t: 'approval.result'; pane: string; prompt_id: string; outcome: string; detail?: string; status_after?: string }
  | { t: 'herdr'; state: 'up' | 'down' }
  | { t: 'ok'; id: string; cols?: number; rows?: number; zoomed?: boolean }
  | { t: 'error'; id?: string; code: string; message: string };

// ---------- CLI, state file, QR ----------
interface Cli { url: string | undefined; pair: string | undefined; fp: string | undefined; qr: string | undefined; state: string | undefined; pane: string | undefined; insecure: boolean }
interface State { url: string; token: string; fingerprint?: string; host_name?: string }

function die(msg: string): never {
  process.stderr.write(`tui-client: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { url: undefined, pair: undefined, fp: undefined, qr: undefined, state: undefined, pane: undefined, insecure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--url': cli.url = value().replace(/\/+$/, ''); break;
      case '--pair': cli.pair = value(); break;
      case '--fp': cli.fp = value(); break;
      case '--qr': cli.qr = value(); break;
      case '--state': cli.state = value(); break;
      case '--pane': cli.pane = value(); break;
      case '--insecure': cli.insecure = true; break;
      case '-h': case '--help': process.stdout.write(USAGE + '\n'); process.exit(0); break;
      default: die(`unknown option ${a}\n${USAGE}`);
    }
  }
  return cli;
}

/** Same rules as bridge/src/server/pairing.ts parseQrPayload (reimplemented so the script stays standalone). */
function parseQrPayload(payload: string): { url: string; code: string; hostName: string; fp: string | undefined } | null {
  if (!payload.startsWith('remotly://pair?')) return null;
  const q = new URLSearchParams(payload.slice('remotly://pair?'.length));
  const url = q.get('u');
  const code = q.get('c');
  const hostName = q.get('n');
  if (!url || !code || hostName === null) return null;
  return { url, code, hostName, fp: q.get('fp') || undefined };
}

function configDir(): string {
  const o = process.env['REMOTLY_CONFIG_DIR']?.trim();
  if (o) return path.resolve(o.startsWith('~') ? path.join(os.homedir(), o.slice(1)) : o);
  return path.join(os.homedir(), '.config', 'remotly');
}

// ---------- TLS ----------
const fingerprintOf = (der: Buffer): string => crypto.createHash('sha256').update(der).digest('base64url');

/**
 * Options shared by the /pair request and the WebSocket. Pinned mode verifies the leaf fingerprint on
 * `secureConnect`: Node only calls `checkServerIdentity` when chain verification passed, so with a
 * self-signed certificate and `rejectUnauthorized:false` that hook would never run.
 */
function tlsOptions(fp: string | undefined, insecure: boolean): { rejectUnauthorized: boolean; createConnection?: (o: ClientRequestArgs) => tls.TLSSocket } {
  if (fp === undefined) return { rejectUnauthorized: !insecure };
  return {
    rejectUnauthorized: false,
    createConnection: (o) => {
      const host = o.host ?? 'localhost';
      const sock = tls.connect({ host, port: Number(o.port ?? 443), servername: net.isIP(host) ? '' : host, rejectUnauthorized: false });
      sock.once('secureConnect', () => {
        const got = fingerprintOf(sock.getPeerCertificate().raw);
        if (got !== fp) sock.destroy(new Error(`TLS fingerprint mismatch: expected ${fp}, got ${got}`));
      });
      return sock;
    },
  };
}

function pairDevice(url: string, code: string, fp: string | undefined, insecure: boolean): Promise<{ token: string; device_id: string; host_name: string }> {
  const target = new URL(url.replace(/^wss:/, 'https:'));
  target.pathname = '/pair';
  const body = JSON.stringify({ code, device: { name: `tui-client@${os.hostname()}`.slice(0, 64), platform: 'android', app_version: 'tui' } });
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    const req = https.request(target, { method: 'POST', headers, ...tlsOptions(fp, insecure) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`POST /pair → ${res.statusCode} ${text}`));
        try { resolve(JSON.parse(text) as { token: string; device_id: string; host_name: string }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---------- session state ----------
type Mode = 'list' | 'pane' | 'prompt' | 'history';
const S = { url: '', token: '', fp: undefined as string | undefined, insecure: false, hostName: '', logStream: null as fs.WriteStream | null };
let ws: WebSocket | null = null;
let backoff = 500;
let pingTimer: NodeJS.Timeout | null = null;
let quitting = false;
let seq = 0;
let mode: Mode = 'list';
let panes: PaneInfo[] = [];
const paneStatus = new Map<string, PaneStatusInfo>();
let herdrState = '?';
let watched: string | null = null;
const grid = { cols: 0, rows: 0, rev: 0, lines: [] as WireRun[][] };
let styles: Record<string, Style> = {};
let lastFrameAt = 0;
let frameDelta = 0;
let notice = '';
let composer = '';
let textBuf = '';
let textTimer: NodeJS.Timeout | null = null;

const out = process.stdout;
const termCols = (): number => out.columns || 80;
const termRows = (): number => out.rows || 24;

function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function request(msg: Record<string, unknown>): string {
  const id = String(++seq);
  send({ id, ...msg });
  return id;
}
function setNotice(s: string): void {
  notice = s;
  scheduleDraw();
}

// ---------- connection ----------
function wsOptions(): WebSocket.ClientOptions {
  const t = tlsOptions(S.fp, S.insecure);
  const o: WebSocket.ClientOptions = { rejectUnauthorized: t.rejectUnauthorized, handshakeTimeout: 10_000 };
  // ws (like http.request) calls createConnection(options); @types/ws merely borrows net.createConnection's overloads.
  if (t.createConnection) o.createConnection = t.createConnection as unknown as typeof net.createConnection;
  return o;
}

function connect(): void {
  const sock = new WebSocket(`${S.url}/ws`, wsOptions());
  ws = sock;
  sock.on('open', () => {
    send({ t: 'hello', token: S.token, client: { platform: 'android', app_version: 'tui', device_name: `tui-client@${os.hostname()}` }, mode: 'full' });
    pingTimer = setInterval(() => sock.ping(), 15_000);
    scheduleDraw();
  });
  sock.on('message', (data) => onMessage(data.toString()));
  let lastError = '';
  sock.on('error', (err) => { lastError = err.message; });
  sock.on('close', (code, reason) => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    ws = null;
    herdrState = '?';
    if (quitting) return;
    if (code === 4401) {
      quit(`authentication rejected (4401): ${reason.toString() || 'token invalid'}; re-pair with --pair/--qr`);
      return;
    }
    setNotice(`disconnected (${code}${lastError ? `: ${lastError}` : ''}); reconnecting in ${backoff} ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  });
}

function applySnapshot(snap: Snapshot): void {
  panes = snap.panes;
  for (const p of panes) paneStatus.set(p.id, p);
}

function applyFrame(f: Frame): void {
  Object.assign(styles, f.styles);
  if (f.full || f.cols !== grid.cols || f.rows !== grid.rows) {
    grid.lines = Array.from({ length: f.rows }, (): WireRun[] => []);
    grid.cols = f.cols;
    grid.rows = f.rows;
  }
  for (const l of f.lines) grid.lines[l.y] = l.runs;
  grid.rev = f.rev;
}

function onMessage(raw: string): void {
  S.logStream?.write(raw + '\n');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { t?: unknown }).t !== 'string') return;
  const m = parsed as ServerMsg;
  switch (m.t) {
    case 'welcome':
      S.hostName = m.host.name;
      backoff = 500;
      styles = {};
      if (m.snapshot) applySnapshot(m.snapshot);
      setNotice(`connected: herdr ${m.host.herdr_version} (protocol ${m.host.herdr_protocol}), flow ${m.host.flow_version}`);
      if (watched) {
        request({ t: 'watch', pane: watched });
        send({ t: 'viewing', pane: watched });
      }
      break;
    case 'snapshot': applySnapshot(m); break;
    case 'pane.status': paneStatus.set(m.pane, m); break;
    case 'frame': {
      if (m.pane !== watched) break;
      const now = performance.now();
      frameDelta = lastFrameAt ? now - lastFrameAt : 0;
      lastFrameAt = now;
      applyFrame(m);
      break;
    }
    case 'history': showHistory(m); break;
    case 'approval.result': setNotice(`approval.result: ${m.outcome}${m.detail ? ` (${m.detail})` : ''}${m.status_after ? ` → ${m.status_after}` : ''}`); break;
    case 'herdr': herdrState = m.state; break;
    case 'ok': if (m.cols !== undefined) setNotice(`watching, pane is ${m.cols}x${m.rows}`); break;
    case 'error': setNotice(`error ${m.code}: ${m.message}`); break;
  }
  scheduleDraw();
}

// ---------- rendering ----------
let drawTimer: NodeJS.Timeout | null = null;
let lastDraw = 0;

function scheduleDraw(): void {
  if (drawTimer || mode === 'history') return;
  drawTimer = setTimeout(draw, Math.max(0, 33 - (performance.now() - lastDraw)));
}

function fit(s: string, width: number): string {
  return s.length > width ? s.slice(0, width) : s.padEnd(width);
}

function sgrFor(style: Style | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.a & 1) parts.push('1');
  if (style.a & 16) parts.push('7');
  return parts.length ? `\x1b[${parts.join(';')}m` : '';
}

/** Runs are ordered by `c`; gaps are blanks. Autowrap is off, so overlong rows are clipped by the terminal. */
function renderRuns(runs: WireRun[]): string {
  let s = '';
  let col = 0;
  for (const r of runs) {
    if (r.c > col) s += ' '.repeat(r.c - col);
    const sgr = sgrFor(styles[String(r.s)]);
    s += sgr ? `${sgr}${r.t}\x1b[0m` : r.t;
    col = r.c + r.w;
  }
  return s;
}

function topLine(): string {
  const conn = ws?.readyState === WebSocket.OPEN ? 'connected' : 'connecting…';
  let s = `Remotly tui · ${S.hostName || S.url} · ${conn} · herdr:${herdrState}`;
  if (mode !== 'list' && watched) {
    const st = paneStatus.get(watched);
    s += ` · pane ${watched} "${st?.title ?? ''}" ${st?.display_agent ?? st?.agent ?? 'shell'}(${st?.agent_status ?? '?'})`;
  } else {
    s += ` · ${panes.length} panes`;
  }
  return `\x1b[7m${fit(s, termCols())}\x1b[0m`;
}

const LIST_KEYS = '123456789abcdefghijklmnopqrstuvwxyz';

function listLines(): string[] {
  const rows = panes.map((p, i) => {
    const st = paneStatus.get(p.id) ?? p;
    return `[${LIST_KEYS.charAt(i) || '·'}] ${p.id.padEnd(12)}  ${st.display_agent ?? st.agent ?? 'shell'}(${st.agent_status})  ${st.title}${p.focused ? '  *' : ''}`;
  });
  if (rows.length === 0) rows.push(herdrState === 'down' ? 'herdr is down' : '(no panes yet)');
  rows.push('', 'press the key in brackets to watch a pane · Ctrl+Q quit');
  return rows;
}

function bottomLine(): string {
  if (mode === 'prompt') return `prompt> ${composer}`;
  if (mode === 'list') return notice || `${panes.length} panes`;
  const st = watched ? paneStatus.get(watched) : undefined;
  let s = `Δ${frameDelta.toFixed(0)}ms rev=${grid.rev} ${grid.cols}x${grid.rows}`;
  if (st) s += ` | ${st.agent ?? 'shell'}:${st.agent_status} ${st.state_label}`;
  if (st?.agent_status === 'blocked') s += ` | [Ctrl+A approve] [Ctrl+D deny]`;
  if (notice) s += ` | ${notice}`;
  return s;
}

function draw(): void {
  drawTimer = null;
  lastDraw = performance.now();
  const rows = termRows();
  const cols = termCols();
  const body = mode === 'list' ? listLines() : grid.lines.slice(0, rows - 2).map(renderRuns);
  let buf = `\x1b[1;1H${topLine()}`;
  for (let i = 1; i < rows - 1; i++) buf += `\x1b[${i + 1};1H${body[i - 1] ?? ''}\x1b[K`;
  buf += `\x1b[${rows};1H${fit(bottomLine(), cols)}`;
  out.write(buf);
}

function showHistory(m: HistoryMsg): void {
  Object.assign(styles, m.styles);
  mode = 'history';
  if (drawTimer) clearTimeout(drawTimer); // a pending redraw would paint over the dump
  drawTimer = null;
  const text = m.lines.map((l) => renderRuns(l.runs)).join('\r\n');
  out.write(`\x1b[2J\x1b[H${text}\r\n\x1b[7m-- history: ${m.lines.length} lines, has_more=${m.has_more} -- press any key --\x1b[0m`);
}

// ---------- input ----------
const KEY_NAMES: Record<string, string> = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\x1b': 'esc', '\x03': 'ctrl+c',
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[3~': 'delete', '\x1b[2~': 'insert',
};

/** Split a stdin chunk into whole escape sequences (CSI … final byte, or SS3 + one char) and single characters. */
function tokenize(s: string): string[] {
  return s.match(/\x1b\[[^\x40-\x7e]*[\x40-\x7e]?|\x1bO.|[\s\S]/g) ?? [];
}

function flushText(): void {
  if (textTimer) clearTimeout(textTimer);
  textTimer = null;
  if (textBuf && watched) request({ t: 'text', pane: watched, text: textBuf });
  textBuf = '';
}

function watchPane(id: string): void {
  watched = id;
  mode = 'pane';
  grid.lines = [];
  grid.cols = grid.rows = grid.rev = 0;
  lastFrameAt = 0;
  notice = '';
  request({ t: 'watch', pane: id });
  send({ t: 'viewing', pane: id });
  scheduleDraw();
}

function unwatchPane(): void {
  flushText();
  if (watched) {
    request({ t: 'unwatch', pane: watched });
    send({ t: 'viewing', pane: null });
  }
  watched = null;
  mode = 'list';
  scheduleDraw();
}

function approve(action: 'approve' | 'deny'): void {
  const st = watched ? paneStatus.get(watched) : undefined;
  if (!watched || st?.agent_status !== 'blocked' || st.prompt_id === undefined) return setNotice('pane is not blocked');
  request({ t: 'approve', pane: watched, prompt_id: st.prompt_id, action });
  setNotice(`${action} sent for ${st.prompt_id}…`);
}

function onKey(tok: string): void {
  if (mode === 'history') {
    mode = 'pane';
    out.write('\x1b[2J');
    return scheduleDraw();
  }
  if (tok === '\x11') return quit();
  if (mode === 'prompt') {
    if (tok === '\r' || tok === '\n') {
      if (watched && composer) request({ t: 'prompt', pane: watched, text: composer });
      composer = '';
      mode = 'pane';
    } else if (tok === '\x1b') { composer = ''; mode = 'pane'; }
    else if (tok === '\x7f') composer = composer.slice(0, -1);
    else if (tok >= ' ') composer += tok;
    return scheduleDraw();
  }
  if (mode === 'list') {
    if (tok === '\x03') return quit();
    const p = panes[LIST_KEYS.indexOf(tok)];
    if (p && tok.length === 1) watchPane(p.id);
    return;
  }
  // pane view
  const name = KEY_NAMES[tok];
  if (tok === '\x01') return approve('approve');
  if (tok === '\x04') return approve('deny');
  if (tok === '\x10') { flushText(); mode = 'prompt'; return scheduleDraw(); }
  if (tok === '\x0c') return unwatchPane();
  if (tok === '\x08') { flushText(); if (watched) request({ t: 'history', pane: watched, lines: 200 }); return; }
  if (name !== undefined) {
    flushText();
    if (watched) request({ t: 'keys', pane: watched, keys: [name] });
    return;
  }
  if (tok.length === 1 && tok < ' ') return; // other control chars: ignore
  textBuf += tok;
  if (!textTimer) textTimer = setTimeout(flushText, 20);
}

// ---------- lifecycle ----------
const RESTORE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
let uiStarted = false;

function quit(message?: string): void {
  quitting = true;
  flushText();
  if (uiStarted) {
    out.write(RESTORE);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    uiStarted = false;
  }
  if (message) process.stderr.write(`tui-client: ${message}\n`);
  const exit = (): never => process.exit(message ? 1 : 0);
  const sock = ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) exit();
  else {
    sock.once('close', exit).close(1000, 'quit');
    setTimeout(exit, 300); // in case the close handshake never completes
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const stateFile = cli.state ?? path.join(configDir(), 'tui-client.json');
  const stateDir = path.dirname(stateFile);
  let saved: Partial<State> = {};
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<State>; } catch { /* first run */ }

  let url = cli.url ?? saved.url;
  let fp = cli.fp ?? saved.fingerprint;
  let code = cli.pair;
  let hostName = saved.host_name ?? '';
  if (cli.qr) {
    const q = parseQrPayload(cli.qr);
    if (!q) die('--qr payload is not a valid remotly://pair?… URL');
    url = q.url.replace(/\/+$/, '');
    fp = cli.fp ?? q.fp; // the QR is authoritative: no fp means a publicly trusted cert
    code = cli.pair ?? q.code;
    hostName = q.hostName;
  }
  if (!url) die(`no --url given and none stored in ${stateFile}\n${USAGE}`);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let token = saved.token;
  if (code) {
    process.stderr.write(`pairing with ${url} (${fp ? 'pinned fingerprint' : cli.insecure ? 'INSECURE' : 'system trust'})…\n`);
    const r = await pairDevice(url, code, fp, cli.insecure);
    token = r.token;
    hostName = r.host_name;
    const st: State = { url, token };
    if (fp) st.fingerprint = fp;
    if (hostName) st.host_name = hostName;
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(stateFile, 0o600);
    process.stderr.write(`paired as device ${r.device_id} on ${hostName}; token stored in ${stateFile}\n`);
  }
  if (!token) die(`no token stored in ${stateFile}; pair first with --pair CODE or --qr PAYLOAD`);
  if (!process.stdin.isTTY) die('stdin must be a TTY');

  Object.assign(S, { url, token, fp, insecure: cli.insecure, hostName });
  if (process.env['REMOTLY_TUI_LOG'] === '1') S.logStream = fs.createWriteStream(path.join(stateDir, 'tui-client.log'), { flags: 'a', mode: 0o600 });

  uiStarted = true;
  out.write('\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[2J');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: Buffer | string) => { for (const tok of tokenize(String(chunk))) onKey(tok); });
  out.on('resize', scheduleDraw);
  process.on('exit', () => { if (uiStarted) out.write(RESTORE); });
  process.on('SIGTERM', () => quit());
  if (cli.pane) watchPane(cli.pane); // queued: the watch is (re)sent after welcome
  connect();
  draw();
}

main().catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
