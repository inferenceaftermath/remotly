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
const shipped = v('v0', '0.1.0', 'READY_FOR_DISTRIBUTION'); // the app is past its first version: every new one is an update

/**
 * A fake App Store Connect: `versions`, `submissions` (each with its `items`), `attached` (the build of a READY_FOR_REVIEW
 * version) and `whatsNew` (by version id) are the current state; every call is recorded. Sparse fieldsets are honoured
 * the way the real API does: an item names its version only when `appStoreVersion` is in its fields and included.
 */
function fakeASC({ versions = [shipped], submissions = [], attached, whatsNew = {}, fail = [] } = {}) {
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
    if (method === 'GET' && bare.endsWith('/appStoreVersionLocalizations')) {
      const vid = bare.split('/')[2]; const locale = q.get('filter[locale]');
      const all = [{ id: `loc-en-${vid}`, attributes: { locale: 'en-US', whatsNew: whatsNew[vid] ?? '' } }, { id: `loc-de-${vid}`, attributes: { locale: 'de-DE' } }];
      return respond(200, { data: all.filter((l) => locale === null || l.attributes.locale === locale) });
    }
    if (method === 'PATCH' && bare.startsWith('/appStoreVersionLocalizations/')) return respond(200, { data: { id: bare.split('/')[2] } });
    if (method === 'GET' && bare === '/apps/app1/reviewSubmissions') { const states = q.get('filter[state]').split(','); return respond(200, { data: submissions.filter((s) => states.includes(s.attributes.state)) }); }
    if (method === 'POST' && bare === '/reviewSubmissions') return respond(201, { data: { id: 'subNew', attributes: { state: 'READY_FOR_REVIEW' } } });
    if (method === 'GET' && /^\/reviewSubmissions\/[^/]+\/items$/.test(bare)) {
      const named = (q.get('fields[reviewSubmissionItems]') ?? 'state,appStoreVersion').split(',').includes('appStoreVersion') && q.get('include') === 'appStoreVersion';
      const items = submissions.find((x) => x.id === bare.split('/')[2])?.items ?? [];
      return respond(200, { data: items.map((i) => (named ? i : { id: i.id, attributes: i.attributes })) });
    }
    if (method === 'POST' && bare === '/reviewSubmissionItems') return respond(201, { data: { id: 'item1', attributes: { state: 'READY_FOR_REVIEW' } } });
    if (method === 'PATCH' && bare.startsWith('/reviewSubmissionItems/')) return respond(200, { data: { id: bare.split('/')[2] } });
    if (method === 'PATCH' && /^\/reviewSubmissions\/[^/]+$/.test(bare)) return respond(200, { data: { id: bare.split('/')[2], attributes: { state: 'WAITING_FOR_REVIEW' } } });
    return respond(404, { errors: [{ title: `unexpected ${method} ${bare}` }] });
  };
  return { fetchFn, calls, trail: () => calls.map((c) => `${c.method} ${c.path.split('?')[0]}`) };
}
const VERSIONS = '/apps/app1/appStoreVersions';
const LOOKUP = ['GET /apps', `GET ${VERSIONS}`, `GET ${VERSIONS}`, `GET ${VERSIONS}`]; // the app; this string, in flight, past review
const item = (id, versionId, state = 'READY_FOR_REVIEW') => ({ id, attributes: { state }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } });
const open = { submissions: [{ id: 'subOpen', attributes: { state: 'READY_FOR_REVIEW' }, items: [item('i1', 'v1')] }] };

test('ascToken: an ES256 JWT with the key id, issuer and audience', () => {
  const [h, p] = ascToken(key, 1_000_000).split('.').slice(0, 2).map((s) => JSON.parse(Buffer.from(s, 'base64url')));
  assert.deepEqual(h, { alg: 'ES256', kid: 'KEY1', typ: 'JWT' });
  assert.deepEqual(p, { iss: 'iss-1', iat: 1_000_000, exp: 1_000_600, aud: 'appstoreconnect-v1' });
});

