import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sttyDeviceFlag, ttyFromPs, ttyOfPid } from '../../src/herdr/tty.ts';

test('sttyDeviceFlag: GNU stty takes -F, BSD/macOS stty -f', () => {
  assert.equal(sttyDeviceFlag('linux'), '-F');
  assert.equal(sttyDeviceFlag('darwin'), '-f');
  assert.equal(sttyDeviceFlag('freebsd'), '-F');
});

test('ttyFromPs: what ps prints becomes a device path; "no tty" markers become null', () => {
  assert.equal(ttyFromPs('ttys003\n'), '/dev/ttys003');
  assert.equal(ttyFromPs('  pts/3\n'), '/dev/pts/3');
  assert.equal(ttyFromPs('/dev/pts/3\n'), '/dev/pts/3');
  assert.equal(ttyFromPs('??\n'), null);
  assert.equal(ttyFromPs('?\n'), null);
  assert.equal(ttyFromPs('-\n'), null);
  assert.equal(ttyFromPs('\n'), null);
});

test('ttyOfPid: /proc first (a device on stdin, else null), ps where there is no /proc, null when neither answers', async () => {
  const procs = new Map<string, string>([['/proc/100/fd/0', '/dev/pts/7'], ['/proc/101/fd/0', 'pipe:[1234]']]);
  const readlink = (p: string): string => {
    const v = procs.get(p);
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };
  const asked: number[] = [];
  const ps = async (pid: number): Promise<string> => {
    asked.push(pid);
    return pid === 200 ? 'ttys004\n' : pid === 201 ? '??\n' : Promise.reject(new Error('ps failed'));
  };
  assert.equal(await ttyOfPid(100, { readlink, ps }), '/dev/pts/7');
  assert.equal(await ttyOfPid(101, { readlink, ps }), null, 'a pipe on stdin is not a tty, and ps is not asked');
  assert.deepEqual(asked, []);
  assert.equal(await ttyOfPid(200, { readlink, ps }), '/dev/ttys004', 'no /proc entry: ps answers');
  assert.equal(await ttyOfPid(201, { readlink, ps }), null);
  assert.equal(await ttyOfPid(202, { readlink, ps }), null, 'ps failing is no tty, not an error');
  assert.deepEqual(asked, [200, 201, 202]);
});
