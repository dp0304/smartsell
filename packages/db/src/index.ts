import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg, { type PoolClient } from 'pg';

export interface Scope { tenantId: string; workspaceId: string; actorId: string }

export class Records {
  readonly changes = new Map<string, string | null>();

  constructor(private readonly rows: Map<string, string>, private readonly readOnly: boolean) {}

  get<T>(key: string): T | undefined {
    const value = this.rows.get(key);
    return value === undefined ? undefined : JSON.parse(value) as T;
  }

  entries<T>(prefix: string): [string, T][] {
    return [...this.rows.keys()].filter(key => key.startsWith(prefix)).map(key => [key, this.get<T>(key)!]);
  }

  list<T>(prefix: string): T[] {
    return this.entries<T>(prefix).map(([, value]) => value);
  }

  put(key: string, value: unknown): void {
    if (this.readOnly) throw new Error('Write in read-only transaction');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Record must be JSON serializable');
    this.rows.set(key, encoded);
    this.changes.set(key, encoded);
  }

  delete(key: string): void {
    if (this.readOnly) throw new Error('Write in read-only transaction');
    this.rows.delete(key);
    this.changes.set(key, null);
  }
}

export interface Transaction {
  identity: Records;
  workspace(scope: Scope): Promise<Records>;
}

export interface Store {
  transaction<T>(options: { readOnly?: boolean; identityWrite?: boolean; workspaceBatch?: boolean }, run: (tx: Transaction) => Promise<T> | T): Promise<T>;
  /** Best-effort wakeup after commit. Consumers must still poll for durable state. */
  subscribe?(wake: (workspaceId: string) => void): () => void;
  close(): Promise<void>;
}

// Batch writers serialize on the identity lock and may only change the workspace ID.
function checkWorkspaceScope(options: { identityWrite?: boolean; readOnly?: boolean; workspaceBatch?: boolean },
  scopes: ReadonlyMap<string, { scope: Scope }>, next: Scope) {
  const first = scopes.values().next().value?.scope;
  if (first && (first.tenantId !== next.tenantId || first.actorId !== next.actorId ||
    (first.workspaceId !== next.workspaceId && !(options.workspaceBatch && options.identityWrite && !options.readOnly)))) {
    throw new Error('Workspace scope cannot change');
  }
}

function wakeups() {
  const listeners = new Set<(workspaceId: string) => void>();
  return {
    listeners,
    subscribe(wake: (workspaceId: string) => void) {
      listeners.add(wake);
      return () => { listeners.delete(wake); };
    },
    publish(workspaceId: string) {
      for (const wake of listeners) {
        try { wake(workspaceId); } catch { /* Notifications are advisory. */ }
      }
    },
  };
}

function shouldWake(records: Records) {
  return records.changes.has('stream/revision');
}

interface Snapshot { identity: [string, string][]; workspaces: Record<string, [string, string][]> }

