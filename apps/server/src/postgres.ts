import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { postgresCommandIdentityUnit } from './integration/command-identity-postgres.js';
import type { CommandIdentityUnit } from './integration/command-identity-state.js';
import { DomainError, type Entity } from './modules/types';
import { domainPersistence } from './postgres-domain.js';
import { postgresSessionUser } from './session-user.js';
import type { LoginIdentifier } from './setup-policy.js';
import {
  checkVersion, duplicateRecord, keyConflict, missingWorkspace, unauthenticated, versionConflict,
  type PublicLocator, type Scope, type Setup, type Store, type Unit, type Workspace,
} from './store';

type DbEntity = Omit<Entity, 'created_at' | 'updated_at'> & { created_at: Date; updated_at: Date };
const entity = (row: DbEntity): Entity => ({ ...row, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() });

export class PostgresStore implements Store {
  private readonly pool: Pool;

  constructor(connectionString: string, onPoolError: (error: Error) => void = console.error) {
    this.pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000' });
    this.pool.on('error', onPoolError);
    // pg removes its idle-client listener on checkout, and can emit again while a broken client closes.
    // Query and pool errors are handled separately; keep a listener for errors between those boundaries.
    this.pool.on('connect', client => client.on('error', () => {}));
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await run(client);
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new Error('PostgreSQL transaction did not commit');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async ready(mode?: 'request' | 'background') {
    const { rows: [row] } = await this.pool.query<{ safe: boolean; command_identity: boolean }>(`
      SELECT current_setting('server_version_num')::integer >= 170000
        AND current_setting('row_security') = 'on'
        AND session_user = current_user
        AND EXISTS (SELECT FROM pg_roles r WHERE r.rolname = 'smartsell_request'
          AND NOT r.rolcanlogin AND pg_has_role(r.oid, 'USAGE'))
        AND NOT EXISTS (SELECT FROM pg_roles r WHERE
          (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
            OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program'))
          AND pg_has_role(r.oid, 'MEMBER'))
        AND NOT EXISTS (SELECT FROM pg_namespace n WHERE n.nspname = 'ss' AND pg_has_role(n.nspowner, 'MEMBER'))
        AND (SELECT count(*) = 5 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'ss' AND c.relname IN ('entities','idempotency','audit','events','outbox')
          AND c.relrowsecurity AND c.relforcerowsecurity AND NOT pg_has_role(c.relowner, 'MEMBER'))
        AND to_regprocedure('ss.scope_actor()') IS NOT NULL
        AND to_regprocedure('ss.lock_scoped_workspace(uuid)') IS NOT NULL
        AND to_regprocedure('ss.scoped_members_for_actor(uuid)') IS NOT NULL
        AND to_regprocedure('ss.change_membership(uuid,uuid,text,text,text[])') IS NOT NULL
        AND to_regprocedure('ss.issue_session_ttl(text,uuid,integer)') IS NOT NULL
        AND to_regprocedure('ss.is_initialized()') IS NOT NULL
        AND to_regprocedure('ss.bootstrap(text,text,text,text,text)') IS NOT NULL
        AND to_regprocedure('ss.username_credentials(text)') IS NOT NULL
        AND coalesce(has_function_privilege(to_regprocedure('ss.session_user_profile(text)'), 'EXECUTE'), false) AS safe,
        coalesce(
          has_table_privilege(to_regclass('ss.command_identity_state'), 'SELECT')
          AND has_table_privilege(to_regclass('ss.command_identity_state'), 'INSERT')
          AND has_column_privilege(to_regclass('ss.command_identity_state'), 'version', 'UPDATE')
          AND has_column_privilege(to_regclass('ss.command_identity_state'), 'value', 'UPDATE')
          AND has_table_privilege(to_regclass('ss.command_identity_flow'), 'SELECT')
          AND has_table_privilege(to_regclass('ss.command_identity_flow'), 'DELETE')
          AND has_column_privilege(to_regclass('ss.command_identity_audit'), 'user_id', 'INSERT')
          AND has_column_privilege(to_regclass('ss.command_identity_audit'), 'action', 'INSERT')
          AND has_function_privilege(to_regprocedure('ss.command_identity_password_hash(uuid)'), 'EXECUTE')
          AND has_function_privilege(to_regprocedure('ss.command_identity_put_flow(text,text,timestamptz,jsonb)'), 'EXECUTE'),
          false) AS command_identity`);
    if (!row.safe) throw new Error('Expected migrated PostgreSQL 17+ with a non-owner, non-BYPASSRLS request role');
    if (mode) {
      const { rows: [role] } = await this.pool.query<{ domain: boolean; member: boolean; inherits: boolean; any_access: boolean; all_access: boolean }>(`
        SELECT to_regprocedure('core.in_domain_scope(uuid,uuid)') IS NOT NULL AS domain,
          EXISTS (SELECT FROM pg_roles WHERE rolname='smartsell_background' AND pg_has_role(oid,'MEMBER')) AS member,
          EXISTS (SELECT FROM pg_roles WHERE rolname='smartsell_background' AND pg_has_role(oid,'USAGE')) AS inherits,
          bool_or(coalesce(has_function_privilege(to_regprocedure(name), 'EXECUTE'), false)) AS any_access,
          bool_and(coalesce(has_function_privilege(to_regprocedure(name), 'EXECUTE'), false)) AS all_access
        FROM unnest(ARRAY['ss.operation_workspaces()', 'ss.lock_operation_workspace(uuid)',
          'ss.operation_members(uuid)', 'ss.operation_active_pat_holders(uuid,uuid)']) AS f(name)`);
      if (!role.domain || (mode === 'background' ? !role.inherits || !role.all_access : role.member || role.any_access)) {
        throw new Error(`Expected an isolated PostgreSQL ${mode} login with domain migrations applied`);
      }
    }
    if (mode !== 'background' && !row.command_identity) {
      throw new Error('Expected PostgreSQL Command Identity migration and request privileges');
    }
  }

  async close() { await this.pool.end(); }

  commandIdentity<T>(run: (unit: CommandIdentityUnit) => Promise<T>): Promise<T> {
    return this.transaction(client => run(postgresCommandIdentityUnit(client)));
  }

  async initialized() {
    const { rows: [row] } = await this.pool.query<{ initialized: boolean }>('SELECT ss.is_initialized() AS initialized');
    return row.initialized;
  }

  async setup(input: Setup, tokenHash: string, replace?: string) {
    return this.transaction(async client => {
      const { rows: [row] } = await client.query<{ id: string | null }>(
        'SELECT ss.bootstrap($1,$2,$3,$4,$5) AS id', [input.email, input.name, input.passwordHash, input.workspaceName, input.username]);
      if (!row.id) return false;
      await client.query('SELECT ss.issue_session($1,$2,$3)', [tokenHash, row.id, replace]);
      return true;
    });
  }

  async credentials(input: LoginIdentifier | string) {
    const identifier = typeof input === 'string' ? { email: input } : input;
    const lookup = identifier.email === undefined ? 'ss.username_credentials' : 'ss.credentials';
    const { rows: [row] } = await this.pool.query<{ id: string; passwordHash: string }>(
      `SELECT id, password_hash AS "passwordHash" FROM ${lookup}($1)`, [identifier.email ?? identifier.username]);
    return row;
  }

  async acceptMemberInvitation({ tokenHash, email, name, passwordHash }: Parameters<NonNullable<Store['acceptMemberInvitation']>>[0]) {
    const { rows: [row] } = await this.pool.query<{ accepted: boolean }>(
      'SELECT ss.accept_member_invitation($1,$2,$3,$4) AS accepted', [tokenHash, email, name, passwordHash]);
    return row.accepted;
  }

  async issueSession(userId: string, tokenHash: string, replace?: string, ttlSeconds?: number) {
    if (ttlSeconds === undefined) await this.pool.query('SELECT ss.issue_session($1,$2,$3)', [tokenHash, userId, replace]);
    // Long-lived Agent sessions never replace the browser session.
    else if (replace === undefined) await this.pool.query('SELECT ss.issue_session_ttl($1,$2,$3)', [tokenHash, userId, ttlSeconds]);
    else throw new Error('A session lifetime cannot replace another session');
  }

  async revokeSession(tokenHash: string) {
    await this.pool.query('SELECT ss.revoke_session($1)', [tokenHash]);
  }

  private async actor(client: PoolClient, tokenHash: string | undefined) {
    if (!tokenHash) return undefined;
    const user = await postgresSessionUser(client, tokenHash);
    if (user) await client.query("SELECT set_config('smartsell.session_hash', $1, true)", [tokenHash]);
    return user;
  }

  async session(tokenHash: string) {
    return this.transaction(async client => {
      const user = await this.actor(client, tokenHash);
      if (!user) return undefined;
      const { rows: workspaces } = await client.query<Workspace>('SELECT * FROM ss.workspaces_for_actor()');
      return { user, workspaces };
    });
  }

  async publicWork<T>(locator: PublicLocator, id: string, run: (unit: Unit) => Promise<T>) {
    return this.transaction(async client => {
      const { rows: [row] } = await client.query<{ tenant_id: string; workspace_id: string; actor_id: string }>(
        'SELECT * FROM ss.public_scope($1,$2)', [locator, id]);
      if (!row) return undefined;
      const scope: Scope = { tenantId: row.tenant_id, workspaceId: row.workspace_id, actorId: row.actor_id, role: 'editor' };
      await client.query(`SELECT set_config('smartsell.session_hash','',true), set_config('smartsell.public_locator',$1,true),
        set_config('smartsell.public_id',$2,true), set_config('smartsell.tenant_id',$3,true), set_config('smartsell.workspace_id',$4,true)`,
        [locator, id, scope.tenantId, scope.workspaceId]);
      return run(unitOfWork(client, scope, 'public'));
    });
  }

  async operationWorkspaces() {
    const { rows } = await this.pool.query<import('./identity.js').Workspace>('SELECT * FROM ss.operation_workspaces()');
    return rows;
  }

  async operationWork<T>(workspaceId: string, run: (unit: Unit, members: { userId: string; role: Scope['role'] }[]) => Promise<T>) {
    return this.transaction(async client => {
      const { rows: [actor] } = await client.query<{ tenant_id: string; actor_id: string }>('SELECT * FROM ss.lock_operation_workspace($1)', [workspaceId]);
      if (!actor) throw missingWorkspace();
      const { rows } = await client.query<{ userId: string; role: Scope['role'] }>('SELECT * FROM ss.operation_members($1)', [workspaceId]);
      const scope: Scope = { tenantId: actor.tenant_id, workspaceId, actorId: actor.actor_id, role: 'owner' };
      await setDomainScope(client, scope);
      return run({
        ...unitOfWork(client, scope, 'system'),
        async listActivePatHolders() {
          const { rows } = await client.query<{ id: string; actorId: string }>(
            'SELECT * FROM ss.operation_active_pat_holders($1,$2)', [scope.tenantId, scope.workspaceId]);
          return rows;
        },
      }, rows);
    });
  }

  async workspace<T>(tokenHash: string | undefined, workspaceId: string, run: (unit: Unit) => Promise<T>, credentialId?: string) {
    return this.transaction(async client => {
      const user = await this.actor(client, tokenHash);
      if (!user) throw unauthenticated();
      const { rows: [member] } = await client.query<{ tenant_id: string; role: Scope['role']; scopes: string[] }>('SELECT * FROM ss.lock_scoped_workspace($1)', [workspaceId]);
      if (credentialId !== undefined) {
        await client.query(`SELECT set_config('smartsell.mcp_workspace_id',$1,true), set_config('smartsell.mcp_credential_id',$2,true)`, [workspaceId, credentialId]);
        const { rows: [credential] } = await client.query<{ data: Entity['data'] }>(`
          SELECT data FROM ss.entities WHERE workspace_id=$1 AND module='mcp_runtime' AND kind='credential'
            AND id=$2 AND data->>'actor_id'=$3`, [workspaceId, credentialId, user.id]);
        if (!credential || credential.data.revoked === true || !(credential.data.expires > Date.now())) throw unauthenticated();
        if (!member || credential.data.workspace_removed === true) throw new DomainError('forbidden', 'Workspace access denied', 403);
      }
      if (!member) throw missingWorkspace();
      await client.query("SELECT set_config('smartsell.tenant_id', $1, true), set_config('smartsell.workspace_id', $2, true)", [member.tenant_id, workspaceId]);
      const scope = { tenantId: member.tenant_id, workspaceId, actorId: user.id, role: member.role };
      await setDomainScope(client, scope);
      return run({ ...unitOfWork(client, scope, 'user'), brandScopes: member.scopes });
    });
  }
}

async function setDomainScope(client: PoolClient, scope: Scope) {
  await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_ids',$2,true),
    set_config('app.principal',$3,true)`, [scope.tenantId, [scope.workspaceId], scope.actorId]);
}

function unitOfWork(client: PoolClient, scope: Scope, mode: 'user' | 'system' | 'public'): Unit {
  const domain = domainPersistence(client, scope, mode);
  const now = new Date().toISOString();
  const partition = [scope.tenantId, scope.workspaceId];
  const key = 'tenant_id=$1 AND workspace_id=$2 AND module=$3 AND kind=$4';
  let auditId: string | undefined;
  let commandRunning = false;
  let ordinal = 0;
  function activeAuditId() {
    if (!auditId) throw new Error('Workspace mutations require an active command');
    return auditId;
  }

  async function lockOperations() {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ss.operation:' || $1::uuid::text, 0))", [scope.workspaceId]);
  }

  return {
    ...mode === 'user' && {
      async issueAgentSession(hash: string, ttlSeconds: number) {
        activeAuditId();
        await client.query('SELECT ss.issue_session_ttl($1,$2,$3)', [hash, scope.actorId, ttlSeconds]);
      },
    },
    async listMembers() {
      const { rows } = await client.query<{ user_id: string; role: Scope['role']; scopes: string[] }>('SELECT * FROM ss.scoped_members_for_actor($1)', [scope.workspaceId]);
      return rows;
    },
    async inviteMember({ id, email, role, tokenHash }) {
      activeAuditId();
      const { rows: [row] } = await client.query<{ result: string }>('SELECT ss.invite_member($1,$2,$3,$4,$5) AS result',
        [scope.workspaceId, id, email, role, tokenHash]);
      if (row.result === 'account_exists') throw new DomainError('account_exists', 'This invitation requires a new account', 409);
      if (row.result !== 'created') throw new DomainError('forbidden', 'Invitation is not permitted', 403);
    },
    async changeMembership(change) {
      activeAuditId();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(change.memberId)) {
        throw new DomainError('invalid_input', 'Invalid member ID');
      }
      const { rows: [row] } = await client.query<{ changed: boolean }>('SELECT ss.change_membership($1,$2,$3,$4,$5) AS changed',
        [scope.workspaceId, change.memberId, change.action, change.action === 'set_role' ? change.role : null, change.action === 'set_role' ? change.scopes ?? null : null]);
      if (!row.changed) throw new DomainError('forbidden', 'Membership change is not permitted', 403);
      if (change.action === 'remove') {
        // Keep expiry and explicit revocation readable, but do not restore PAT access on rejoin.
        await client.query(`UPDATE ss.entities SET data = data || '{"workspace_removed":true}'::jsonb,
          version = version + 1, updated_at = greatest(updated_at,$3)
          WHERE tenant_id=$1 AND workspace_id=$2 AND module='mcp_runtime' AND kind='credential'
            AND data->>'actor_id'=$4`, [...partition, now, change.memberId]);
      }
    },
    context: {
      ...scope, now,
      lockOperationRecords: lockOperations,
      async get(module, kind, id) {
        const { rows: [row] } = await client.query<DbEntity>(`SELECT * FROM ss.entities WHERE ${key} AND id=$5`, [...partition, module, kind, id]);
        return row && (await domain.hydrate([entity(row)]))[0];
      },
      async list(module, kind) {
        const { rows } = await client.query<DbEntity>(`SELECT * FROM ss.entities WHERE ${key} ORDER BY created_at, id`, [...partition, module, kind]);
        return domain.hydrate(rows.map(entity));
      },
      async insert(module, kind, data, id = randomUUID()) {
        activeAuditId();
        const { rows: [row] } = await client.query<DbEntity>(`
          INSERT INTO ss.entities (tenant_id,workspace_id,module,kind,id,data,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING *`, [...partition, module, kind, id, JSON.stringify(data), now]);
        if (!row) throw duplicateRecord();
        const record = entity(row);
        domain.track(record);
        return record;
      },
      async update(module, kind, id, patch, expectedVersion) {
        activeAuditId();
        checkVersion(expectedVersion);
        const { rows: [before] } = await client.query<DbEntity>(`
          SELECT * FROM ss.entities WHERE ${key} AND id=$5 AND version=$6 FOR UPDATE`, [...partition, module, kind, id, expectedVersion]);
        if (!before) throw versionConflict();
        const [current] = await domain.hydrate([entity(before)]);
        const data = { ...current!.data, ...patch };
        const { rows: [row] } = await client.query<DbEntity>(`
          UPDATE ss.entities SET data=$7::jsonb, version=version+1, updated_at=greatest(updated_at,$8)
          WHERE ${key} AND id=$5 AND version=$6 RETURNING *`, [...partition, module, kind, id, expectedVersion, JSON.stringify(data), now]);
        if (!row) throw versionConflict();
        const record = entity(row);
        domain.track(record);
        return record;
      },
      async emit(event, payload) {
        const commandAuditId = activeAuditId();
        const eventId = randomUUID();
        await client.query(`INSERT INTO ss.events (id,tenant_id,workspace_id,audit_id,ordinal,name,payload,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId, ...partition, commandAuditId, ++ordinal, event, JSON.stringify(payload), now]);
        await client.query('INSERT INTO ss.outbox (event_id,tenant_id,workspace_id,available_at) VALUES ($1,$2,$3,$4)', [eventId, ...partition, now]);
      },
    },
    async command(info, run) {
      if (commandRunning) throw new Error('Concurrent or nested commands require separate units of work');
      commandRunning = true;
      try {
        // A caller may catch a command error and continue using the workspace transaction.
        await client.query('SAVEPOINT workspace_command');
        try {
          const identity = [...partition, scope.actorId, info.key];
          const reservation = await client.query(`INSERT INTO ss.idempotency (tenant_id,workspace_id,actor_id,key,fingerprint)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...identity, info.fingerprint]);
          let result: unknown;
          if (reservation.rowCount === 0) {
            const { rows: [prior] } = await client.query<{ fingerprint: string; response: unknown }>(`SELECT fingerprint,response FROM ss.idempotency
              WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND key=$4`, identity);
            if (!prior || prior.fingerprint !== info.fingerprint) throw keyConflict();
            result = prior.response;
          } else {
            auditId = randomUUID();
            ordinal = 0;
            await client.query(`INSERT INTO ss.audit (id,tenant_id,workspace_id,actor_id,role,module,action,created_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [auditId, ...partition, scope.actorId, scope.role, info.module, info.action, now]);
            const response = JSON.stringify((await run()) ?? null);
            await domain.flush();
            result = JSON.parse(response);
            const updated = await client.query(`UPDATE ss.idempotency SET response=$5::jsonb
              WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND key=$4`, [...identity, response]);
            if (updated.rowCount !== 1) throw new Error('Command idempotency reservation was lost');
          }
          await client.query('RELEASE SAVEPOINT workspace_command');
          return result;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT workspace_command');
          await client.query('RELEASE SAVEPOINT workspace_command');
          throw error;
        }
      } finally {
        domain.clear();
        auditId = undefined;
        commandRunning = false;
      }
    },
  };
}
