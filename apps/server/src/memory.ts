import { randomUUID } from 'node:crypto';
import { DomainError, type Entity, type Fields } from './modules/types';
import type { LoginIdentifier } from './setup-policy.js';
import { publicUser } from './session-user.js';
import { previewIdentityState, type CommandIdentitySnapshot, type CommandIdentityUnit } from './integration/command-identity-state.js';
import {
  MAX_SESSION_SECONDS, SESSION_SECONDS, checkVersion, duplicateRecord, json, keyConflict, missingWorkspace, newEntity, unauthenticated, versionConflict,
  type CommandInfo, type Scope, type Setup, type Store, type Unit, type User, type Workspace,
} from './store';

type State = {
  records: Map<string, Entity>;
  responses: Map<string, { fingerprint: string; response: unknown }>;
  audit: { id: string; scope: Scope; module: string; action: string; now: string }[];
  events: { id: string; auditId: string; name: string; payload: Fields }[];
  outbox: string[];
};

type Session = { userId: string; expires: number };
type Account = User & { passwordHash: string };
export type MemberInvitation = Parameters<NonNullable<Unit['inviteMember']>>[0] & {
  invitedBy: string;
  expires: number;
};
type PreviewMemberships = {
  members: (Account & { role: Scope['role'] })[];
  invitations: MemberInvitation[];
};
export type Snapshot = State & {
  user?: Account;
  scope?: Scope;
  workspaceInfo?: Workspace;
  sessions: Map<string, Session>;
  recoveredMcpSessions?: Record<string, Session>;
  previewMemberships?: PreviewMemberships;
  commandIdentity?: CommandIdentitySnapshot;
};

export function canInviteMember(actorRole: Scope['role'] | undefined, role: Scope['role']) {
  return (role === 'admin' || role === 'editor' || role === 'reviewer' || role === 'viewer') &&
    (actorRole === 'owner' || (actorRole === 'admin' && role !== 'admin'));
}

function hasAccounts(state: Snapshot) {
  return !!(state.user || state.scope || state.workspaceInfo || state.previewMemberships?.members.length);
}

export function accountByEmail(state: Snapshot, email: string) {
  return state.user?.email === email ? state.user : state.previewMemberships?.members.find(user => user.email === email);
}

function accountById(state: Snapshot, id: string): Account | undefined {
  return state.user?.id === id ? state.user : state.previewMemberships?.members.find(user => user.id === id);
}

export function roleForActor(state: Snapshot, actorId: string) {
  return state.scope?.actorId === actorId ? state.scope.role : state.previewMemberships?.members.find(user => user.id === actorId)?.role;
}

function workspaceMembers(state: Snapshot) {
  return state.scope ? [{ user_id: state.scope.actorId, role: state.scope.role },
    ...(state.previewMemberships?.members ?? []).map(({ id, role }) => ({ user_id: id, role }))] : [];
}

export type SnapshotPersistence = {
  /**
   * `version` changes whenever another connection commits; while it is unchanged the store may reuse its decoded
   * snapshot instead of calling `load`.
   */
  transaction<T>(write: boolean, run: (load: () => string | undefined, save: (encoded: string) => void, version?: number) => Promise<T>): Promise<T>;
  close(): void;
};

