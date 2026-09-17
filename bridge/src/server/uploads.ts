// Photos the phone sends (`POST /upload`, protocol §2): stored as files the program in a pane can read by
// path. Nothing is ever served back; day folders older than `keepDays` are pruned on each save.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';

export type UploadType = 'image/jpeg' | 'image/png';
const EXTENSION: Record<UploadType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The accepted image type named by a `content-type` header (parameters ignored), or null. */
export function uploadType(contentType: string | string[] | undefined): UploadType | null {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  const type = (raw ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/png') return 'image/png';
  return null;
}

export interface UploadStoreOptions {
  dir: string;
  keepDays: number;
  maxBytes: number;
  log?: Logger;
  now?: () => Date;
}

export interface SavedUpload {
  /** Absolute path of the stored file. */
  path: string;
  bytes: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayName = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export class UploadStore {
  readonly dir: string;
  readonly keepDays: number;
  readonly maxBytes: number;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;

  constructor(opts: UploadStoreOptions) {
    this.dir = opts.dir;
    this.keepDays = opts.keepDays;
    this.maxBytes = opts.maxBytes;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  /** `<dir>/<YYYY-MM-DD>/<HHMMSS>-<6 hex>.<ext>` (local time), 0600 in 0700 folders. */
  async save(data: Buffer, type: UploadType): Promise<SavedUpload> {
    const now = this.now();
    const folder = path.join(this.dir, dayName(now));
    await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const file = path.join(folder, `${stamp}-${crypto.randomBytes(3).toString('hex')}.${EXTENSION[type]}`);
    await fs.promises.writeFile(file, data, { mode: 0o600, flag: 'wx' });
    this.prune(now);
    return { path: file, bytes: data.length };
  }

  /** Remove day folders older than `keepDays` (judged by their name, so nothing else in `dir` is touched). */
  prune(now = this.now()): string[] {
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - this.keepDays);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !DAY.test(e.name)) continue;
      const [y, m, d] = e.name.split('-').map(Number) as [number, number, number];
      if (new Date(y, m - 1, d) >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.dir, e.name), { recursive: true, force: true });
        removed.push(e.name);
      } catch (err) {
        this.log?.warn('upload.prune_failed', { folder: e.name, error: (err as Error).message });
      }
    }
    if (removed.length > 0) this.log?.info('upload.pruned', { folders: removed });
    return removed;
  }
}
