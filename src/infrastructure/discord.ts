import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  GuildFeature,
  PermissionFlagsBits as P,
  type GuildBasedChannel,
  type GuildMember,
  type TextChannel,
  type OverwriteResolvable,
  type Message,
} from 'discord.js';
import { DomainError, channelName, type Actor, type Asset, type Game } from '../domain/model.js';
import type { Activity, Community, World, Repository } from '../application/ports.js';
import type { Config } from './config.js';
import { translator } from '../presentation/i18n.js';
import { discordAttachment } from './images.js';
import { logger } from './logger.js';

export function discordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
export class DiscordCommunity implements Community {
  constructor(
    readonly client: Client,
    readonly config: Config,
    private readonly repository: Repository,
  ) {}
  async guild(): Promise<Guild> {
    return this.client.guilds.fetch(this.config.guildId);
  }
  async actor(id: string): Promise<Actor> {
    const guild = await this.guild();
    const member = await guild.members.fetch({ user: id, force: true });
    return this.memberActor(member);
  }
  memberActor(member: GuildMember): Actor {
    return {
      id: member.id,
      member: member.roles.cache.has(this.config.memberRoleId),
      admin: member.roles.cache.has(this.config.adminRoleId) || member.guild.ownerId === member.id,
    };
  }
  private overwrites(archive: boolean): OverwriteResolvable[] {
    return [
      { id: this.config.guildId, deny: [P.ViewChannel, P.SendMessages] },
      {
        id: this.config.memberRoleId,
        ...(archive
          ? { deny: [P.ViewChannel, P.SendMessages] }
          : {
              allow: [
                P.ViewChannel,
                P.SendMessages,
                P.ReadMessageHistory,
                P.AddReactions,
                P.AttachFiles,
                P.EmbedLinks,
                P.SendMessagesInThreads,
                P.CreatePublicThreads,
              ],
            }),
      },
      {
        id: this.config.adminRoleId,
        allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels],
      },
      {
        id: this.client.user!.id,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.ManageChannels,
          P.ManageRoles,
          P.MentionEveryone,
        ],
      },
    ];
  }
  async snapshot(): Promise<World> {
    const guild = await this.guild();
    const [channels, roles, members, onboarding] = await Promise.all([
      guild.channels.fetch(),
      guild.roles.fetch(),
      guild.members.fetch(),
      guild.fetchOnboarding(),
    ]);
    const me = await guild.members.fetchMe();
    const archiveIds = (this.repository.get<string[]>('archiveCategories') || []).filter(
      (id) => channels.get(id)?.type === ChannelType.GuildCategory,
    );
    return {
      channels: [...channels.values()]
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => ({
          id: c.id,
          name: c.name,
          parentId: c.parentId,
          type: c.type,
          topic: 'topic' in c ? c.topic : null,
        })),
      roles: [...roles.values()].map((r) => ({
        id: r.id,
        name: r.name,
        members: [...members.values()]
          .filter((m) => !m.user.bot && m.roles.cache.has(r.id))
          .map((m) => m.id),
        managed: r.managed,
        permissions: r.permissions.bitfield.toString(),
        mentionable: r.mentionable,
        position: r.position,
        editable: me.permissions.has(P.ManageRoles) && me.roles.highest.comparePositionTo(r) > 0,
        references: [...channels.values()]
          .filter((c) => c?.permissionOverwrites.cache.has(r.id))
          .map((c) => c!.id)
          .concat(
            [...onboarding.prompts.values()].flatMap((p) =>
              p.options.filter((o) => o.roles.has(r.id)).map((o) => `onboarding:${o.id}`),
            ),
          ),
      })),
      memberIds: [...members.keys()],
      complete: members.size >= guild.memberCount,
      archiveCategoryIds: archiveIds,
      roleIcons: guild.features.includes(GuildFeature.RoleIcons),
    };
  }
  private async parent(id: string): Promise<GuildBasedChannel> {
    const channel = await (await this.guild()).channels.fetch(id);
    if (!channel) throw new DomainError('notFound');
    return channel;
  }
  private async destination(archive: boolean): Promise<string> {
    const guild = await this.guild();
    const channels = await guild.channels.fetch();
    if (!archive) {
      const category = channels.get(this.config.activeCategoryId);
      if (category?.type !== ChannelType.GuildCategory) throw new DomainError('configuration');
      if (channels.filter((c) => c?.parentId === category.id).size >= 50)
        throw new DomainError('capacity');
      return category.id;
    }
    const ids = (this.repository.get<string[]>('archiveCategories') || []).filter(
      (id) => channels.get(id)?.type === ChannelType.GuildCategory,
    );
    const available = ids.find((id) => channels.filter((c) => c?.parentId === id).size < 50);
    if (available) return available;
    if (ids.length >= this.config.maxArchives || channels.size >= 500)
      throw new DomainError('capacity');
    const category = await guild.channels.create({
      name: `Archives Nexus · ${ids.length + 1}`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: this.overwrites(true),
      reason: '11eNexus: archive capacity',
    });
    ids.push(category.id);
    this.repository.set('archiveCategories', ids);
    return category.id;
  }
  async createChannel(game: Game, operationId: string): Promise<string> {
    const guild = await this.guild();
    const parent = await this.destination(false);
    const channel = await guild.channels.create({
      name: channelName(game.name),
      type: ChannelType.GuildText,
      parent,
      topic: `11eNexus:${game.id} · ${game.name}`,
      permissionOverwrites: this.overwrites(false),
      reason: `11eNexus op:${operationId}`,
    });
    return channel.id;
  }
  async createRole(game: Game, asset: Asset | null, operationId: string): Promise<string> {
    if (!asset) throw new DomainError('needsReview');
    const guild = await this.guild();
    const role = await guild.roles.create({
      name: game.name.slice(0, 100),
      permissions: 0n,
      mentionable: true,
      hoist: false,
      icon: Buffer.from(asset.bytes),
      reason: `11eNexus op:${operationId}`,
    });
    return role.id;
  }
  async move(game: Game, archive: boolean, operationId: string): Promise<void> {
    if (!game.channelId) throw new DomainError('notFound');
    const channel = await this.parent(game.channelId);
    if (
      !('setParent' in channel) ||
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice
    )
      throw new DomainError('invalidInput');
    const alreadyThere = archive
      ? (this.repository.get<string[]>('archiveCategories') || []).includes(channel.parentId || '')
      : channel.parentId === this.config.activeCategoryId;
    const destination =
      alreadyThere && channel.parentId ? channel.parentId : await this.destination(archive);
    const old = channel.permissionOverwrites.cache.map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
    }));
    this.repository.set(`permissionsBefore:${operationId}`, old);
    // Apply the restrictive ACL before moving to archives. A failed move is reconciled, never reported as success.
    if (archive)
      await channel.permissionOverwrites.set(this.overwrites(true), `11eNexus op:${operationId}`);
    if (channel.parentId !== destination)
      await channel.setParent(destination, {
        lockPermissions: false,
        reason: `11eNexus op:${operationId}`,
      });
    if (!archive)
      await channel.permissionOverwrites.set(this.overwrites(false), `11eNexus op:${operationId}`);
  }
  async adoptArchives(requested: string[], operationId: string): Promise<void> {
    const guild = await this.guild();
    const channels = await guild.channels.fetch();
    const ids = [
      ...new Set([
        ...requested,
        ...(this.repository.get<string[]>('archiveCategories') || []).filter(
          (id) => channels.get(id)?.type === ChannelType.GuildCategory,
        ),
      ]),
    ];
    if (
      ids.length > this.config.maxArchives ||
      requested.some(
        (id) =>
          id === this.config.activeCategoryId ||
          channels.get(id)?.type !== ChannelType.GuildCategory,
      ) ||
      [...channels.values()].some(
        (c) => c && requested.includes(c.parentId || '') && ![0, 5, 15, 16].includes(c.type),
      )
    )
      throw new DomainError('invalidInput');
    const total = [...channels.values()].filter((c) => c && ids.includes(c.parentId || '')).length;
    if (
      total > this.config.maxArchives * 50 ||
      channels.size + Math.max(0, Math.ceil(total / 50) - ids.length) > 500
    )
      throw new DomainError('capacity');
    const reason = `11eNexus archive adoption:${operationId}`;
    for (const id of requested) {
      const category = channels.get(id)!;
      if (category.type !== ChannelType.GuildCategory) throw new DomainError('invalidInput');
      if (this.repository.get(`permissionsBefore:${operationId}:${id}`) === undefined)
        this.repository.set(
          `permissionsBefore:${operationId}:${id}`,
          category.permissionOverwrites.cache.map((o) => ({
            id: o.id,
            type: o.type,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString(),
          })),
        );
      await category.permissionOverwrites.set(this.overwrites(true), reason);
      await category.setName(`Archives Nexus · ${ids.indexOf(id) + 1}`, reason);
      for (const channel of channels.values()) {
        if (channel?.parentId !== id || !('permissionOverwrites' in channel)) continue;
        if (this.repository.get(`permissionsBefore:${operationId}:${channel.id}`) === undefined)
          this.repository.set(
            `permissionsBefore:${operationId}:${channel.id}`,
            channel.permissionOverwrites.cache.map((o) => ({
              id: o.id,
              type: o.type,
              allow: o.allow.bitfield.toString(),
              deny: o.deny.bitfield.toString(),
            })),
          );
        await channel.permissionOverwrites.set(this.overwrites(true), reason);
      }
    }
    this.repository.set('archiveCategories', ids);
    for (const id of requested) {
      const children = [...channels.values()]
        .filter((c) => c?.parentId === id)
        .sort((a, b) => a!.id.localeCompare(b!.id));
      for (const channel of children.slice(50)) {
        if (!channel || !('setParent' in channel)) throw new DomainError('invalidInput');
        const destination = await this.destination(true);
        await channel.setParent(destination, { lockPermissions: false, reason });
      }
    }
  }
  async setSubscription(roleId: string, memberId: string, enabled: boolean): Promise<void> {
    const member = await (await this.guild()).members.fetch({ user: memberId, force: true });
    if (enabled) await member.roles.add(roleId, '11eNexus: subscription');
    else await member.roles.remove(roleId, '11eNexus: subscription');
  }
  async repairResources(game: Game): Promise<void> {
    if (!game.channelId || !game.roleId) throw new DomainError('invalidInput');
    await this.prepareImportedRole(game.roleId);
    const channel = await this.parent(game.channelId);
    if (!('permissionOverwrites' in channel)) throw new DomainError('invalidInput');
    await channel.permissionOverwrites.set(
      this.overwrites(game.state === 'archived'),
      '11eNexus: explicit administrative repair',
    );
  }
  async subscription(roleId: string, memberId: string): Promise<boolean> {
    return (
      await (await this.guild()).members.fetch({ user: memberId, force: true })
    ).roles.cache.has(roleId);
  }
  async deleteRole(id: string, operationId: string): Promise<void> {
    await (await this.guild()).roles.delete(id, `11eNexus op:${operationId}`);
  }
  async notify(game: Game, actorId: string, message: string): Promise<void> {
    const actor = await this.actor(actorId);
    if (!actor.member && !actor.admin) throw new DomainError('forbidden');
    if (!game.roleId || !game.channelId) throw new DomainError('needsReview');
    const channel = await this.parent(game.channelId);
    if (!channel.isTextBased() || !('send' in channel)) throw new DomainError('invalidInput');
    await channel.send({
      content: `<@&${game.roleId}> · <@${actorId}>\n${message}`,
      allowedMentions: { parse: [], roles: [game.roleId], users: [], repliedUser: false },
    });
  }
  async alert(
    key: string,
    textKey: string,
    values: Record<string, string | number> = {},
  ): Promise<void> {
    const notice = this.repository.get<number>(`alert:${key}`);
    if (notice && notice + 3600000 > Date.now()) return;
    try {
      const guild = await this.guild();
      const channel = await guild.channels.fetch(this.config.adminChannelId);
      if (!channel?.isTextBased() || !('send' in channel)) return;
      const t = translator(guild.preferredLocale.startsWith('fr') ? 'fr' : 'en');
      await channel.send({ content: t(textKey, values), allowedMentions: { parse: [] } });
      this.repository.set(`alert:${key}`, Date.now());
    } catch (err) {
      logger.error({ event: 'admin_alert_failed', key: textKey, err });
    }
  }
  private async latestHuman(channel: GuildBasedChannel, since: number): Promise<Activity> {
    if (!('messages' in channel)) return { at: null, complete: false };
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const messages = await channel.messages.fetch({ limit: 100, before });
      if (messages.size === 0) return { at: null, complete: true };
      const ordered = [...messages.values()].sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp,
      );
      const human = ordered.find((m) => !m.author.bot && !m.webhookId && !m.system);
      if (human) return { at: human.createdTimestamp, complete: true };
      const oldest = ordered.at(-1)!;
      if (oldest.createdTimestamp < since || messages.size < 100)
        return { at: null, complete: true };
      before = oldest.id;
    }
    return { at: null, complete: false };
  }
  async activity(game: Game, since: number): Promise<Activity> {
    if (!game.channelId) return { at: null, complete: false };
    const channel = await this.parent(game.channelId);
    const observations: Activity[] = [];
    if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      observations.push(await this.latestHuman(channel, since));
    if ('threads' in channel) {
      const active = await channel.threads.fetchActive();
      for (const thread of active.threads.values())
        observations.push(await this.latestHuman(thread, since));
      let before: Date | undefined;
      let finished = false;
      for (let page = 0; page < 20; page++) {
        const archived = await channel.threads.fetchArchived({ limit: 100, before });
        for (const thread of archived.threads.values())
          observations.push(await this.latestHuman(thread, since));
        const times = [...archived.threads.values()].map((t) => t.archiveTimestamp || 0);
        const oldest = Math.min(...times);
        if (!archived.hasMore || !times.length || oldest < since) {
          finished = true;
          break;
        }
        before = new Date(oldest);
      }
      if (!finished) observations.push({ at: null, complete: false });
      if (channel.type === ChannelType.GuildText) {
        let privateBefore: Date | undefined;
        let privateFinished = false;
        for (let page = 0; page < 20; page++) {
          const archived = await channel.threads.fetchArchived({
            type: 'private',
            fetchAll: true,
            limit: 100,
            before: privateBefore,
          });
          for (const thread of archived.threads.values())
            observations.push(await this.latestHuman(thread, since));
          const times = [...archived.threads.values()].map((t) => t.archiveTimestamp || 0);
          const oldest = Math.min(...times);
          if (!archived.hasMore || !times.length || oldest < since) {
            privateFinished = true;
            break;
          }
          privateBefore = new Date(oldest);
        }
        if (!privateFinished) observations.push({ at: null, complete: false });
      }
    }
    if (!observations.length) return { at: null, complete: false };
    const timestamps = observations.map((o) => o.at).filter((t): t is number => t !== null);
    return {
      at: timestamps.length ? Math.max(...timestamps) : null,
      complete: observations.every((o) => o.complete),
    };
  }
  onActivity(handler: (id: string, at: number) => Promise<void>): void {
    this.client.on(Events.MessageCreate, (message: Message) => {
      if (
        message.guildId !== this.config.guildId ||
        message.author.bot ||
        message.webhookId ||
        message.system
      )
        return;
      const id = message.channel.isThread() ? message.channel.parentId : message.channelId;
      if (id)
        handler(id, message.createdTimestamp).catch((err) =>
          logger.error({ event: 'activity_record_failed', err }),
        );
    });
  }
  async panelChannel(requested?: string): Promise<TextChannel> {
    const guild = await this.guild();
    const id =
      requested || this.repository.get<string>('panelChannel') || this.config.panelChannelId;
    if (id) {
      const channel = await guild.channels.fetch(id);
      if (channel?.type !== ChannelType.GuildText) throw new DomainError('configuration');
      return channel;
    }
    const channel = await guild.channels.create({
      name: '🎮︱nexus',
      type: ChannelType.GuildText,
      permissionOverwrites: [
        ...this.overwrites(false).filter((o) => o.id !== this.config.memberRoleId),
        {
          id: this.config.memberRoleId,
          allow: [P.ViewChannel, P.ReadMessageHistory],
          deny: [
            P.SendMessages,
            P.CreatePublicThreads,
            P.CreatePrivateThreads,
            P.SendMessagesInThreads,
          ],
        },
      ],
      reason: '11eNexus: admin panel setup',
    });
    this.repository.set('panelChannel', channel.id);
    return channel;
  }
  async securePanel(channel: TextChannel): Promise<void> {
    await channel.permissionOverwrites.set(
      [
        ...this.overwrites(false).filter((o) => o.id !== this.config.memberRoleId),
        {
          id: this.config.memberRoleId,
          allow: [P.ViewChannel, P.ReadMessageHistory],
          deny: [
            P.SendMessages,
            P.CreatePublicThreads,
            P.CreatePrivateThreads,
            P.SendMessagesInThreads,
          ],
        },
      ],
      '11eNexus: admin panel setup',
    );
  }
  async prepareImportedRole(id: string): Promise<void> {
    const guild = await this.guild();
    const role = await guild.roles.fetch(id);
    const me = await guild.members.fetchMe();
    if (
      !role ||
      role.managed ||
      role.permissions.bitfield !== 0n ||
      me.roles.highest.comparePositionTo(role) <= 0
    )
      throw new DomainError('needsReview');
    if (!role.mentionable)
      await role.setMentionable(true, '11eNexus: members can mention game notifications');
  }
  async importRoleAsset(id: string): Promise<Asset | null> {
    const role = await (await this.guild()).roles.fetch(id);
    const url = role?.iconURL({ size: 64, extension: 'png' });
    return url ? discordAttachment(url, true) : null;
  }
  async removeGameOptions(roleIds: string[], channelIds: string[]): Promise<void> {
    const guild = await this.guild();
    const onboarding = await guild.fetchOnboarding();
    const prompts = [...onboarding.prompts.values()]
      .map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        type: prompt.type,
        singleSelect: prompt.singleSelect,
        required: prompt.required,
        inOnboarding: prompt.inOnboarding,
        options: [...prompt.options.values()].flatMap((option) => {
          const roles = [...option.roles.keys()].filter((id) => !roleIds.includes(id));
          const channels = [...option.channels.keys()].filter((id) => !channelIds.includes(id));
          const affected =
            roles.length !== option.roles.size || channels.length !== option.channels.size;
          if (affected && !roles.length && !channels.length) return [];
          return [
            {
              id: option.id,
              title: option.title,
              description: option.description,
              emoji: option.emoji?.id || option.emoji?.name || null,
              roles,
              channels,
            },
          ];
        }),
      }))
      .filter((prompt) => prompt.options.length > 0);
    await guild.editOnboarding({
      prompts,
      reason: '11eNexus: imported game notifications now managed in panel',
    });
  }
}