// Persistent stores keep one decoded snapshot and run each transaction against a copy-on-write layer over it, so a
// request costs the work it does rather than a full decode and re-encode of the whole workspace.
const deleted = Symbol('deleted');
class OverlayMap<K, V> {
  readonly changes = new Map<K, V | typeof deleted>();
  constructor(readonly base: Map<K, V>) {}
  get(key: K): V | undefined {
    if (!this.changes.has(key)) return this.base.get(key);
    const value = this.changes.get(key);
    return value === deleted ? undefined : value;
  }
  has(key: K) { return this.changes.has(key) ? this.changes.get(key) !== deleted : this.base.has(key); }
  set(key: K, value: V) { this.changes.set(key, value); return this; }
  delete(key: K) {
    const had = this.has(key);
    if (had) this.changes.set(key, deleted);
    return had;
  }
  clear() { for (const key of [...this.keys()]) this.changes.set(key, deleted); }
  get size() { let count = 0; for (const _ of this.keys()) count++; return count; }
  *entries(): IterableIterator<[K, V]> {
    for (const [key, value] of this.base) {
      if (!this.changes.has(key)) yield [key, value];
      else {
        const changed = this.changes.get(key);
        if (changed !== deleted) yield [key, changed as V];
      }
    }
    for (const [key, value] of this.changes) if (value !== deleted && !this.base.has(key)) yield [key, value as V];
  }
  *keys() { for (const [key] of this.entries()) yield key; }
  *values() { for (const [, value] of this.entries()) yield value; }
  forEach(callback: (value: V, key: K, map: Map<K, V>) => void) { for (const [key, value] of this.entries()) callback(value, key, this as unknown as Map<K, V>); }
  [Symbol.iterator]() { return this.entries(); }
  apply() { for (const [key, value] of this.changes) value === deleted ? this.base.delete(key) : this.base.set(key, value as V); }
}

const collections = ['records', 'responses', 'sessions'] as const;
const logs = ['audit', 'events', 'outbox'] as const;

function overlay(base: Snapshot): Snapshot {
  const scalars = Object.fromEntries(Object.entries(base).filter(([key]) =>
    !(collections as readonly string[]).includes(key) && !(logs as readonly string[]).includes(key)).map(([key, value]) => [key, structuredClone(value)]));
  return { ...scalars, ...Object.fromEntries(collections.map(name => [name, new OverlayMap(base[name] as Map<unknown, unknown>)])),
    ...Object.fromEntries(logs.map(name => [name, base[name].slice()])) } as unknown as Snapshot;
}

/** Fold a successful transaction into the cached snapshot. Returns whether anything changed. */
function commit(base: Snapshot, next: Snapshot) {
  let dirty = false;
  for (const name of collections) {
    const map = next[name] as unknown;
    if (map instanceof OverlayMap) {
      if (map.changes.size) { map.apply(); dirty = true; }
    } else { (base as Record<string, unknown>)[name] = map; dirty = true; }
  }
  for (const name of logs) {
    const [before, after] = [base[name] as unknown[], next[name] as unknown[]];
    if (before.length !== after.length || after.some((value, index) => value !== before[index])) {
      (base as Record<string, unknown>)[name] = after;
      dirty = true;
    }
  }
  const fixed = new Set<string>([...collections, ...logs]);
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (fixed.has(key)) continue;
    const [before, after] = [(base as Record<string, unknown>)[key], (next as Record<string, unknown>)[key]];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (after === undefined) delete (base as Record<string, unknown>)[key];
    else (base as Record<string, unknown>)[key] = after;
    dirty = true;
  }
  return dirty;
}

const empty = (): Snapshot => ({ records: new Map(), responses: new Map(), sessions: new Map(), audit: [], events: [], outbox: [] });

function encode(state: Snapshot) {
  return JSON.stringify({ ...state, records: [...state.records], responses: [...state.responses], sessions: [...state.sessions] });
}

function decode(encoded: string): Snapshot {
  const state = JSON.parse(encoded);
  // Snapshots saved before this store dropped absent Operation keys still hold them as null rows. They read as absent
  // either way, so shedding them on load lets the next write persist a compacted snapshot.
  const records = (state.records as [string, Entity][]).filter(([, row]) => !operationTombstone(row));
  return { ...state, records: new Map(records), responses: new Map(state.responses), sessions: new Map(state.sessions) };
}

