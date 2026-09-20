#!/usr/bin/env node
// Promote a version code (or, without one, the newest completed internal-testing release) to Play's production track:
// a staged rollout to a fraction of users (status inProgress), raised on later runs until 1 (status completed). Run by
// promote.yml, which always names the code (a dispatch may start after a later delivery); nothing is built or uploaded
// here. The bundle must already be on Play (deliver.yml's android lane), and the app
// must have had one production release through the console (Play's rule for the API). No dependencies: the service
// account signs a JWT (RS256) for an OAuth token, then the Android Publisher API v3 in one edit (insert → tracks →
// update production → validate → commit).
//   env: PLAY_SERVICE_ACCOUNT_JSON (the key JSON), PLAY_PACKAGE (application id)
//   args: --fraction 0.1|0.25|0.5|1 [--version-code N] [--notes "text"] [--dry-run]
// Test: store/test/play-promote.test.mjs (the API is a fake fetch).
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const pct = (f) => `${Math.round(f * 100)}%`;
const NOTES_MAX = 500; // Play's limit per language for release notes

/** An OAuth access token for the Android Publisher scope from a service-account key. */
export async function accessToken(sa, fetchFn, now = Math.floor(Date.now() / 1000)) {
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 300 });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), createPrivateKey(sa.private_key)).toString('base64url');
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claims}.${sig}`,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Google token exchange failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token;
}

/**
 * The plan: which version code, and the production track's releases to write. Pure, so the test pins it.
 * The track update names the desired state (releases left out are dropped from the track). A staged rollout goes
 * beside the completed release, which is sent back unchanged as Play's fallback; the rollout of `code` is raised in
 * place when one is under way (its retained version codes, notes and targeting kept); completing sends that release
 * alone, since Play allows one completed release and the new one supersedes the old; any other staged, halted or draft
 * release is left out, i.e. replaced — Play serves one rollout at a time.
 */
export function plan({ tracks, fraction, versionCode, notes }) {
  const internal = tracks.find((t) => t.track === 'internal');
  const production = tracks.find((t) => t.track === 'production');
  const releases = production?.releases ?? [];
  const codesOf = (r) => (r.versionCodes ?? []).map(Number);
  let code = versionCode;
  if (code === undefined) {
    // Only what testers actually got: a draft on the internal track is served to nobody.
    const candidates = (internal?.releases ?? []).filter((r) => r.status === 'completed').flatMap(codesOf);
    if (candidates.length === 0) throw new Error('the internal track has no completed release to promote');
    code = Math.max(...candidates);
  }
  const completed = releases.filter((r) => r.status === 'completed');
  const live = Math.max(0, ...completed.flatMap(codesOf));
  if (completed.some((r) => codesOf(r).includes(code))) throw new Error(`version code ${code} is production's completed release already`);
  if (code < live) throw new Error(`version code ${code} is older than production's completed release ${live}`);
  // A draft on production is somebody's unpublished work (its codes, notes, priority): neither published as this
  // rollout nor dropped by it — the console decides first. This pipeline never makes one.
  const drafts = releases.filter((r) => r.status === 'draft');
  if (drafts.length) throw new Error(`production has a draft release (${drafts.map((r) => codesOf(r).join('+')).join(', ')}); publish or discard it in the Play Console first — a rollout from here would replace it`);
  // A release under way is named by its newest code (a retained older code names nothing); so any code of a rollout
  // above the one named means: not a raise, and not a newer build either.
  const current = releases.find((r) => ['inProgress', 'halted'].includes(r.status) && Math.max(...codesOf(r)) === code);
  const ahead = releases.filter((r) => ['inProgress', 'halted'].includes(r.status)).flatMap(codesOf).filter((c) => c > code);
  if (ahead.length) throw new Error(`version code ${code} is below ${Math.max(...ahead)}, which production is rolling out already; a rollout is raised by its newest code and replaced only by a newer build`);
  if (current?.status === 'halted') throw new Error(`version code ${code} is halted on production; resume it in the Play Console`);
  if (current?.status === 'inProgress' && current.userFraction !== undefined && fraction <= current.userFraction) {
    throw new Error(`version code ${code} is rolled out to ${pct(current.userFraction)} of users already; a rollout is only raised here (halt it in the Play Console)`);
  }
  const status = fraction >= 1 ? 'completed' : 'inProgress';
  const release = current ? { ...current, status } : { versionCodes: [String(code)], status };
  delete release.userFraction;
  if (fraction < 1) release.userFraction = fraction;
  else delete release.countryTargeting; // Play allows it on staged rollouts only
  if (notes) release.releaseNotes = [{ language: 'en-US', text: notes }];
  const replaces = releases.filter((r) => r !== current && r.status !== 'completed').map((r) => `${(r.versionCodes ?? []).join('+')} (${r.status})`);
  return { code, release, releases: status === 'completed' ? [release] : [...completed, release], replaces, raised: Boolean(current) };
}

