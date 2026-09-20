#!/usr/bin/env node
// Submit an iOS build that is on TestFlight to App Store review: the App Store version for a version string (found in
// a state that can still be edited, or created), the build of that version attached, "What's New" set, one review
// submission with that version, submitted. Run by promote.yml; nothing is built or uploaded here (deliver.yml's ios
// lane does). No dependencies: the App Store Connect API key signs a JWT (ES256), then the App Store Connect API v1.
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
// string (WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, READY_FOR_DISTRIBUTION, …). READY_FOR_REVIEW is the
// version sitting in a review submission that was never submitted: an earlier run that stopped before the last step,
// which this one finishes.
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
// Versions Apple has in hand, or had: while one is in flight nothing else is submitted; once one passed review, the
// app is past its first version and "What's New" exists.
const IN_FLIGHT = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'READY_FOR_REVIEW'];
const PAST_REVIEW = ['ACCEPTED', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION'];
// Review submissions that can still take an item; a submission already sent needs a new one after it completes.
const OPEN_SUBMISSION = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'];
const WHATS_NEW_MAX = 4000;

export async function submit({ key, bundleId, version, build, notes, release = 'after-approval', dryRun, fetchFn = fetch, log = console.log }) {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version ?? '')) throw new Error(`--version must be X.Y or X.Y.Z, got ${version}`);
  if (build !== undefined && !/^\d+$/.test(String(build))) throw new Error(`--build must be a build number, got ${build}`);
  if (!['after-approval', 'manual'].includes(release)) throw new Error(`--release must be after-approval or manual, got ${release}`);
  if (notes && notes.length > WHATS_NEW_MAX) throw new Error(`--notes is ${notes.length} characters; Apple allows ${WHATS_NEW_MAX} for What's New`);
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
  const name = app.attributes.name;
  const versionsWhere = async (filter) => (await call('GET', `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&${filter}&limit=200&fields[appStoreVersions]=versionString,appVersionState,releaseType`)).data ?? [];
  // The version with this string (Apple keeps one per string and platform) and whatever is in flight: Apple takes one
  // submission at a time, and a version left in an unsubmitted submission blocks the others until it is dealt with.
  const ver = (await versionsWhere(`filter[versionString]=${encodeURIComponent(version)}`))[0];
  const state = ver?.attributes.appVersionState;
  const flight = await versionsWhere(`filter[appVersionState]=${IN_FLIGHT.join(',')}`);
  const inReview = flight.filter((v) => v.attributes.appVersionState !== 'READY_FOR_REVIEW').map((v) => v.attributes.versionString);
  if (inReview.length) throw new Error(`version ${inReview.join(', ')} is already waiting for or in review; Apple takes one at a time`);
  const parked = flight.filter((v) => v.attributes.appVersionState === 'READY_FOR_REVIEW' && v.attributes.versionString !== version).map((v) => v.attributes.versionString);
  if (parked.length) throw new Error(`version ${parked.join(', ')} sits in a review submission that was never submitted; submit or remove it in App Store Connect first`);
  if (ver && state !== 'READY_FOR_REVIEW' && !EDITABLE.has(state)) throw new Error(`version ${version} is ${state}; submit a new version string`);
  const releaseType = release === 'manual' ? 'MANUAL' : 'AFTER_APPROVAL';
  const openSubmission = async () => (await call('GET', `/apps/${app.id}/reviewSubmissions?filter[platform]=IOS&filter[state]=${OPEN_SUBMISSION.join(',')}&limit=5&fields[reviewSubmissions]=state`)).data?.[0];
  const send = async (sub) => {
    const done = await call('PATCH', `/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
    return done.data?.attributes?.state ?? 'submitted';
  };
  if (state === 'READY_FOR_REVIEW') {
    // An earlier run attached the build and put the version into a submission, then stopped: finish it as it stands.
    const attached = (await call('GET', `/appStoreVersions/${ver.id}/build?fields[builds]=version`)).data;
    const has = attached?.attributes.version;
    if (!has) throw new Error(`version ${version} is READY_FOR_REVIEW without a build; remove it from its review submission in App Store Connect and run again`);
    if (build !== undefined && has !== String(build)) throw new Error(`version ${version} is READY_FOR_REVIEW with build ${has}, not ${build}; remove it from its review submission in App Store Connect first`);
    log(`${name}: version ${version} is READY_FOR_REVIEW with build ${has} already (an earlier run stopped before submitting)${notes ? '; What\'s New stays as it is' : ''}: submitting`);
    if (dryRun) { log('dry run: nothing changed'); return { app: app.id, build: has, version, created: false, resumed: true }; }
    const sub = await openSubmission();
    const items = sub ? (await call('GET', `/reviewSubmissions/${sub.id}/items?fields[reviewSubmissionItems]=state&include=appStoreVersion`)).data ?? [] : [];
    if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === ver.id)) throw new Error(`no open review submission holds version ${version}; remove the version from review in App Store Connect and run again`);
    const st = await send(sub);
    log(`submitted: version ${version} with build ${has} — review submission ${sub.id} is ${st}`);
    return { app: app.id, build: has, version, created: false, resumed: true, submission: sub.id };
  }
  // The build: a processed, unexpired TestFlight build whose marketing version (MARKETING_VERSION at upload) is this
  // version string — the given build number, or the newest.
  const buildsQuery = `/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[preReleaseVersion.platform]=IOS&filter[processingState]=VALID&filter[expired]=false${build === undefined ? '' : `&filter[version]=${build}`}&sort=-uploadedDate&limit=1&fields[builds]=version,uploadedDate`;
  const chosen = (await call('GET', buildsQuery)).data?.[0];
  if (!chosen) {
    throw new Error(build === undefined
      ? `no processed, unexpired TestFlight build carries version ${version}: bump MARKETING_VERSION in ios/project.yml to ${version} and let deliver.yml upload one`
      : `build ${build} is not a processed, unexpired TestFlight build of version ${version}`);
  }
  log(`${name}: ${ver ? `version ${version} (${state})` : `new version ${version}`} ← build ${chosen.attributes.version} (${chosen.attributes.uploadedDate}), release ${releaseType}${notes ? ', with What\'s New' : ''}`);
  if (dryRun) { log('dry run: nothing changed'); return { app: app.id, build: chosen.attributes.version, version, created: !ver }; }
  let v = ver;
  if (!v) {
    v = (await call('POST', '/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: version, releaseType }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  } else if (v.attributes.releaseType !== releaseType) {
    await call('PATCH', `/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes: { releaseType } } });
  }
  await call('PATCH', `/appStoreVersions/${v.id}/relationships/build`, { data: { type: 'builds', id: chosen.id } });
  if (notes) {
    // Apple has no "What's New" on an app's first version: it exists once a version passed review.
    const past = await versionsWhere(`filter[appVersionState]=${PAST_REVIEW.join(',')}`);
    if (past.length === 0) {
      log(`What's New not set: ${version} is the app's first version, which has no What's New`);
    } else {
      const locs = await call('GET', `/appStoreVersions/${v.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`);
      const loc = (locs.data ?? []).find((l) => l.attributes.locale === app.attributes.primaryLocale) ?? locs.data?.[0];
      if (!loc) throw new Error('the version has no localization to put What\'s New on');
      await call('PATCH', `/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: notes } } });
    }
  }
  // One review submission for the platform: an open one is reused, otherwise created; the version is its item.
  let sub = await openSubmission();
  if (!sub) sub = (await call('POST', '/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  const items = (await call('GET', `/reviewSubmissions/${sub.id}/items?fields[reviewSubmissionItems]=state&include=appStoreVersion`)).data ?? [];
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === v.id)) {
    await call('POST', '/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } });
  }
  const st = await send(sub);
  log(`submitted: version ${version} with build ${chosen.attributes.version} — review submission ${sub.id} is ${st}`);
  return { app: app.id, build: chosen.attributes.version, version, created: !ver, submission: sub.id };
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
