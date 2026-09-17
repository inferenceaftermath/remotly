// WebCrypto JWT signing for the two upstreams: ES256 for the APNs provider token, RS256 for the Google
// service-account assertion. Only Web APIs (crypto.subtle, atob/btoa), so the same code runs in the Worker and
// under Node for the tests. Signing stays under a millisecond of CPU; callers cache the results.

const encoder = new TextEncoder();

export function b64url(input: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `-----BEGIN PRIVATE KEY-----` PEM (PKCS#8) → DER bytes. Throws on anything else. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!m || !m[1]) throw new Error('expected a PKCS#8 "BEGIN PRIVATE KEY" PEM block');
  const bin = atob(m[1].replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export type JwtAlg = 'ES256' | 'RS256';
/** WebCrypto key type spelled portably (Workers types and @types/node name it differently). */
export type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export function importSigningKey(pem: string, alg: JwtAlg): Promise<SigningKey> {
  const der = pemToPkcs8(pem);
  return alg === 'ES256'
    ? crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    : crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** `header.claims.signature`; ECDSA signatures come out of WebCrypto already in the raw r||s form JWTs use. */
export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: SigningKey, alg: JwtAlg): Promise<string> {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig =
    alg === 'ES256'
      ? await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(data))
      : await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, encoder.encode(data));
  return `${data}.${b64url(sig)}`;
}
