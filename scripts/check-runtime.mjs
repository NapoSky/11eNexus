import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import sharp from 'sharp';

assert.equal(Number(process.versions.node.split('.')[0]), 26, 'Node 26 is required.');
const require = createRequire(import.meta.url);
const { Store } = require('../dist/infrastructure/store.js');
const directory = mkdtempSync(join(tmpdir(), 'nexus-runtime-'));
let source;
let restored;
try {
  source = new Store(join(directory, 'source.sqlite'));
  const png = await sharp({ create: { width: 32, height: 48, channels: 4, background: '#557c5b' } })
    .resize(64, 64)
    .png()
    .toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 64);
  source.saveAsset({
    id: 'synthetic-image',
    bytes: png,
    mime: 'image/png',
    source: 'offline-check',
    sha256: 'synthetic',
  });
  source.saveGame({
    id: 'synthetic-game',
    rawgId: null,
    name: 'Offline check',
    aliases: [],
    channelId: null,
    roleId: null,
    roleState: 'missing',
    state: 'archived',
    lastActivityAt: null,
    activatedAt: Date.now(),
    awaitingActivity: false,
    assetId: 'synthetic-image',
    externalUrl: null,
    canRecycle: false,
    blocked: false,
    retired: false,
  });
  source.subscribe('synthetic-game', 'synthetic-member', true);
  // Back up while the WAL database is open, then restore an independent copy.
  const backup = join(directory, 'backup.sqlite');
  await source.backup(backup);
  const copy = join(directory, 'restored.sqlite');
  copyFileSync(backup, copy);
  restored = new DatabaseSync(copy, { readOnly: true });
  assert.equal(restored.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(restored.prepare('SELECT count(*) AS total FROM subscriptions').get().total, 1);
  assert.deepEqual(Buffer.from(restored.prepare('SELECT bytes FROM assets').get().bytes), png);
  console.info(
    JSON.stringify({
      event: 'runtime_check_passed',
      node: process.version,
      sqlite: process.versions.sqlite,
      sharp: sharp.versions.sharp,
      backupRestored: true,
    }),
  );
} finally {
  restored?.close();
  source?.close();
  rmSync(directory, { recursive: true, force: true });
}
