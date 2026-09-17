// M0 fixture capture: raw herdr reads of reference screens (shell colours, alt-screen program,
// Claude Code / Codex / pi idle + permission prompt). Writes shared/fixtures/reads/*.ansi (+ .txt, .json).
// Usage: HERDR_SOCKET_PATH=~/.config/herdr/sessions/remotly-dev/herdr.sock node scripts/capture.ts [--agents claude,codex,pi] [--skip-agents]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HerdrClient, resolveSocketPath } from '../src/herdr/client.ts';
import type { HerdrEvent, PaneInfo, PaneReadResult, SessionSnapshot } from '../src/herdr/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const args = process.argv.slice(2);
const skipAgents = args.includes('--skip-agents');
const agentArg = args.find((a) => a.startsWith('--agents='));
const agents = agentArg ? agentArg.slice('--agents='.length).split(',') : ['claude', 'codex', 'pi'];

const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(root, 'shared', 'fixtures', 'reads');
fs.mkdirSync(outDir, { recursive: true });
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-capture-'));
fs.writeFileSync(path.join(workDir, 'README.md'), '# scratch project for Remotly fixture capture\n');
fs.writeFileSync(path.join(workDir, 'hello.txt'), 'hello from flow capture\n');

const c = new HerdrClient({ socketPath: resolveSocketPath(), requestTimeoutMs: 30_000 });
const events: Array<{ t: number; ev: HerdrEvent }> = [];
const eventLog: string[] = [];
const snap = (await c.request<{ snapshot: SessionSnapshot }>('session.snapshot')).snapshot;
const ws = snap.workspaces[0]!;
const tab = await c.request<{ tab: { tab_id: string }; root_pane: PaneInfo }>('tab.create', { workspace_id: ws.workspace_id, cwd: workDir, label: 'flow-capture', focus: true });
const P = tab.root_pane.pane_id;
const T = tab.tab.tab_id;
log('capture pane', P, 'tab', T, 'cwd', workDir);
const sub = await c.subscribe([{ type: 'pane.updated' }, { type: 'pane.agent_detected' }, { type: 'pane.exited' }, { type: 'pane.agent_status_changed', pane_id: P }], (ev) => {
  events.push({ t: performance.now(), ev });
  const d = ev.data as Record<string, any>;
  const pane = d['pane'] ?? d;
  if ((pane?.pane_id ?? d['pane_id']) === P) eventLog.push(`${new Date().toISOString().slice(11, 23)} ${ev.event} agent=${pane?.agent ?? d['agent']} status=${pane?.agent_status ?? d['agent_status']} rev=${pane?.revision} title=${JSON.stringify(pane?.terminal_title_stripped ?? d['title'])}`);
});
await sleep(800);

