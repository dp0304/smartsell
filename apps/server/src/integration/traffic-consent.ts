import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PublicVisitor } from '../modules/traffic/operation-bridge.js';

const cookieName = 'smartsell_traffic_consent';
type Choice = { consent: false } | (PublicVisitor & { landingPath?: string });

export function trafficConsent(origin: string, key: Uint8Array) {
  const secure = origin.startsWith('https:');
  const name = secure ? `__Host-${cookieName}` : cookieName;
  const sign = (payload: string) => createHmac('sha256', key).update(JSON.stringify([origin, payload])).digest('base64url');
  return {
    read(header: string | undefined): Choice | undefined {
      const entry = header?.split(/;\s*/).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
      if (!entry || entry.length > 2048) return;
      const [payload, signature, extra] = entry.split('.');
      if (!payload || !signature || extra !== undefined || !/^[\w-]{43}$/.test(signature)) return;
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return;
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Choice;
    },
    write(choice: Choice) {
      const payload = Buffer.from(JSON.stringify(choice)).toString('base64url');
      return `${name}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    },
  };
}

export function analyticsChoice(optedIn: boolean, prior?: Choice): Choice {
  if (!optedIn) return { consent: false };
  return prior?.consent ? prior : { consent: true, sessionRef: randomUUID() };
}
