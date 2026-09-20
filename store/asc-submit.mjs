#!/usr/bin/env node
// Submit an iOS build that is on TestFlight to App Store review: the App Store version for a version string (found in
// a state that can still be edited, or created), the build attached, "What's New" set, one review submission with that
// version, submitted. Run by promote.yml; nothing is built or uploaded here (deliver.yml's ios lane does). No
// dependencies: the App Store Connect API key signs a JWT (ES256), then the App Store Connect API v1.
//   env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_CONTENT (the .p8 text), ASC_BUNDLE_ID
//   args: --version 0.1.1 [--build 36] [--notes "text"] [--release after-approval|manual] [--dry-run]
// Test: store/test/asc-submit.test.mjs (the API is a fake fetch).
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com/v1';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/** A short-lived App Store Connect API token. */
export function ascToken({ keyId, issuerId, p8 }, now = Math.floor(Date.now() / 1000)) {
  const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const body = b64({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: createPrivateKey(p8), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

// The version states in which the version can still take a build and be submitted; anything else needs a new version
// string (WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, READY_FOR_SALE, …).
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
// Review submissions that can still take an item; a submission already sent needs a new one after it completes.
const OPEN_SUBMISSION = new Set(['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES']);

export async function submit({ key, bundleId, version, build, notes, release = 'after-approval', dryRun, fetchFn = fetch, log = console.log }) {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version ?? '')) throw new Error(`--version must be X.Y or X.Y.Z, got ${version}`);
  if (!['after-approval', 'manual'].includes(release)) throw new Error(`--release must be after-approval or manual, got ${release}`);
  const token = ascToken(key);
  const call = async (method, path, body) => {
    const r = await fetchFn(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (!r.ok) { const e = json.errors?.[0]; throw new Error(`${method} ${path}: ${r.status} ${e ? `${e.code ?? ''} ${e.title ?? ''} ${e.detail ?? ''}`.trim() : text.slice(0, 300)}`); }
    return json;
  };
  const apps = await call('GET', `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,primaryLocale`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`no App Store Connect app for ${bundleId}`);
  // The build: the given number, or the newest processed one; never an expired one.
  const builds = await call('GET', `/builds?filter[app]=${app.id}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=50&fields[builds]=version,uploadedDate`);
  const chosen = build === undefined ? builds.data?.[0] : builds.data?.find((b) => b.attributes.version === String(build));
  if (!chosen) throw new Error(build === undefined ? 'no processed build on TestFlight' : `build ${build} is not a processed, unexpired build on TestFlight`);
  // The version: an editable one with this string, or a new one.
  const versions = await call('GET', `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20&fields[appStoreVersions]=versionString,appVersionState,releaseType`);
  const same = (versions.data ?? []).filter((v) => v.attributes.versionString === version);
  const blocked = same.find((v) => !EDITABLE.has(v.attributes.appVersionState));
  if (blocked) throw new Error(`version ${version} is ${blocked.attributes.appVersionState}; submit a new version string`);
  const inFlight = (versions.data ?? []).filter((v) => ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(v.attributes.appVersionState)).map((v) => v.attributes.versionString);
  if (inFlight.length) throw new Error(`version ${inFlight.join(', ')} is already waiting for or in review; Apple takes one at a time`);
  const releaseType = release === 'manual' ? 'MANUAL' : 'AFTER_APPROVAL';
  let ver = same[0];
  log(`${app.attributes.name}: ${ver ? `version ${version} (${ver.attributes.appVersionState})` : `new version ${version}`} ← build ${chosen.attributes.version} (${chosen.attributes.uploadedDate}), release ${releaseType}${notes ? ', with What\'s New' : ''}`);
  if (dryRun) { log('dry run: nothing changed'); return { app: app.id, build: chosen.attributes.version, version, created: !ver }; }
  if (!ver) {
    ver = (await call('POST', '/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: version, releaseType }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  } else if (ver.attributes.releaseType !== releaseType) {
    await call('PATCH', `/appStoreVersions/${ver.id}`, { data: { type: 'appStoreVersions', id: ver.id, attributes: { releaseType } } });
  }
  await call('PATCH', `/appStoreVersions/${ver.id}/relationships/build`, { data: { type: 'builds', id: chosen.id } });
  if (notes) {
    const locs = await call('GET', `/appStoreVersions/${ver.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`);
    const loc = (locs.data ?? []).find((l) => l.attributes.locale === app.attributes.primaryLocale) ?? locs.data?.[0];
    if (!loc) throw new Error('the version has no localization to put What\'s New on');
    try {
      await call('PATCH', `/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: notes } } });
    } catch (err) {
      // Apple refuses What's New on an app's first version.
      if (!/whatsNew|What's New/i.test(err.message)) throw err;
      log(`What's New not set: ${err.message}`);
    }
  }
  // One review submission for the platform: an open one is reused, otherwise created; the version is its item.
  const subs = await call('GET', `/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=${[...OPEN_SUBMISSION].join(',')}&limit=5&fields[reviewSubmissions]=state`);
  let sub = subs.data?.[0];
  if (!sub) sub = (await call('POST', '/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  const items = await call('GET', `/reviewSubmissions/${sub.id}/items?fields[reviewSubmissionItems]=state&include=appStoreVersion`);
  if (!(items.data ?? []).some((i) => i.relationships?.appStoreVersion?.data?.id === ver.id)) {
    await call('POST', '/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } } } } });
  }
  const done = await call('PATCH', `/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
  log(`submitted: version ${version} with build ${chosen.attributes.version} — review submission ${sub.id} is ${done.data?.attributes?.state ?? 'submitted'}`);
  return { app: app.id, build: chosen.attributes.version, version, created: same.length === 0, submission: sub.id };
}

function args(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--build') out.build = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--release') out.release = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.version) throw new Error('--version is required (the App Store version string, e.g. 0.1.1)');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_CONTENT, ASC_BUNDLE_ID } = process.env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_API_KEY_P8_CONTENT || !ASC_BUNDLE_ID) { console.error('set ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_CONTENT and ASC_BUNDLE_ID'); process.exit(2); }
  submit({ key: { keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, p8: ASC_API_KEY_P8_CONTENT }, bundleId: ASC_BUNDLE_ID, ...args(process.argv.slice(2)) })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