test('an update as a new version: created, the newest build of that version attached, What\'s New set, one submission created and submitted', async () => {
  const asc = fakeASC();
  const logs = [];
  const r = await submit({ key, bundleId: 'com.example.app', version: '0.1.1', notes: 'Fixes', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(r, { app: 'app1', build: '36', version: '0.1.1', created: true, submission: 'subNew' });
  assert.deepEqual(asc.trail(), [...LOOKUP, 'GET /builds', 'POST /appStoreVersions', 'PATCH /appStoreVersions/vNew/relationships/build',
    'GET /appStoreVersions/vNew/appStoreVersionLocalizations', 'PATCH /appStoreVersionLocalizations/loc-en-vNew', 'GET /apps/app1/reviewSubmissions', 'POST /reviewSubmissions', 'POST /reviewSubmissionItems', 'PATCH /reviewSubmissions/subNew']);
  assert.match(asc.calls[4].path, /filter\[preReleaseVersion\.version\]=0\.1\.1&filter\[preReleaseVersion\.platform\]=IOS&filter\[processingState\]=VALID&filter\[expired\]=false&sort=-uploadedDate/);
  const created = asc.calls[5].body.data;
  assert.deepEqual(created.attributes, { platform: 'IOS', versionString: '0.1.1', releaseType: 'AFTER_APPROVAL' });
  assert.equal(created.relationships.app.data.id, 'app1');
  assert.deepEqual(asc.calls[6].body, { data: { type: 'builds', id: 'b36' } });
  assert.match(asc.calls[7].path, /filter\[locale\]=en-US/);
  assert.equal(asc.calls[8].body.data.attributes.whatsNew, 'Fixes');
  assert.equal(asc.calls[11].body.data.relationships.appStoreVersion.data.id, 'vNew');
  assert.deepEqual(asc.calls[12].body.data.attributes, { submitted: true });
  assert.match(logs[0], /new version 0\.1\.1 ← build 36 .*release AFTER_APPROVAL, What's New from notes/);
  assert.match(logs.at(-1), /submitted: version 0\.1\.1 with build 36/);
});

test('a rejected version with its What\'s New is reused; a different release type is patched; its rejected item is resolved and the submission sent again', async () => {
  const asc = fakeASC({ versions: [shipped, v('v1', '0.1.1', 'REJECTED')], submissions: [{ id: 'subOpen', attributes: { state: 'UNRESOLVED_ISSUES' }, items: [item('i1', 'v1', 'REJECTED')] }], whatsNew: { v1: 'Already there' } });
  const logs = [];
  const r = await submit({ key, bundleId: 'com.example.app', version: '0.1.1', build: '35', release: 'manual', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(r, { app: 'app1', build: '35', version: '0.1.1', created: false, submission: 'subOpen' });
  assert.deepEqual(asc.trail(), [...LOOKUP, 'GET /builds', 'GET /appStoreVersions/v1/appStoreVersionLocalizations', 'PATCH /appStoreVersions/v1', 'PATCH /appStoreVersions/v1/relationships/build', 'GET /apps/app1/reviewSubmissions', 'GET /reviewSubmissions/subOpen/items', 'PATCH /reviewSubmissionItems/i1', 'PATCH /reviewSubmissions/subOpen']);
  assert.deepEqual(asc.calls[6].body.data.attributes, { releaseType: 'MANUAL' });
  assert.deepEqual(asc.calls[7].body, { data: { type: 'builds', id: 'b35' } });
  assert.match(asc.calls[9].path, /fields\[reviewSubmissionItems\]=state,appStoreVersion&include=appStoreVersion&limit=200/);
  assert.deepEqual(asc.calls[10].body, { data: { type: 'reviewSubmissionItems', id: 'i1', attributes: { resolved: true } } });
  assert.match(logs[0], /version 0\.1\.1 \(REJECTED\) ← build 35 .*What's New as it is/);
});

test('the review submission is exactly the one for the version: an empty open one is reused, a draft holding other items is left alone', async () => {
  const empty = fakeASC({ submissions: [{ id: 'subEmpty', attributes: { state: 'READY_FOR_REVIEW' }, items: [] }] });
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: empty.fetchFn, log: () => {} });
  assert.equal(r.submission, 'subEmpty');
  assert.deepEqual(empty.trail().slice(-3), ['GET /reviewSubmissions/subEmpty/items', 'POST /reviewSubmissionItems', 'PATCH /reviewSubmissions/subEmpty']);
  const foreign = fakeASC({ submissions: [{ id: 'subEvent', attributes: { state: 'READY_FOR_REVIEW' }, items: [{ id: 'e1', attributes: { state: 'READY_FOR_REVIEW' }, relationships: { appEvent: { data: { type: 'appEvents', id: 'ev1' } } } }] }] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: foreign.fetchFn, log: () => {} }), /an open review submission \(READY_FOR_REVIEW\) holds 1 item\(s\) that are not version 0\.1\.1; submit or remove it in App Store Connect first/);
  assert.ok(!foreign.trail().some((t) => t.startsWith('PATCH /reviewSubmissions') || t === 'POST /reviewSubmissionItems'));
  // Ours plus another item: not submitted from here either.
  const mixed = fakeASC({ versions: [shipped, v('v1', '0.1.1', 'PREPARE_FOR_SUBMISSION')], submissions: [{ id: 'subMixed', attributes: { state: 'READY_FOR_REVIEW' }, items: [item('i1', 'v1'), { id: 'e1', attributes: { state: 'READY_FOR_REVIEW' }, relationships: {} }] }], whatsNew: { v1: 'y' } });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: mixed.fetchFn, log: () => {} }), /holding version 0\.1\.1 holds 1 other item\(s\) too/);
  assert.ok(!mixed.trail().some((t) => t.startsWith('PATCH /reviewSubmissions')));
});

