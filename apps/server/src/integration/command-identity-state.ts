import { opaque, type IdentityState } from '../../../../packages/identity/src/index.ts';
import type { User } from '../store.js';

export type CommandIdentityAction = 'enroll' | 'confirm' | 'revoke' | 'recovery_revoke' | 'login_totp' | 'login_recovery';

export type CommandIdentityUnit = {
  state: IdentityState;
  lock(accountId: string): Promise<void>;
  passwordHash(accountId: string): Promise<string | undefined>;
  sessionUser(tokenHash: string): Promise<User | undefined>;
  issueSession(userId: string, tokenHash: string, replace?: string): Promise<void>;
  audit(accountId: string, action: CommandIdentityAction): Promise<void>;
};

export type CommandIdentitySnapshot = {
  records: Record<string, { version: string; value: unknown }>;
  flows: Record<string, { binding: string; expiresAt: number; value: unknown }>;
  audit: { accountId: string; action: CommandIdentityAction; at: string }[];
};

// The preview snapshot transaction serializes reads and writes, including session issuance.
export function previewIdentityState({ records, flows }: CommandIdentitySnapshot): IdentityState {
  return {
    async read<T>(key: string) {
      return structuredClone(records[key] ?? null) as { version: string; value: T } | null;
    },
    async compareAndSwap<T>(key: string, version: string | null, value: T) {
      if ((records[key]?.version ?? null) !== version) return false;
      records[key] = { version: opaque(), value };
      return true;
    },
    async putFlow(key, binding, expiresAt, value) {
      const now = Date.now();
      for (const [id, flow] of Object.entries(flows)) if (flow.expiresAt <= now) delete flows[id];
      flows[key] = { binding, expiresAt, value };
    },
    async takeFlow<T>(key: string, binding: string) {
      const flow = flows[key];
      if (!flow || flow.binding !== binding || flow.expiresAt <= Date.now()) return null;
      delete flows[key];
      return flow.value as T;
    },
  };
}
