import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const path = resolve(process.argv[2] || process.env.DATABASE_PATH || './data/nexus.sqlite');
if (!existsSync(path)) throw new Error('Database file does not exist.');
const database = new DatabaseSync(path, { readOnly: true });
try {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || foreignKeys.length) {
    throw new Error('SQLite verification failed.');
  }
  console.info('SQLite integrity and foreign keys verified.');
} finally {
  database.close();
}
