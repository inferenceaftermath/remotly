import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { agentDirs, agentSettingsStep, applyAgentSettings, applyPendingAgents, claudeRunning, isClaudeCommand, readAgentRecord, withClaudeTui, withCodexAltScreen } from '../src/agent-settings.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-agents-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const set = (text: string, was: string | null = null) => ({ kind: 'set', text, was });

test('agentDirs: CLAUDE_CONFIG_DIR and CODEX_HOME, else the dot dirs in home', () => {
  assert.deepEqual(agentDirs({}, '/home/u'), { claude: '/home/u/.claude', codex: '/home/u/.codex' });
  assert.deepEqual(agentDirs({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }, '/home/u'), { claude: '/c', codex: '/x' });
});

test('withClaudeTui: sets "tui": "default", keeps every other key, leaves a file that has it alone', () => {
  assert.deepEqual(withClaudeTui(null), set('{\n  "tui": "default"\n}\n'));
  assert.deepEqual(withClaudeTui('  '), set('{\n  "tui": "default"\n}\n'));
  assert.deepEqual(withClaudeTui('{"model":"opus","tui":"fullscreen","env":{"A":"1"}}'), set('{\n  "model": "opus",\n  "tui": "default",\n  "env": {\n    "A": "1"\n  }\n}\n', '"fullscreen"'));
  assert.deepEqual(withClaudeTui('{"tui":"default","x":1}'), { kind: 'kept' });
  assert.equal(withClaudeTui('{"a":1,}').kind, 'error');
  assert.equal(withClaudeTui('[1]').kind, 'error');
});

test('withCodexAltScreen: into the [tui] table, replacing another value, keeping comments and the rest', () => {
  assert.deepEqual(withCodexAltScreen(null), set('[tui]\nalternate_screen = "never"\n'));
  assert.deepEqual(withCodexAltScreen('model = "gpt-5"\n'), set('model = "gpt-5"\n\n[tui]\nalternate_screen = "never"\n'));
  assert.deepEqual(withCodexAltScreen('model = "gpt-5"'), set('model = "gpt-5"\n\n[tui]\nalternate_screen = "never"\n'));
  assert.deepEqual(
    withCodexAltScreen('# mine\n[tui]\nnotifications = true\n\n[profiles.fast]\nmodel = "x"\n'),
    set('# mine\n[tui]\nalternate_screen = "never"\nnotifications = true\n\n[profiles.fast]\nmodel = "x"\n'),
  );
  assert.deepEqual(
    withCodexAltScreen('[ tui ] # ui\nalternate_screen = "auto"   # was\n[mcp_servers.a]\n'),
    set('[ tui ] # ui\nalternate_screen = "never"\n[mcp_servers.a]\n', '"auto"'),
  );
  assert.deepEqual(withCodexAltScreen('[tui]\nalternate_screen = \'never\'\n'), { kind: 'kept' });
  // a sub-table of tui is not the tui table: a [tui] table may still be added after it
  assert.deepEqual(withCodexAltScreen('[tui.notifications]\nx = 1\n'), set('[tui.notifications]\nx = 1\n\n[tui]\nalternate_screen = "never"\n'));
  // the [tui] table of a profile is not the root one
  assert.deepEqual(withCodexAltScreen('[profiles.p.tui]\nalternate_screen = "always"\n'), set('[profiles.p.tui]\nalternate_screen = "always"\n\n[tui]\nalternate_screen = "never"\n'));
});

test('withCodexAltScreen: dotted keys at the root stay dotted (a [tui] header would define the table twice); inline tables are refused', () => {
  assert.deepEqual(withCodexAltScreen('tui.alternate_screen = "always"\n'), set('tui.alternate_screen = "never"\n', '"always"'));
  assert.deepEqual(withCodexAltScreen('tui.alternate_screen="never"\n[x]\n'), { kind: 'kept' });
  assert.deepEqual(withCodexAltScreen('model = "m"\ntui.notifications = true\n[x]\ny = 1\n'), set('model = "m"\ntui.notifications = true\ntui.alternate_screen = "never"\n[x]\ny = 1\n'));
  assert.equal(withCodexAltScreen('tui = { notifications = true }\n').kind, 'error');
});

