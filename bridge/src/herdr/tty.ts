// A pane's tty and `stty` on it, per platform: GNU stty names the device with `-F`, BSD/macOS stty with `-f`; the tty of
// a pid is a /proc link on Linux and a `ps` column where there is no /proc.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

export function sttyDeviceFlag(platform: string = process.platform): '-F' | '-f' {
  return platform === 'darwin' ? '-f' : '-F';
}

/** `stty <device flag> <tty> args…`, its stdout; rejects when stty fails (a vanished tty, a PTY that refuses the write). */
export function stty(tty: string, args: string[], platform: string = process.platform): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('stty', [sttyDeviceFlag(platform), tty, ...args], { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}

/** What `ps -o tty=` prints — `ttys003`, `pts/3`, `??` (none) — as a device path, or null. */
export function ttyFromPs(out: string): string | null {
  const t = out.trim();
  if (!t || t === '??' || t === '?' || t === '-') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

const defaultPs = (pid: number): Promise<string> =>
  new Promise((resolve, reject) => execFile('ps', ['-o', 'tty=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

/**
 * The tty on `pid`'s stdin: `/proc/<pid>/fd/0` where /proc names it (Linux), else `ps -o tty= -p <pid>` (macOS). Null
 * when neither says (the process is gone, or its stdin is not a device).
 */
export async function ttyOfPid(pid: number, io: { readlink?: (p: string) => string; ps?: (pid: number) => Promise<string> } = {}): Promise<string | null> {
  const readlink = io.readlink ?? fs.readlinkSync;
  try {
    const tty = readlink(`/proc/${pid}/fd/0`);
    return tty.startsWith('/dev/') ? tty : null;
  } catch {
    /* no /proc here, or the process is gone: ask ps */
  }
  try {
    return ttyFromPs(await (io.ps ?? defaultPs)(pid));
  } catch {
    return null;
  }
}
