import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ascToken, submit } from '../asc-submit.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const key = { keyId: 'KEY1', issuerId: 'iss-1', p8: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const app = { id: 'app1', attributes: { name: 'Remotly', primaryLocale: 'en-US' } };
// TestFlight builds with their marketing version (preReleaseVersion): 36 and 35 are 0.1.1, 30 is 0.1.0.
const builds = [
  { id: 'b36', pre: '0.1.1', attributes: { version: '36', uploadedDate: '2026-09-20T15:56:16Z' } },
  { id: 'b35', pre: '0.1.1', attributes: { version: '35', uploadedDate: '2026-09-20T12:17:32Z' } },
  { id: 'b30', pre: '0.1.0', attributes: { version: '30', uploadedDate: '2026-09-10T10:00:00Z' } },
];
const v = (id, versionString, appVersionState, releaseType = 'AFTER_APPROVAL') => ({ id, attributes: { versionString, appVersionState, releaseType } });
const shipped = v('v0', '0.1.0', 'READY_FOR_DISTRIBUTION');

/** A fake App Store Connect: `versions`, `submissions`, `items` and `attached` are the current state; every call is recorded. */
function fakeASC({ versions = [shipped], submissions = [], items = [], attached, fail = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace('https://api.appstoreconnect.apple.com/v1', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const respond = (status, obj) => ({ ok: status < 300, status, text: async () => (obj === undefined ? '' : JSON.stringify(obj)) });
    const [bare, query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    if (fail.some((f) => `${method} ${bare}` === f)) return respond(409, { errors: [{ code: 'STATE_ERROR', title: 'The request cannot be fulfilled', detail: `fake failure of ${method} ${bare}` }] });
    if (method === 'GET' && bare === '/apps') return respond(200, { data: [app] });
    if (method === 'GET' && bare === '/builds') {
      const pre = q.get('filter[preReleaseVersion.version]'); const num = q.get('filter[version]');
      return respond(200, { data: builds.filter((b) => b.pre === pre && (num === null || b.attributes.version === num)).slice(0, Number(q.get('limit') ?? 200)).map(({ pre: _, ...b }) => b) });
    }
    if (method === 'GET' && bare === '/apps/app1/appStoreVersions') {
      const str = q.get('filter[versionString]'); const states = q.get('filter[appVersionState]')?.split(',');
      return respond(200, { data: versions.filter((x) => (str === null || x.attributes.versionString === str) && (!states || states.includes(x.attributes.appVersionState))) });
    }
    if (method === 'GET' && /^\/appStoreVersions\/[^/]+\/build$/.test(bare)) return respond(200, { data: attached ?? null });
    if (method === 'POST' && bare === '/appStoreVersions') return respond(201, { data: { id: 'vNew', attributes: { ...body.data.attributes, appVersionState: 'PREPARE_FOR_SUBMISSION' } } });
    if (method === 'PATCH' && /^\/appStoreVersions\/[^/]+$/.test(bare)) return respond(200, { data: { id: bare.split('/')[2] } });
    if (method === 'PATCH' && bare.endsWith('/relationships/build')) return respond(204, undefined);
    if (method === 'GET' && bare.endsWith('/appStoreVersionLocalizations')) return respond(200, { data: [{ id: 'loc-en', attributes: { locale: 'en-US', whatsNew: '' } }, { id: 'loc-de', attributes: { locale: 'de-DE' } }] });
    if (method === 'PATCH' && bare.startsWith('/appStoreVersionLocalizations/')) return respond(200, { data: { id: 'loc-en' } });
    if (method === 'GET' && bare === '/apps/app1/reviewSubmissions') { const states = q.get('filter[state]').split(','); return respond(200, { data: submissions.filter((s) => states.includes(s.attributes.state)) }); }
    if (method === 'POST' && bare === '/reviewSubmissions') return respond(201, { data: { id: 'subNew', attributes: { state: 'READY_FOR_REVIEW' } } });
    if (method === 'GET' && /^\/reviewSubmissions\/[^/]+\/items$/.test(bare)) return respond(200, { data: items });
    if (method === 'POST' && bare === '/reviewSubmissionItems') return respond(201, { data: { id: 'item1' } });
    if (method === 'PATCH' && /^\/reviewSubmissions\/[^/]+$/.test(bare)) return respond(200, { data: { id: bare.split('/')[2], attributes: { state: 'WAITING_FOR_REVIEW' } } });
    return respond(404, { errors: [{ title: `unexpected ${method} ${bare}` }] });
  };
  return { fetchFn, calls, trail: () => calls.map((c) => `${c.method} ${c.path.split('?')[0]}`) };
}
const VERSIONS = '/apps/app1/appStoreVersions';

test('ascToken: an ES256 JWT with the key id, issuer and audience', () => {
  const [h, p] = ascToken(key, 1_000_000).split('.').slice(0, 2).map((s) => JSON.parse(Buffer.from(s, 'base64url')));
  assert.deepEqual(h, { alg: 'ES256', kid: 'KEY1', typ: 'JWT' });
  assert.deepEqual(p, { iss: 'iss-1', iat: 1_000_000, exp: 1_000_600, aud: 'appstoreconnect-v1' });
});

test('a new version: created, the newest build of that version attached, What\'s New set, one submission created and submitted', async () => {
  const asc = fakeASC();
  const logs = [];
  const r = await submit({ key, bundleId: 'com.example.app', version: '0.1.1', notes: 'Fixes', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(r, { app: 'app1', build: '36', version: '0.1.1', created: true, submission: 'subNew' });
  assert.deepEqual(asc.trail(), ['GET /apps', `GET ${VERSIONS}`, `GET ${VERSIONS}`, 'GET /builds', 'POST /appStoreVersions', 'PATCH /appStoreVersions/vNew/relationships/build', `GET ${VERSIONS}`,
    'GET /appStoreVersions/vNew/appStoreVersionLocalizations', 'PATCH /appStoreVersionLocalizations/loc-en', 'GET /apps/app1/reviewSubmissions', 'POST /reviewSubmissions', 'GET /reviewSubmissions/subNew/items', 'POST /reviewSubmissionItems', 'PATCH /reviewSubmissions/subNew']);
  assert.match(asc.calls[3].path, /filter\[preReleaseVersion\.version\]=0\.1\.1&filter\[preReleaseVersion\.platform\]=IOS&filter\[processingState\]=VALID&filter\[expired\]=false&sort=-uploadedDate/);
  const created = asc.calls[4].body.data;
  assert.deepEqual(created.attributes, { platform: 'IOS', versionString: '0.1.1', releaseType: 'AFTER_APPROVAL' });
  assert.equal(created.relationships.app.data.id, 'app1');
  assert.deepEqual(asc.calls[5].body, { data: { type: 'builds', id: 'b36' } });
  assert.equal(asc.calls[8].body.data.attributes.whatsNew, 'Fixes');
  assert.equal(asc.calls[12].body.data.relationships.appStoreVersion.data.id, 'vNew');
  assert.deepEqual(asc.calls[13].body.data.attributes, { submitted: true });
  assert.match(logs[0], /new version 0\.1\.1 ← build 36 .*release AFTER_APPROVAL, with What's New/);
  assert.match(logs.at(-1), /submitted: version 0\.1\.1 with build 36/);
});

test('an editable version with the string is reused; a different release type is patched; an open submission is reused', async () => {
  const asc = fakeASC({ versions: [shipped, v('v1', '0.1.1', 'DEVELOPER_REJECTED')], submissions: [{ id: 'subOpen', attributes: { state: 'UNRESOLVED_ISSUES' } }], items: [{ id: 'i1', relationships: { appStoreVersion: { data: { id: 'v1' } } } }] });
  const r = await submit({ key, bundleId: 'com.example.app', version: '0.1.1', build: '35', release: 'manual', fetchFn: asc.fetchFn, log: () => {} });
  assert.deepEqual(r, { app: 'app1', build: '35', version: '0.1.1', created: false, submission: 'subOpen' });
  assert.deepEqual(asc.trail(), ['GET /apps', `GET ${VERSIONS}`, `GET ${VERSIONS}`, 'GET /builds', 'PATCH /appStoreVersions/v1', 'PATCH /appStoreVersions/v1/relationships/build', 'GET /apps/app1/reviewSubmissions', 'GET /reviewSubmissions/subOpen/items', 'PATCH /reviewSubmissions/subOpen']);
  assert.deepEqual(asc.calls[4].body.data.attributes, { releaseType: 'MANUAL' });
  assert.deepEqual(asc.calls[5].body, { data: { type: 'builds', id: 'b35' } });
});

test('a version string already waiting for review, any version in review, or one parked in an unsubmitted submission is refused before anything changes', async () => {
  const waiting = fakeASC({ versions: [v('v1', '0.1.0', 'WAITING_FOR_REVIEW')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.0', fetchFn: waiting.fetchFn, log: () => {} }), /version 0\.1\.0 is already waiting for or in review/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: waiting.fetchFn, log: () => {} }), /version 0\.1\.0 is already waiting for or in review/);
  const sale = fakeASC({ versions: [v('v1', '0.1.0', 'READY_FOR_DISTRIBUTION')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.0', fetchFn: sale.fetchFn, log: () => {} }), /version 0\.1\.0 is READY_FOR_DISTRIBUTION; submit a new version string/);
  const parked = fakeASC({ versions: [shipped, v('v2', '0.1.2', 'READY_FOR_REVIEW')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: parked.fetchFn, log: () => {} }), /version 0\.1\.2 sits in a review submission that was never submitted/);
  for (const f of [waiting, sale, parked]) assert.ok(!f.calls.some((c) => c.method !== 'GET'));
});

test('the build must be a processed one of the version; the newest is the default', async () => {
  const asc = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '99', fetchFn: asc.fetchFn, log: () => {} }), /build 99 is not a processed, unexpired TestFlight build of version 0\.1\.1/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '30', fetchFn: asc.fetchFn, log: () => {} }), /build 30 is not a processed, unexpired TestFlight build of version 0\.1\.1/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.2.0', fetchFn: asc.fetchFn, log: () => {} }), /no processed, unexpired TestFlight build carries version 0\.2\.0: bump MARKETING_VERSION in ios\/project\.yml/);
  assert.ok(!asc.calls.some((c) => c.method !== 'GET'));
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', dryRun: true, fetchFn: asc.fetchFn, log: () => {} });
  assert.equal(r.build, '36');
});

test('a dry run only reads', async () => {
  const asc = fakeASC();
  await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: asc.fetchFn, log: () => {} });
  assert.deepEqual(asc.trail(), ['GET /apps', `GET ${VERSIONS}`, `GET ${VERSIONS}`, 'GET /builds']);
});

test("the app's first version has no What's New: skipped with a note, nothing else changes", async () => {
  const asc = fakeASC({ versions: [] });
  const logs = [];
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.equal(r.submission, 'subNew');
  assert.ok(logs.some((l) => /What's New not set: 0\.1\.1 is the app's first version/.test(l)), logs.join('\n'));
  assert.ok(!asc.trail().some((t) => t.includes('appStoreVersionLocalizations')));
});

test("a refused What's New on a later version is an error, not a note", async () => {
  const asc = fakeASC({ fail: ['PATCH /appStoreVersionLocalizations/loc-en'] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: () => {} }), /PATCH \/appStoreVersionLocalizations\/loc-en: 409/);
  assert.ok(!asc.trail().includes('POST /reviewSubmissions'));
});

test('a version left READY_FOR_REVIEW by an earlier run is submitted as it stands', async () => {
  const state = { versions: [shipped, v('v1', '0.1.1', 'READY_FOR_REVIEW')], submissions: [{ id: 'subOpen', attributes: { state: 'READY_FOR_REVIEW' } }], items: [{ id: 'i1', relationships: { appStoreVersion: { data: { id: 'v1' } } } }], attached: { id: 'b36', attributes: { version: '36' } } };
  const asc = fakeASC(state);
  const logs = [];
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(r, { app: 'app1', build: '36', version: '0.1.1', created: false, resumed: true, submission: 'subOpen' });
  assert.deepEqual(asc.trail(), ['GET /apps', `GET ${VERSIONS}`, `GET ${VERSIONS}`, 'GET /appStoreVersions/v1/build', 'GET /apps/app1/reviewSubmissions', 'GET /reviewSubmissions/subOpen/items', 'PATCH /reviewSubmissions/subOpen']);
  assert.match(logs[0], /READY_FOR_REVIEW with build 36 already .*What's New stays as it is: submitting/);
  // The same build may be named; another one is refused; a dry run stops after the checks.
  await submit({ key, bundleId: 'b', version: '0.1.1', build: '36', fetchFn: fakeASC(state).fetchFn, log: () => {} });
  const other = fakeASC(state);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '35', fetchFn: other.fetchFn, log: () => {} }), /READY_FOR_REVIEW with build 36, not 35/);
  assert.ok(!other.calls.some((c) => c.method !== 'GET'));
  const dry = fakeASC(state);
  assert.deepEqual(await submit({ key, bundleId: 'b', version: '0.1.1', dryRun: true, fetchFn: dry.fetchFn, log: () => {} }), { app: 'app1', build: '36', version: '0.1.1', created: false, resumed: true });
  assert.deepEqual(dry.trail(), ['GET /apps', `GET ${VERSIONS}`, `GET ${VERSIONS}`, 'GET /appStoreVersions/v1/build']);
  // No open submission holding it: refused with advice.
  const orphan = fakeASC({ ...state, submissions: [] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: orphan.fetchFn, log: () => {} }), /no open review submission holds version 0\.1\.1/);
});

test('an API refusal names the call and Apple\'s detail', async () => {
  const asc = fakeASC({ fail: ['PATCH /reviewSubmissions/subNew'] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: asc.fetchFn, log: () => {} }), /PATCH \/reviewSubmissions\/subNew: 409 STATE_ERROR The request cannot be fulfilled fake failure/);
});

test('bad arguments are refused before any call', async () => {
  const asc = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: 'v1', fetchFn: asc.fetchFn }), /--version must be X\.Y or X\.Y\.Z/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', build: 'latest', fetchFn: asc.fetchFn }), /--build must be a build number/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', release: 'now', fetchFn: asc.fetchFn }), /--release must be/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', notes: 'x'.repeat(4001), fetchFn: asc.fetchFn }), /--notes is 4001 characters; Apple allows 4000/);
  assert.equal(asc.calls.length, 0);
});
