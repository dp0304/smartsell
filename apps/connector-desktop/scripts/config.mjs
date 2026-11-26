import { createPublicKey } from 'node:crypto';

export function httpsUrl(value, name, originOnly = false) {
  if (!value) return;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) {
    throw new Error(`${name} must be an HTTPS ${originOnly ? 'origin' : 'URL'}`);
  }
  return originOnly ? url.origin : url.href;
}

/**
 * SMARTSELL_RELEASE_PUBLIC_KEY (security review S1): the Ed25519 release public key, as base64 SPKI DER (what
 * `pnpm worker:release` passes) or PEM. Returned as base64 SPKI DER for RELEASE.releasePublicKey; undefined when unset.
 */
export function releasePublicKey(value) {
  const text = value?.trim();
  if (!text) return;
  let key;
  try {
    key = text.startsWith('-----BEGIN') ? createPublicKey(text)
      : /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' }) : null;
  } catch { key = null; }
  if (key?.asymmetricKeyType !== 'ed25519') throw new Error('SMARTSELL_RELEASE_PUBLIC_KEY must be an Ed25519 public key (base64 SPKI DER or PEM)');
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function releaseConfig(platform) {
  const api = httpsUrl(process.env.SMARTSELL_API_ORIGIN, 'SMARTSELL_API_ORIGIN', true);
  const workbench = httpsUrl(process.env.SMARTSELL_WORKBENCH_ORIGIN, 'SMARTSELL_WORKBENCH_ORIGIN', true);
  const feed = httpsUrl(process.env.SMARTSELL_UPDATE_FEED, 'SMARTSELL_UPDATE_FEED');
  const publisher = process.env.SMARTSELL_WIN_PUBLISHER?.trim();
  if (feed && platform === 'win32' && (!publisher || !/(?:^|,)\s*CN=/.test(publisher) || !/(?:^|,)\s*O=/.test(publisher))) {
    throw new Error('SMARTSELL_WIN_PUBLISHER must be the full Authenticode subject DN, including CN and O');
  }
  const releaseKey = releasePublicKey(process.env.SMARTSELL_RELEASE_PUBLIC_KEY);
  return { api, workbench, update: feed ? { feed, publisher } : undefined, ...(releaseKey && { releasePublicKey: releaseKey }) };
}
