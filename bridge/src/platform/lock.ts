// One install or update at a time: a kernel lock (flock(2)) on <home>/update.lock, held by an open descriptor for as
// long as any process has it — this run, and the installer it hands the descriptor to. Linux runs the update under
// flock(1) and finds the inherited descriptor under /proc/self/fd (the links name the files). macOS has neither: perl's
// flock stands in (perl ships with macOS; the same flock(2) underneath), and the descriptor's number travels in
// REMOTLY_UPDATE_LOCK_FD, checked against the lock file by fstat before it is believed.

/**
 * What flock(1) exits with when the lock is taken (`-E`), and what the perl stand-in exits with. Outside 0, 1 and 2
 * (the run under the lock), 64–78 (flock's own failures, sysexits: 66 when it cannot open the lock file, 69 when it
 * cannot run the command), 126/127 (newer flocks for the latter) and 128+ (the command killed by a signal).
 */
export const LOCK_TAKEN_EXIT = 99;
/** Where the perl stand-in leaves the lock descriptor's number for the command it runs, and `update` for the installer. */
export const LOCK_FD_ENV = 'REMOTLY_UPDATE_LOCK_FD';

/** perl: open the lock file, flock it (`$taken` when another one holds it), keep the descriptor across exec, tell the command its number, run it. */
const PERL_RELOCK = [
  'use Fcntl qw(:flock F_GETFD F_SETFD FD_CLOEXEC);',
  'my ($lock, $taken, @cmd) = @ARGV;',
  'open(my $fh, ">>", $lock) or exit 66;',
  'flock($fh, LOCK_EX | LOCK_NB) or exit $taken;',
  'fcntl($fh, F_SETFD, fcntl($fh, F_GETFD, 0) & ~FD_CLOEXEC) or exit 66;',
  `$ENV{${LOCK_FD_ENV}} = fileno($fh);`,
  'exec @cmd or exit 69;',
].join(' ');
/** perl: flock the open descriptor `$fd` as it is (no dup: the lock is on the open file); `$taken` when another one holds it. */
const PERL_CONFIRM = 'use Fcntl qw(:flock); my ($fd, $taken) = @ARGV; open(my $fh, ">>&=", $fd) or exit 66; flock($fh, LOCK_EX | LOCK_NB) or exit $taken; exit 0;';

/** The tool that takes the lock, by name (messages). */
export const lockTool = (platform: string): string => (platform === 'darwin' ? 'perl' : 'flock');

/** `cmd` again, under the lock on `lock`: the locking process holds the descriptor for as long as the command (and whatever it hands the descriptor to) lives. */
export function lockedCommand(platform: string, lock: string, cmd: string[]): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'perl', args: ['-e', PERL_RELOCK, lock, String(LOCK_TAKEN_EXIT), ...cmd] };
  return { cmd: 'flock', args: ['-n', '-E', String(LOCK_TAKEN_EXIT), lock, ...cmd] };
}

/** Confirms (or takes) the lock on the open file behind descriptor `fd` of the process that runs this; LOCK_TAKEN_EXIT when another one holds it. */
export function confirmCommand(platform: string, fd = 3): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'perl', args: ['-e', PERL_CONFIRM, String(fd), String(LOCK_TAKEN_EXIT)] };
  return { cmd: 'flock', args: ['-n', '-E', String(LOCK_TAKEN_EXIT), String(fd)] };
}

/** What a missing lock tool means: on Linux flock is a package, on macOS perl is part of the system. */
export function lockToolMissing(platform: string): string {
  return platform === 'darwin' ? 'perl is needed to run one update at a time (macOS ships it at /usr/bin/perl); put it on PATH and run again' : 'flock (util-linux) is needed to run one update at a time; install it and run again';
}