function userSession(state: Snapshot, hash: string, credentialId?: string) {
  let session = state.sessions.get(hash);
  if (!session && credentialId && state.recoveredMcpSessions && Object.hasOwn(state.recoveredMcpSessions, hash)) {
    // Sealed MCP credentials may reference the same token hash as a revoked browser cookie.
    const retained = state.recoveredMcpSessions[hash];
    const credential = state.records.get(JSON.stringify(['mcp_runtime', 'credential', credentialId]));
    if (credential?.data.actor_id === retained.userId && credential.data.revoked !== true &&
      credential.data.workspace_removed !== true && credential.data.expires > Date.now()) session = retained;
  }
  if (!session || session.expires <= Date.now() || !state.workspaceInfo) return;
  const account = accountById(state, session.userId);
  const role = roleForActor(state, session.userId);
  if (!account || !role) return;
  return { user: publicUser(account), workspaces: [{ ...state.workspaceInfo, role }] };
}

function replaceSession(state: Snapshot, userId: string, tokenHash: string, replace?: string, ttlSeconds = SESSION_SECONDS) {
  const now = Date.now();
  for (const [key, session] of state.sessions) if (session.expires <= now) state.sessions.delete(key);
  if (replace) state.sessions.delete(replace);
  state.sessions.set(tokenHash, { userId, expires: now + sessionLifetime(ttlSeconds) * 1000 });
}

function sessionLifetime(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > MAX_SESSION_SECONDS) throw new Error('Invalid session lifetime');
  return seconds;
}

export class MemoryStore implements Store {
  private state = empty();
  private queue = Promise.resolve();
  private cached?: { version: number; state: Snapshot };

  constructor(private readonly persistence?: SnapshotPersistence) {}

