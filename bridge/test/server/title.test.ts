import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaneInfo } from '../../src/herdr/types.ts';
import { cleanTitle, paneTitle } from '../../src/server/hub.ts';

test('cleanTitle drops the agent status glyph herdr leaves on terminal titles', () => {
  assert.equal(cleanTitle('◑ Remotly app UI/UX improvements'), 'Remotly app UI/UX improvements');
  assert.equal(cleanTitle('✳ Landing page concepts generation'), 'Landing page concepts generation');
  assert.equal(cleanTitle('⠹ building'), 'building');
  assert.equal(cleanTitle('· ✻ two glyphs'), 'two glyphs');
  assert.equal(cleanTitle('  padded  '), 'padded');
});

test('cleanTitle keeps titles that start with a letter or a symbol that is not a glyph; an all-glyph title is empty', () => {
  assert.equal(cleanTitle('π - notes'), 'π - notes');
  assert.equal(cleanTitle('[WIP] fix tests'), '[WIP] fix tests');
  assert.equal(cleanTitle('~/remotly'), '~/remotly');
  assert.equal(cleanTitle('✳'), '');
  assert.equal(cleanTitle('◑ '), '');
  assert.equal(cleanTitle(''), '');
});

test('paneTitle prefers herdr title, then label, then the stripped terminal title, and cleans each', () => {
  const base = { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'idle', focused: false } as PaneInfo;
  assert.equal(paneTitle({ ...base, title: '✳ named', terminal_title_stripped: 'other' }), 'named');
  assert.equal(paneTitle({ ...base, label: 'Distribution', terminal_title: '◑ x' }), 'Distribution');
  assert.equal(paneTitle({ ...base, terminal_title_stripped: '◑ Remotly app UI/UX improvements' }), 'Remotly app UI/UX improvements');
  assert.equal(paneTitle({ ...base, terminal_title: '✳ raw only' }), 'raw only');
  assert.equal(paneTitle(base), 'w1:p1');
});