test('a new version is not created while the current one is accepted but not out yet', async () => {
  for (const st of ['PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'ACCEPTED']) {
    const asc = fakeASC({ versions: [v('v0', '0.1.0', st)] });
    await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: asc.fetchFn, log: () => {} }), new RegExp(`version 0\\.1\\.0 is ${st}; Apple lets a new version be created once it is ready for distribution`));
    assert.ok(!asc.calls.some((c) => c.method !== 'GET'));
  }
  // An existing editable version is fine in that state (it was created before).
  const reuse = fakeASC({ versions: [v('v0', '0.1.0', 'PENDING_DEVELOPER_RELEASE'), v('v1', '0.1.1', 'PREPARE_FOR_SUBMISSION')] });
  assert.equal((await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: reuse.fetchFn, log: () => {} })).build, '36');
});

test('an update without What\'s New is refused before anything changes', async () => {
  const fresh = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: fresh.fetchFn, log: () => {} }), /notes are required: Apple wants What's New for an update, and version 0\.1\.1 has none/);
  const reused = fakeASC({ versions: [shipped, v('v1', '0.1.1', 'PREPARE_FOR_SUBMISSION')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: reused.fetchFn, log: () => {} }), /notes are required/);
  for (const f of [fresh, reused]) assert.ok(!f.calls.some((c) => c.method !== 'GET'));
});

test("the app's first version has no What's New: optional, skipped with a note when given", async () => {
  const asc = fakeASC({ versions: [] });
  const logs = [];
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.equal(r.submission, 'subNew');
  assert.ok(logs.some((l) => /What's New not set: 0\.1\.1 is the app's first version/.test(l)), logs.join('\n'));
  assert.ok(!asc.trail().some((t) => t.includes('appStoreVersionLocalizations')));
  const quiet = fakeASC({ versions: [] });
  assert.equal((await submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: quiet.fetchFn, log: () => {} })).submission, 'subNew');
});