  protected transact<T>(write: boolean, run: (state: Snapshot) => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      if (this.persistence) return this.persistence.transaction(write, async (load, save, version) => {
        let base = version !== undefined && this.cached?.version === version ? this.cached.state : undefined;
        if (!base) {
          const encoded = load();
          base = encoded === undefined ? empty() : decode(encoded);
          this.cached = version === undefined ? undefined : { version, state: base };
        }
        const state = overlay(base);
        let result: T;
        try { result = await run(state); } catch (error) {
          // A failed write may have half-applied in-place changes; drop the cache and reload next time.
          if (write) this.cached = undefined;
          throw error;
        }
        if (write && commit(base, state)) save(encode(base));
        return result;
      }).catch(error => {
        // The snapshot cache already holds this write; if saving or the database COMMIT failed it was rolled back.
        if (write) this.cached = undefined;
        throw error;
      });
      const state = write ? structuredClone(this.state) : this.state;
      const result = await run(state);
      if (write) this.state = state;
      return result;
    });
    this.queue = work.then(() => {}, () => {});
    return work;
  }

  async ready() { await this.transact(false, () => {}); }
  async close() { await this.queue; this.persistence?.close(); }

  initialized() { return this.transact(false, hasAccounts); }

  setup(input: Setup, tokenHash: string, replace?: string) {
    return this.transact(true, state => {
      if (hasAccounts(state)) return false;
      const { email, username, name, passwordHash } = input;
      const id = randomUUID();
      const workspaceId = randomUUID();
      state.user = { email: email ?? `username:${id}`, username, name, passwordHash, id };
      state.scope = { workspaceId, tenantId: randomUUID(), actorId: id, role: 'owner' };
      state.workspaceInfo = { id: workspaceId, name: input.workspaceName, role: 'owner' };
      replaceSession(state, id, tokenHash, replace);
      return true;
    });
  }

  credentials(input: LoginIdentifier | string) {
    const identifier = typeof input === 'string' ? { email: input } : input;
    return this.transact(false, state => {
      const user = identifier.email === undefined
        ? (state.user?.username === identifier.username ? state.user : undefined)
        : accountByEmail(state, identifier.email);
      return user && { id: user.id, passwordHash: user.passwordHash };
    });
  }

  issueSession(userId: string, tokenHash: string, replace?: string, ttlSeconds?: number) {
    return this.transact(true, state => replaceSession(state, userId, tokenHash, replace, ttlSeconds));
  }

  commandIdentity<T>(run: (unit: CommandIdentityUnit) => Promise<T>) {
    return this.transact(true, state => {
      const identity = state.commandIdentity ??= { records: {}, flows: {}, audit: [] };
      return run({
        state: previewIdentityState(identity),
        async lock() {},
        async passwordHash(accountId) { return accountById(state, accountId)?.passwordHash; },
        async sessionUser(hash) { return userSession(state, hash)?.user; },
        async issueSession(userId, hash, replace) { replaceSession(state, userId, hash, replace); },
        async audit(accountId, action) { identity.audit.push({ accountId, action, at: new Date().toISOString() }); },
      });
    });
  }

  revokeSession(tokenHash: string) {
    return this.transact(true, state => { state.sessions.delete(tokenHash); });
  }

  session(tokenHash: string) { return this.transact(false, state => userSession(state, tokenHash)); }

  publicWork<T>(locator: import('./store.js').PublicLocator, id: string, run: (unit: Unit) => Promise<T>) {
    return this.transact(true, state => {
      if (!state.scope) return;
      if (locator === 'traffic.workspace') {
        if (state.scope.workspaceId !== id) return;
      } else {
        const [module, kind] = locator.split('.');
        if (!/^[A-Za-z0-9_-]{32}$/.test(id) || !state.records.has(JSON.stringify([module, kind, id]))) return;
      }
      return run(unitOfWork(state, { ...state.scope, role: 'editor', actorId: '00000000-0000-0000-0000-000000000001' }));
    });
  }

  operationWorkspaces() {
    return this.transact(false, ({ scope, workspaceInfo }) => scope && workspaceInfo
      ? [{ id: scope.workspaceId, tenantId: scope.tenantId, name: workspaceInfo.name }] : []);
  }

  operationWork<T>(workspaceId: string, run: (unit: Unit, members: { userId: string; role: Scope['role'] }[]) => Promise<T>) {
    return this.transact(true, state => {
      const scope = state.scope;
      if (!scope || scope.workspaceId !== workspaceId) throw missingWorkspace();
      return run(unitOfWork(state, { ...scope, actorId: '00000000-0000-0000-0000-000000000001' }),
        workspaceMembers(state).map(({ user_id, role }) => ({ userId: user_id, role })));
    });
  }

  workspace<T>(tokenHash: string | undefined, workspaceId: string, run: (unit: Unit) => Promise<T>, credentialId?: string) {
    return this.transact(true, async state => {
      const session = tokenHash && userSession(state, tokenHash, credentialId);
      if (!session) throw unauthenticated();
      if (state.scope?.workspaceId !== workspaceId) throw missingWorkspace();
      return run(unitOfWork(state, { ...state.scope, actorId: session.user.id, role: session.workspaces[0].role }, Boolean(this.persistence)));
    });
  }
}

// Operation snapshot rows each hold one immutable JSON string, so a shallow copy isolates them without re-serializing
// the whole workspace on every request.
const operationModule = 'operation_runtime';
const copyRow = (row: Entity): Entity => row.module === operationModule ? { ...row, data: { ...row.data } } : json(row);
// A null Operation snapshot value is an absent key. Postgres roles cannot DELETE entities and keep it as a tombstone;
// this store drops the row so pruned outbox, consumed and job keys do not pile up in the local snapshot.
function operationTombstone(row: Entity) { return row.module === operationModule && row.kind === 'record' && row.data.value === null; }

