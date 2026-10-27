import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Asset, Game, Operation, Proposal } from '../domain/model.js';
import type { Repository, Session } from '../application/ports.js';

export class Store implements Repository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL)',
    );
    const sql = readFileSync(resolve(__dirname, '../../migrations/001-initial.sql'), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const applied = this.db.prepare('SELECT sha256 FROM schema_migrations WHERE id=?').get('001');
    if (applied && applied.sha256 !== hash) {
      this.db.close();
      throw new Error('Migration checksum mismatch: 001');
    }
    if (!applied)
      this.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('001', hash);
      });
  }
  transaction<T>(task: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = task();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  games(includeRetired = false): Game[] {
    return this.db
      .prepare('SELECT data FROM games ORDER BY id')
      .all()
      .map((r) => JSON.parse(String(r.data)) as Game)
      .filter((g) => includeRetired || !g.retired);
  }
  game(id: string): Game | undefined {
    const row = this.db.prepare('SELECT data FROM games WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as Game) : undefined;
  }
  byRawg(id: number): Game | undefined {
    const row = this.db.prepare('SELECT data FROM games WHERE rawg_id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as Game) : undefined;
  }
  saveGame(g: Game): void {
    this.db
      .prepare(
        'INSERT INTO games VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET rawg_id=excluded.rawg_id,data=excluded.data',
      )
      .run(g.id, g.rawgId, JSON.stringify(g));
  }
  subscribers(id: string): string[] {
    return this.db
      .prepare('SELECT user_id FROM subscriptions WHERE game_id=? ORDER BY user_id')
      .all(id)
      .map((r) => String(r.user_id));
  }
  subscribed(id: string, user: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM subscriptions WHERE game_id=? AND user_id=?').get(id, user),
    );
  }
  subscribe(id: string, user: string, enabled: boolean): void {
    if (enabled) this.db.prepare('INSERT OR IGNORE INTO subscriptions VALUES (?,?)').run(id, user);
    else this.db.prepare('DELETE FROM subscriptions WHERE game_id=? AND user_id=?').run(id, user);
  }
  replaceSubscribers(id: string, users: string[]): void {
    this.db.prepare('DELETE FROM subscriptions WHERE game_id=?').run(id);
    for (const user of new Set(users)) this.subscribe(id, user, true);
  }
  asset(id: string): Asset | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    return row
      ? {
          id,
          bytes: row.bytes as Uint8Array,
          mime: String(row.mime),
          source: String(row.source),
          sha256: String(row.sha256),
        }
      : null;
  }
  saveAsset(a: Asset): void {
    this.db
      .prepare('INSERT OR REPLACE INTO assets VALUES (?,?,?,?,?)')
      .run(a.id, a.bytes, a.mime, a.source, a.sha256);
  }
  cooldown(user: string): number | null {
    const row = this.db.prepare('SELECT at FROM cooldowns WHERE user_id=?').get(user);
    return row ? Number(row.at) : null;
  }
  setCooldown(user: string, at: number): void {
    this.db.prepare('INSERT OR REPLACE INTO cooldowns VALUES (?,?)').run(user, at);
  }
  operations(): Operation[] {
    return this.db
      .prepare('SELECT data FROM operations')
      .all()
      .map((r) => JSON.parse(String(r.data)) as Operation);
  }
  saveOperation(o: Operation): void {
    this.db.prepare('INSERT OR REPLACE INTO operations VALUES (?,?)').run(o.id, JSON.stringify(o));
  }
  proposals(user?: string): Proposal[] {
    return this.db
      .prepare('SELECT data FROM proposals')
      .all()
      .map((r) => JSON.parse(String(r.data)) as Proposal)
      .filter((p) => !user || p.actorId === user)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  proposal(id: string): Proposal | undefined {
    return this.proposals().find((p) => p.id === id);
  }
  saveProposal(p: Proposal): void {
    this.db.prepare('INSERT OR REPLACE INTO proposals VALUES (?,?)').run(p.id, JSON.stringify(p));
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(value));
  }
  session(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row
      ? {
          id,
          userId: String(row.user_id),
          kind: String(row.kind),
          data: JSON.parse(String(row.data)) as Record<string, unknown>,
          expiresAt: Number(row.expires_at),
        }
      : undefined;
  }
  saveSession(s: Session): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    this.db
      .prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?)')
      .run(s.id, s.userId, s.kind, JSON.stringify(s.data), s.expiresAt);
  }
  audit(action: string, actorId: string | null, target: string, at: number): void {
    this.db
      .prepare('INSERT INTO audit(action,actor_id,target,at) VALUES (?,?,?,?)')
      .run(action, actorId, target, at);
  }
  acquireLease(owner: string, now: number): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (row && row.owner !== owner && Number(row.expires_at) > now) return false;
      this.db.prepare('INSERT OR REPLACE INTO lease VALUES (1,?,?)').run(owner, now + 60000);
      return true;
    });
  }
  maintain(now: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
      this.db
        .prepare(
          "DELETE FROM metadata WHERE key LIKE 'rawg:%' AND json_extract(value,'$.expires')<=?",
        )
        .run(now);
      this.db.exec(
        "DELETE FROM assets WHERE id NOT IN (SELECT json_extract(data,'$.assetId') FROM games WHERE json_extract(data,'$.assetId') IS NOT NULL) AND id NOT IN (SELECT json_extract(data,'$.assetId') FROM sessions WHERE json_extract(data,'$.assetId') IS NOT NULL)",
      );
    });
  }
  releaseLease(owner: string): void {
    this.db.prepare('DELETE FROM lease WHERE owner=?').run(owner);
  }
  async backup(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await backup(this.db, path);
    chmodSync(path, 0o600);
  }
  close(): void {
    this.db.close();
  }
}
