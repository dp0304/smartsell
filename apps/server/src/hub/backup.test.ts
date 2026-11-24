// E45 (AO-8, wave 6 G5-ops): SQLite backups and durability. Everything runs on temp files; nothing touches a real hub.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { localStore } from '../local.js';
import { BACKUP_DIR, createBackupSchedule, dailyBackup, latestBackup, listBackups, preUpdateBackup, pruneBackups, restoreDatabase,
  scratchCopy, snapshotDigest } from './backup.js';

function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function database(path: string, payload: string) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  db.prepare('INSERT INTO snapshot VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload').run(payload);
  db.close();
}
const payloadOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare('SELECT payload FROM snapshot WHERE id = 1').get() as { payload: string }).payload; } finally { db.close(); }
};
const mode = (path: string) => statSync(path).mode & 0o777;

test('AO-8: the local store asks macOS for F_FULLFSYNC and waits out a backup lock', t => {
  const dir = temp(t);
  const mac = localStore(join(dir, 'mac.sqlite'), { platform: 'darwin' });
  assert.equal(mac.pragma('fullfsync'), 1);
  assert.equal(mac.pragma('checkpoint_fullfsync'), 1);
  assert.equal(mac.pragma('busy_timeout'), 5000);
  const other = localStore(join(dir, 'other.sqlite'), { platform: 'win32' });
  assert.equal(other.pragma('fullfsync'), 0, 'fullfsync is a macOS-only setting');
  assert.equal(other.pragma('busy_timeout'), 5000);
});

test('E45: one 0600 copy a day in a 0700 folder, the newest 7 kept; pre-update copies kept apart (3)', t => {
  const hubDir = temp(t);
  const statePath = join(hubDir, 'smartsell.sqlite');
  assert.equal(dailyBackup(statePath, hubDir).status, 'missing_database', 'a hub that never ran has nothing to copy');
  database(statePath, '{"day":0}');
  const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n, 12));
  const first = dailyBackup(statePath, hubDir, { now: day(0), timeZone: 'UTC' });
  assert.equal(first.status, 'created');
  assert.equal(first.path, join(hubDir, BACKUP_DIR, 'smartsell-2026-11-01.sqlite'));
  assert.equal(mode(first.path), 0o600);
  assert.equal(mode(join(hubDir, BACKUP_DIR)), 0o700);
  assert.equal(payloadOf(first.path), '{"day":0}');
  assert.equal(dailyBackup(statePath, hubDir, { now: day(0), timeZone: 'UTC' }).status, 'exists');
  for (let n = 1; n < 10; n++) {
    database(statePath, `{"day":${n}}`);
    dailyBackup(statePath, hubDir, { now: day(n), timeZone: 'UTC' });
  }
  const daily = listBackups(hubDir).filter(file => file.kind === 'daily').map(file => file.name).sort();
  assert.deepEqual(daily, ['04', '05', '06', '07', '08', '09', '10'].map(d => `smartsell-2026-11-${d}.sqlite`));
  for (let n = 0; n < 5; n++) preUpdateBackup(statePath, hubDir, { now: new Date(Date.UTC(2026, 10, 20, 9, n)) });
  const updates = listBackups(hubDir).filter(file => file.kind === 'pre_update').map(file => file.name).sort();
  assert.deepEqual(updates, ['pre-update-20261120T090200Z.sqlite', 'pre-update-20261120T090300Z.sqlite', 'pre-update-20261120T090400Z.sqlite']);
  assert.equal(listBackups(hubDir).filter(file => file.kind === 'daily').length, 7, 'update copies never push daily ones out');
  // Leftovers of an interrupted copy disappear after a day; a fresh one stays (it may be in progress).
  const stale = join(hubDir, BACKUP_DIR, 'smartsell-2026-11-30.sqlite.partial');
  writeFileSync(stale, '');
  utimesSync(stale, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
  const fresh = join(hubDir, BACKUP_DIR, '.load-check-1-abcd.sqlite');
  writeFileSync(fresh, '');
  pruneBackups(hubDir, new Date());
  const names = readdirSync(join(hubDir, BACKUP_DIR));
  assert.ok(!names.includes('smartsell-2026-11-30.sqlite.partial'));
  assert.ok(names.includes('.load-check-1-abcd.sqlite'));
  assert.ok(latestBackup(hubDir));
});

