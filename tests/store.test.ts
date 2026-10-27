import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/infrastructure/store.js';
import { asset, game, member, now } from './helpers.js';

let directory: string;
let store: Store;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nexus-test-'));
  store = new Store(join(directory, 'live.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
test('SQLite enforces uniqueness for RAWG, channel and role identities', () => {
  const g = game({ rawgId: 123 });
  store.saveGame(g);
  expect(() => store.saveGame(game({ rawgId: 123 }))).toThrow();
  expect(() => store.saveGame(game({ channelId: g.channelId }))).toThrow();
  expect(() => store.saveGame(game({ roleId: g.roleId }))).toThrow();
});
test('a failed transaction rolls back all subscriber changes', () => {
  const g = game();
  store.saveGame(g);
  store.subscribe(g.id, member.id, true);
  expect(() =>
    store.transaction(() => {
      store.replaceSubscribers(g.id, ['other']);
      throw new Error('abort');
    }),
  ).toThrow('abort');
  expect(store.subscribers(g.id)).toEqual([member.id]);
});
test('an unchanged Discord subscriber snapshot performs no writes, including duplicate or reordered IDs', () => {
  const g = game();
  store.saveGame(g);
  store.replaceSubscribers(g.id, ['one', 'two']);
  const before = store.db.prepare('SELECT total_changes() AS changes').get()!.changes;
  store.replaceSubscribers(g.id, ['two', 'one', 'two']);
  expect(store.db.prepare('SELECT total_changes() AS changes').get()!.changes).toBe(before);
  expect(store.subscribers(g.id)).toEqual(['one', 'two']);
});
test('a changed Discord snapshot only adds and removes the necessary subscribers', () => {
  const g = game();
  store.saveGame(g);
  store.replaceSubscribers(g.id, ['keep', 'remove']);
  const before = Number(store.db.prepare('SELECT total_changes() AS changes').get()!.changes);
  store.replaceSubscribers(g.id, ['keep', 'add']);
  const after = Number(store.db.prepare('SELECT total_changes() AS changes').get()!.changes);
  expect(after - before).toBe(2);
  expect(store.subscribers(g.id)).toEqual(['add', 'keep']);
});
test('a failed subscriber delta restores the old snapshot while its outer transaction may continue', () => {
  const g = game();
  store.saveGame(g);
  store.replaceSubscribers(g.id, ['old']);
  store.db.exec(
    "CREATE TRIGGER reject_subscriber BEFORE INSERT ON subscriptions WHEN NEW.user_id='fail' BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
  );
  store.transaction(() => {
    expect(() => store.replaceSubscribers(g.id, ['new', 'fail'])).toThrow('rejected');
    expect(store.subscribers(g.id)).toEqual(['old']);
    store.audit('outer-transaction-continues', null, g.id, now);
  });
  expect(store.subscribers(g.id)).toEqual(['old']);
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM audit').get()!.count).toBe(1);
});
test('images and owner-bound sessions survive a database reopen', () => {
  store.saveAsset(asset);
  store.saveSession({
    id: 'session',
    userId: member.id,
    kind: 'game',
    data: { gameId: 'x' },
    expiresAt: Date.now() + 10000,
  });
  store.close();
  store = new Store(join(directory, 'live.sqlite'));
  expect(Buffer.from(store.asset(asset.id)!.bytes)).toEqual(Buffer.from(asset.bytes));
  expect(store.session('session')?.userId).toBe(member.id);
});
test('lease renewal prevents two writers and permits recovery after expiry', () => {
  const second = new Store(join(directory, 'live.sqlite'));
  try {
    expect(store.acquireLease('a', now)).toBe(true);
    expect(second.acquireLease('b', now + 1)).toBe(false);
    expect(store.acquireLease('a', now + 50000)).toBe(true);
    expect(second.acquireLease('b', now + 60001)).toBe(false);
    expect(second.acquireLease('b', now + 110001)).toBe(true);
    expect(store.acquireLease('a', now + 110002)).toBe(false);
    second.releaseLease('b');
    expect(store.acquireLease('a', now + 110003)).toBe(true);
  } finally {
    second.close();
  }
});
test('backup includes committed WAL content and passes SQLite integrity verification', async () => {
  const g = game();
  store.saveGame(g);
  store.subscribe(g.id, member.id, true);
  const path = join(directory, 'backup.sqlite');
  await store.backup(path);
  const backup = new Store(path);
  try {
    expect(backup.game(g.id)).toEqual(g);
    expect(backup.subscribers(g.id)).toEqual([member.id]);
    expect(backup.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  } finally {
    backup.close();
  }
});
test('a modified applied migration is refused', () => {
  store.db.prepare('UPDATE schema_migrations SET sha256=?').run('tampered');
  store.close();
  expect(() => new Store(join(directory, 'live.sqlite'))).toThrow('checksum');
  store = new Store(':memory:');
});
test('maintenance removes expired previews and cache while preserving icons of games and live previews', () => {
  const g = game();
  store.saveGame(g);
  store.saveAsset(asset);
  store.saveAsset({ ...asset, id: 'preview' });
  store.saveAsset({ ...asset, id: 'orphan' });
  store.saveSession({
    id: 'live',
    userId: member.id,
    kind: 'candidate',
    data: { assetId: 'preview' },
    expiresAt: Date.now() + 60000,
  });
  store.set('rawg:test', { expires: 1, data: {} });
  store.maintain(Date.now());
  expect(store.asset(asset.id)).not.toBeNull();
  expect(store.asset('preview')).not.toBeNull();
  expect(store.asset('orphan')).toBeNull();
  expect(store.get('rawg:test')).toBeUndefined();
});
test('icons reserved by a reviewed import survive cleanup until their reservation expires', () => {
  store.saveAsset(asset);
  store.set('import-icon:game', { assetId: asset.id, expiresAt: Date.now() + 60000 });
  store.maintain(Date.now());
  expect(store.asset(asset.id)).not.toBeNull();
  store.maintain(Date.now() + 60001);
  expect(store.asset(asset.id)).toBeNull();
  expect(store.get('import-icon:game')).toBeUndefined();
});
