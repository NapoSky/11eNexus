import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ADMIN_RETENTION_MS,
  type Asset,
  type Game,
  type Operation,
  type Proposal,
} from '../domain/model.js';
import type { Repository, Session } from '../application/ports.js';
import type { CommunityEvent, EventOperation } from '../domain/community-event.js';

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
    for (const name of ['001-initial', '002-game-added-dates', '003-events']) {
      const id = name.slice(0, 3);
      const sql = readFileSync(resolve(__dirname, `../../migrations/${name}.sql`), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const applied = this.db.prepare('SELECT sha256 FROM schema_migrations WHERE id=?').get(id);
      if (applied && applied.sha256 !== hash) {
        this.db.close();
        throw new Error(`Migration checksum mismatch: ${id}`);
      }
      if (!applied)
        this.transaction(() => {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(id, hash);
        });
    }
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
  events(): CommunityEvent[] {
    return this.db
      .prepare('SELECT data FROM community_events ORDER BY id')
      .all()
      .map((row) => JSON.parse(String(row.data)) as CommunityEvent);
  }
  event(id: string): CommunityEvent | undefined {
    const row = this.db.prepare('SELECT data FROM community_events WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as CommunityEvent) : undefined;
  }
  saveEvent(event: CommunityEvent): void {
    this.db
      .prepare(
        'INSERT INTO community_events VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(event.id, JSON.stringify(event));
  }
  eventOperations(): EventOperation[] {
    return this.db
      .prepare('SELECT data FROM event_operations ORDER BY id')
      .all()
      .map((row) => JSON.parse(String(row.data)) as EventOperation);
  }
  saveEventOperation(operation: EventOperation): void {
    this.db
      .prepare(
        'INSERT INTO event_operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(operation.id, JSON.stringify(operation));
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
    const current = new Set(this.subscribers(id));
    const desired = new Set(users);
    const removed = [...current].filter((user) => !desired.has(user));
    const added = [...desired].filter((user) => !current.has(user));
    if (!removed.length && !added.length) return;
    // One commit for the delta; SAVEPOINT also works inside an existing transaction.
    // Rewriting unchanged subscribers used to perform hundreds of blocking disk commits.
    this.db.exec('SAVEPOINT replace_subscribers');
    try {
      const remove = this.db.prepare('DELETE FROM subscriptions WHERE game_id=? AND user_id=?');
      const add = this.db.prepare('INSERT INTO subscriptions VALUES (?,?)');
      for (const user of removed) remove.run(id, user);
      for (const user of added) add.run(id, user);
      this.db.exec('RELEASE replace_subscribers');
    } catch (error) {
      this.db.exec('ROLLBACK TO replace_subscribers; RELEASE replace_subscribers');
      throw error;
    }
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
    const row = this.db.prepare('SELECT data FROM proposals WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as Proposal) : undefined;
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
      const started = this.get<number>('retentionStartedAt') ?? now;
      if (this.get('retentionStartedAt') === undefined) this.set('retentionStartedAt', started);
      const cutoff = now - ADMIN_RETENTION_MS;
      this.purgePermissionSnapshots(now, cutoff, started);
      this.db
        .prepare(
          "DELETE FROM event_operations WHERE json_extract(data,'$.status')='completed' AND json_extract(data,'$.completedAt')<=?",
        )
        .run(cutoff);
      this.db.prepare('DELETE FROM audit WHERE at<=?').run(cutoff);
      this.db
        .prepare(
          "DELETE FROM proposals WHERE json_extract(data,'$.status') IN ('accepted','rejected','expired') AND COALESCE(json_extract(data,'$.closedAt'),MAX(json_extract(data,'$.createdAt'),?))<=?",
        )
        .run(started, cutoff);
      this.db
        .prepare(
          "DELETE FROM operations WHERE json_extract(data,'$.status') IN ('completed','failed') AND COALESCE(json_extract(data,'$.completedAt'),MAX(json_extract(data,'$.startedAt'),?))<=?",
        )
        .run(started, cutoff);
      this.db
        .prepare(
          "DELETE FROM metadata WHERE (key LIKE 'alert:%' OR key LIKE 'notification:%') AND CAST(value AS INTEGER)<=?",
        )
        .run(cutoff);
      this.db.prepare('DELETE FROM cooldowns WHERE at<=?').run(cutoff);
      this.db
        .prepare(
          "DELETE FROM metadata WHERE key LIKE 'new-game-announcement:%' AND json_extract(value,'$.status')='sent' AND json_extract(value,'$.sentAt')<=?",
        )
        .run(cutoff);
      this.db
        .prepare(
          "DELETE FROM metadata WHERE (key LIKE 'import-icon:%' OR key LIKE 'admin-action:%') AND json_extract(value,'$.expiresAt')<=?",
        )
        .run(now);
      this.db
        .prepare(
          "DELETE FROM metadata WHERE key LIKE 'rawg:%' AND json_extract(value,'$.expires')<=?",
        )
        .run(now);
      this.db.exec(
        "DELETE FROM assets WHERE id NOT IN (SELECT json_extract(data,'$.assetId') FROM games WHERE json_extract(data,'$.assetId') IS NOT NULL) AND id NOT IN (SELECT json_extract(data,'$.assetId') FROM sessions WHERE json_extract(data,'$.assetId') IS NOT NULL) AND id NOT IN (SELECT json_extract(value,'$.assetId') FROM metadata WHERE key LIKE 'import-icon:%' AND json_extract(value,'$.assetId') IS NOT NULL)",
      );
    });
  }
  private purgePermissionSnapshots(now: number, cutoff: number, legacyStarted: number): void {
    const owners = `WITH copies AS (
      SELECT key, substr(key,length('permissionsBefore:')+1) AS suffix
      FROM metadata WHERE key GLOB 'permissionsBefore:*'
    ), owners AS (
      SELECT key, CASE WHEN instr(suffix,':')=0 THEN suffix
        ELSE substr(suffix,1,instr(suffix,':')-1) END AS owner FROM copies
    )`;
    // Resolve each owner by primary key, then purge its ACL copies atomically.
    this.db
      .prepare(
        `${owners} DELETE FROM metadata WHERE key IN (
      SELECT owners.key FROM owners JOIN operations ON operations.id=owners.owner
      WHERE json_extract(data,'$.status') IN ('completed','failed')
      AND COALESCE(json_extract(data,'$.completedAt'),MAX(json_extract(data,'$.startedAt'),?))<=?
    )`,
      )
      .run(legacyStarted, cutoff);
    const key = 'permissionSnapshotRetentionStartedAt';
    const started = this.get<number>(key) ?? now;
    if (this.get(key) === undefined) this.set(key, started);
    if (started > cutoff) return;
    // Old orphan copies lack a timestamp: allow a full rollout grace period.
    // Import/adoption evidence and unresolved operations remain correlated and retained.
    this.db
      .prepare(
        `${owners} DELETE FROM metadata WHERE key IN (
      SELECT key FROM owners WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id=owner)
      AND NOT EXISTS (SELECT 1 FROM metadata WHERE key='migration:'||owner)
      AND owner!=COALESCE((SELECT json_extract(value,'$.plan') FROM metadata WHERE key='archiveAdoption'),'')
    )`,
      )
      .run();
  }
  releaseLease(owner: string): void {
    this.db.prepare('DELETE FROM lease WHERE owner=?').run(owner);
  }
  async backup(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await backup(this.db, path);
    chmodSync(path, 0o600);
    // Make the snapshot self-contained, including on a read-only restore mount.
    // The online backup inherits WAL mode, which otherwise needs sidecar files.
    const snapshot = new DatabaseSync(path);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
    } finally {
      snapshot.close();
    }
  }
  close(): void {
    this.db.close();
  }
}