test('withCodexAltScreen: quoted names, strings and arrays that look like tables, CRLF; what it cannot edit for sure it refuses', () => {
  // quoted header and key name the same table and key
  assert.deepEqual(withCodexAltScreen('["tui"]\n"alternate_screen" = "always"\n'), set('["tui"]\n"alternate_screen" = "never"\n', '"always"'));
  assert.deepEqual(withCodexAltScreen("[tui]\n'alternate_screen' = 'never'\n"), { kind: 'kept' });
  assert.deepEqual(withCodexAltScreen('"tui" . "alternate_screen" = "auto"\n'), set('"tui" . "alternate_screen" = "never"\n', '"auto"'));
  // a [tui] line inside a multi-line string or a multi-line array is not a table header
  const ml = 'notes = """\n[tui]\nalternate_screen = 1\n"""\nargs = [\n  ["tui"]\n]\n';
  assert.deepEqual(withCodexAltScreen(ml), set(`${ml}\n[tui]\nalternate_screen = "never"\n`));
  assert.deepEqual(withCodexAltScreen("lit = '''\n[tui]\n'''\n[tui]\nx = 1\n"), set("lit = '''\n[tui]\n'''\n[tui]\nalternate_screen = \"never\"\nx = 1\n"));
  // one or two quotes just before a multi-line string's closing three belong to the string
  const quoted = `x = ["""abc"""", 1]\ny = '''it'''''\n[tui]\nz = 1\n`;
  assert.deepEqual(withCodexAltScreen(quoted), set(quoted.replace('[tui]\n', '[tui]\nalternate_screen = "never"\n')));
  // an array of tables called tui cannot also be the tui table
  assert.equal(withCodexAltScreen('[[tui]]\nalternate_screen = "always"\n').kind, 'error');
  assert.equal(withCodexAltScreen('[[tui.hooks]]\nx = 1\n').kind, 'error');
  // a quoted key with a dot in it is one key, not tui.alternate_screen
  assert.deepEqual(withCodexAltScreen('"tui.alternate_screen" = "auto"\n'), set('"tui.alternate_screen" = "auto"\n\n[tui]\nalternate_screen = "never"\n'));
  // escapes in quoted names are read as TOML reads them; one TOML does not have is refused
  assert.deepEqual(withCodexAltScreen('["\\u0074ui"]\n"alternate_\\U00000073creen" = "auto"\n'), set('["\\u0074ui"]\n"alternate_\\U00000073creen" = "never"\n', '"auto"'));
  assert.equal(withCodexAltScreen('["t\\qui"]\n').kind, 'error');
  assert.equal(withCodexAltScreen('[tui]\nalternate_screen.x = 1\n').kind, 'error', 'a tui.alternate_screen table');
  // CRLF stays CRLF
  assert.deepEqual(withCodexAltScreen('model = "m"\r\n[tui]\r\nx = 1\r\n'), set('model = "m"\r\n[tui]\r\nalternate_screen = "never"\r\nx = 1\r\n'));
  assert.deepEqual(withCodexAltScreen('model = "m"\r\n'), set('model = "m"\r\n\r\n[tui]\r\nalternate_screen = "never"\r\n'));
  // refused, file untouched by the caller
  assert.equal(withCodexAltScreen('[tui]\nalternate_screen = "always"\n"alternate_screen" = "auto"\n').kind, 'error', 'set twice');
  assert.equal(withCodexAltScreen('[tui]\nalternate_screen = """\nauto\n"""\n').kind, 'error', 'value across lines');
  assert.equal(withCodexAltScreen('notes = """\nunterminated\n').kind, 'error', 'ends inside a string');
  assert.equal(withCodexAltScreen('[tui.alternate_screen]\nx = 1\n').kind, 'error');
});

