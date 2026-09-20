#!/usr/bin/env node
// Submit an iOS build that is on TestFlight to App Store review: the App Store version for a version string (found in
// a state that can still be edited, or created), the build of that version attached, "What's New" set, one review
// submission with that version, submitted. Run by promote.yml; nothing is built or uploaded here (deliver.yml's ios
// lane does). No dependencies: the App Store Connect API key signs a JWT (ES256), then the App Store Connect API v1.
//   env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_CONTENT (the .p8 text), ASC_BUNDLE_ID
//   args: --version 0.1.1 [--build 36] [--notes "text"] [--release after-approval|manual] [--dry-run]
//   (notes = What's New: required for an update unless the version already has it, absent on the app's first version)
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
// app is past its first version, every later one is an update, and Apple requires "What's New" on it.
const IN_FLIGHT = ['WAITING_FOR_REVIEW', 'WAITING_FOR_EXPORT_COMPLIANCE', 'IN_REVIEW', 'READY_FOR_REVIEW'];
const PAST_REVIEW = ['ACCEPTED', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION'];
// Past review but not out yet: Apple lets a new version be created only once the current one is ready for distribution.
const NOT_OUT_YET = ['ACCEPTED', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_DISTRIBUTION'];
// Review submissions that can still take an item; a submission already sent needs a new one after it completes.
const OPEN_SUBMISSION = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES']; // (item states: READY_FOR_REVIEW, REJECTED, …)
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
  const inReview = flight.filter((v) => v.attributes.appVersionState !== 'READY_FOR_REVIEW').map((v) => `${v.attributes.versionString} (${v.attributes.appVersionState})`);
  if (inReview.length) throw new Error(`version ${inReview.join(', ')} is already waiting for or in review; Apple takes one at a time${inReview.some((s) => s.includes('EXPORT_COMPLIANCE')) ? " (wait for Apple's export-compliance review, or remove it from review)" : ''}`);
  const parked = flight.filter((v) => v.attributes.appVersionState === 'READY_FOR_REVIEW' && v.attributes.versionString !== version).map((v) => v.attributes.versionString);
  if (parked.length) throw new Error(`version ${parked.join(', ')} sits in a review submission that was never submitted; submit or remove it in App Store Connect first`);
  if (ver && state !== 'READY_FOR_REVIEW' && !EDITABLE.has(state)) throw new Error(`version ${version} is ${state}; submit a new version string`);
  // An update (a version passed review before) must carry What's New; the app's first version has no such field.
  const past = await versionsWhere(`filter[appVersionState]=${PAST_REVIEW.join(',')}`);
  const update = past.length > 0;
  if (!ver) {
    const notOut = past.find((p) => NOT_OUT_YET.includes(p.attributes.appVersionState));
    if (notOut) throw new Error(`version ${notOut.attributes.versionString} is ${notOut.attributes.appVersionState}; Apple lets a new version be created once it is ready for distribution (release it in App Store Connect first)`);
  }
  const releaseType = release === 'manual' ? 'MANUAL' : 'AFTER_APPROVAL';
  const primaryLocalization = async (v) => {
    const locs = await call('GET', `/appStoreVersions/${v.id}/appStoreVersionLocalizations?filter[locale]=${encodeURIComponent(app.attributes.primaryLocale)}&limit=200&fields[appStoreVersionLocalizations]=locale,whatsNew`);
    const loc = locs.data?.[0];
    if (!loc) throw new Error(`version ${version} has no ${app.attributes.primaryLocale} localization to put What's New on`);
    return loc;
  };
  const setWhatsNew = (loc) => call('PATCH', `/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: notes } } });
  // The open review submission for the version: the one holding it (and nothing else), an empty one, or none. An open
  // submission holding other items (an in-app event, a product page) is somebody's draft: this run submits one version,
  // not that, and says so. The items name their version only when the relationship is asked for by name and included.
  const itemsOf = async (sub) => (await call('GET', `/reviewSubmissions/${sub.id}/items?fields[reviewSubmissionItems]=state,appStoreVersion&include=appStoreVersion&limit=200`)).data ?? [];
  const isVersion = (i, v) => i.relationships?.appStoreVersion?.data?.id === v.id;
  const findSubmission = async (v) => { // v: the version, or undefined when it does not exist yet
    const subs = (await call('GET', `/apps/${app.id}/reviewSubmissions?filter[platform]=IOS&filter[state]=${OPEN_SUBMISSION.join(',')}&limit=200&fields[reviewSubmissions]=state`)).data ?? [];
    const withItems = [];
    for (const sub of subs) withItems.push({ sub, items: await itemsOf(sub) });
    const holder = v && withItems.find((s) => s.items.some((i) => isVersion(i, v)));
    if (holder) {
      if (holder.items.length > 1) throw new Error(`the review submission holding version ${version} holds ${holder.items.length - 1} other item(s) too; submit it, or remove them, in App Store Connect`);
      return { sub: holder.sub, item: holder.items[0] };
    }
    const other = withItems.find((s) => s.items.length > 0);
    if (other) throw new Error(`an open review submission (${other.sub.attributes.state}) holds ${other.items.length} item(s) that are not version ${version}; submit or remove it in App Store Connect first`);
    return { sub: withItems[0]?.sub };
  };
  // Send the submission: created when there is none, the version added when it is not in it, a rejected item marked
  // resolved (Apple's step before a resubmission), then — after a last look at its items, since a submission goes
  // whole and somebody may have added to it since the lookup — submitted.
  const send = async ({ sub, item }, v) => {
    if (!sub) sub = (await call('POST', '/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
    if (!item) await call('POST', '/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } });
    else if (item.attributes?.state === 'REJECTED') await call('PATCH', `/reviewSubmissionItems/${item.id}`, { data: { type: 'reviewSubmissionItems', id: item.id, attributes: { resolved: true } } });
    const items = await itemsOf(sub);
    if (items.length !== 1 || !isVersion(items[0], v)) throw new Error(`the review submission holds ${items.length} item(s) now, not version ${version} alone; nothing was submitted — check it in App Store Connect and run again`);
    const done = await call('PATCH', `/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
    return { id: sub.id, state: done.data?.attributes?.state ?? 'submitted' };
  };
  if (state === 'READY_FOR_REVIEW') {
    // An earlier run attached the build and put the version into a submission, then stopped: finish it as it stands.
    const attached = (await call('GET', `/appStoreVersions/${ver.id}/build?fields[builds]=version`)).data;
    const has = attached?.attributes.version;
    if (!has) throw new Error(`version ${version} is READY_FOR_REVIEW without a build; remove it from its review submission in App Store Connect and run again`);
    if (build !== undefined && has !== String(build)) throw new Error(`version ${version} is READY_FOR_REVIEW with build ${has}, not ${build}; remove it from its review submission in App Store Connect first`);
    const loc = update ? await primaryLocalization(ver) : undefined;
    const missing = update && !loc.attributes.whatsNew?.trim();
    if (missing && !notes) throw new Error(`version ${version} is READY_FOR_REVIEW without What's New, which Apple requires for an update; run again with notes`);
    const found = await findSubmission(ver);
    if (!found.item) throw new Error(`no open review submission holds version ${version}; remove the version from review in App Store Connect and run again`);
    log(`${name}: version ${version} is READY_FOR_REVIEW with build ${has} already (an earlier run stopped before submitting)${missing ? '; What\'s New from notes' : notes ? '; What\'s New stays as it is' : ''}: submitting`);
    if (dryRun) { log('dry run: nothing changed'); return { app: app.id, build: has, version, created: false, resumed: true }; }
    if (missing) {
      await setWhatsNew(loc).catch((err) => {
        // A state conflict means the version cannot be edited as it stands; anything else (auth, rate limit, outage) is retried as is.
        if (/: 409 /.test(err.message)) throw new Error(`${err.message}\nWhat's New cannot be set on the version as it stands; remove it from its review submission in App Store Connect, then run again`);
        throw err;
      });
    }
    const sent = await send(found, ver);
    log(`submitted: version ${version} with build ${has} — review submission ${sent.id} is ${sent.state}`);
    return { app: app.id, build: has, version, created: false, resumed: true, submission: sent.id };
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
  // What's New: required for an update — from notes, or already on the version being reused; absent on the first version.
  // A reused version's primary localization is read now, before anything changes (it must exist to take the notes).
  let whatsNew = 'none';
  let loc = update && ver ? await primaryLocalization(ver) : undefined;
  if (update) {
    if (notes) whatsNew = 'from notes';
    else if (loc?.attributes.whatsNew?.trim()) whatsNew = 'as it is';
    else throw new Error(`notes are required: Apple wants What's New for an update, and version ${version} has none`);
  } else if (notes) {
    log(`What's New not set: ${version} is the app's first version, which has no What's New`);
  }
  // The review submission is settled now too, before anything changes: somebody's open draft stops the run here.
  const found = await findSubmission(ver);
  log(`${name}: ${ver ? `version ${version} (${state})` : `new version ${version}`} ← build ${chosen.attributes.version} (${chosen.attributes.uploadedDate}), release ${releaseType}, What's New ${whatsNew}`);
  if (dryRun) { log('dry run: nothing changed'); return { app: app.id, build: chosen.attributes.version, version, created: !ver }; }
  let v = ver;
  if (!v) {
    v = (await call('POST', '/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: version, releaseType }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  } else if (v.attributes.releaseType !== releaseType) {
    await call('PATCH', `/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes: { releaseType } } });
  }
  await call('PATCH', `/appStoreVersions/${v.id}/relationships/build`, { data: { type: 'builds', id: chosen.id } });
  if (whatsNew === 'from notes') await setWhatsNew(loc ?? await primaryLocalization(v));
  // One review submission for the platform with the version as its item: the open one holding it (a rejected item is
  // marked resolved), an empty open one, or a new one.
  const sent = await send(found, v);
  log(`submitted: version ${version} with build ${chosen.attributes.version} — review submission ${sent.id} is ${sent.state}`);
  return { app: app.id, build: chosen.attributes.version, version, created: !ver, submission: sent.id };
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
