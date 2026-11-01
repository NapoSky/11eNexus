import { Events, type Client, type Guild } from 'discord.js';
import { NEXUS_GUILD_ID } from './config.js';
import { logger, type AppLogger } from './logger.js';

/** Runtime only: diagnostics must never leave a guild. */
export class GuildRestriction {
  private readonly pending = new Map<string, Promise<void>>();
  private listening = false;
  private stopped = false;
  private readonly ready = () => void this.enforce();
  private readonly joined = (guild: Guild) => void this.leave(guild);

  constructor(
    private readonly client: Client,
    private readonly log: Pick<AppLogger, 'info' | 'warn'> = logger,
  ) {}

  listen(): void {
    if (this.listening || this.stopped) return;
    this.listening = true;
    this.client.on(Events.ClientReady, this.ready);
    this.client.on(Events.GuildCreate, this.joined);
    if (this.client.isReady()) this.ready();
  }

  async enforce(): Promise<void> {
    if (this.stopped || !this.client.isReady()) return;
    await Promise.all([...this.client.guilds.cache.values()].map((guild) => this.leave(guild)));
  }

  private leave(guild: Pick<Guild, 'id' | 'leave'>): Promise<void> {
    if (this.stopped || guild.id === NEXUS_GUILD_ID) return Promise.resolve();
    const current = this.pending.get(guild.id);
    if (current) return current;
    const task = Promise.resolve()
      .then(async () => {
        if (this.stopped) return;
        try {
          await guild.leave();
          this.log.info({ event: 'unauthorized_guild_left', guildId: guild.id });
        } catch (err) {
          this.log.warn({ event: 'unauthorized_guild_leave_failed', guildId: guild.id, err });
        }
      })
      .finally(() => this.pending.delete(guild.id));
    this.pending.set(guild.id, task);
    return task;
  }

  stopAccepting(): void {
    this.stopped = true;
    this.client.off(Events.ClientReady, this.ready);
    this.client.off(Events.GuildCreate, this.joined);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.pending.values()]);
  }
}