test('a version string already waiting for review, any version in review, or one parked in an unsubmitted submission is refused before anything changes', async () => {
  const waiting = fakeASC({ versions: [v('v1', '0.1.0', 'WAITING_FOR_REVIEW')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.0', fetchFn: waiting.fetchFn, log: () => {} }), /version 0\.1\.0 is already waiting for or in review/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: waiting.fetchFn, log: () => {} }), /version 0\.1\.0 is already waiting for or in review/);
  const sale = fakeASC({ versions: [v('v1', '0.1.0', 'READY_FOR_DISTRIBUTION')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.0', fetchFn: sale.fetchFn, log: () => {} }), /version 0\.1\.0 is READY_FOR_DISTRIBUTION; submit a new version string/);
  const parked = fakeASC({ versions: [shipped, v('v2', '0.1.2', 'READY_FOR_REVIEW')] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: parked.fetchFn, log: () => {} }), /version 0\.1\.2 sits in a review submission that was never submitted/);
  for (const f of [waiting, sale, parked]) assert.ok(!f.calls.some((c) => c.method !== 'GET'));
});

test('the build must be a processed one of the version; the newest is the default', async () => {
  const asc = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '99', notes: 'x', fetchFn: asc.fetchFn, log: () => {} }), /build 99 is not a processed, unexpired TestFlight build of version 0\.1\.1/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '30', notes: 'x', fetchFn: asc.fetchFn, log: () => {} }), /build 30 is not a processed, unexpired TestFlight build of version 0\.1\.1/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.2.0', notes: 'x', fetchFn: asc.fetchFn, log: () => {} }), /no processed, unexpired TestFlight build carries version 0\.2\.0: bump MARKETING_VERSION in ios\/project\.yml/);
  assert.ok(!asc.calls.some((c) => c.method !== 'GET'));
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: asc.fetchFn, log: () => {} });
  assert.equal(r.build, '36');
});

test('a dry run only reads; a reused version has its localization read before the stop', async () => {
  const asc = fakeASC();
  await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: asc.fetchFn, log: () => {} });
  assert.deepEqual(asc.trail(), [...LOOKUP, 'GET /builds']);
  const reused = fakeASC({ versions: [shipped, v('v1', '0.1.1', 'PREPARE_FOR_SUBMISSION')] });
  await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: reused.fetchFn, log: () => {} });
  assert.deepEqual(reused.trail(), [...LOOKUP, 'GET /builds', 'GET /appStoreVersions/v1/appStoreVersionLocalizations']);
});

test("a refused What's New is an error, not a note", async () => {
  const asc = fakeASC({ fail: ['PATCH /appStoreVersionLocalizations/loc-en-vNew'] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: () => {} }), /PATCH \/appStoreVersionLocalizations\/loc-en-vNew: 409/);
  assert.ok(!asc.trail().includes('POST /reviewSubmissions'));
});

test('a version left READY_FOR_REVIEW by an earlier run is submitted as it stands, after every check', async () => {
  const state = { versions: [shipped, v('v1', '0.1.1', 'READY_FOR_REVIEW')], ...open, attached: { id: 'b36', attributes: { version: '36' } }, whatsNew: { v1: 'Set last time' } };
  const asc = fakeASC(state);
  const logs = [];
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(r, { app: 'app1', build: '36', version: '0.1.1', created: false, resumed: true, submission: 'subOpen' });
  assert.deepEqual(asc.trail(), [...LOOKUP, 'GET /appStoreVersions/v1/build', 'GET /appStoreVersions/v1/appStoreVersionLocalizations', 'GET /apps/app1/reviewSubmissions', 'GET /reviewSubmissions/subOpen/items', 'PATCH /reviewSubmissions/subOpen']);
  assert.match(logs[0], /READY_FOR_REVIEW with build 36 already .*What's New stays as it is: submitting/);
  // The same build may be named; another one is refused; a dry run does every check and stops before the PATCH.
  await submit({ key, bundleId: 'b', version: '0.1.1', build: '36', fetchFn: fakeASC(state).fetchFn, log: () => {} });
  const other = fakeASC(state);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '35', fetchFn: other.fetchFn, log: () => {} }), /READY_FOR_REVIEW with build 36, not 35/);
  assert.ok(!other.calls.some((c) => c.method !== 'GET'));
  const dry = fakeASC(state);
  assert.deepEqual(await submit({ key, bundleId: 'b', version: '0.1.1', dryRun: true, fetchFn: dry.fetchFn, log: () => {} }), { app: 'app1', build: '36', version: '0.1.1', created: false, resumed: true });
  assert.deepEqual(dry.trail(), [...LOOKUP, 'GET /appStoreVersions/v1/build', 'GET /appStoreVersions/v1/appStoreVersionLocalizations', 'GET /apps/app1/reviewSubmissions', 'GET /reviewSubmissions/subOpen/items']);
  // No open submission holding it: refused with advice (also in a dry run); one holding something else is left alone.
  const orphan = fakeASC({ ...state, submissions: [] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', dryRun: true, fetchFn: orphan.fetchFn, log: () => {} }), /no open review submission holds version 0\.1\.1/);
  const otherItem = fakeASC({ ...state, submissions: [{ id: 'subX', attributes: { state: 'READY_FOR_REVIEW' }, items: [item('i9', 'v9')] }] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: otherItem.fetchFn, log: () => {} }), /holds 1 item\(s\) that are not version 0\.1\.1/);
  // Among several open submissions, the one holding the version is found.
  const several = fakeASC({ ...state, submissions: [{ id: 'subEmpty', attributes: { state: 'READY_FOR_REVIEW' }, items: [] }, ...open.submissions] });
  assert.equal((await submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: several.fetchFn, log: () => {} })).submission, 'subOpen');
});