test('applyAgentSettings: only installed agents, through a symlinked file, mode kept, said once', () => {
  const out: string[] = [];
  const dirs = { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') };
  applyAgentSettings({ dirs, env: {}, home: dir, out: (l) => out.push(l) });
  assert.equal(out.length, 0, 'neither installed: nothing written or said');
  assert.equal(fs.existsSync(dirs.claude), false);

  fs.mkdirSync(dirs.claude);
  const real = path.join(dir, 'dotfiles-settings.json');
  fs.writeFileSync(real, '{"model":"opus","tui":"fullscreen"}', { mode: 0o644 });
  fs.symlinkSync(real, path.join(dirs.claude, 'settings.json'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  applyAgentSettings({ dirs, env: { PATH: bin }, home: dir, out: (l) => out.push(l) });
  assert.ok(fs.lstatSync(path.join(dirs.claude, 'settings.json')).isSymbolicLink(), 'the link stays a link');
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { model: 'opus', tui: 'default' });
  assert.equal(fs.statSync(real).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(dirs.codex, 'config.toml'), 'utf8'), '[tui]\nalternate_screen = "never"\n');
  assert.equal(fs.statSync(path.join(dirs.codex, 'config.toml')).mode & 0o777, 0o600);
  assert.match(out[0]!, /Claude Code: "tui": "default" set in ~\/claude\/settings\.json \(was "fullscreen"\)/);
  assert.match(out[1]!, /\/exit, then claude --resume/);
  assert.match(out[2]!, /Codex: \[tui\] alternate_screen = "never" set in ~\/codex\/config\.toml/);

  out.length = 0;
  applyAgentSettings({ dirs, env: { PATH: bin }, home: dir, out: (l) => out.push(l) });
  assert.equal(out.length, 2);
  assert.ok(out.every((l) => l.startsWith('  ✔') && !l.includes(' set in ')), 'already set: said, not changed');

  // a link to a file that does not exist yet is left as it is (writing would replace the link)
  fs.rmSync(path.join(dirs.codex, 'config.toml'));
  const dangling = path.join(dir, 'dotfiles', 'codex.toml');
  fs.symlinkSync(dangling, path.join(dirs.codex, 'config.toml'));
  out.length = 0;
  applyAgentSettings({ dirs, env: { PATH: bin }, home: dir, out: (l) => out.push(l) });
  assert.match(out[1]!, /⚠ Codex: could not set .*a link to a file that does not exist/);
  assert.ok(fs.lstatSync(path.join(dirs.codex, 'config.toml')).isSymbolicLink());
  assert.equal(fs.existsSync(dangling), false);

  fs.writeFileSync(real, '{oops');
  out.length = 0;
  applyAgentSettings({ dirs, env: {}, home: dir, out: (l) => out.push(l) });
  assert.match(out[0]!, /⚠ Claude Code: could not set "tui": "default" .*not valid JSON/);
  assert.equal(fs.readFileSync(real, 'utf8'), '{oops', 'a file it cannot read is left as it is');
});

test('readAgentRecord: none is null; on, on with settings pending (absolute dirs only), off; anything it cannot read counts as off', () => {
  const file = path.join(dir, 'agent-settings.json');
  assert.equal(readAgentRecord(file), null);
  fs.writeFileSync(file, '{"choice":"on"}\n');
  assert.deepEqual(readAgentRecord(file), { choice: 'on' });
  fs.writeFileSync(file, '{"choice":"on","pending":{"claude":"/h/.claude","codex":"rel/dir","x":"/y"}}\n');
  assert.deepEqual(readAgentRecord(file), { choice: 'on', pending: { claude: '/h/.claude' } });
  fs.writeFileSync(file, '{"choice":"on","pending":{"codex":3}}\n');
  assert.deepEqual(readAgentRecord(file), { choice: 'on' });
  fs.writeFileSync(file, '{"choice":"off","pending":{"claude":"/h/.claude"}}\n');
  assert.deepEqual(readAgentRecord(file), { choice: 'off' });
  for (const junk of ['', '{oops', '[]', '{"choice":"maybe"}', 'null']) {
    fs.writeFileSync(file, junk);
    assert.deepEqual(readAgentRecord(file), { choice: 'off' }, JSON.stringify(junk));
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepEqual(readAgentRecord(file), { choice: 'off' }, 'unreadable');
});

test('agentSettingsStep: by hand always (recorded), skipped when asked (recorded); unattended only once, on an install with no record', () => {
  const out: string[] = [];
  const dirs = { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') };
  fs.mkdirSync(dirs.claude);
  fs.mkdirSync(dirs.codex);
  const record = path.join(dir, 'config', 'agent-settings.json');
  const claudeFile = path.join(dirs.claude, 'settings.json');
  const codexFile = path.join(dirs.codex, 'config.toml');
  let running = false;
  let looked = 0;
  const d = { dirs, env: {}, home: dir, out: (l: string) => out.push(l), record, claudeRunning: () => (looked++, running) };
  const reset = () => {
    for (const f of [claudeFile, codexFile, record]) fs.rmSync(f, { force: true });
    out.length = 0;
    looked = 0;
  };

  agentSettingsStep(d, { unattended: false, skip: true });
  assert.deepEqual(readAgentRecord(record), { choice: 'off' });
  assert.equal(fs.existsSync(claudeFile) || fs.existsSync(codexFile), false);
  assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.equal(fs.existsSync(codexFile), false, 'off: an update leaves them alone');

  running = true; // by hand the user reads what to restart, so a running Claude Code does not hold it back
  agentSettingsStep(d, { unattended: false, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on' });
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), { tui: 'default' });
  assert.ok(fs.existsSync(codexFile));
  fs.writeFileSync(claudeFile, '{"tui":"fullscreen"}');
  fs.rmSync(codexFile);
  out.length = 0;
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), '{"tui":"fullscreen"}', 'recorded: the user\'s own edits since stand');
  assert.equal(fs.existsSync(codexFile), false);
  assert.equal(out.length, 0);

  // an install from before the record: its first update sets both, once
  reset();
  running = false;
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on' });
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), { tui: 'default' });
  assert.ok(fs.existsSync(codexFile));
  assert.equal(looked, 1, 'looked for a running Claude Code right before the write');
  fs.rmSync(codexFile);
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.equal(fs.existsSync(codexFile), false, 'only once');

  // ... with Claude Code running: Codex now, Claude Code left to the daemon, in the directory used here
  reset();
  running = true;
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on', pending: { claude: dirs.claude } });
  assert.equal(fs.existsSync(claudeFile), false, 'a running session would redraw badly');
  assert.ok(fs.existsSync(codexFile));
  assert.ok(out.some((l) => l.includes('⚠ Claude Code is running')));
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on', pending: { claude: dirs.claude } }, 'the next update leaves it to the daemon');
  agentSettingsStep(d, { unattended: false, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on' }, 'setup by hand sets it now');
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), { tui: 'default' });

  // ... with Claude Code running but already set: nothing to write, nothing pending
  fs.rmSync(record);
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on' });

  // ... an edit that fails is left pending, not recorded as made
  reset();
  running = false;
  fs.writeFileSync(codexFile, 'tui = { alternate_screen = "always" }\n');
  fs.writeFileSync(claudeFile, '{oops');
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on', pending: { claude: dirs.claude, codex: dirs.codex } });
  assert.equal(fs.readFileSync(codexFile, 'utf8'), 'tui = { alternate_screen = "always" }\n');

  // Claude Code not installed: running or not, nothing is pending
  reset();
  running = true;
  fs.rmSync(dirs.claude, { recursive: true });
  agentSettingsStep(d, { unattended: true, skip: false });
  assert.deepEqual(readAgentRecord(record), { choice: 'on' });
  assert.equal(fs.existsSync(dirs.claude), false);
});

