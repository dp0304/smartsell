// Ed25519 release signature for Worker updates (security review S1, §8.18). `pnpm worker:release` signs and the
// Worker App verifies exactly the bytes built here, so both import this one file.
//
// Signed bytes: the JSON object {platform, sha256, version} in RFC 8785 (JCS) form — keys sorted, no whitespace,
// UTF-8. The package file is bound through sha256; the Worker checks the downloaded bytes against that hash.
// The public key travels as base64 SPKI DER (one line, no PEM armour) so it embeds cleanly in the esbuild define.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const RELEASE_PLATFORMS = ['mac-arm64', 'mac-x64', 'win-x64'] as const;
export type ReleasePlatform = typeof RELEASE_PLATFORMS[number];
export interface SignedReleaseFields { version: string; platform: string; sha256: string }

const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
/** An Ed25519 signature (64 bytes) in standard base64. */
export const RELEASE_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** The canonical bytes that are signed. Throws on fields a release can never have. */
export function releaseSignaturePayload(fields: SignedReleaseFields): Buffer {
  const { version, platform, sha256 } = fields;
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('version must be major.minor.patch[-pre]');
  if (!(RELEASE_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`unknown platform ${String(platform)}`);
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 lowercase hex digits');
  return Buffer.from(JSON.stringify({ platform, sha256, version }), 'utf8');
}

function ed25519(key: KeyObject, kind: 'private' | 'public') {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`release ${kind} key must be Ed25519, not ${key.asymmetricKeyType ?? 'unknown'}`);
  return key;
}

/** A private key from PEM (PKCS#8) text or a KeyObject. */
export function releasePrivateKey(key: string | KeyObject): KeyObject {
  return ed25519(typeof key === 'string' ? createPrivateKey(key) : key, 'private');
}

/** A public key from base64 SPKI DER, PEM text or a KeyObject (a private key yields its public half). */
export function releasePublicKey(key: string | KeyObject): KeyObject {
  if (typeof key !== 'string') return ed25519(key.type === 'private' ? createPublicKey(key) : key, 'public');
  const text = key.trim();
  if (text.startsWith('-----BEGIN')) return ed25519(createPublicKey(text), 'public');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('release public key must be base64 SPKI DER or PEM');
  return ed25519(createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' }), 'public');
}

/** The one-line form embedded in the Worker build (`RELEASE.releasePublicKey`). */
export function encodeReleasePublicKey(key: string | KeyObject): string {
  return releasePublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
}

export function signRelease(fields: SignedReleaseFields, privateKey: string | KeyObject): string {
  return sign(null, releaseSignaturePayload(fields), releasePrivateKey(privateKey)).toString('base64');
}

export type ReleaseSignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid' | 'bad_fields' | 'bad_key' };

/** Never throws: a bad key, bad fields or a bad signature is a failed check with a reason. */
export function verifyReleaseSignature(fields: SignedReleaseFields, signature: string | null | undefined,
  publicKey: string | KeyObject): ReleaseSignatureCheck {
  let key: KeyObject;
  try { key = releasePublicKey(publicKey); } catch { return { ok: false, reason: 'bad_key' }; }
  if (signature === undefined || signature === null || signature === '') return { ok: false, reason: 'missing' };
  if (typeof signature !== 'string' || !RELEASE_SIGNATURE.test(signature)) return { ok: false, reason: 'malformed' };
  let payload: Buffer;
  try { payload = releaseSignaturePayload(fields); } catch { return { ok: false, reason: 'bad_fields' }; }
  try {
    return verify(null, payload, key, Buffer.from(signature, 'base64')) ? { ok: true } : { ok: false, reason: 'invalid' };
  } catch { return { ok: false, reason: 'invalid' }; }
}