export async function fileStore(path: string): Promise<Store> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let initialized = false;
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error(`Development database is locked: ${lockPath}`);
    throw error;
  });
  try {
    await lock.writeFile(String(process.pid));
    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
      if (!Array.isArray(snapshot.identity) || !snapshot.workspaces || typeof snapshot.workspaces !== 'object') {
        throw new Error('Invalid development database');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      snapshot = { identity: [], workspaces: {} };
    }
    const notifications = wakeups();
    let pending: Promise<unknown> = Promise.resolve();
    let closed = false;
    initialized = true;
    return {
      subscribe: notifications.subscribe,
      transaction(options, run) {
        if (closed) return Promise.reject(new Error('Store closed'));
        const result = pending.then(async () => {
          const identityRows = new Map(snapshot.identity);
          const identity = new Records(identityRows, !options.identityWrite || !!options.readOnly);
          const workspacesById = new Map<string, { scope: Scope; rows: Map<string, string>; records: Records }>();
          const result = await run({
            identity,
            async workspace(scope) {
              const key = `${scope.tenantId}/${scope.workspaceId}`;
              checkWorkspaceScope(options, workspacesById, scope);
              let scoped = workspacesById.get(key);
              if (!scoped) {
                const rows = new Map(snapshot.workspaces[key]);
                scoped = { scope, rows, records: new Records(rows, !!options.readOnly) };
                workspacesById.set(key, scoped);
              }
              return scoped.records;
            },
          });
          const changed = [...workspacesById].filter(([, entry]) => entry.records.changes.size);
          if (identity.changes.size || changed.length) {
            const workspaces = { ...snapshot.workspaces };
            for (const [key, scoped] of changed) workspaces[key] = [...scoped.rows];
            const next = { identity: [...identityRows], workspaces };
            const tmp = `${path}.${randomUUID()}.tmp`;
            try {
              const file = await open(tmp, 'wx', 0o600);
              try {
                await file.writeFile(JSON.stringify(next));
                await file.sync();
              } finally {
                await file.close();
              }
              await rename(tmp, path);
            } catch (error) {
              await rm(tmp, { force: true });
              throw error;
            }
            snapshot = next;
            for (const [, scoped] of changed) if (shouldWake(scoped.records)) notifications.publish(scoped.scope.workspaceId);
          }
          return result;
        });
        pending = result.catch(() => {});
        return result;
      },
      async close() {
        if (closed) return;
        closed = true;
        await pending;
        await lock.close();
        await rm(lockPath, { force: true });
      },
    };
  } finally {
    if (!initialized) {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function load(client: PoolClient, scope?: Scope): Promise<Map<string, string>> {
  const result = scope
    ? await client.query('SELECT id, value::text FROM smartsell.record WHERE tenant_id = $1 AND workspace_id = $2', [scope.tenantId, scope.workspaceId])
    : await client.query('SELECT id, value::text FROM smartsell.identity');
  return new Map(result.rows.map(row => [row.id, row.value]));
}

async function flush(client: PoolClient, records: Records, scope?: Scope): Promise<void> {
  for (const [key, value] of records.changes) {
    if (scope) {
      const args = [scope.tenantId, scope.workspaceId, key];
      if (value === null) {
        await client.query('DELETE FROM smartsell.record WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3', args);
      } else if (key.startsWith('audit/')) {
        await client.query('INSERT INTO smartsell.record (tenant_id, workspace_id, id, value) VALUES ($1,$2,$3,$4)', [...args, value]);
      } else {
        await client.query(`INSERT INTO smartsell.record (tenant_id, workspace_id, id, value) VALUES ($1,$2,$3,$4)
          ON CONFLICT (tenant_id, workspace_id, id) DO UPDATE SET value = EXCLUDED.value`, [...args, value]);
      }
    } else if (value === null) {
      await client.query('DELETE FROM smartsell.identity WHERE id = $1', [key]);
    } else {
      await client.query(`INSERT INTO smartsell.identity (id, value) VALUES ($1,$2)
        ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
    }
  }
}

export async function postgresStore(connectionString: string): Promise<Store> {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', error => console.error('PostgreSQL idle client error', error.message));
  try {
    const check = await pool.query(`SELECT current_setting('server_version_num')::int AS version,
      current_user = 'app_rw' AND session_user = 'app_rw' AND NOT rolsuper AND NOT rolbypassrls
        AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication
        AND NOT pg_has_role(current_user, 'app_owner', 'MEMBER') AS safe,
      EXISTS (SELECT FROM pg_class WHERE oid = to_regclass('smartsell.record')
        AND relrowsecurity AND relforcerowsecurity AND NOT pg_has_role(current_user, relowner, 'MEMBER'))
        AND to_regclass('smartsell.identity') IS NOT NULL AS migrated
      FROM pg_roles WHERE rolname = current_user`);
    if (!check.rows[0]?.safe || !check.rows[0]?.migrated || check.rows[0].version < 170000) {
      throw new Error('Use a migrated PostgreSQL 17+ with an unprivileged app_rw login');
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  const notifications = wakeups();
  const channel = 'smartsell_workspace_changed';
  let listener: pg.Client | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function listen() {
    if (closed || listener || !notifications.listeners.size) return;
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    listener = client;
    function disconnected() {
      if (listener !== client) return;
      listener = undefined;
      void client.end().catch(() => {});
      if (!closed && notifications.listeners.size) {
        reconnect = setTimeout(listen, 5000).unref();
      }
    }
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', message => {
      if (message.channel === channel && message.payload) notifications.publish(message.payload);
    });
    void client.connect().then(() => client.query(`LISTEN ${channel}`)).catch(disconnected);
  }

  return {
    subscribe(wake) {
      const unsubscribe = notifications.subscribe(wake);
      listen();
      return unsubscribe;
    },
    async transaction(options, run) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query(options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        if (options.identityWrite) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('smartsell.identity', 0))");
        const identity = new Records(await load(client), !options.identityWrite || !!options.readOnly);
        const scopes = new Map<string, { scope: Scope; records: Records }>();
        const setScope = (scope: Scope) => client.query(
          `SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_ids',$2,true),set_config('app.principal',$3,true)`,
          [scope.tenantId, `{${scope.workspaceId}}`, scope.actorId]);
        const result = await run({
          identity,
          async workspace(scope) {
            checkWorkspaceScope(options, scopes, scope);
            const key = `${scope.tenantId}/${scope.workspaceId}`;
            let scoped = scopes.get(key);
            if (!scoped) {
              if (!options.readOnly) {
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
              }
              await setScope(scope);
              scoped = { scope, records: new Records(await load(client, scope), !!options.readOnly) };
              scopes.set(key, scoped);
            }
            return scoped.records;
          },
        });
        await flush(client, identity);
        for (const scoped of scopes.values()) {
          if (!scoped.records.changes.size) continue;
          if (scopes.size > 1) await setScope(scoped.scope);
          await flush(client, scoped.records, scoped.scope);
          if (shouldWake(scoped.records)) await client.query('SELECT pg_notify($1, $2)', [channel, scoped.scope.workspaceId]);
        }
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(reconnect);
      const client = listener;
      listener = undefined;
      try { await client?.end(); } finally { await pool.end(); }
    },
  };
}