test('applyPendingAgents: Claude Code once no session of it runs, a failed edit again until it works, in the recorded dirs; a setup meanwhile has the last word', () => {
  const out: string[] = [];
  const dirs = { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') };
  fs.mkdirSync(dirs.claude);
  fs.mkdirSync(dirs.codex);
  const record = path.join(dir, 'agent-settings.json');
  const claudeFile = path.join(dirs.claude, 'settings.json');
  const codexFile = path.join(dirs.codex, 'config.toml');
  let running: () => boolean = () => true;
  const d = { env: {}, home: dir, out: (l: string) => out.push(l), record, claudeRunning: () => running() };
  assert.equal(applyPendingAgents(d), 'none', 'no record');
  for (const r of ['{"choice":"on"}', '{"choice":"off"}', '{oops', `{"choice":"off","pending":{"claude":${JSON.stringify(dirs.claude)}}}`]) {
    fs.writeFileSync(record, r);
    assert.equal(applyPendingAgents(d), 'none', r);
  }
  assert.equal(fs.existsSync(claudeFile), false);

  fs.writeFileSync(record, JSON.stringify({ choice: 'on', pending: { claude: dirs.claude } }));
  assert.equal(applyPendingAgents(d), 'waiting');
  assert.equal(fs.existsSync(claudeFile), false);
  running = () => false;
  assert.equal(applyPendingAgents(d), 'done');
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), { tui: 'default' });
  assert.deepEqual(readAgentRecord(record), { choice: 'on' });
  assert.match(out[0]!, /Claude Code: "tui": "default" set in ~\/claude\/settings\.json/);
  assert.equal(applyPendingAgents(d), 'none');

  // a failed Codex edit: tried again, and made once the file can be edited
  fs.writeFileSync(codexFile, 'tui = { alternate_screen = "always" }\n');
  fs.writeFileSync(record, JSON.stringify({ choice: 'on', pending: { codex: dirs.codex } }));
  assert.equal(applyPendingAgents(d), 'failed');
  assert.deepEqual(readAgentRecord(record), { choice: 'on', pending: { codex: dirs.codex } });
  fs.writeFileSync(codexFile, 'model = "x"\n');
  assert.equal(applyPendingAgents(d), 'done');
  assert.equal(fs.readFileSync(codexFile, 'utf8'), 'model = "x"\n\n[tui]\nalternate_screen = "never"\n');

  // `setup --no-agent-settings` while the daemon looks: its record stands
  fs.rmSync(claudeFile);
  fs.writeFileSync(record, JSON.stringify({ choice: 'on', pending: { claude: dirs.claude } }));
  running = () => {
    fs.writeFileSync(record, '{"choice":"off"}');
    return false;
  };
  assert.equal(applyPendingAgents(d), 'none');
  assert.deepEqual(readAgentRecord(record), { choice: 'off' });
});