async function run(cmd: string) {
  await c.request('pane.send_text', { pane_id: P, text: cmd });
  await c.request('pane.send_keys', { pane_id: P, keys: ['enter'] });
}
async function read(source: string, format: string, lines?: number): Promise<PaneReadResult> {
  const params: Record<string, unknown> = { pane_id: P, source, format, strip_ansi: false };
  if (lines !== undefined) params['lines'] = lines;
  return (await c.request<{ read: PaneReadResult }>('pane.read', params)).read;
}
async function paneInfo(): Promise<PaneInfo> {
  return (await c.request<{ pane: PaneInfo }>('pane.get', { pane_id: P })).pane;
}
import { execFileSync } from 'node:child_process';
/** Exact PTY size of the pane's shell: readlink /proc/<pid>/fd/0 → stty size (Linux host-side, non-intrusive). */
async function ptySize(): Promise<{ rows: number; cols: number; tty: string } | null> {
  try {
    const pi = (await c.request<{ process_info: { shell_pid: number } }>('pane.process_info', { pane_id: P })).process_info;
    const tty = fs.readlinkSync(`/proc/${pi.shell_pid}/fd/0`);
    const out = execFileSync('stty', ['-F', tty, 'size'], { encoding: 'utf8' }).trim();
    const [rows, cols] = out.split(/\s+/).map(Number);
    return { rows: rows!, cols: cols!, tty };
  } catch (e) {
    log('ptySize failed:', String(e));
    return null;
  }
}
async function layoutRect() {
  const l = (await c.request<{ layout: any }>('pane.layout', { pane_id: P })).layout;
  return l.panes.find((p: any) => p.pane_id === P)?.rect;
}
async function waitText(pred: (t: string) => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const r = await read('visible', 'text');
    if (pred(r.text)) return true;
    await sleep(150);
  }
  return false;
}
async function waitStatus(statuses: string[], timeoutMs: number): Promise<string> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const p = await paneInfo();
    if (statuses.includes(p.agent_status)) return p.agent_status;
    await sleep(250);
  }
  return `timeout(last=${(await paneInfo()).agent_status})`;
}
let currentAgentName: string | null = null;
async function capture(name: string, note: string) {
  const ansi = await read('visible', 'ansi');
  const text = await read('visible', 'text');
  const info = await paneInfo();
  const rect = await layoutRect();
  const pty = await ptySize();
  const agentInfo = info.agent ? await c.request<{ agent: any }>('agent.get', { target: currentAgentName ?? P }).then((r) => r.agent).catch(() => null) : null;
  // scrub: home path and user@host
  const scrub = (s: string) => s.split(os.homedir()).join('/home/user').split(`${os.userInfo().username}@${os.hostname()}`).join('user@host').split(workDir).join('/tmp/flow-capture');
  fs.writeFileSync(path.join(outDir, `${name}.ansi`), scrub(ansi.text));
  fs.writeFileSync(path.join(outDir, `${name}.txt`), scrub(text.text));
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ note, captured: new Date().toISOString(), herdr: snap.version, rect, pty, rows_in_read: ansi.text.split('\n').length, pane: { agent: info.agent ?? null, display_agent: info.display_agent ?? null, agent_status: info.agent_status, title: scrub(info.terminal_title_stripped ?? ''), revision: info.revision, scroll: info.scroll, state_labels: info.state_labels ?? {} }, agent: agentInfo ? { name: agentInfo.name, state_change_seq: agentInfo.state_change_seq, interactive_ready: agentInfo.interactive_ready, screen_detection_skipped: agentInfo.screen_detection_skipped, agent_session: agentInfo.agent_session?.kind } : null }, null, 2) + '\n');
  log(`captured ${name}: ${ansi.text.split('\n').length} rows, agent=${info.agent ?? '-'} status=${info.agent_status} rect=${JSON.stringify(rect)} pty=${JSON.stringify(pty)}`);
}

const skipShell = args.includes('--skip-shell');
if (!skipShell) {
// 1. shell with ls --color
await run('clear; ls --color=always -la /etc | head -20; ls --color=always /');
await waitText((t) => t.includes('usr'), 5000);
await sleep(400);
await capture('shell-ls-color', 'bash prompt + ls --color=always (256-colour SGR, bold)');

// 2. alt-screen programs: top (colours, full redraw) and less
await run('top');
await sleep(2500);
await capture('top', 'top (full-screen, alt-screen-like redraw, inverse header)');
await c.request('pane.send_keys', { pane_id: P, keys: ['q'] });
await sleep(500);
await run('less -R /etc/services');
await sleep(1200);
await capture('less', 'less (alternate screen, status line)');
await c.request('pane.send_keys', { pane_id: P, keys: ['q'] });
await sleep(500);
// 3. wide chars, emoji, box drawing, braille, powerline
await run(`clear; printf '\\e[1;31mbold-red\\e[0m \\e[2mdim\\e[0m \\e[3mitalic\\e[0m \\e[4munder\\e[0m \\e[7minverse\\e[0m \\e[9mstrike\\e[0m \\e[38;5;208m256-orange\\e[0m \\e[48;5;27;97mbg27\\e[0m \\e[38;2;10;200;120mtruecolor\\e[0m\\n日本語テキスト 中文 한국어 → wide\\n🚀 🎉 👨‍👩‍👧 🇯🇵 ❤️ → emoji zwj/flag/vs16\\n┌──┬──┐ │ ├──┼──┤ └──┴──┘ ▶ ● ✔ → box\\n⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ → braille spinner\\n\\ue0b0 \\ue0b2 \\ue0a0 → powerline\\ttab\\there\\n\\e[44m   blue bg trailing blanks   \\e[0m\\ncombining: e\\u0301 a\\u0308 → accents\\n'`);
await waitText((t) => t.includes('accents'), 5000);
await sleep(400);
await capture('unicode-styles', 'SGR attribute zoo + CJK, emoji (ZWJ, flag, VS16), box drawing, braille, powerline, tabs, styled trailing blanks, combining marks');
}

