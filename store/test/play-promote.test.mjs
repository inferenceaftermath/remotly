import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { plan, promote } from '../play-promote.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'ci@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const live = { name: '0.1.0 (30)', status: 'completed', versionCodes: ['30'], releaseNotes: [{ language: 'en-US', text: 'First' }] };
const tracks = [
  { track: 'production', releases: [live] },
  { track: 'beta' }, { track: 'alpha' },
  { track: 'internal', releases: [{ name: '37', status: 'draft', versionCodes: ['37'] }, { name: '36', status: 'completed', versionCodes: ['36'] }, { name: '35', status: 'completed', versionCodes: ['35'] }] },
];
const staged = { name: '35', status: 'inProgress', versionCodes: ['34', '35'], userFraction: 0.1, releaseNotes: [{ language: 'en-US', text: 'Old notes' }], countryTargeting: { countries: ['DE'] }, inAppUpdatePriority: 2 };
const withStaged = [{ track: 'production', releases: [live, staged] }, { track: 'internal', releases: [{ status: 'completed', versionCodes: ['36'] }] }];

/** A fake Play: records every call, answers the token exchange, the edit, the tracks; fails the calls named in `fail`. */
function fakePlay({ tracks: t = tracks, fail = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https:\/\/androidpublisher\.googleapis\.com\/androidpublisher\/v3\/applications\/[^/]+/, '');
    calls.push({ method, path: url.startsWith('https://oauth2') ? 'token' : path, body: init.body ? (init.body.startsWith('grant_type') ? 'jwt' : JSON.parse(init.body)) : undefined });
    const respond = (status, obj) => ({ ok: status < 300, status, json: async () => obj, text: async () => (obj === undefined ? '' : JSON.stringify(obj)) });
    if (url.startsWith('https://oauth2')) return respond(200, { access_token: 'tok' });
    const bare = path.split('?')[0];
    if (fail.includes(`${method} ${bare}`)) return respond(400, { error: 'nope' });
    if (method === 'POST' && path === '/edits') return respond(200, { id: 'e1' });
    if (method === 'GET' && path === '/edits/e1/tracks') return respond(200, { tracks: t });
    if (method === 'PUT' && path === '/edits/e1/tracks/production') return respond(200, init.body && JSON.parse(init.body));
    if (bare === '/edits/e1:validate' || bare === '/edits/e1:commit') return respond(200, { id: 'e1' });
    if (method === 'DELETE' && path === '/edits/e1') return respond(204, undefined);
    return respond(404, { error: `unexpected ${method} ${path}` });
  };
  return { fetchFn, calls, trail: () => calls.map((c) => `${c.method} ${c.path}`) };
}

test('plan: the newest completed internal release (never a draft) goes to production as a staged rollout beside the completed release', () => {
  const p = plan({ tracks, fraction: 0.1, notes: 'Fixes' });
  assert.equal(p.code, 36);
  assert.deepEqual(p.release, { versionCodes: ['36'], status: 'inProgress', userFraction: 0.1, releaseNotes: [{ language: 'en-US', text: 'Fixes' }] });
  assert.deepEqual(p.releases, [live, p.release]);
  assert.deepEqual(p.replaces, []);
  assert.equal(p.raised, false);
});

test('plan: fraction 1 completes the rollout — the release alone, Play allows one completed release', () => {
  const p = plan({ tracks, fraction: 1 });
  assert.deepEqual(p.release, { versionCodes: ['36'], status: 'completed' });
  assert.deepEqual(p.releases, [p.release]);
});