test('isClaudeCommand: the native binary, a link to it, node running the package; not other programs', () => {
  for (const argv of [['claude'], ['claude', '--resume', 'x'], ['/home/u/.local/bin/claude'], ['/home/u/.local/share/claude/versions/2.1.0', '--model', 'opus'], ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], ['node', '/home/u/.npm-global/bin/claude']]) {
    assert.equal(isClaudeCommand(argv), true, argv.join(' '));
  }
  for (const argv of [[''], ['bash'], ['codex', '--model', 'claude'], ['vim', 'notes/claude.md'], ['/usr/bin/claude-monitor'], ['bash', '-c', 'source /home/u/.claude/shell-snapshots/s.sh']]) {
    assert.equal(isClaudeCommand(argv), false, argv.join(' '));
  }
});

test('claudeRunning: this user\'s processes from /proc; ps where there is no /proc; yes whenever something cannot be read', () => {
  const uid = process.getuid!();
  const proc = path.join(dir, 'proc');
  const pid = (n: number, argv: string[]) => {
    fs.mkdirSync(path.join(proc, String(n)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(n), 'cmdline'), argv.join('\0') + '\0');
  };
  pid(10, ['bash']);
  pid(11, ['codex', 'exec']);
  fs.mkdirSync(path.join(proc, 'self'));
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(proc, '13')); // ended between the listing and the look
  assert.equal(claudeRunning(uid, { procDir: proc }), false);
  assert.equal(claudeRunning(uid + 1, { procDir: proc }), false);
  fs.mkdirSync(path.join(proc, '14', 'cmdline'), { recursive: true }); // a command line that cannot be read
  assert.equal(claudeRunning(uid, { procDir: proc }), true, 'not known: counted as running');
  assert.equal(claudeRunning(uid + 1, { procDir: proc }), false, 'another user\'s process is not looked into');
  fs.rmSync(path.join(proc, '14'), { recursive: true });
  pid(12, ['claude', '--resume']);
  assert.equal(claudeRunning(uid, { procDir: proc }), true);
  assert.equal(claudeRunning(uid + 1, { procDir: proc }), false, 'another user\'s sessions are not this user\'s settings');

  const none = path.join(dir, 'no-proc');
  assert.equal(claudeRunning(uid, { procDir: none, ps: () => `  ${uid} bash\n  ${uid} codex exec\n` }), false);
  assert.equal(claudeRunning(uid, { procDir: none, ps: () => `  ${uid + 1} claude\n  ${uid} /Users/u/.local/bin/claude --model opus\n` }), true);
  assert.equal(claudeRunning(uid, { procDir: none, ps: () => `  ${uid + 1} claude\n` }), false);
  assert.equal(claudeRunning(uid, { procDir: none, ps: () => { throw new Error('no ps'); } }), true);
});
