import { AdapterError, classifyCode, TransportError, client, record } from './provider-http.ts';
import { TransportFailure } from './types.ts';
import type { AdapterTransport, ClassifiedError, ErrorClass, PlatformProvider, TransportRequest } from './types.ts';

export { AdapterError, classifyError, identifier, json, record as object, text, url as urlWith, bearer } from './provider-http.ts';
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const https = (value: unknown): URL | undefined => {
  try {
    if (typeof value !== 'string') return;
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url;
  } catch { /* invalid URL */ }
};
export function fail(errorClass: ErrorClass, reason: string): never { throw new AdapterError(errorClass, reason); }
export const platformError = (_provider: PlatformProvider, code: string): ClassifiedError => classifyCode(code, 'platform_rejected');
export function createRequester(provider: PlatformProvider, transport?: AdapterTransport) {
  return async (request: TransportRequest) => {
    if (!transport) fail('unsupported', 'transport_unavailable');
    const send = client(provider, async wire => {
      try {
        return await transport({ ...wire, method: request.method, effect: request.effect });
      } catch (error) {
        if (error instanceof TransportFailure) throw new TransportError(error.delivery);
        throw error;
      }
    });
    const response = await send({ method: request.method, url: request.url, headers: { ...request.headers }, body: request.body }, { mutation: request.effect === 'write' });
    return { payload: record(response.body), headers: response.headers };
  };
}
export type Requester = ReturnType<typeof createRequester>;
