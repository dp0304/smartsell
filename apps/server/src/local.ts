import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { accountByEmail, canInviteMember, MemoryStore, roleForActor, type SnapshotPersistence } from './memory.js';
import type { Store } from './store.js';

class LocalStore extends MemoryStore {
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

/** A loopback preview store. SQLite serializes and commits whole units across restarts. */
export function localStore(path: string) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('SMARTSELL_DATA_FILE must be a regular file accessible only to its owner');
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`);
    const load = db.prepare('SELECT payload FROM snapshot WHERE id = 1');
    const save = db.prepare(`INSERT INTO snapshot VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`);
    const dataVersion = db.prepare('PRAGMA data_version');
    const persistence: SnapshotPersistence = {
      async transaction(write, run) {
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
    return new LocalStore(persistence);
  } catch (error) {
    db.close();
    throw error;
  }
}
