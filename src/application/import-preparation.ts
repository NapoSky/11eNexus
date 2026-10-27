import { DomainError, normalize, type Candidate } from '../domain/model.js';
import type { Catalogue, World, ChannelObservation, RoleObservation } from './ports.js';
import { fingerprint } from './migration.js';

export const LEGACY_ACTIVE = '1163827775115890708';
export const LEGACY_STANDBY = '1163828069551845427';
export type ReviewIssue =
  | 'unmatched'
  | 'fuzzy'
  | 'duplicate'
  | 'event'
  | 'family'
  | 'permissions'
  | 'hierarchy'
  | 'references'
  | 'catalogueUnavailable';
export interface PreparedRole {
  id: string;
  name: string;
  subscribers: number;
  permissions: string;
  editable: boolean;
  references: string[];
}
export interface PreparedChannel {
  channelId: string;
  channelName: string;
  categoryName: string;
  type: number;
  name: string;
  roleId: string | null;
  state: 'active' | 'archived';
  aliases: string[];
  confirmed: false;
  confidence: 'exact' | 'suggested' | 'none';
  candidates: { roleId: string; score: number }[];
  issues: ReviewIssue[];
  rawgId?: number;
  rawgCandidates: Candidate[];
}
export interface ImportPreparation {
  version: 1;
  generatedAt: string;
  inventoryFingerprint: string;
  complete: boolean;
  activeCategoryId: string;
  standbyCategoryId: string;
  archiveCategoryIds: string[];
  roles: PreparedRole[];
  channels: PreparedChannel[];
  ignoredNonTextual: number;
}
const textual = (type: number) => [0, 5, 15, 16].includes(type);
export function readInventory(value: unknown): World {
  if (!value || typeof value !== 'object') throw new DomainError('invalidInput');
  const w = value as World;
  const id = (v: unknown) => typeof v === 'string' && /^\d{17,20}$/.test(v);
  if (
    !Array.isArray(w.channels) ||
    !Array.isArray(w.roles) ||
    !Array.isArray(w.memberIds) ||
    !Array.isArray(w.archiveCategoryIds) ||
    typeof w.complete !== 'boolean' ||
    typeof w.roleIcons !== 'boolean' ||
    w.channels.some(
      (c) =>
        !c ||
        !id(c.id) ||
        typeof c.name !== 'string' ||
        !Number.isInteger(c.type) ||
        (c.parentId !== null && !id(c.parentId)),
    ) ||
    w.roles.some(
      (r) =>
        !r ||
        !id(r.id) ||
        typeof r.name !== 'string' ||
        !Array.isArray(r.members) ||
        !Array.isArray(r.references) ||
        r.references.some((ref) => typeof ref !== 'string') ||
        typeof r.managed !== 'boolean' ||
        typeof r.editable !== 'boolean' ||
        typeof r.permissions !== 'string' ||
        !/^\d+$/.test(r.permissions),
    )
  )
    throw new DomainError('invalidInput');
  if (
    new Set(w.channels.map((c) => c.id)).size !== w.channels.length ||
    new Set(w.roles.map((r) => r.id)).size !== w.roles.length
  )
    throw new DomainError('invalidInput');
  return w;
}
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j]! + 1, previous[j + 1]! + 1, previous[j]! + Number(a[i] !== b[j])));
    previous = next;
  }
  return previous[b.length]!;
}
function roleNames(role: RoleObservation): string[] {
  return [
    ...new Set([
      normalize(role.name),
      ...Array.from(role.name.matchAll(/\(([^)]+)\)/g), (m) => normalize(m[1] || '')),
    ]),
  ].filter(Boolean);
}
function score(channel: ChannelObservation, role: RoleObservation): number {
  const a = normalize(channel.name);
  let best = 0;
  for (const b of roleNames(role)) {
    if (a === b) best = Math.max(best, 100);
    else if (b.length >= 4 && ` ${a} `.includes(` ${b} `)) best = Math.max(best, 82);
    if (a.length >= 5 && b.length >= 5) {
      const similarity = 1 - distance(a, b) / Math.max(a.length, b.length);
      if (similarity >= 0.75) best = Math.max(best, Math.round(similarity * 95));
    }
    const words = b.split(' ');
    const acronym = words.map((w) => w[0]).join('');
    if (acronym.length >= 2 && a.split(' ').includes(acronym)) best = Math.max(best, 78);
    const aWords = a.split(' ');
    const bWords = b.split(' ');
    const shared = aWords.filter((w) => w.length >= 4 && bWords.includes(w));
    if (shared.length)
      best = Math.max(
        best,
        Math.round(65 + (20 * shared.length) / Math.max(aWords.length, bWords.length)),
      );
    if (aWords.some((w) => w.length >= 3 && bWords.some((v) => v.startsWith(w))) && best === 0)
      best = 55;
  }
  // Explicit access references support a candidate but do not grant certainty about its identity.
  if (best > 0 && role.references.includes(channel.id)) best = Math.max(best, 85);
  return best;
}
export function prepareInventory(
  world: World,
  activeCategoryId = LEGACY_ACTIVE,
  standbyCategoryId = LEGACY_STANDBY,
): ImportPreparation {
  if (
    activeCategoryId === standbyCategoryId ||
    [activeCategoryId, standbyCategoryId].some(
      (id) => world.channels.find((c) => c.id === id)?.type !== 4,
    )
  )
    throw new DomainError('invalidInput');
  const source = new Set([activeCategoryId, standbyCategoryId]);
  const rolePool = world.roles.filter(
    (r) =>
      !r.managed &&
      normalize(r.name) &&
      !r.name.startsWith('@') &&
      !/^(jeux reguliers|jeux recents|bots|syndicats)$/.test(normalize(r.name)),
  );
  const channels = world.channels
    .filter((c) => source.has(c.parentId || '') && textual(c.type))
    .map((c) => {
      const candidates = rolePool
        .map((r) => ({ roleId: r.id, score: score(c, r) }))
        .filter((r) => r.score >= 55)
        .sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId))
        .slice(0, 5);
      const first = candidates[0];
      const unique = first && first.score > (candidates[1]?.score || 0);
      const selected =
        unique && first.score >= 70 ? world.roles.find((r) => r.id === first.roleId) : undefined;
      const issues: ReviewIssue[] = [];
      if (!selected) issues.push('unmatched');
      else if (first?.score !== 100) issues.push('fuzzy');
      if (
        /\b(campagne|campaign|saison|season|serveur|server|20\d\d|b\d{2})\b/.test(normalize(c.name))
      )
        issues.push('event');
      if (
        /\b(series|hub|etc)\b/.test(normalize(c.name)) ||
        (candidates.filter((r) => r.score >= 70).length > 1 &&
          (first?.score || 0) < 95 &&
          (first?.score || 0) - (candidates[1]?.score || 0) < 8)
      )
        issues.push('family');
      if (selected?.permissions !== '0' && selected) issues.push('permissions');
      if (selected && !selected.editable) issues.push('hierarchy');
      if (selected?.references.some((ref) => !ref.startsWith('onboarding:')))
        issues.push('references');
      return {
        channelId: c.id,
        channelName: c.name,
        categoryName: world.channels.find((cat) => cat.id === c.parentId)!.name,
        type: c.type,
        name: selected?.name || c.name,
        roleId: selected?.id || null,
        state: c.parentId === activeCategoryId ? ('active' as const) : ('archived' as const),
        aliases: [...new Set([c.name, normalize(c.name)])].filter(
          (name) => normalize(name) !== normalize(selected?.name || ''),
        ),
        confirmed: false as const,
        confidence:
          first?.score === 100 && unique
            ? ('exact' as const)
            : selected
              ? ('suggested' as const)
              : ('none' as const),
        candidates,
        issues,
        rawgCandidates: [],
      };
    });
  for (const row of channels)
    if (
      row.roleId &&
      channels.some(
        (other) => other !== row && other.roleId === row.roleId && !other.issues.includes('event'),
      )
    ) {
      if (
        channels.filter((other) => other.roleId === row.roleId && !other.issues.includes('event'))
          .length > 1
      )
        row.issues.push('duplicate');
    }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    inventoryFingerprint: fingerprint(world),
    complete: world.complete,
    activeCategoryId,
    standbyCategoryId,
    archiveCategoryIds: [standbyCategoryId],
    roles: rolePool.map((r) => ({
      id: r.id,
      name: r.name,
      subscribers: r.members.length,
      permissions: r.permissions,
      editable: r.editable,
      references: r.references,
    })),
    channels: channels.sort(
      (a, b) => a.name.localeCompare(b.name, 'fr') || a.channelId.localeCompare(b.channelId),
    ),
    ignoredNonTextual: world.channels.filter(
      (c) => source.has(c.parentId || '') && !textual(c.type),
    ).length,
  };
}
export async function enrichPreparation(
  preparation: ImportPreparation,
  catalogue: Pick<Catalogue, 'search'>,
): Promise<void> {
  const cache = new Map<string, Candidate[]>();
  for (const row of preparation.channels) {
    if (row.issues.includes('event')) continue;
    try {
      const query = row.name.trim().slice(0, 100);
      let results = cache.get(query);
      if (!results) {
        results = await catalogue.search(query);
        cache.set(query, results);
      }
      row.rawgCandidates = results;
      // Search results remain proposals; homonymous games must be selected explicitly.
    } catch {
      row.issues.push('catalogueUnavailable');
    }
  }
}
