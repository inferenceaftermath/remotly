// Register Remotly's Android app in the Firebase project and write android/app/google-services.json,
// using the FCM service account already configured for the bridge (manual step H8 reduced to one command):
//   REMOTLY_CONFIG_DIR=~/.config/remotly node scripts/firebase-android-app.ts [--package com.inferenceaftermath.remotly] [--name Remotly]
// Idempotent: reuses an existing app with the same package name. Needs the service account to have
// the Firebase Admin (or Editor) role on the project.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const packageName = arg('--package', 'com.inferenceaftermath.remotly');
const displayName = arg('--name', 'Remotly');
const outFile = path.resolve(import.meta.dirname, '..', '..', 'android', 'app', 'google-services.json');

const config = loadConfig();
const saPath = config.push.fcm.service_account_path;
if (!fs.existsSync(saPath)) {
  console.error(`service account not found at ${saPath} (copy it there first, mode 0600)`);
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8')) as { client_email: string; private_key: string; project_id: string; token_uri?: string };
const project = config.push.fcm.project_id || sa.project_id;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
async function accessToken(): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), sa.private_key);
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const token = await accessToken();
const api = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
};

const base = `https://firebase.googleapis.com/v1beta1/projects/${project}`;
interface AndroidApp { name: string; appId: string; packageName: string; displayName?: string }
const list = await api<{ apps?: AndroidApp[] }>('GET', `${base}/androidApps?pageSize=100`);
let app = (list.apps ?? []).find((a) => a.packageName === packageName);
if (app) {
  console.log(`existing Android app ${app.appId} (${packageName})`);
} else {
  console.log(`creating Android app ${packageName} in ${project} …`);
  const op = await api<{ name: string; done?: boolean; response?: AndroidApp }>('POST', `${base}/androidApps`, { packageName, displayName });
  let done = op;
  for (let i = 0; i < 30 && !done.done; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    done = await api<typeof op>('GET', `https://firebase.googleapis.com/v1beta1/${op.name}`);
  }
  if (!done.done || !done.response) throw new Error('app creation did not finish; check the Firebase console');
  app = done.response;
  console.log(`created ${app.appId}`);
}
const cfg = await api<{ configFilename: string; configFileContents: string }>('GET', `${base}/androidApps/${app.appId}/config`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.from(cfg.configFileContents, 'base64'));
console.log(`wrote ${outFile} (${cfg.configFilename}); it is gitignored — rebuild the Android app to pick it up`);