export async function promote({ sa, pkg, fraction, versionCode, notes, dryRun, fetchFn = fetch, log = console.log }) {
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`--fraction must be in (0, 1], got ${fraction}`);
  if (notes && [...notes].length > NOTES_MAX) throw new Error(`--notes is ${[...notes].length} characters; Play allows ${NOTES_MAX} per language`);
  const token = await accessToken(sa, fetchFn);
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}`;
  const call = async (method, path, body) => {
    const r = await fetchFn(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  };
  const edit = await call('POST', '/edits', {});
  try {
    const { tracks = [] } = await call('GET', `/edits/${edit.id}/tracks`);
    const p = plan({ tracks, fraction, versionCode, notes });
    log(`production ← ${p.code} as ${p.release.status}${p.release.userFraction ? ` (${pct(p.release.userFraction)} of users${p.raised ? ', raised' : ''})` : ''}${p.replaces.length ? `, replacing ${p.replaces.join(', ')}` : ''}`);
    // Play sends a commit for review together with whatever the Publishing overview holds ready to send (console
    // changes not sent yet) — as the console's own button does, and as every deliver.yml upload does. Said each time.
    log('the commit sends every change waiting in the Play Console\'s Publishing overview along with it');
    if (dryRun) { log('dry run: the edit is discarded'); return p; }
    await call('PUT', `/edits/${edit.id}/tracks/production`, { track: 'production', releases: p.releases });
    await call('POST', `/edits/${edit.id}:validate`);
    // Changes the console has in review already are left alone: the commit fails instead of cancelling them.
    await call('POST', `/edits/${edit.id}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`).catch((err) => {
      throw new Error(`${err.message}\nif Play reports changes in review: they were made in the Play Console; wait for that review, or send this rollout from the console`);
    });
    log('committed');
    return p;
  } catch (err) {
    await call('DELETE', `/edits/${edit.id}`).catch(() => {});
    throw err;
  } finally {
    if (dryRun) await call('DELETE', `/edits/${edit.id}`).catch(() => {});
  }
}

function args(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--fraction') out.fraction = Number(argv[++i]);
    else if (a === '--version-code') out.versionCode = Number(argv[++i]);
    else if (a === '--notes') out.notes = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(out.fraction)) throw new Error('--fraction is required (0.1, 0.25, 0.5 or 1)');
  if (out.versionCode !== undefined && !Number.isInteger(out.versionCode)) throw new Error('--version-code must be an integer');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { PLAY_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE } = process.env;
  if (!PLAY_SERVICE_ACCOUNT_JSON || !PLAY_PACKAGE) { console.error('set PLAY_SERVICE_ACCOUNT_JSON and PLAY_PACKAGE'); process.exit(2); }
  promote({ sa: JSON.parse(PLAY_SERVICE_ACCOUNT_JSON), pkg: PLAY_PACKAGE, ...args(process.argv.slice(2)) })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