test('plan: an explicit version code; older than, or equal to, the completed production release is refused', () => {
  assert.equal(plan({ tracks, fraction: 0.5, versionCode: 35 }).code, 35);
  assert.throws(() => plan({ tracks, fraction: 0.5, versionCode: 29 }), /older than production's completed release 30/);
  assert.throws(() => plan({ tracks, fraction: 0.5, versionCode: 30 }), /version code 30 is production's completed release already/);
});

test('plan: a staged rollout of another code is replaced and named', () => {
  const p = plan({ tracks: withStaged, fraction: 0.25 });
  assert.equal(p.code, 36);
  assert.deepEqual(p.replaces, ['34+35 (inProgress)']);
  assert.deepEqual(p.releases, [live, { versionCodes: ['36'], status: 'inProgress', userFraction: 0.25 }]);
});

test('plan: raising the rollout of the same code keeps its retained codes, notes, targeting and priority', () => {
  const p = plan({ tracks: withStaged, fraction: 0.5, versionCode: 35 });
  assert.equal(p.raised, true);
  assert.deepEqual(p.replaces, []);
  assert.deepEqual(p.release, { ...staged, userFraction: 0.5 });
  assert.deepEqual(p.releases, [live, p.release]);
  // New notes replace the old ones; nothing else changes.
  assert.deepEqual(plan({ tracks: withStaged, fraction: 0.5, versionCode: 35, notes: 'New' }).release.releaseNotes, [{ language: 'en-US', text: 'New' }]);
  // Completing it drops the fraction and the country targeting (Play allows that on staged rollouts only).
  const finished = plan({ tracks: withStaged, fraction: 1, versionCode: 35 });
  assert.deepEqual(finished.release, { name: '35', status: 'completed', versionCodes: ['34', '35'], releaseNotes: staged.releaseNotes, inAppUpdatePriority: 2 });
  assert.ok(!('userFraction' in finished.release) && !('countryTargeting' in finished.release));
  assert.deepEqual(finished.releases, [finished.release]);
});

test('plan: a rollout is never lowered here, and a halted release is left to the console', () => {
  assert.throws(() => plan({ tracks: withStaged, fraction: 0.1, versionCode: 35 }), /rolled out to 10% of users already; a rollout is only raised here/);
  assert.throws(() => plan({ tracks: withStaged, fraction: 0.05, versionCode: 35 }), /only raised here/);
  // A code between the completed release and the rollout under way: not a raise, not newer — refused, not a downgrade.
  assert.throws(() => plan({ tracks: withStaged, fraction: 0.5, versionCode: 31 }), /version code 31 is below 35, which production is rolling out already; a rollout is raised by its newest code and replaced only by a newer build/);
  // A retained older code of the rollout under way names nothing: the rollout is raised by 35, not by 34.
  assert.throws(() => plan({ tracks: withStaged, fraction: 0.5, versionCode: 34 }), /version code 34 is below 35/);
  assert.throws(() => plan({ tracks: [{ track: 'production', releases: [live, { ...staged, status: 'halted' }] }], fraction: 0.5, versionCode: 33 }), /below 35/);
  const halted = [{ track: 'production', releases: [live, { ...staged, status: 'halted' }] }, { track: 'internal', releases: [{ status: 'completed', versionCodes: ['36'] }] }];
  assert.throws(() => plan({ tracks: halted, fraction: 0.5, versionCode: 35 }), /version code 35 is halted on production; resume it in the Play Console/);
  // A newer code replaces the halted one, and says so.
  assert.deepEqual(plan({ tracks: halted, fraction: 0.5 }).replaces, ['34+35 (halted)']);
});

test('plan: no completed internal release is an error; a draft may still be named explicitly', () => {
  assert.throws(() => plan({ tracks: [{ track: 'internal' }, { track: 'production' }], fraction: 1 }), /no completed release to promote/);
  assert.throws(() => plan({ tracks: [{ track: 'internal', releases: [{ status: 'draft', versionCodes: ['37'] }] }, { track: 'production' }], fraction: 1 }), /no completed release to promote/);
  assert.equal(plan({ tracks, fraction: 0.1, versionCode: 37 }).code, 37);
});

test('promote: one edit — insert, tracks, put production (completed release kept), validate, commit without cancelling a review', async () => {
  const play = fakePlay();
  const logs = [];
  const p = await promote({ sa, pkg: 'com.example.app', fraction: 0.25, notes: 'Hello', fetchFn: play.fetchFn, log: (l) => logs.push(l) });
  assert.equal(p.code, 36);
  assert.deepEqual(play.trail(), ['POST token', 'POST /edits', 'GET /edits/e1/tracks', 'PUT /edits/e1/tracks/production', 'POST /edits/e1:validate', 'POST /edits/e1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW']);
  assert.deepEqual(play.calls[3].body, { track: 'production', releases: [live, { versionCodes: ['36'], status: 'inProgress', userFraction: 0.25, releaseNotes: [{ language: 'en-US', text: 'Hello' }] }] });
  assert.match(logs[0], /^production ← 36 as inProgress \(25% of users\)$/);
  assert.match(logs[1], /Publishing overview/);
  assert.equal(logs[2], 'committed');
});

test('promote: the log names a raised rollout and what is replaced', async () => {
  const logs = [];
  await promote({ sa, pkg: 'p', fraction: 0.5, versionCode: 35, dryRun: true, fetchFn: fakePlay({ tracks: withStaged }).fetchFn, log: (l) => logs.push(l) });
  assert.match(logs[0], /^production ← 35 as inProgress \(50% of users, raised\)$/);
  logs.length = 0;
  await promote({ sa, pkg: 'p', fraction: 1, dryRun: true, fetchFn: fakePlay({ tracks: withStaged }).fetchFn, log: (l) => logs.push(l) });
  assert.match(logs[0], /^production ← 36 as completed, replacing 34\+35 \(inProgress\)$/);
});

test('promote: notes beyond Play\'s 500 characters are refused before any call', async () => {
  const play = fakePlay();
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 1, notes: '€'.repeat(501), fetchFn: play.fetchFn }), /--notes is 501 characters; Play allows 500 per language/);
  assert.equal(play.calls.length, 0);
  await promote({ sa, pkg: 'p', fraction: 1, notes: '€'.repeat(500), dryRun: true, fetchFn: play.fetchFn, log: () => {} });
});

