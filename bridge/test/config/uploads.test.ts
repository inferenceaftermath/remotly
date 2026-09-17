import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, validateConfig } from '../../src/config.ts';

test('uploads: defaults, overrides with ~ expansion, and bounds', () => {
  const d = defaultConfig();
  assert.equal(d.uploads.keep_days, 14);
  assert.equal(d.uploads.max_mb, 20);
  assert.ok(d.uploads.dir.endsWith('/.local/share/remotly/uploads'), d.uploads.dir);
  const c = validateConfig({ uploads: { dir: '~/photos', keep_days: 3, max_mb: 5 } });
  assert.equal(c.uploads.keep_days, 3);
  assert.equal(c.uploads.max_mb, 5);
  assert.ok(!c.uploads.dir.startsWith('~') && c.uploads.dir.endsWith('/photos'), c.uploads.dir);
  assert.throws(() => validateConfig({ uploads: { max_mb: 0 } }), /uploads\.max_mb/);
  assert.throws(() => validateConfig({ uploads: { keep_days: 'week' } }), /uploads\.keep_days/);
  const warnings: string[] = [];
  validateConfig({ uploads: { dir: '/tmp/x', bogus: 1 } }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => w.includes('uploads.bogus')), warnings.join('; '));
});
