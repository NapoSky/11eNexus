import { Events, type Client, type Role } from 'discord.js';
import { GAME_ROLE_MARKER } from '../application/resource-audit.js';
import { DomainError } from '../domain/model.js';
import { logger, type AppLogger } from './logger.js';

interface SortableRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}
const alphabetical = new Intl.Collator('fr', {
  sensitivity: 'base',
  numeric: true,
  ignorePunctuation: true,
});

/** Positions are Discord.js effective positions, including its snowflake tie-break. */
export function gameRolePositions(
  roles: SortableRole[],
  guildId: string,
  markerId = GAME_ROLE_MARKER,
): { role: string; position: number }[] {
  const marker = roles.find((r) => r.id === markerId);
  if (
    !marker ||
    marker.managed ||
    marker.id === guildId ||
    roles.some((r) => !Number.isInteger(r.position) || r.position < 0) ||
    new Set(roles.map((r) => r.position)).size !== roles.length
  )
    throw new DomainError('configuration');
  const current = roles
    .filter((r) => r.id !== guildId && !r.managed && r.position < marker.position)
    .sort((a, b) => b.position - a.position);
  const desired = [...current].sort(
    (a, b) =>
      alphabetical.compare(a.name, b.name) ||
      (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0),
  );
  if (current.every((r, i) => r.id === desired[i]!.id)) return [];
  const targets = new Map(desired.map((r, i) => [r.id, current[i]!.position]));
  // Discord may return duplicate raw positions. A partial PATCH mixing effective
  // positions with untouched raw positions can lift games above the marker.
  // Anchor the entire hierarchy, as Discord.js does for single-role moves, with
  // contiguous effective positions. Only ordinary-role slots are permuted.
  return roles
    .map((r) => ({ role: r.id, position: targets.get(r.id) ?? r.position }))
    .sort((a, b) => a.position - b.position);
}

/** Runtime only: constructing a CLI gateway never installs mutation listeners. */
export class GameRoleOrder {
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> = Promise.resolve();
  private queued = false;
  private stopped = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly sort: () => Promise<void>,
    private readonly log: Pick<AppLogger, 'warn'> = logger,
  ) {}

  private changed = (role: Role): void => {
    if (role.guild.id === this.guildId) this.request();
  };
  private updated = (before: Role, after: Role): void => {
    if (
      before.name !== after.name ||
      before.rawPosition !== after.rawPosition ||
      before.managed !== after.managed ||
      before.permissions.bitfield !== after.permissions.bitfield
    )
      this.changed(after);
  };
  listen(): void {
    this.client.on(Events.GuildRoleCreate, this.changed);
    this.client.on(Events.GuildRoleDelete, this.changed);
    this.client.on(Events.GuildRoleUpdate, this.updated);
  }
  request(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.queued) return;
      this.queued = true;
      this.running = this.running.then(async () => {
        this.queued = false;
        if (this.stopped) return;
        try {
          await this.sort();
        } catch (err) {
          this.log.warn({ event: 'game_role_order_failed', err });
        }
      });
    }, 2000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.client.off(Events.GuildRoleCreate, this.changed);
    this.client.off(Events.GuildRoleDelete, this.changed);
    this.client.off(Events.GuildRoleUpdate, this.updated);
    await this.running;
  }
}
