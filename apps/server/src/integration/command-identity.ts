import { digest, IdentityError, IdentitySecrets, TotpIdentity, type MfaAnswer } from '../../../../packages/identity/src/index.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, type Fields } from '../modules/types.js';
import { invalid, passwordMatches, requestObject } from '../auth.js';
import { unauthenticated, type Store } from '../store.js';
import type { CommandIdentityAction, CommandIdentityUnit } from './command-identity-state.js';

const path = '/api/v1/auth/totp';

function field(body: Fields, key: string, pattern: RegExp) {
  const value = body[key];
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid('Invalid identity request');
  return value;
}

const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const totpCode = /^\d{6}$/;

function answer(body: Fields): MfaAnswer {
  if ((body.totp === undefined) === (body.recoveryCode === undefined)) throw invalid('Provide one second factor');
  return body.totp !== undefined ? { totp: field(body, 'totp', totpCode) }
    : { recoveryCode: field(body, 'recoveryCode', /^[a-f0-9]{32}$/) };
}

export function commandIdentity(store: Store, key: Uint8Array) {
  const secrets = new IdentitySecrets(key);
  const transact = store.commandIdentity?.bind(store);
  if (!transact) throw new Error('Commands identity storage is unavailable');

  const run = async <T>(work: (unit: CommandIdentityUnit, totp: TotpIdentity) => Promise<T>): Promise<T> => {
    const result = await transact(async unit => {
      try { return { data: await work(unit, new TotpIdentity(unit.state, secrets)) }; }
      catch (error) {
        // Failed factor attempts and consumed challenges must survive a verification error.
        if (error instanceof IdentityError) return { failure: { status: error.statusCode, message: error.message } };
        throw error;
      }
    });
    if (result.failure) throw new DomainError('identity_verification', result.failure.message, result.failure.status);
    return result.data;
  }

  return {
    async login(user: { id: string; passwordHash: string }, hash: string, replace?: string) {
      return run(async (unit, totp) => {
        await unit.lock(user.id);
        if (await unit.passwordHash(user.id) !== user.passwordHash) throw new IdentityError();
        const gate = await totp.afterPassword({ accountId: user.id, credentialVersion: digest(user.passwordHash) });
        if (!gate.required) await unit.issueSession(user.id, hash, replace);
        return gate;
      });
    },
    async finish(body: Fields, hash: string, replace?: string) {
      const challenge = field(body, 'challenge', opaqueToken);
      const factor = answer(body);
      await run(async (unit, totp) => {
        const proof = await totp.finish(challenge, factor);
        const passwordHash = await unit.passwordHash(proof.accountId);
        if (!passwordHash || digest(passwordHash) !== proof.credentialVersion ||
          await totp.factorId(proof.accountId) !== proof.factorId) throw new IdentityError();
        await unit.issueSession(proof.accountId, hash, replace);
        await unit.audit(proof.accountId, proof.method === 'totp' ? 'login_totp' : 'login_recovery');
      });
    },
    register(app: FastifyInstance, sessionHash: (request: FastifyRequest) => string | undefined,
      checkCsrf: (request: FastifyRequest, hash: string) => void) {
      app.get(path, request => run(async (unit, totp) => {
        const hash = sessionHash(request);
        const user = hash && await unit.sessionUser(hash);
        if (!user) throw unauthenticated();
        return { data: { enabled: !!await totp.factorId(user.id), canManage: true, passwordRecheck: true } };
      }));
      const manage = (action: CommandIdentityAction, change: (totp: TotpIdentity, id: string, email: string, body: Fields) => Promise<unknown>) =>
        async (request: FastifyRequest) => {
          const hash = sessionHash(request);
          if (!hash) throw unauthenticated();
          checkCsrf(request, hash);
          const body = requestObject(request.body);
          const password = body.password;
          if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) throw invalid('Invalid password');
          return run(async (unit, totp) => {
            const user = await unit.sessionUser(hash);
            if (!user) throw unauthenticated();
            await unit.lock(user.id);
            if (!(await unit.sessionUser(hash))) throw unauthenticated();
            const passwordHash = await unit.passwordHash(user.id);
            if (!passwordHash) throw new IdentityError();
            const key = `reauth:${user.id}`;
            const previous = await unit.state.read<{ until: number; count: number }>(key);
            const now = Date.now();
            const window = previous && previous.value.until > now ? previous.value : { until: now + 60_000, count: 0 };
            if (window.count >= 10) throw new IdentityError(429, 'Try again later');
            if (!await unit.state.compareAndSwap(key, previous?.version ?? null, { ...window, count: window.count + 1 })) {
              throw new IdentityError(503, 'Identity state busy');
            }
            if (!await passwordMatches(passwordHash, password)) throw new IdentityError();
            const data = await change(totp, user.id, user.email, body);
            await unit.audit(user.id, action);
            return { data: data ?? {} };
          });
        };
      const options = { bodyLimit: 4096 };
      app.post(`${path}/enroll`, options, manage('enroll', (totp, id, email) => totp.enroll(id, email)));
      app.post(`${path}/confirm`, options, manage('confirm', (totp, id, _email, body) =>
        totp.confirm(id, field(body, 'enrollmentId', opaqueToken), field(body, 'totp', totpCode))));
      app.post(`${path}/revoke`, options, manage('revoke', (totp, id, _email, body) => totp.revoke(id, answer(body), 'factor')));
      app.post(`${path}/recovery/revoke`, options, manage('recovery_revoke', (totp, id, _email, body) => totp.revoke(id, answer(body), 'recovery')));
    },
  };
}
