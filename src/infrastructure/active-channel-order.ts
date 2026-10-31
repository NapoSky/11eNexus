import { Events, type Client, type Channel } from 'discord.js';
import { logger, type AppLogger } from './logger.js';

interface SortableChannel {
  id: string;
  name: string;
  parentId: string | null;
  type: number;
  rawPosition: number;
}
const alphabetical = new Intl.Collator('fr', {
  sensitivity: 'base',
  numeric: true,
  ignorePunctuation: true,
});
const byId = (a: SortableChannel, b: SortableChannel) =>
  BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;

export function activeChannelPositions(
  channels: SortableChannel[],
  categoryId: string,
): { channel: string; position: number }[] {
  const siblings = channels
    .filter((c) => c.parentId === categoryId && [0, 5, 15, 16].includes(c.type))
    .sort((a, b) => a.rawPosition - b.rawPosition || byId(a, b));
  const desired = [...siblings].sort((a, b) => alphabetical.compare(a.name, b.name) || byId(a, b));
  if (siblings.every((c, i) => c.id === desired[i]!.id)) return [];
  // Discord positions can have gaps or ties. Send the full textual sibling
  // order using consecutive positions, without parent or permission fields.
  return desired.map((c, position) => ({
    channel: c.id,
    position,
  }));
}

/** Only the runtime installs this listener; CLI diagnostics never start sorting. */
export class ActiveChannelOrder {
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> = Promise.resolve();
  private queued = false;
  private stopped = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly categoryId: string,
    private readonly sort: () => Promise<void>,
    private readonly log: Pick<AppLogger, 'warn'> = logger,
  ) {}

  private relevant(channel: Channel): boolean {
    return (
      'guild' in channel &&
      channel.guild.id === this.guildId &&
      channel.parentId === this.categoryId &&
      [0, 5, 15, 16].includes(channel.type)
    );
  }
  private changed = (channel: Channel): void => {
    if (this.relevant(channel)) this.request();
  };
  private updated = (before: Channel, after: Channel): void => {
    if (!('rawPosition' in before) || !('rawPosition' in after)) return;
    if (
      (this.relevant(before) || this.relevant(after)) &&
      (before.name !== after.name ||
        before.parentId !== after.parentId ||
        before.rawPosition !== after.rawPosition ||
        before.type !== after.type)
    )
      this.request();
  };

  listen(): void {
    this.client.on(Events.ChannelCreate, this.changed);
    this.client.on(Events.ChannelDelete, this.changed);
    this.client.on(Events.ChannelUpdate, this.updated);
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
          this.log.warn({ event: 'active_channel_order_failed', err });
        }
      });
    }, 2000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.client.off(Events.ChannelCreate, this.changed);
    this.client.off(Events.ChannelDelete, this.changed);
    this.client.off(Events.ChannelUpdate, this.updated);
    await this.running;
  }
}