test('promote: a dry run reads the tracks, writes nothing and discards the edit', async () => {
  const play = fakePlay();
  await promote({ sa, pkg: 'com.example.app', fraction: 1, dryRun: true, fetchFn: play.fetchFn, log: () => {} });
  assert.deepEqual(play.trail(), ['POST token', 'POST /edits', 'GET /edits/e1/tracks', 'DELETE /edits/e1']);
});

test('promote: a failed validation deletes the edit and reports the API answer', async () => {
  const play = fakePlay({ fail: ['POST /edits/e1:validate'] });
  await assert.rejects(promote({ sa, pkg: 'com.example.app', fraction: 1, fetchFn: play.fetchFn, log: () => {} }), /POST \/edits\/e1:validate: 400 .*nope/);
  assert.equal(play.calls.at(-1).method, 'DELETE');
  assert.ok(!play.calls.some((c) => c.path.startsWith('/edits/e1:commit')));
});

test('promote: a refused commit (changes in review) deletes the edit and says what to do', async () => {
  const play = fakePlay({ fail: ['POST /edits/e1:commit'] });
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 1, fetchFn: play.fetchFn, log: () => {} }), /commit\?changesInReviewBehavior=ERROR_IF_IN_REVIEW: 400 .*nope[\s\S]*made in the Play Console/);
  assert.equal(play.calls.at(-1).method, 'DELETE');
});

test('promote: a plan refusal deletes the edit', async () => {
  const play = fakePlay({ tracks: withStaged });
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 0.1, versionCode: 35, fetchFn: play.fetchFn, log: () => {} }), /only raised here/);
  assert.deepEqual(play.trail(), ['POST token', 'POST /edits', 'GET /edits/e1/tracks', 'DELETE /edits/e1']);
});

test('promote: a bad fraction is refused before any call', async () => {
  const play = fakePlay();
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 0, fetchFn: play.fetchFn }), /--fraction must be in \(0, 1\]/);
  await assert.rejects(promote({ sa, pkg: 'p', fraction: 1.5, fetchFn: play.fetchFn }), /--fraction/);
  assert.equal(play.calls.length, 0);
});