// 4. agents
async function waitStatusSeq(sequence: Array<{ any: string[]; timeoutMs: number }>): Promise<string[]> {
  const seen: string[] = [];
  for (const step of sequence) {
    const st = await waitStatus(step.any, step.timeoutMs);
    seen.push(st);
    if (st.startsWith('timeout')) break;
  }
  return seen;
}
async function visibleText(): Promise<string> {
  return (await read('visible', 'text')).text;
}
if (!skipAgents) {
  for (const kind of agents) {
    log(`--- agent ${kind} ---`);
    eventLog.push(`--- ${kind} ---`);
    await run('clear');
    await sleep(400);
    const name = `flowcap${kind}`;
    const started = await c.request<any>('agent.start', { name, kind, pane_id: P, timeout_ms: 90_000 }, 100_000).catch((e) => ({ error: String(e) }));
    log(`agent.start ${kind} ->`, JSON.stringify(started).slice(0, 160));
    if (started.error) { await capture(`${kind}-start-failed`, `agent.start failed: ${started.error}`); await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] }).catch(() => {}); await sleep(500); await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] }).catch(() => {}); await sleep(1000); continue; }
    const agentName: string = started.agent?.name ?? name;
    currentAgentName = agentName;
    let st = await waitStatus(['idle', 'blocked', 'done'], 60_000);
    await sleep(1500);
    log(`${kind} after start: ${st}`);
    let screen = await visibleText();
    if (kind === 'claude' && /Quick safety check|Is this a project you created|trust/i.test(screen)) {
      await capture('claude-trust-dialog', `Claude Code workspace trust dialog right after start (herdr status ${st}); default selection is "No, exit"`);
      await c.request('pane.send_keys', { pane_id: P, keys: ['down'] });
      await sleep(300);
      await c.request('pane.send_keys', { pane_id: P, keys: ['enter'] });
      await sleep(3500);
      st = await waitStatus(['idle', 'blocked', 'done'], 30_000);
      screen = await visibleText();
      log(`claude after trust dialog: ${st}`);
    }
    if (kind === 'codex' && /Do you trust the contents of this directory/i.test(screen)) {
      await capture('codex-trust-dialog', `Codex CLI directory trust dialog right after start (herdr status ${st}); default selection is "Yes, continue"`);
      await c.request('pane.send_keys', { pane_id: P, keys: ['enter'] });
      await sleep(3500);
      st = await waitStatus(['idle', 'blocked', 'done'], 30_000);
      screen = await visibleText();
      log(`codex after trust dialog: ${st}`);
    }
    await capture(`${kind}-idle`, `${kind} ready for input (herdr status ${st})`);
    if (kind === 'claude') {
      await c.request('pane.send_text', { pane_id: P, text: 'first line of a multi-line prompt\nsecond line\nthird line' });
      await sleep(1500);
      await capture('claude-composer-multiline', 'Claude Code composer after pane.send_text with two embedded newlines (no Enter)');
      await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] });
      await sleep(1000);
    }
    const ag = await c.request<any>('agent.get', { target: agentName }).then((r) => r.agent).catch(() => null);
    log(`   agent.get before prompt: status=${ag?.agent_status} launch_pending=${ag?.launch_pending} seq=${ag?.state_change_seq}`);
    // codex runs sandboxed (cwd + /tmp writable) and only asks when a command needs escalation, so its
    // marker lives outside the sandbox (inside this repo, gitignored)
    const marker = kind === 'codex' ? `${root}/.capture/flow-capture-marker-codex.txt` : `/tmp/flow-capture-marker-${kind}.txt`;
    const prompt = `Run the shell command \`touch ${marker}\` and then stop. Do nothing else and do not explain.`;
    let how = 'agent.prompt(name)';
    let pr: any = await c.request<any>('agent.prompt', { target: agentName, text: prompt }).catch((e) => ({ error: String(e) }));
    if (pr.error) {
      // fallback: type the text, verify it landed in the composer, then Enter
      how = 'pane.send_text + verify + enter';
      for (let attempt = 0; attempt < 3; attempt++) {
        await c.request('pane.send_text', { pane_id: P, text: prompt });
        await sleep(600);
        if ((await visibleText()).includes('Do nothing else')) break;
        log(`   typed text not visible yet (attempt ${attempt + 1})`);
        await sleep(1500);
      }
      pr = await c.request<any>('pane.send_keys', { pane_id: P, keys: ['enter'] }).catch((e) => ({ error: String(e) }));
    }
    log(`submit ${kind} via ${how} ->`, JSON.stringify(pr).slice(0, 120));
    eventLog.push(`submit via ${how}: ${JSON.stringify(pr).slice(0, 100)}`);
    const seq = await waitStatusSeq([{ any: ['working', 'blocked'], timeoutMs: 30_000 }, { any: ['blocked', 'idle', 'done'], timeoutMs: 150_000 }]);
    log(`${kind} status sequence after prompt: ${seq.join(' → ')}`);
    st = seq[seq.length - 1]!;
    await sleep(1500);
    if (st === 'blocked') {
      await capture(`${kind}-permission-prompt`, `${kind} asking for permission to run \`touch ${marker}\` (herdr status blocked)`);
      const det = await read('detection', 'text');
      fs.writeFileSync(path.join(outDir, `${kind}-permission-prompt.detection.txt`), det.text);
      await c.request('pane.send_keys', { pane_id: P, keys: ['esc'] });
      const seq2 = await waitStatusSeq([{ any: ['idle', 'done', 'working'], timeoutMs: 30_000 }]);
      await sleep(2000);
      await capture(`${kind}-after-deny-esc`, `${kind} after Esc on the permission prompt (status ${seq2.join('→')}, marker exists: ${fs.existsSync(marker)})`);
      // if the agent kept working after esc, wait for it to settle
      await waitStatus(['idle', 'done', 'blocked'], 60_000);
    } else {
      await capture(`${kind}-after-prompt-${st.replace(/[^a-z]/g, '')}`, `${kind} after the prompt without a blocked state (status ${st}, marker exists: ${fs.existsSync(marker)})`);
    }
    fs.rmSync(marker, { force: true });
    if (kind === 'pi' || kind === 'codex') {
      await c.request('pane.send_text', { pane_id: P, text: '/model' });
      await sleep(400);
      await c.request('pane.send_keys', { pane_id: P, keys: ['enter'] });
      await sleep(1500);
      await capture(`${kind}-model-dialog`, `${kind} /model picker dialog (herdr status ${(await paneInfo()).agent_status})`);
      await c.request('pane.send_keys', { pane_id: P, keys: ['esc'] });
      await sleep(800);
    }
    // quit the agent
    if (kind === 'claude') { await run('/exit'); }
    else if (kind === 'codex') { await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] }); await sleep(400); await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] }); }
    else { await run('/exit'); await sleep(800); await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] }); await sleep(300); await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+d'] }); }
    const gone = await (async () => { const t0 = performance.now(); while (performance.now() - t0 < 30_000) { const p = await paneInfo(); if (!p.agent) return true; await sleep(500); } return false; })();
    log(`${kind} exited: ${gone}`);
    currentAgentName = null;
    if (!gone) { await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+c'] }); await sleep(500); await c.request('pane.send_keys', { pane_id: P, keys: ['ctrl+d'] }); await sleep(1000); }
    await sleep(1000);
  }
}

fs.writeFileSync(path.join(outDir, 'capture-events.log'), eventLog.join('\n') + '\n');
log('event log lines:', eventLog.length);
for (const l of eventLog) console.log('   ', l);
await c.request('tab.close', { tab_id: T }).catch((e) => log('tab.close err', String(e)));
sub.close();
fs.rmSync(workDir, { recursive: true, force: true });
process.exit(0);
