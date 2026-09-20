#!/usr/bin/env node
// Promote the newest internal-testing release (or a given version code) to Play's production track: a staged rollout
// to a fraction of users (status inProgress), raised on later runs until 1 (status completed). Run by promote.yml;
// nothing is built or uploaded here. The bundle must already be on Play (deliver.yml's android lane), and the app
// must have had one production release through the console (Play's rule for the API). No dependencies: the service
// account signs a JWT (RS256) for an OAuth token, then the Android Publisher API v3 in one edit (insert → tracks →
// update production → validate → commit).
//   env: PLAY_SERVICE_ACCOUNT_JSON (the key JSON), PLAY_PACKAGE (application id)
//   args: --fraction 0.1|0.25|0.5|1 [--version-code N] [--notes "text"] [--dry-run]
// Test: store/test/play-promote.test.mjs (the API is a fake fetch).
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

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

/** The plan: which version code, and the production release to write. Pure, so the test pins it. */
export function plan({ tracks, fraction, versionCode, notes }) {
  const internal = tracks.find((t) => t.track === 'internal');
  const production = tracks.find((t) => t.track === 'production');
  const codes = (t) => (t?.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number));
  let code = versionCode;
  if (code === undefined) {
    const candidates = codes(internal);
    if (candidates.length === 0) throw new Error('the internal track has no release to promote');
    code = Math.max(...candidates);
  }
  const live = Math.max(0, ...codes(production).filter((c) => production.releases.some((r) => r.status === 'completed' && r.versionCodes?.includes(String(c)))));
  if (code < live) throw new Error(`version code ${code} is older than production's completed release ${live}`);
  const release = { versionCodes: [String(code)], status: fraction >= 1 ? 'completed' : 'inProgress' };
  if (fraction < 1) release.userFraction = fraction;
  if (notes) release.releaseNotes = [{ language: 'en-US', text: notes }];
  // Play keeps one release in progress at a time: the rollout of `code` replaces any earlier staged release; a
  // completed release of an older code stays as the fallback and is retained by Play, not repeated here.
  return { code, release, replaces: (production?.releases ?? []).filter((r) => r.status === 'inProgress' && !r.versionCodes?.includes(String(code))).map((r) => r.versionCodes) };
}

export async function promote({ sa, pkg, fraction, versionCode, notes, dryRun, fetchFn = fetch, log = console.log }) {
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`--fraction must be in (0, 1], got ${fraction}`);
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
    log(`production ← ${p.code} as ${p.release.status}${p.release.userFraction ? ` (${Math.round(p.release.userFraction * 100)}% of users)` : ''}${p.replaces.length ? `, replacing the staged ${p.replaces.flat().join(', ')}` : ''}`);
    if (dryRun) { log('dry run: the edit is discarded'); return p; }
    await call('PUT', `/edits/${edit.id}/tracks/production`, { track: 'production', releases: [p.release] });
    await call('POST', `/edits/${edit.id}:validate`);
    await call('POST', `/edits/${edit.id}:commit`);
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
