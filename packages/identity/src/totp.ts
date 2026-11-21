import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { digest, equal, IdentityError, IdentitySecrets, type IdentityState, opaque } from './state.ts';

const fiveMinutes = 300_000;
const stepMs = 30_000;
const attemptsPerWindow = 10;

type SecretFactor = { id: string; sealed: string };
type ActiveFactor = SecretFactor & { lastStep: number; recoveryHashes: string[] };
type FactorState = {
  pending?: SecretFactor & { expiresAt: number };
  active?: ActiveFactor;
  attempts?: { until: number; used: number };
};

// Obtained only from core after fresh password verification.
export type PasswordProof = { accountId: string; credentialVersion: string };
export type MfaAnswer = { totp: string } | { recoveryCode: string };
type Challenge = { proof: PasswordProof; factorId: string };

export class TotpIdentity {
  constructor(private readonly state: IdentityState, private readonly secrets: IdentitySecrets,
    private readonly clock = Date.now) {}

  private key(accountId: string) { return `totp:${accountId}`; }

  private async update<T>(accountId: string, change: (value: FactorState) => { value: FactorState; result: T }): Promise<T> {
    const key = this.key(accountId);
    for (let retry = 0; retry < 16; retry++) {
      const row = await this.state.read<FactorState>(key);
      const next = change(row?.value ?? {});
      if (await this.state.compareAndSwap(key, row?.version ?? null, next.value)) return next.result;
    }
    throw new IdentityError(503, 'Identity state busy');
  }

  private attempt(state: FactorState, now: number) {
    if (!state.attempts || state.attempts.until <= now) state.attempts = { until: now + fiveMinutes, used: 0 };
    if (state.attempts.used >= attemptsPerWindow) throw new IdentityError(429, 'Try again later');
    state.attempts.used++;
  }

  private factor(accountId: string, value: SecretFactor) {
    return new TOTP({ secret: Secret.fromBase32(this.secrets.open(value.sealed, `${this.key(accountId)}:${value.id}`)) });
  }

  private step(accountId: string, value: SecretFactor, token: string, now: number) {
    if (!/^\d{6}$/.test(token)) return null;
    const delta = this.factor(accountId, value).validate({ token, timestamp: now, window: 1 });
    return delta === null ? null : Math.floor(now / stepMs) + delta;
  }

  async enroll(accountId: string, label: string) {
    const id = opaque();
    const secret = new Secret({ size: 20 });
    await this.update(accountId, value => {
      if (value.active) throw new IdentityError(409, 'TOTP already enabled');
      value.pending = { id, sealed: this.secrets.seal(secret.base32, `${this.key(accountId)}:${id}`), expiresAt: this.clock() + fiveMinutes };
      return { value, result: undefined };
    });
    return { enrollmentId: id, uri: new TOTP({ issuer: 'SmartSell', label, secret }).toString() };
  }

  async confirm(accountId: string, enrollmentId: string, token: string) {
    const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
    const accepted = await this.update(accountId, value => {
      const now = this.clock();
      const pending = value.pending;
      if (value.active || !pending || pending.id !== enrollmentId || pending.expiresAt <= now) throw new IdentityError();
      this.attempt(value, now);
      const step = this.step(accountId, pending, token, now);
      if (step === null) return { value, result: false };
      value.active = { id: pending.id, sealed: pending.sealed, lastStep: step, recoveryHashes: codes.map(digest) };
      delete value.pending;
      return { value, result: true };
    });
    if (!accepted) throw new IdentityError();
    return { recoveryCodes: codes };
  }

  // Call after successful password validation and before issuing a session.
  async afterPassword(proof: PasswordProof) {
    const factor = (await this.state.read<FactorState>(this.key(proof.accountId)))?.value.active;
    if (!factor) return { required: false } as const;
    const challenge = opaque();
    await this.state.putFlow(`mfa:${digest(challenge)}`, '', this.clock() + fiveMinutes, { proof, factorId: factor.id });
    return { required: true, challenge } as const;
  }

  async finish(challenge: string, answer: MfaAnswer) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new IdentityError();
    const flow = await this.state.takeFlow<Challenge>(`mfa:${digest(challenge)}`, '');
    if (!flow) throw new IdentityError();
    const method = await this.update(flow.proof.accountId, value => {
      if (value.active?.id !== flow.factorId) throw new IdentityError();
      return { value, result: this.verify(flow.proof.accountId, value, answer) };
    });
    if (!method) throw new IdentityError();
    return { ...flow.proof, factorId: flow.factorId, method };
  }

  private verify(accountId: string, value: FactorState, answer: MfaAnswer) {
    const active = value.active;
    if (!active) throw new IdentityError();
    const now = this.clock();
    this.attempt(value, now);
    if ('recoveryCode' in answer) {
      const hash = digest(answer.recoveryCode);
      const index = active.recoveryHashes.findIndex(candidate => equal(candidate, hash));
      if (index < 0) return null;
      active.recoveryHashes.splice(index, 1);
      return 'recovery' as const;
    }
    const step = this.step(accountId, active, answer.totp, now);
    if (step === null || step <= active.lastStep) return null;
    active.lastStep = step;
    return 'totp' as const;
  }

  async revoke(accountId: string, answer: MfaAnswer, what: 'factor' | 'recovery') {
    const accepted = await this.update(accountId, value => {
      if (!this.verify(accountId, value, answer)) return { value, result: false };
      if (what === 'factor') delete value.active;
      else if (value.active) value.active.recoveryHashes = [];
      return { value, result: true };
    });
    if (!accepted) throw new IdentityError();
  }

  // A core issuer can recheck this while it serializes account security changes.
  async factorId(accountId: string) {
    return (await this.state.read<FactorState>(this.key(accountId)))?.value.active?.id ?? null;
  }
}
