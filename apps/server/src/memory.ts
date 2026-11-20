import { randomUUID } from 'node:crypto';
import { DomainError, type Entity, type Fields } from './modules/types';
import { previewIdentityState, type CommandIdentitySnapshot, type CommandIdentityUnit } from './integration/command-identity-state.js';
import {
  SESSION_SECONDS, checkVersion, duplicateRecord, json, keyConflict, missingWorkspace, newEntity, unauthenticated, versionConflict,
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
type Snapshot = State & {
  user?: Account;
  scope?: Scope;
  workspaceInfo?: Workspace;
  sessions: Map<string, Session>;
  previewMemberships?: PreviewMemberships;
  commandIdentity?: CommandIdentitySnapshot;
};

export function canInviteMember(actorRole: Scope['role'] | undefined, role: Scope['role']) {
  return (role === 'admin' || role === 'editor' || role === 'reviewer' || role === 'viewer') &&
    (actorRole === 'owner' || (actorRole === 'admin' && role !== 'admin'));
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
  transaction<T>(write: boolean, run: (encoded: string | undefined, save: (encoded: string) => void) => Promise<T>): Promise<T>;
  close(): void;
};

const empty = (): Snapshot => ({ records: new Map(), responses: new Map(), sessions: new Map(), audit: [], events: [], outbox: [] });

function encode(state: Snapshot) {
  return JSON.stringify({ ...state, records: [...state.records], responses: [...state.responses], sessions: [...state.sessions] });
}

function decode(encoded: string): Snapshot {
  const state = JSON.parse(encoded);
  return { ...state, records: new Map(state.records), responses: new Map(state.responses), sessions: new Map(state.sessions) };
}

function userSession(state: Snapshot, hash: string) {
  const session = state.sessions.get(hash);
  if (!session || session.expires <= Date.now() || !state.workspaceInfo) return;
  const account = accountById(state, session.userId);
  const role = roleForActor(state, session.userId);
  if (!account || !role) return;
  const { id, email, name } = account;
  return { user: { id, email, name }, workspaces: [{ ...state.workspaceInfo, role }] };
}

function replaceSession(state: Snapshot, userId: string, tokenHash: string, replace?: string) {
  const now = Date.now();
  for (const [key, session] of state.sessions) if (session.expires <= now) state.sessions.delete(key);
  if (replace) state.sessions.delete(replace);
  state.sessions.set(tokenHash, { userId, expires: now + SESSION_SECONDS * 1000 });
}

export class MemoryStore implements Store {
  private state = empty();
  private queue = Promise.resolve();

  constructor(private readonly persistence?: SnapshotPersistence) {}

  protected transact<T>(write: boolean, run: (state: Snapshot) => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      if (this.persistence) return this.persistence.transaction(write, async (encoded, save) => {
        const state = encoded === undefined ? empty() : decode(encoded);
        const result = await run(state);
        if (write) save(encode(state));
        return result;
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

  setup(input: Setup, tokenHash: string, replace?: string) {
    return this.transact(true, state => {
      if (state.user) return false;
      const { email, name, passwordHash } = input;
      const id = randomUUID();
      const workspaceId = randomUUID();
      state.user = { email, name, passwordHash, id };
      state.scope = { workspaceId, tenantId: randomUUID(), actorId: id, role: 'owner' };
      state.workspaceInfo = { id: workspaceId, name: input.workspaceName, role: 'owner' };
      replaceSession(state, id, tokenHash, replace);
      return true;
    });
  }

  credentials(email: string) {
    return this.transact(false, state => {
      const user = accountByEmail(state, email);
      return user && { id: user.id, passwordHash: user.passwordHash };
    });
  }

  issueSession(userId: string, tokenHash: string, replace?: string) {
    return this.transact(true, state => replaceSession(state, userId, tokenHash, replace));
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

  workspace<T>(tokenHash: string | undefined, workspaceId: string, run: (unit: Unit) => Promise<T>) {
    return this.transact(true, async state => {
      const session = tokenHash && userSession(state, tokenHash);
      if (!session) throw unauthenticated();
      if (state.scope?.workspaceId !== workspaceId) throw missingWorkspace();
      return run(unitOfWork(state, { ...state.scope, actorId: session.user.id, role: session.workspaces[0].role }, Boolean(this.persistence)));
    });
  }
}

function unitOfWork(state: Snapshot, scope: Scope, allowInvites = false): Unit {
  const now = new Date().toISOString();
  const key = (module: string, kind: string, id: string) => JSON.stringify([module, kind, id]);
  let auditId: string | undefined;
  function requireCommand() {
    if (!auditId) throw new Error('Writes require an active command');
    return auditId;
  }

  return {
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
      async get(module, kind, id) {
        const row = state.records.get(key(module, kind, id));
        return row && json(row);
      },
      async list(module, kind) {
        return json([...state.records.values()].filter(row => row.module === module && row.kind === kind)
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
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
        state.records.set(identity, next);
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
        records: new Map(state.records), responses: new Map(state.responses),
        audit: state.audit.slice(), events: state.events.slice(), outbox: state.outbox.slice(),
        previewMemberships: state.previewMemberships,
      };
      auditId = randomUUID();
      state.audit.push({ id: auditId, scope, module: info.module, action: info.action, now });
      try {
        const response = json((await run()) ?? null);
        state.responses.set(key, { fingerprint: info.fingerprint, response });
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
