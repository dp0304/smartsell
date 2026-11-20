import type { PoolClient } from 'pg';
import { opaque, type IdentityState } from '../../../../packages/identity/src/state.ts';
import type { User } from '../store.js';
import type { CommandIdentityUnit } from './command-identity-state.js';

const totpKey = /^totp:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

export function postgresCommandIdentityUnit(client: PoolClient): CommandIdentityUnit {
  async function lock(accountId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ss.command_identity:' || $1::uuid::text, 0))", [accountId]);
  }

  const state: IdentityState = {
    async read<T>(key: string) {
      // Challenge completion learns the account from the consumed flow before reading the factor.
      const accountId = totpKey.exec(key)?.[1];
      if (accountId) await lock(accountId);
      const { rows: [row] } = await client.query<{ version: string; value: T }>(
        'SELECT version, value FROM ss.command_identity_state WHERE key=$1', [key]);
      return row ?? null;
    },
    async compareAndSwap<T>(key: string, version: string | null, value: T) {
      const params = [key, opaque(), JSON.stringify(value)];
      const result = version === null
        ? await client.query(`INSERT INTO ss.command_identity_state (key, version, value)
          VALUES ($1,$2,$3::jsonb) ON CONFLICT (key) DO NOTHING`, params)
        : await client.query(`UPDATE ss.command_identity_state SET version=$2, value=$3::jsonb
          WHERE key=$1 AND version=$4`, [...params, version]);
      return result.rowCount === 1;
    },
    async putFlow(key, binding, expiresAt, value) {
      await client.query('SELECT ss.command_identity_put_flow($1,$2,$3,$4::jsonb)',
        [key, binding, new Date(expiresAt), JSON.stringify(value)]);
    },
    async takeFlow<T>(key: string, binding: string) {
      const { rows: [row] } = await client.query<{ value: T }>(`DELETE FROM ss.command_identity_flow
        WHERE key=$1 AND binding=$2 AND expires_at > clock_timestamp() RETURNING value`, [key, binding]);
      return row?.value ?? null;
    },
  };

  return {
    state,
    lock,
    async passwordHash(accountId) {
      const { rows: [row] } = await client.query<{ hash: string | null }>(
        'SELECT ss.command_identity_password_hash($1) AS hash', [accountId]);
      return row?.hash ?? undefined;
    },
    async sessionUser(tokenHash) {
      const { rows: [user] } = await client.query<User>('SELECT * FROM ss.session_user($1)', [tokenHash]);
      return user;
    },
    async issueSession(userId, tokenHash, replace) {
      await client.query('SELECT ss.issue_session($1,$2,$3)', [tokenHash, userId, replace]);
    },
    async audit(accountId, action) {
      await client.query('INSERT INTO ss.command_identity_audit (user_id, action) VALUES ($1,$2)', [accountId, action]);
    },
  };
}
