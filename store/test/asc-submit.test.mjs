import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ascToken, submit } from '../asc-submit.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const key = { keyId: 'KEY1', issuerId: 'iss-1', p8: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const app = { id: 'app1', attributes: { name: 'Remotly', primaryLocale: 'en-US' } };
const builds = [{ id: 'b36', attributes: { version: '36', uploadedDate: '2026-09-20T15:56:16Z' } }, { id: 'b35', attributes: { version: '35', uploadedDate: '2026-09-20T12:17:32Z' } }];

/** A fake App Store Connect: `versions` and `submissions` are the current state; every call is recorded. */
function fakeASC({ versions = [], submissions = [], items = [], fail = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace('https://api.appstoreconnect.apple.com/v1', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const respond = (status, obj) => ({ ok: status < 300, status, text: async () => (obj === undefined ? '' : JSON.stringify(obj)) });
    const bare = path.split('?')[0];
    if (fail.some((f) => `${method} ${bare}` === f)) return respond(409, { errors: [{ code: 'STATE_ERROR', title: 'The request cannot be fulfilled', detail: `fake failure of ${method} ${bare}` }] });
    if (method === 'GET' && bare === '/apps') return respond(200, { data: [app] });
    if (method === 'GET' && bare === '/builds') return respond(200, { data: builds });
    if (method === 'GET' && bare === '/apps/app1/appStoreVersions') return respond(200, { data: versions });
    if (method === 'POST' && bare === '/appStoreVersions') return respond(201, { data: { id: 'vNew', attributes: { ...body.data.attributes, appVersionState: 'PREPARE_FOR_SUBMISSION' } } });
    if (method === 'PATCH' && /^\/appStoreVersions\/[^/]+$/.test(bare)) return respond(200, { data: { id: bare.split('/')[2] } });
    if (method === 'PATCH' && bare.endsWith('/relationships/build')) return respond(204, undefined);
    if (method === 'GET' && bare.endsWith('/appStoreVersionLocalizations')) return respond(200, { data: [{ id: 'loc-en', attributes: { locale: 'en-US', whatsNew: '' } }, { id: 'loc-de', attributes: { locale: 'de-DE' } }] });
    if (method === 'PATCH' && bare.startsWith('/appStoreVersionLocalizations/')) return fail.includes('whatsNew') ? respond(409, { errors: [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', detail: "The attribute 'whatsNew' cannot be set on the first version" }] }) : respond(200, { data: { id: 'loc-en' } });
    if (method === 'GET' && bare === '/reviewSubmissions') return respond(200, { data: submissions });
    if (method === 'POST' && bare === '/reviewSubmissions') return respond(201, { data: { id: 'subNew', attributes: { state: 'READY_FOR_REVIEW' } } });
    if (method === 'GET' && /^\/reviewSubmissions\/[^/]+\/items$/.test(bare)) return respond(200, { data: items });
    if (method === 'POST' && bare === '/reviewSubmissionItems') return respond(201, { data: { id: 'item1' } });
    if (method === 'PATCH' && /^\/reviewSubmissions\/[^/]+$/.test(bare)) return respond(200, { data: { id: bare.split('/')[2], attributes: { state: 'WAITING_FOR_REVIEW' } } });
    return respond(404, { errors: [{ title: `unexpected ${method} ${bare}` }] });
  };
  return { fetchFn, calls, trail: () => calls.map((c) => `${c.method} ${c.path.split('?')[0]}`) };
}

test('ascToken: an ES256 JWT with the key id, issuer and audience', () => {
  const [h, p] = ascToken(key, 1_000_000).split('.').slice(0, 2).map((s) => JSON.parse(Buffer.from(s, 'base64url')));
  assert.deepEqual(h, { alg: 'ES256', kid: 'KEY1', typ: 'JWT' });
  assert.deepEqual(p, { iss: 'iss-1', iat: 1_000_000, exp: 1_000_600, aud: 'appstoreconnect-v1' });
});

test('a new version: created, build attached, What\'s New set, one submission created and submitted', async () => {
  const asc = fakeASC();
  const logs = [];
  const r = await submit({ key, bundleId: 'com.example.app', version: '0.1.1', notes: 'Fixes', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.deepEqual(r, { app: 'app1', build: '36', version: '0.1.1', created: true, submission: 'subNew' });
  assert.deepEqual(asc.trail(), ['GET /apps', 'GET /builds', 'GET /apps/app1/appStoreVersions', 'POST /appStoreVersions', 'PATCH /appStoreVersions/vNew/relationships/build',
    'GET /appStoreVersions/vNew/appStoreVersionLocalizations', 'PATCH /appStoreVersionLocalizations/loc-en', 'GET /reviewSubmissions', 'POST /reviewSubmissions', 'GET /reviewSubmissions/subNew/items', 'POST /reviewSubmissionItems', 'PATCH /reviewSubmissions/subNew']);
  const created = asc.calls[3].body.data;
  assert.deepEqual(created.attributes, { platform: 'IOS', versionString: '0.1.1', releaseType: 'AFTER_APPROVAL' });
  assert.equal(created.relationships.app.data.id, 'app1');
  assert.deepEqual(asc.calls[4].body, { data: { type: 'builds', id: 'b36' } });
  assert.equal(asc.calls[6].body.data.attributes.whatsNew, 'Fixes');
  assert.equal(asc.calls[10].body.data.relationships.appStoreVersion.data.id, 'vNew');
  assert.deepEqual(asc.calls[11].body.data.attributes, { submitted: true });
  assert.match(logs[0], /new version 0\.1\.1 ← build 36 .*release AFTER_APPROVAL, with What's New/);
  assert.match(logs.at(-1), /submitted: version 0\.1\.1 with build 36/);
});

test('an editable version with the string is reused; a different release type is patched; an open submission is reused', async () => {
  const asc = fakeASC({ versions: [{ id: 'v1', attributes: { versionString: '0.1.1', appVersionState: 'DEVELOPER_REJECTED', releaseType: 'AFTER_APPROVAL' } }], submissions: [{ id: 'subOpen', attributes: { state: 'UNRESOLVED_ISSUES' } }], items: [{ id: 'i1', relationships: { appStoreVersion: { data: { id: 'v1' } } } }] });
  const r = await submit({ key, bundleId: 'com.example.app', version: '0.1.1', build: '35', release: 'manual', fetchFn: asc.fetchFn, log: () => {} });
  assert.deepEqual(r, { app: 'app1', build: '35', version: '0.1.1', created: false, submission: 'subOpen' });
  assert.deepEqual(asc.trail(), ['GET /apps', 'GET /builds', 'GET /apps/app1/appStoreVersions', 'PATCH /appStoreVersions/v1', 'PATCH /appStoreVersions/v1/relationships/build', 'GET /reviewSubmissions', 'GET /reviewSubmissions/subOpen/items', 'PATCH /reviewSubmissions/subOpen']);
  assert.deepEqual(asc.calls[3].body.data.attributes, { releaseType: 'MANUAL' });
  assert.deepEqual(asc.calls[4].body, { data: { type: 'builds', id: 'b35' } });
});

test('a version string already waiting for review, or any version in review, is refused before anything changes', async () => {
  const waiting = fakeASC({ versions: [{ id: 'v1', attributes: { versionString: '0.1.0', appVersionState: 'WAITING_FOR_REVIEW', releaseType: 'AFTER_APPROVAL' } }] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.0', fetchFn: waiting.fetchFn, log: () => {} }), /version 0\.1\.0 is WAITING_FOR_REVIEW; submit a new version string/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: waiting.fetchFn, log: () => {} }), /version 0\.1\.0 is already waiting for or in review/);
  assert.ok(!waiting.calls.some((c) => c.method !== 'GET'));
});

test('the build must be a processed one; the newest is the default', async () => {
  const asc = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', build: '99', fetchFn: asc.fetchFn, log: () => {} }), /build 99 is not a processed, unexpired build/);
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', dryRun: true, fetchFn: asc.fetchFn, log: () => {} });
  assert.equal(r.build, '36');
});

test('a dry run only reads', async () => {
  const asc = fakeASC();
  await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', dryRun: true, fetchFn: asc.fetchFn, log: () => {} });
  assert.deepEqual(asc.trail(), ['GET /apps', 'GET /builds', 'GET /apps/app1/appStoreVersions']);
});

test("Apple refusing What's New on the first version is reported, not fatal", async () => {
  const asc = fakeASC({ fail: ['whatsNew'] });
  const logs = [];
  const r = await submit({ key, bundleId: 'b', version: '0.1.1', notes: 'x', fetchFn: asc.fetchFn, log: (l) => logs.push(l) });
  assert.equal(r.submission, 'subNew');
  assert.ok(logs.some((l) => /What's New not set: .*first version/.test(l)), logs.join('\n'));
});

test('an API refusal names the call and Apple\'s detail', async () => {
  const asc = fakeASC({ fail: ['PATCH /reviewSubmissions/subNew'] });
  await assert.rejects(submit({ key, bundleId: 'b', version: '0.1.1', fetchFn: asc.fetchFn, log: () => {} }), /PATCH \/reviewSubmissions\/subNew: 409 STATE_ERROR The request cannot be fulfilled fake failure/);
});

test('bad arguments are refused before any call', async () => {
  const asc = fakeASC();
  await assert.rejects(submit({ key, bundleId: 'b', version: 'v1', fetchFn: asc.fetchFn }), /--version must be X\.Y or X\.Y\.Z/);
  await assert.rejects(submit({ key, bundleId: 'b', version: '1.0', release: 'now', fetchFn: asc.fetchFn }), /--release must be/);
  assert.equal(asc.calls.length, 0);
});
