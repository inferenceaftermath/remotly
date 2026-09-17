import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { b64url, importSigningKey, pemToPkcs8, signJwt } from '../src/jwt.ts';

const decode = (seg: string): unknown => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));

test('b64url matches Node base64url for strings and bytes', () => {
  const s = 'héllo wörld {"a":1}';
  assert.equal(b64url(s), Buffer.from(s, 'utf8').toString('base64url'));
  const bytes = crypto.randomBytes(70);
  assert.equal(b64url(bytes), bytes.toString('base64url'));
  assert.equal(b64url(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 70)), bytes.toString('base64url'));
});

test('pemToPkcs8 decodes the DER and rejects other PEM kinds', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const der = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  assert.deepEqual(Buffer.from(pemToPkcs8(pem)), der);
  assert.throws(() => pemToPkcs8('-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----'), /PKCS#8/);
});

test('ES256: header, claims and a signature Node verifies in ieee-p1363 form', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = await importSigningKey(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'ES256');
  const jwt = await signJwt({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' }, { iss: 'TEAM123456', iat: 1_700_000_000 }, key, 'ES256');
  const [h, c, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(decode(h), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.deepEqual(decode(c), { iss: 'TEAM123456', iat: 1_700_000_000 });
  assert.equal(Buffer.from(s, 'base64url').length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('RS256: signature verifies against the public key', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = await importSigningKey(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'RS256');
  const jwt = await signJwt({ alg: 'RS256', typ: 'JWT' }, { iss: 'sa@proj.iam.gserviceaccount.com', exp: 1 }, key, 'RS256');
  const [h, c, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
});
