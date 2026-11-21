import { createHmac, timingSafeEqual } from 'node:crypto';
import { Problem } from '@smartsell/contracts';
import type { FastifyRequest } from 'fastify';
import { header } from './identity.js';

/** Bind the operation CSRF token to the existing, rotating Command cookie. */
export function createOperationCsrf(secret: string) {
  function token(sessionHash: string | undefined) {
    if (!sessionHash) return undefined;
    return createHmac('sha256', secret).update(`smartsell:operation-csrf:v1:${sessionHash}`).digest('base64url');
  }
  return {
    token,
    check(request: FastifyRequest, sessionHash: string | undefined) {
      const expected = token(sessionHash);
      const supplied = header(request, 'x-csrf-token');
      if (!expected || !supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw new Problem(403, 'CSRF_FAILED', 'Invalid CSRF token');
      }
    },
  };
}