test("a READY_FOR_REVIEW update without What's New takes it from notes, or is refused", async () => {
  const state = { versions: [shipped, v('v1', '0.1.1', 'READY_FOR_REVIEW')], ...open, attached: { id: 'b36', attributes: { version: '36' } } };
  const bare = fakeASC(state);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: bare.fetchFn, log: () => {} }), /READY_FOR_REVIEW without What's New, which Apple requires for an update; run again with notes/);
  assert.ok(!bare.calls.some((c) => c.method !== 'GET'));
  const asc = fakeASC(state);
  const logs = [];
  await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'Now', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(asc.trail().slice(-2), ['PATCH /appStoreVersionLocalizations/loc-en-v1', 'PATCH /reviewSubmissions/subOpen']);
  assert.equal(asc.calls.at(-2).body.data.attributes.whatsNew, 'Now');
  assert.match(logs[0], /What's New from notes: submitting/);
  const refused = fakeASC({ ...state, fail: ['PATCH /appStoreVersionLocalizations/loc-en-v1'] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'Now', fetchFn: refused.fetchFn, log: () => {} }), /409[\s\S]*remove it from its review submission in App Store Connect, then run again/);
  assert.ok(!refused.trail().includes('PATCH /reviewSubmissions/subOpen'));
  // Any other failure (here a 500) is reported as it is, without that advice.
  const outage = fakeASC(state);
  const flaky = async (url, init) => (init?.method === 'PATCH' && url.includes('/appStoreVersionLocalizations/') ? { ok: false, status: 500, text: async () => '{"errors":[{"title":"Internal"}]}' } : outage.fetchFn(url, init));
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'Now', fetchFn: flaky, log: () => {} }), (err) => /: 500 /.test(err.message) && !/remove it from its review submission/.test(err.message));
});

test('an API refusal names the call and Apple\'s detail', async () => {
  const asc = fakeASC({ fail: ['PATCH /reviewSubmissions/subNew'] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: () => {} }), /PATCH \/reviewSubmissions\/subNew: 409 STATE_ERROR The request cannot be fulfilled fake failure/);
});

test('bad arguments are refused before any call', async () => {
  const asc = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: 'v1', fetchFn: asc.fetchFn }), /--version must be X\.Y or X\.Y\.Z/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', build: 'latest', fetchFn: asc.fetchFn }), /--build must be a build number/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', release: 'now', fetchFn: asc.fetchFn }), /--release must be/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', notes: 'x'.repeat(4001), fetchFn: asc.fetchFn }), /--notes is 4001 characters; Apple allows 4000/);
  assert.equal(asc.calls.length, 0);
});