test('E45: a copy taken while the live store is mid-write is consistent, and the store still commits', async t => {
  const hubDir = temp(t);
  const statePath = join(hubDir, 'smartsell.sqlite');
  const store = localStore(statePath);
  t.after(() => store.close());
  await store.setup({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Shop', passwordHash: 'unused' }, 'a'.repeat(64));
  const before = snapshotDigest(statePath);
  assert.equal(typeof before, 'string');
  // A backup that runs inside another connection's open write transaction sees the last committed state.
  const writer = new DatabaseSync(statePath);
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare("UPDATE snapshot SET payload = '{\"uncommitted\":true}' WHERE id = 1").run();
  const copied = preUpdateBackup(statePath, hubDir).path;
  writer.exec('ROLLBACK');
  writer.close();
  assert.notEqual(payloadOf(copied), '{"uncommitted":true}');
  assert.equal(snapshotDigest(copied), before);
  assert.ok(await store.initialized(), 'the live store keeps working after the copy');
});

test('AO-1: snapshot digests tell whether the new code wrote; a restore keeps the replaced file aside', t => {
  const hubDir = temp(t);
  const statePath = join(hubDir, 'smartsell.sqlite');
  database(statePath, '{"v":1}');
  const backup = preUpdateBackup(statePath, hubDir, { now: new Date('2026-11-24T09:00:00Z') }).path;
  assert.equal(snapshotDigest(statePath), snapshotDigest(backup));
  database(statePath, '{"v":2,"reencoded":true}');
  writeFileSync(`${statePath}-journal`, 'hot journal of the failed version');
  assert.notEqual(snapshotDigest(statePath), snapshotDigest(backup));
  const aside = restoreDatabase(backup, statePath, { now: new Date('2026-11-24T09:05:00Z') });
  assert.equal(aside, `${statePath}.failed-update-20261124T090500Z`);
  assert.equal(payloadOf(statePath), '{"v":1}');
  assert.equal(mode(statePath), 0o600);
  assert.ok(readdirSync(hubDir).includes('smartsell.sqlite.failed-update-20261124T090500Z-journal'), 'the journal moves with its file');
  rmSync(`${aside}-journal`);   // a fake journal; a real one would be rolled back by the next writer of that file
  assert.equal(payloadOf(aside), '{"v":2,"reencoded":true}');
  assert.equal(snapshotDigest(join(hubDir, 'nope.sqlite')), undefined);
  const scratch = scratchCopy(statePath, hubDir);
  assert.equal(payloadOf(scratch.path), '{"v":1}');
  scratch.remove();
  assert.ok(!readdirSync(join(hubDir, BACKUP_DIR)).some(name => name.startsWith('.load-check-')));
});

test('E45: the running hub makes today\'s copy on its schedule and logs a failure instead of stopping', t => {
  const hubDir = temp(t);
  const statePath = join(hubDir, 'smartsell.sqlite');
  database(statePath, '{}');
  const lines: string[] = [];
  const schedule = createBackupSchedule({ statePath, hubDir, log: line => lines.push(line), now: () => new Date('2026-11-24T10:00:00Z'), timeZone: 'Asia/Shanghai' });
  assert.equal(schedule.runNow()?.status, 'created');
  assert.equal(schedule.runNow()?.status, 'exists');
  assert.match(lines.join('\n'), /已備份資料：.*smartsell-2026-11-24\.sqlite/);
  const other = temp(t);
  const broken = createBackupSchedule({ statePath: other, hubDir: other, log: line => lines.push(line) });   // a directory, not a database
  assert.equal(broken.runNow(), undefined);
  assert.match(lines.at(-1)!, /^\[警告\] 每日備份失敗，一小時後再試/);
  schedule.start(); schedule.stop(); broken.stop();
});