function unitOfWork(state: Snapshot, scope: Scope, allowInvites = false): Unit {
  const now = new Date().toISOString();
  const key = (module: string, kind: string, id: string) => JSON.stringify([module, kind, id]);
  let auditId: string | undefined;
  function requireCommand() {
    if (!auditId) throw new Error('Writes require an active command');
    return auditId;
  }

  return {
    async issueAgentSession(hash, ttlSeconds) {
      requireCommand();
      replaceSession(state, scope.actorId, hash, undefined, ttlSeconds);
    },
    ...(allowInvites && {
      async listMembers() { return workspaceMembers(state); },
      async inviteMember(input: Parameters<NonNullable<Unit['inviteMember']>>[0]) {
        requireCommand();
        if (!canInviteMember(scope.role, input.role)) throw new DomainError('forbidden', 'Invitation is not permitted', 403);
        if (accountByEmail(state, input.email)) throw new DomainError('account_exists', 'This invitation requires a new account', 409);
        const { members = [], invitations = [] } = state.previewMemberships ?? {};
        const timestamp = Date.parse(now);
        state.previewMemberships = {
          members,
          invitations: [...invitations.filter(invitation => invitation.expires > timestamp),
            { ...input, invitedBy: scope.actorId, expires: timestamp + 7 * 86_400_000 }],
        };
      },
    }),
    context: {
      ...scope, now,
      // The workspace name given at setup (S8 ledger item 4): Operation reads fall back to it (workspace(ctx).name, so
      // smartsell_overview and the get-started form) until the owner saves a name in the workspace settings.
      ...(state.workspaceInfo?.id === scope.workspaceId && { workspaceName: state.workspaceInfo.name }),
      async get(module, kind, id) {
        const row = state.records.get(key(module, kind, id));
        return row && copyRow(row);
      },
      async list(module, kind) {
        const rows = [...state.records.values()].filter(row => row.module === module && row.kind === kind)
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        return module === operationModule ? rows.map(copyRow) : json(rows);
      },
      async insert(module, kind, data, id = randomUUID()) {
        requireCommand();
        const identity = key(module, kind, id);
        if (state.records.has(identity)) throw duplicateRecord();
        const row = newEntity(scope, now, module, kind, json(data), id);
        state.records.set(identity, row);
        return json(row);
      },
      async update(module, kind, id, patch, expectedVersion) {
        requireCommand();
        checkVersion(expectedVersion);
        const identity = key(module, kind, id);
        const row = state.records.get(identity);
        if (!row || row.version !== expectedVersion) throw versionConflict();
        const next = { ...row, data: { ...row.data, ...json(patch) }, updated_at: now, version: row.version + 1 };
        if (operationTombstone(next)) state.records.delete(identity);
        else state.records.set(identity, next);
        return json(next);
      },
      async emit(name, payload) {
        const activeAuditId = requireCommand();
        const id = randomUUID();
        state.events.push({ id, auditId: activeAuditId, name, payload: json(payload) });
        state.outbox.push(id);
      },
    },
    async command(info: CommandInfo, run) {
      // Keep existing idempotency keys and give each invited account its own namespace.
      const invitedActor = state.previewMemberships?.members.some(member => member.id === scope.actorId);
      const key = invitedActor ? JSON.stringify([scope.actorId, info.key]) : info.key;
      const prior = state.responses.get(key);
      if (prior) {
        if (prior.fingerprint !== info.fingerprint) throw keyConflict();
        return json(prior.response);
      }
      if (auditId) throw new Error('Commands cannot be nested');
      const snapshot = {
        records: new Map(state.records), responses: new Map(state.responses), sessions: new Map(state.sessions),
        audit: state.audit.slice(), events: state.events.slice(), outbox: state.outbox.slice(),
        previewMemberships: state.previewMemberships,
      };
      // Each background flush runs under a fresh random key, so its replay record can never be hit, and its audit line
      // names no change. Postgres appends both to tables it never rescans; this snapshot re-encodes every entry on each
      // write, so keeping them would make every later write cost more with each event or schedule run.
      const transient = info.module === operationModule && info.action === 'background';
      auditId = randomUUID();
      if (!transient) state.audit.push({ id: auditId, scope, module: info.module, action: info.action, now });
      try {
        const response = json((await run()) ?? null);
        if (!transient) state.responses.set(key, { fingerprint: info.fingerprint, response });
        return json(response);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      } finally {
        auditId = undefined;
      }
    },
  };
}
