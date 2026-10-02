import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { LOCK_FD_ENV, LOCK_TAKEN_EXIT, confirmCommand, lockToolMissing, lockTool, lockedCommand } from '../../src/platform/lock.ts';
import { inheritedLockFd } from '../../src/update.ts';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotly-lock-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const hasPerl = (): boolean => spawnSync('perl', ['-e', 'use Fcntl qw(:flock); exit 0']).status === 0;
/** What another process sees: 0 when the lock is free (and taken for an instant), LOCK_TAKEN_EXIT while someone holds it. */
const probe = (lock: string): number | null => spawnSync('perl', ['-e', 'use Fcntl qw(:flock); open(my $fh, ">>", $ARGV[0]) or exit 66; flock($fh, LOCK_EX | LOCK_NB) or exit $ARGV[1]; exit 0', lock, String(LOCK_TAKEN_EXIT)]).status;

test('lockedCommand and confirmCommand: flock(1) on Linux, perl on macOS, the same exit code for "taken"', () => {
  assert.deepEqual(lockedCommand('linux', '/h/update.lock', ['/usr/bin/node', '/h/app/src/main.ts', 'update']), { cmd: 'flock', args: ['-n', '-E', '99', '/h/update.lock', '/usr/bin/node', '/h/app/src/main.ts', 'update'] });
  const mac = lockedCommand('darwin', '/h/update.lock', ['/usr/local/bin/node', '/h/app/src/main.ts', 'update']);
  assert.equal(mac.cmd, 'perl');
  assert.equal(mac.args[0], '-e');
  assert.match(mac.args[1]!, /flock\(\$fh, LOCK_EX \| LOCK_NB\)/);
  assert.match(mac.args[1]!, new RegExp(`\\$ENV\\{${LOCK_FD_ENV}\\} = fileno`));
  assert.deepEqual(mac.args.slice(2), ['/h/update.lock', '99', '/usr/local/bin/node', '/h/app/src/main.ts', 'update']);
  assert.deepEqual(confirmCommand('linux', 3), { cmd: 'flock', args: ['-n', '-E', '99', '3'] });
  const confirm = confirmCommand('darwin', 3);
  assert.equal(confirm.cmd, 'perl');
  assert.match(confirm.args[1]!, /open\(my \$fh, ">>&=", \$fd\)/, 'the descriptor itself, not a copy: the lock is on the open file');
  assert.deepEqual(confirm.args.slice(2), ['3', '99']);
  assert.equal(lockTool('linux'), 'flock');
  assert.equal(lockTool('darwin'), 'perl');
  assert.match(lockToolMissing('linux'), /util-linux/);
  assert.match(lockToolMissing('darwin'), /perl is needed/);
});

test('inheritedLockFd without /proc: the descriptor named by the environment, and only when it is open on the lock file', () => {
  const lock = path.join(dir, 'update.lock');
  const other = path.join(dir, 'other');
  fs.writeFileSync(lock, '');
  fs.writeFileSync(other, '');
  const fd = fs.openSync(lock, 'a');
  const wrong = fs.openSync(other, 'a');
  const noProc = path.join(dir, 'no-proc');
  try {
    assert.equal(inheritedLockFd(lock, { [LOCK_FD_ENV]: String(fd) }, noProc), fd);
    assert.equal(inheritedLockFd(lock, { [LOCK_FD_ENV]: String(wrong) }, noProc), null, 'a descriptor on another file is not the lock');
    assert.equal(inheritedLockFd(lock, { [LOCK_FD_ENV]: '2' }, noProc), null, 'stdio is never the lock');
    assert.equal(inheritedLockFd(lock, { [LOCK_FD_ENV]: 'three' }, noProc), null);
    assert.equal(inheritedLockFd(lock, {}, noProc), null);
    assert.equal(inheritedLockFd(lock, { [LOCK_FD_ENV]: '9999' }, noProc), null, 'a closed descriptor');
    // With /proc, the links decide and the environment is not consulted (Linux).
    if (process.platform === 'linux') assert.equal(inheritedLockFd(lock, { [LOCK_FD_ENV]: String(wrong) }), fd);
  } finally {
    fs.closeSync(fd);
    fs.closeSync(wrong);
  }
});

test('the perl lock, for real: held by the locked command and whatever inherits the descriptor, taken by nobody else meanwhile, released when the last holder exits', async (t) => {
  if (!hasPerl()) return t.skip('needs perl with Fcntl');
  const lock = path.join(dir, 'update.lock');
  const src = path.resolve('src/update.ts');
  // The command under the lock: a node that finds the inherited descriptor the macOS way (no /proc) and then lingers.
  const script = `import { inheritedLockFd } from ${JSON.stringify(src)};
const fd = inheritedLockFd(process.env.LOCK, process.env, '/nonexistent/proc');
process.stdout.write(process.env[${JSON.stringify(LOCK_FD_ENV)}] + ' ' + fd + '\\n');
setTimeout(() => {}, 1500);`;
  const { cmd, args } = lockedCommand('darwin', lock, [process.execPath, '--input-type=module', '-e', script]);
  const child = spawn(cmd, args, { env: { ...process.env, LOCK: lock }, stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(String(d).trim())));
  const [named, found] = line.split(' ');
  assert.ok(Number(named) >= 3, `the locking process named its descriptor (${line})`);
  assert.equal(found, named, 'and the command found that very descriptor by fstat');
  assert.equal(probe(lock), LOCK_TAKEN_EXIT, 'held: another install or update would see the lock taken');
  const again = spawnSync(cmd, args, { env: { ...process.env, LOCK: lock } });
  assert.equal(again.status, LOCK_TAKEN_EXIT, 'a second locked run ends with the "taken" code without running its command');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.equal(probe(lock), 0, 'released when the holder exited');

  // confirmCommand on an inherited descriptor: the lock it takes stays with this process's descriptor once perl is gone.
  const fd = fs.openSync(lock, 'a');
  try {
    const confirm = confirmCommand('darwin', 3);
    assert.equal(spawnSync(confirm.cmd, confirm.args, { stdio: ['ignore', 'pipe', 'pipe', fd] }).status, 0);
    assert.equal(probe(lock), LOCK_TAKEN_EXIT, 'the test process holds the lock through its own descriptor');
    assert.equal(spawnSync(confirm.cmd, confirm.args, { stdio: ['ignore', 'pipe', 'pipe', fd] }).status, 0, 'confirming again on the same open file is not a conflict');
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(probe(lock), 0);
});
