// Structured logger: one JSON line per event on stdout (systemd journal captures it).
// Policy (SECURITY.md): `info` never carries tokens or pane text (screen contents, titles, labels, typed text, error
// messages that quote the client); pane and device ids may appear at any level. `debug` may carry anything but tokens.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** True when `debug` lines are emitted; lets callers skip building expensive debug fields. */
  readonly debugEnabled: boolean;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  return v in LEVELS ? (v as LogLevel) : fallback;
}

/** Errors do not JSON.stringify usefully; flatten them so the journal keeps message + code. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    const out: LogFields = { message: value.message, name: value.name };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out['code'] = code;
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for finished lines (default: stdout). Tests capture lines here. */
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const threshold = LEVELS[opts.level ?? parseLevel(process.env['REMOTLY_LOG'])];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => new Date());
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVELS[level] < threshold) return;
    const record: LogFields = { ts: now().toISOString(), level, event };
    if (fields) for (const [k, v] of Object.entries(fields)) if (v !== undefined) record[k] = plain(v);
    write(JSON.stringify(record));
  };
  return {
    debugEnabled: threshold <= LEVELS.debug,
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

/** Process-wide default; level from env REMOTLY_LOG (debug|info|warn|error, default info). */
export const log: Logger = createLogger();

/** Logger that discards everything (tests, CLI subcommands that print their own output). */
export const silentLogger: Logger = createLogger({ level: 'error', write: () => {} });
