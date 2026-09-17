import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseApprovalDialog } from '../../src/approvals/dialog.ts';

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, '../../../shared/fixtures/reads', name), 'utf8');

test('Claude Bash dialog → tool, command, description, question and the four options', () => {
  assert.deepEqual(parseApprovalDialog(fixture('claude-permission-prompt.txt')), {
    tool: 'Bash',
    command: 'touch /tmp/flow-capture-marker-claude.txt',
    path: null,
    description: 'Create marker file',
    question: 'Do you want to proceed?',
    options: ['Yes', 'Yes, and always allow access to /tmp from this project', 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No'],
    selected: 1,
    kind: 'permission',
  });
});

test('a question menu (AskUserQuestion) is kind choice and reports where the marker is', () => {
  const screen = ['', ' Which database should the service use?', '', '   1. Postgres', ' ❯ 2. SQLite', '   3. Other', '', ' Enter to select · Esc to cancel'].join('\n');
  const d = parseApprovalDialog(screen);
  assert.ok(d);
  assert.equal(d.kind, 'choice');
  assert.equal(d.selected, 2);
  assert.deepEqual(d.options, ['Postgres', 'SQLite', 'Other']);
  const unmarked = parseApprovalDialog(screen.replace('❯', ' '));
  assert.equal(unmarked?.selected, null);
  // A yes/no question that is not a permission gate stays a choice.
  const yesno = parseApprovalDialog(['', ' Should the deploy include the migrations?', '', ' ❯ 1. Yes', '   2. No'].join('\n'));
  assert.equal(yesno?.kind, 'choice');
});

test('Codex command dialog → Shell command, reason, wrapped option label rejoined', () => {
  const d = parseApprovalDialog(fixture('codex-permission-prompt.txt'));
  assert.ok(d);
  assert.equal(d.tool, 'Shell');
  assert.equal(d.command, 'touch /home/user/Desktop/remotly/.capture/flow-capture-marker-codex.txt');
  assert.equal(d.path, null);
  assert.equal(d.description, 'Allow creating the requested marker file in /home/user/Desktop/remotly/.capture/?');
  assert.equal(d.question, 'Would you like to run the following command?');
  assert.deepEqual(d.options, [
    'Yes, proceed (y)',
    "Yes, and don't ask again for commands that start with `touch /home/user/Desktop/remotly/.capture/ flow-capture-marker-codex.txt` (p)",
    'No, and tell Codex what to do differently (esc)',
  ]);
});

test('Claude file dialog → tool and path, diff body ignored', () => {
  const screen = [
    '─────────────────────────────────────────────',
    ' Edit file',
    ' ╭───────────────────────────────────────────╮',
    ' │ src/server/session.ts                      │',
    ' │                                            │',
    ' │  12 -  const a = 1;                        │',
    ' │  12 +  const a = 2;                        │',
    ' ╰───────────────────────────────────────────╯',
    ' Do you want to make this edit to session.ts?',
    ' ❯ 1. Yes',
    '   2. Yes, allow all edits during this session (shift+tab)',
    "   3. No, and tell Claude what to do differently (esc)",
    '',
    ' Esc to cancel',
  ].join('\n');
  const d = parseApprovalDialog(screen);
  assert.ok(d);
  assert.equal(d.tool, 'Edit');
  assert.equal(d.path, 'src/server/session.ts');
  assert.equal(d.command, null);
  assert.equal(d.description, null);
  assert.equal(d.question, 'Do you want to make this edit to session.ts?');
  assert.equal(d.options.length, 3);
});

test('idle screens, trust dialogs and model pickers are not approval dialogs', () => {
  for (const name of ['claude-idle.txt', 'codex-idle.txt', 'claude-trust-dialog.txt', 'codex-trust-dialog.txt', 'codex-model-dialog.txt', 'shell-ls-color.txt', 'less.txt']) {
    assert.equal(parseApprovalDialog(fixture(name)), null, name);
  }
  assert.equal(parseApprovalDialog(''), null);
  assert.equal(parseApprovalDialog('Do you want to proceed?\n 1. Yes'), null, 'a single choice is not a dialog');
});

test("a user's own question echoed in the transcript is not mistaken for the dialog question", () => {
  const screen = ['❯ can you run the tests?', '', ' Bash command', '', '   npm test', '   Run the test suite', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
  const d = parseApprovalDialog(screen);
  assert.ok(d);
  assert.equal(d.question, 'Do you want to proceed?');
  assert.equal(d.tool, null, 'no rule above the header: header is not trusted');
  assert.deepEqual(d.options, ['Yes', 'No']);
});
