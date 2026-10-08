import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { agentDirs, applyAgentSettings, withClaudeTui, withCodexAltScreen } from '../src/agent-settings.ts';

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
