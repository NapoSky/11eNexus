export type Locale = 'fr' | 'en';
export type GameState = 'active' | 'archived' | 'unavailable';
export type RoleState = 'present' | 'recycled' | 'missing';
export interface Game {
  id: string;
  rawgId: number | null;
  name: string;
  aliases: string[];
  channelId: string | null;
  roleId: string | null;
  roleState: RoleState;
  state: GameState;
  lastActivityAt: number | null;
  /** First successful creation in Nexus; absent/null for undated historical imports. */
  addedAt?: number | null;
  activatedAt: number;
  awaitingActivity: boolean;
  assetId: string | null;
  externalUrl: string | null;
  canRecycle: boolean;
  blocked: boolean;
  retired: boolean;
}
export interface Actor {
  id: string;
  member: boolean;
  admin: boolean;
}
export interface Candidate {
  id: number;
  name: string;
  released: string | null;
  studio: string;
  imageUrl: string | null;
  url: string;
  parentId?: number;
}
export interface Asset {
  id: string;
  bytes: Uint8Array;
  mime: string;
  source: string;
  sha256: string;
}
export interface Proposal {
  id: string;
  actorId: string;
  name: string;
  url: string;
  status: 'pending' | 'needs_info' | 'accepted' | 'rejected' | 'expired';
  reason: string | null;
  gameId: string | null;
  createdAt: number;
  updatedAt?: number;
  closedAt?: number | null;
  locale: Locale;
}
export interface Operation {
  id: string;
  kind: 'create' | 'activate' | 'archive' | 'recycle' | 'import' | 'rename';
  gameId: string;
  actorId: string | null;
  status: 'pending' | 'completed' | 'failed' | 'review';
  startedAt: number;
  completedAt?: number | null;
  data: Record<string, unknown>;
  error: string | null;
}
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly values: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = 'DomainError';
  }
}
export const DAY = 86_400_000;
export function blocksMemberCreation(operation: Operation, actorId: string, now: number): boolean {
  return (
    operation.actorId === actorId &&
    (operation.status === 'pending' ||
      (operation.status === 'review' && operation.startedAt + DAY > now))
  );
}
export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function channelName(name: string): string {
  return normalize(name).replace(/ /g, '-').slice(0, 90) || 'jeu';
}
export function requireMember(actor: Actor): void {
  if (!actor.member && !actor.admin) throw new DomainError('forbidden');
}
export function requireAdmin(actor: Actor): void {
  if (!actor.admin) throw new DomainError('adminOnly');
}
export function archiveCandidates(games: Game[], now: number, minimum: number): Game[] {
  const eligible = games.filter((g) => g.state === 'active' && !g.blocked);
  // Provisional activations never displace the baseline. One message moves them into the normal pool.
  const normal = eligible
    .filter((g) => !g.awaitingActivity)
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.activatedAt) - (a.lastActivityAt ?? a.activatedAt) ||
        a.id.localeCompare(b.id),
    );
  const protectedIds = new Set(normal.slice(0, minimum).map((g) => g.id));
  return eligible.filter((g) =>
    g.awaitingActivity
      ? now - g.activatedAt >= 2 * DAY
      : !protectedIds.has(g.id) && now - (g.lastActivityAt ?? g.activatedAt) >= 30 * DAY,
  );
}

export const ADMIN_RETENTION_MS = 30 * DAY;
export function validateGameIdentity(name: string, url: string): string {
  if (!name.trim() || name.length > 100 || url.length > 500) throw new DomainError('invalidInput');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainError('invalidInput');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hostname === 'localhost' ||
    !parsed.hostname.includes('.') ||
    /^[\d.]+$/.test(parsed.hostname)
  )
    throw new DomainError('invalidInput');
  return parsed.href;
}
