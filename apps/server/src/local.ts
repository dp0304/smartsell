import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { accountByEmail, canInviteMember, MemoryStore, roleForActor, type Snapshot, type SnapshotPersistence } from './memory.js';
import type { Store } from './store.js';

function recoveryOwner(state: Snapshot) {
  const { user, scope, workspaceInfo } = state;
  if (!user || !scope || !workspaceInfo || scope.actorId !== user.id || scope.role !== 'owner' ||
    workspaceInfo.id !== scope.workspaceId || workspaceInfo.role !== 'owner') return;
  const username = user.username ?? user.email;
  if (!username || username === `username:${user.id}`) return;
  const credentialVersion = createHash('sha256').update(user.passwordHash).digest('hex');
  return { id: user.id, workspaceId: workspaceInfo.id, username, credentialVersion };
}

class LocalStore extends MemoryStore {
  readRecoveryOwner() { return this.transact(false, recoveryOwner); }

  resetRecoveryOwner(expected: { id: string; workspaceId: string; credentialVersion: string }, passwordHash: string) {
    return this.transact(true, state => {
      const owner = recoveryOwner(state);
      if (!owner || owner.id !== expected.id || owner.workspaceId !== expected.workspaceId ||
        owner.credentialVersion !== expected.credentialVersion || !state.user) return false;
      state.user = { ...state.user, passwordHash };
      const now = Date.now();
      const retained = Object.entries(state.recoveredMcpSessions ?? {}).filter(([, session]) => session.expires > now);
      for (const [key, session] of state.sessions) {
        if (session.userId !== owner.id) continue;
        if (session.expires > now) retained.push([key, session]);
        state.sessions.delete(key);
      }
      state.recoveredMcpSessions = Object.fromEntries(retained);
      return true;
    });
  }

  acceptMemberInvitation({ tokenHash, email, name, passwordHash }: Parameters<NonNullable<Store['acceptMemberInvitation']>>[0]) {
    return this.transact(true, state => {
      const memberships = state.previewMemberships;
      if (!state.scope || !memberships || accountByEmail(state, email)) return false;
      const now = Date.now();
      const invitation = memberships.invitations.find(item => item.tokenHash === tokenHash && item.email === email && item.expires > now);
      if (!invitation || !canInviteMember(roleForActor(state, invitation.invitedBy), invitation.role)) return false;
      state.previewMemberships = {
        members: [...memberships.members, { id: randomUUID(), email, name, passwordHash, role: invitation.role }],
        invitations: memberships.invitations.filter(item => item !== invitation && item.expires > now),
      };
      return true;
    });
  }
}

function checkedFile(path: string, existing: boolean) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
    (existing && stat.uid !== process.getuid?.())) {
    throw new Error('SMARTSELL_DATA_FILE must be a regular file accessible only to its owner');
  }
  return stat;
}

/** How long a connection waits for another one's lock (a backup reading the file, hub:update's copy) before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * E45 (AO-8): durability settings for every connection to the hub's SQLite file. On macOS a plain fsync does not flush
 * the drive's write cache, so a power cut could lose acknowledged Worker facts or corrupt the only data file; fullfsync
 * asks for F_FULLFSYNC. The busy timeout lets a write wait out a backup's short read lock instead of failing.
 */
export function applyDurability(db: DatabaseSync, platform: NodeJS.Platform = process.platform) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (platform === 'darwin') db.exec('PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON');
}

/** A loopback preview store. Existing-only mode never creates a database or initializes its schema. */
export function localStore(path: string, { existing = false, platform = process.platform }: { existing?: boolean; platform?: NodeJS.Platform } = {}) {
  if (!existing) {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = checkedFile(path, existing);
  const verifyFile = () => {
    const current = checkedFile(path, true);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('The recovery database was replaced');
  };
  const db = new DatabaseSync(existing ? `${pathToFileURL(path).href}?mode=rw` : path);
  try {
    applyDurability(db, platform);
    if (existing) {
      verifyFile();
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    } else {
      db.exec(`CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`);
    }
    const load = db.prepare('SELECT payload FROM snapshot WHERE id = 1');
    const save = db.prepare(`INSERT INTO snapshot VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`);
    const dataVersion = db.prepare('PRAGMA data_version');
    const persistence: SnapshotPersistence = {
      async transaction(write, run) {
        if (existing) verifyFile();
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
          // data_version only moves when another connection commits, so the decoded snapshot stays valid otherwise.
          const { data_version: version } = dataVersion.get() as { data_version: number };
          const result = await run(() => (load.get() as { payload: string } | undefined)?.payload, encoded => { save.run(encoded); }, version);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      close() { db.close(); },
    };
    /** A PRAGMA value of this store's own connection (per-connection settings are invisible to any other connection). */
    const pragma = (name: 'fullfsync' | 'checkpoint_fullfsync' | 'busy_timeout' | 'synchronous') => {
      const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
      return row ? Number(Object.values(row)[0]) : undefined;
    };
    return Object.assign(new LocalStore(persistence), { pragma });
  } catch (error) {
    db.close();
    throw error;
  }
}
