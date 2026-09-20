import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { plan, promote } from '../play-promote.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'ci@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const tracks = [
  { track: 'production', releases: [{ name: '0.1.0 (30)', status: 'completed', versionCodes: ['30'] }] },
  { track: 'beta' }, { track: 'alpha' },
  { track: 'internal', releases: [{ name: '36', status: 'completed', versionCodes: ['36'] }, { name: '35', status: 'completed', versionCodes: ['35'] }] },
];

/** A fake Play: records every call, answers the token exchange, the edit, the tracks; fails the calls named in `fail`. */
function fakePlay({ tracks: t = tracks, fail = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https:\/\/androidpublisher\.googleapis\.com\/androidpublisher\/v3\/applications\/[^/]+/, '');
    calls.push({ method, path: url.startsWith('https://oauth2') ? 'token' : path, body: init.body ? (init.body.startsWith('grant_type') ? 'jwt' : JSON.parse(init.body)) : undefined });
    const respond = (status, obj) => ({ ok: status < 300, status, json: async () => obj, text: async () => (obj === undefined ? '' : JSON.stringify(obj)) });
    if (url.startsWith('https://oauth2')) return respond(200, { access_token: 'tok' });
    if (fail.includes(`${method} ${path}`)) return respond(400, { error: 'nope' });
    if (method === 'POST' && path === '/edits') return respond(200, { id: 'e1' });
    if (method === 'GET' && path === '/edits/e1/tracks') return respond(200, { tracks: t });
    if (method === 'PUT' && path === '/edits/e1/tracks/production') return respond(200, init.body && JSON.parse(init.body));
    if (path === '/edits/e1:validate' || path === '/edits/e1:commit') return respond(200, { id: 'e1' });
    if (method === 'DELETE' && path === '/edits/e1') return respond(204, undefined);
    return respond(404, { error: `unexpected ${method} ${path}` });
  };
  return { fetchFn, calls };
}

test('plan: the newest internal release goes to production as a staged rollout', () => {
  const p = plan({ tracks, fraction: 0.1, notes: 'Fixes' });
  assert.equal(p.code, 36);
  assert.deepEqual(p.release, { versionCodes: ['36'], status: 'inProgress', userFraction: 0.1, releaseNotes: [{ language: 'en-US', text: 'Fixes' }] });
  assert.deepEqual(p.replaces, []);
});

test('plan: fraction 1 completes the rollout, no userFraction, no notes when none given', () => {
  assert.deepEqual(plan({ tracks, fraction: 1 }).release, { versionCodes: ['36'], status: 'completed' });
});

test('plan: an explicit version code; older than the completed production release is refused', () => {
  assert.equal(plan({ tracks, fraction: 0.5, versionCode: 35 }).code, 35);
  assert.throws(() => plan({ tracks, fraction: 0.5, versionCode: 29 }), /older than production's completed release 30/);
});

test('plan: an in-progress rollout of another code is replaced and named', () => {
  const t = [{ track: 'production', releases: [{ status: 'completed', versionCodes: ['30'] }, { status: 'inProgress', versionCodes: ['35'], userFraction: 0.1 }] }, { track: 'internal', releases: [{ status: 'completed', versionCodes: ['36'] }] }];
  assert.deepEqual(plan({ tracks: t, fraction: 0.25 }).replaces, [['35']]);
  // Raising the fraction of the same code replaces nothing.
  assert.deepEqual(plan({ tracks: t, fraction: 0.5, versionCode: 35 }).replaces, []);
});

test('plan: no internal release is an error', () => {
  assert.throws(() => plan({ tracks: [{ track: 'internal' }, { track: 'production' }], fraction: 1 }), /no release to promote/);
});

test('promote: one edit — insert, tracks, put production, validate, commit', async () => {
  const play = fakePlay();
  const logs = [];
  const p = await promote({ sa, pkg: 'com.example.app', fraction: 0.25, notes: 'Hello', fetchFn: play.fetchFn, log: (l) => logs.push(l) });
  assert.equal(p.code, 36);
  assert.deepEqual(play.calls.map((c) => `${c.method} ${c.path}`), ['POST token', 'POST /edits', 'GET /edits/e1/tracks', 'PUT /edits/e1/tracks/production', 'POST /edits/e1:validate', 'POST /edits/e1:commit']);
  assert.deepEqual(play.calls[3].body, { track: 'production', releases: [{ versionCodes: ['36'], status: 'inProgress', userFraction: 0.25, releaseNotes: [{ language: 'en-US', text: 'Hello' }] }] });
  assert.match(logs[0], /production ← 36 as inProgress \(25% of users\)/);
  assert.equal(logs[1], 'committed');
});

test('promote: a dry run reads the tracks, writes nothing and discards the edit', async () => {
  const play = fakePlay();
  await promote({ sa, pkg: 'com.example.app', fraction: 1, dryRun: true, fetchFn: play.fetchFn, log: () => {} });
  assert.deepEqual(play.calls.map((c) => `${c.method} ${c.path}`), ['POST token', 'POST /edits', 'GET /edits/e1/tracks', 'DELETE /edits/e1']);
});

test('promote: a failed validation deletes the edit and reports the API answer', async () => {
  const play = fakePlay({ fail: ['POST /edits/e1:validate'] });
  await assert.rejects(promote({ sa, pkg: 'com.example.app', fraction: 1, fetchFn: play.fetchFn, log: () => {} }), /POST \/edits\/e1:validate: 400 .*nope/);
  assert.equal(play.calls.at(-1).method, 'DELETE');
  assert.ok(!play.calls.some((c) => c.path === '/edits/e1:commit'));
});

test('promote: a bad fraction is refused before any call', async () => {
  const play = fakePlay();
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 0, fetchFn: play.fetchFn }), /--fraction must be in \(0, 1\]/);
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 1.5, fetchFn: play.fetchFn }), /--fraction/);
  assert.equal(play.calls.length, 0);
});
