import { createHash } from 'node:crypto';
import {
  AuditLogEvent,
  ChannelType,
  ChannelFlagsBitField,
  PermissionFlagsBits as P,
  type OverwriteResolvable,
  type TextChannel,
} from 'discord.js';
import { DomainError, channelName, requireAdmin, requireMember } from '../domain/model.js';
import { eventRoleName, type CommunityEvent } from '../domain/community-event.js';
import type { EventCommunity, EventWorld } from '../application/event-ports.js';
import type { DiscordCommunity } from './discord.js';
import { eventAnnouncement, eventMessage } from '../presentation/event-messages.js';
import { activeChannelPositions } from './active-channel-order.js';

const EVENT_CATEGORY_NAME = 'Évènements ╠════════════════';
const LEGACY_EVENT_CATEGORY_NAMES = ['Événements', 'Les événements du moment ╠════════════════'];
const EVENT_ARCHIVE_CATEGORY_NAME = 'Archives Nexus · Events';

export class DiscordEvents implements EventCommunity {
  constructor(readonly gateway: DiscordCommunity) {}
  async authorize(actorId: string, admin: boolean): Promise<void> {
    const actor = await this.gateway.actor(actorId);
    if (admin) requireAdmin(actor);
    else requireMember(actor);
  }
  async recoverCategory(archived: boolean, operationId: string): Promise<string | null> {
    const guild = await this.gateway.guild();
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 100 });
    const names = archived
      ? [EVENT_ARCHIVE_CATEGORY_NAME]
      : [EVENT_CATEGORY_NAME, ...LEGACY_EVENT_CATEGORY_NAMES];
    const channels = await guild.channels.fetch();
    const matches = logs.entries.filter(
      (e) =>
        e.executorId === this.gateway.client.user!.id &&
        e.reason === `11eNexus event:${operationId}` &&
        e.targetId &&
        channels.get(e.targetId)?.type === ChannelType.GuildCategory &&
        names.includes(channels.get(e.targetId)?.name || ''),
    );
    if (matches.size > 1) throw new DomainError('e.ambiguous');
    return matches.first()?.targetId || null;
  }
  async recoverRole(event: CommunityEvent, operationId: string): Promise<string | null> {
    const guild = await this.gateway.guild();
    const [logs, roles] = await Promise.all([
      guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 100 }),
      guild.roles.fetch(),
    ]);
    const matches = logs.entries.filter(
      (e) =>
        e.executorId === this.gateway.client.user!.id &&
        e.reason === `11eNexus event:${operationId}` &&
        e.targetId &&
        roles.get(e.targetId)?.name === eventRoleName(event),
    );
    if (matches.size > 1) throw new DomainError('e.ambiguous');
    return matches.first()?.targetId || null;
  }
  private overwrites(hidden: boolean): OverwriteResolvable[] {
    const { guildId, memberRoleId, adminRoleId } = this.gateway.config;
    return [
      { id: guildId, deny: [P.ViewChannel, P.SendMessages] },
      {
        id: memberRoleId,
        ...(hidden
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
        id: adminRoleId,
        allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels],
      },
      {
        id: this.gateway.client.user!.id,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.ManageChannels,
          P.ManageRoles,
          P.PinMessages,
        ],
      },
    ];
  }
  async inspect(): Promise<EventWorld> {
    const guild = await this.gateway.guild();
    const [channels, roles, me, onboarding] = await Promise.all([
      guild.channels.fetch(),
      guild.roles.fetch(),
      guild.members.fetchMe(),
      guild.fetchOnboarding(),
    ]);
    const allowed = [this.gateway.config.adminRoleId, me.id];
    return {
      complete: true,
      channels: [...channels.values()]
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentId: c.parentId,
          topic: 'topic' in c ? c.topic : null,
          lastMessageId: 'lastMessageId' in c ? c.lastMessageId : null,
          requiresTag: 'availableTags' in c && c.flags.has(ChannelFlagsBitField.Flags.RequireTag),
          tags:
            'availableTags' in c
              ? c.availableTags.map((tag) => ({ id: tag.id, name: tag.name }))
              : undefined,
          editable: Boolean(c.permissionsFor(me)?.has([P.ManageChannels, P.ManageRoles])),
          hidden:
            !c.permissionsFor(this.gateway.config.memberRoleId)?.has(P.ViewChannel) &&
            c.permissionOverwrites.cache.every(
              (o) => allowed.includes(o.id) || !o.allow.has(P.ViewChannel),
            ),
          permissions: JSON.stringify(
            [...c.permissionOverwrites.cache.values()]
              .map((o) => ({
                id: o.id,
                type: o.type,
                allow: o.allow.bitfield.toString(),
                deny: o.deny.bitfield.toString(),
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          ),
        })),
      roles: [...roles.values()].map((r) => ({
        id: r.id,
        name: r.name,
        members: [],
        managed: r.managed,
        permissions: r.permissions.bitfield.toString(),
        mentionable: r.mentionable,
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
    };
  }
  async createCategory(archived: boolean, operationId: string): Promise<string> {
    const guild = await this.gateway.guild();
    const channels = await guild.channels.fetch();
    if (channels.size >= 500) throw new DomainError('capacity');
    const category = await guild.channels.create({
      name: archived ? EVENT_ARCHIVE_CATEGORY_NAME : EVENT_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      permissionOverwrites: this.overwrites(true),
      reason: `11eNexus event:${operationId}`,
    });
    return category.id;
  }
  private async text(id: string | null): Promise<TextChannel> {
    if (!id) throw new DomainError('notFound');
    const channel = await (await this.gateway.guild()).channels.fetch(id);
    if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement)
      throw new DomainError('e.channelMissing');
    return channel as TextChannel;
  }
  async createChannel(
    event: CommunityEvent,
    parentId: string,
    operationId: string,
  ): Promise<string> {
    const guild = await this.gateway.guild();
    const channels = await guild.channels.fetch();
    if (
      channels.get(parentId)?.type !== ChannelType.GuildCategory ||
      channels.filter((c) => c?.parentId === parentId).size >= 50 ||
      channels.size >= 500
    )
      throw new DomainError('capacity');
    const channel = await guild.channels.create({
      name: channelName(event.name),
      type: ChannelType.GuildText,
      parent: parentId,
      topic: `11eNexus:event:${event.id}`,
      permissionOverwrites: this.overwrites(false),
      reason: `11eNexus event:${operationId}`,
    });
    return channel.id;
  }
  async createRole(event: CommunityEvent, operationId: string): Promise<string> {
    const role = await (
      await this.gateway.guild()
    ).roles.create({
      name: eventRoleName(event),
      permissions: 0n,
      mentionable: true,
      hoist: false,
      reason: `11eNexus event:${operationId}`,
    });
    return role.id;
  }
  async publish(event: CommunityEvent): Promise<string> {
    const message = await (
      await this.text(event.channelId)
    ).send({
      ...eventMessage(event),
      nonce: createHash('sha256').update(`event:${event.id}`).digest('hex').slice(0, 25),
      enforceNonce: true,
    });
    return message.id;
  }
  async findMessage(event: CommunityEvent, announcement: boolean): Promise<string | null> {
    if (announcement) {
      const source = await (
        await this.gateway.guild()
      ).channels.fetch(event.announcementChannelId!);
      if (source?.type === ChannelType.GuildForum || source?.type === ChannelType.GuildMedia) {
        const [active, archived] = await Promise.all([
          source.threads.fetchActive(),
          source.threads.fetchArchived({ limit: 100, type: 'public' }),
        ]);
        const candidates = [...new Map([...active.threads, ...archived.threads]).values()]
          .filter(
            (thread) =>
              thread.ownerId === this.gateway.client.user!.id &&
              thread.createdTimestamp! >= event.createdAt,
          )
          .slice(0, 100);
        const ids: string[] = [];
        for (const thread of candidates) {
          const message = await thread.fetchStarterMessage();
          if (
            message &&
            JSON.stringify(message.components).includes(
              `https://discord.com/channels/${this.gateway.config.guildId}/${event.channelId}`,
            )
          )
            ids.push(thread.id);
        }
        if (ids.length > 1) throw new DomainError('e.ambiguous');
        return ids[0] || null;
      }
    }
    const channel = await this.text(announcement ? event.announcementChannelId : event.channelId);
    const messages = await channel.messages.fetch({ limit: 100 });
    const needle = announcement
      ? `https://discord.com/channels/${this.gateway.config.guildId}/${event.channelId}`
      : `ne:subscribe:${event.id}`;
    const matches = messages.filter(
      (m) =>
        m.author.id === this.gateway.client.user!.id &&
        m.createdTimestamp >= event.createdAt &&
        JSON.stringify(m.components).includes(needle),
    );
    if (matches.size > 1) throw new DomainError('e.ambiguous');
    return matches.first()?.id || null;
  }
  async pin(event: CommunityEvent): Promise<void> {
    if (!event.messageId) throw new DomainError('notFound');
    const message = await (await this.text(event.channelId)).messages.fetch(event.messageId);
    if (!message.pinned) await message.pin('11eNexus event notifications');
  }
  async messageStatus(event: CommunityEvent): Promise<'present' | 'missing' | 'unpinned'> {
    if (!event.messageId) return 'missing';
    try {
      const message = await (await this.text(event.channelId)).messages.fetch(event.messageId);
      return message.pinned ? 'present' : 'unpinned';
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 10008)
        return 'missing';
      throw error;
    }
  }
  async updateMessage(event: CommunityEvent): Promise<void> {
    if (!event.messageId) return;
    try {
      const message = await (await this.text(event.channelId)).messages.fetch(event.messageId);
      await message.edit({ ...eventMessage(event), content: null, embeds: [] });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10008)
        throw error;
      // A moderator's deletion is preserved; state checks also disable old buttons server-side.
    }
  }
  async announce(event: CommunityEvent): Promise<string> {
    const channel = await (await this.gateway.guild()).channels.fetch(event.announcementChannelId!);
    if (!channel) throw new DomainError('e.channelMissing');
    if (channel.parentId !== this.gateway.config.activeCategoryId)
      throw new DomainError('staleAction');
    if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
      if (channel.flags.has(ChannelFlagsBitField.Flags.RequireTag) && !event.announcementTagId)
        throw new DomainError('e.tagRequired');
      return (
        await channel.threads.create({
          name: event.name,
          message: eventAnnouncement(event, this.gateway.config.guildId),
          appliedTags: event.announcementTagId ? [event.announcementTagId] : [],
          reason: '11eNexus event announcement',
        })
      ).id;
    }
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
      throw new DomainError('e.channelMissing');
    return (
      await channel.send({
        ...eventAnnouncement(event, this.gateway.config.guildId),
        nonce: createHash('sha256')
          .update(`event-announcement:${event.id}`)
          .digest('hex')
          .slice(0, 25),
        enforceNonce: true,
      })
    ).id;
  }
  async hide(event: CommunityEvent, operationId: string): Promise<void> {
    await (
      await this.text(event.channelId)
    ).permissionOverwrites.set(this.overwrites(true), `11eNexus event:${operationId}`);
  }
  async archive(event: CommunityEvent, parentId: string, operationId: string): Promise<void> {
    const channel = await this.text(event.channelId);
    const channels = await (await this.gateway.guild()).channels.fetch();
    if (channels.get(parentId)?.type !== ChannelType.GuildCategory)
      throw new DomainError('e.categoriesMissing');
    if (
      channel.parentId !== parentId &&
      channels.filter((c) => c?.parentId === parentId).size >= 50
    )
      throw new DomainError('e.archiveFull');
    await channel.setParent(parentId, {
      lockPermissions: false,
      reason: `11eNexus event:${operationId}`,
    });
  }
  async deleteRole(roleId: string, operationId: string): Promise<void> {
    const guild = await this.gateway.guild();
    const [role, me, channels, onboarding] = await Promise.all([
      guild.roles.fetch(roleId, { force: true }),
      guild.members.fetchMe(),
      guild.channels.fetch(),
      guild.fetchOnboarding(),
    ]);
    if (!role) return;
    if (
      role.managed ||
      role.permissions.bitfield !== 0n ||
      me.roles.highest.comparePositionTo(role) <= 0 ||
      channels.some((c) => c?.permissionOverwrites.cache.has(roleId)) ||
      onboarding.prompts.some((p) => p.options.some((o) => o.roles.has(roleId)))
    )
      throw new DomainError('needsReview');
    await role.delete(`11eNexus event:${operationId}`);
  }
  async deleteChannel(
    channelId: string,
    operationId: string,
    expected: EventWorld['channels'][number],
  ): Promise<void> {
    const channel = await this.text(channelId);
    const permissions = JSON.stringify(
      [...channel.permissionOverwrites.cache.values()]
        .map((o) => ({
          id: o.id,
          type: o.type,
          allow: o.allow.bitfield.toString(),
          deny: o.deny.bitfield.toString(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    if (
      channel.parentId !== expected.parentId ||
      channel.name !== expected.name ||
      channel.lastMessageId !== expected.lastMessageId ||
      permissions !== expected.permissions
    )
      throw new DomainError('staleAction');
    await channel.delete(`11eNexus event cleanup:${operationId}`);
  }
  async edit(event: CommunityEvent, operationId: string): Promise<void> {
    const channel = await this.text(event.channelId);
    if (channel.name !== channelName(event.name))
      await channel.setName(channelName(event.name), `11eNexus event:${operationId}`);
    if (event.roleId) {
      const role = await (await this.gateway.guild()).roles.fetch(event.roleId, { force: true });
      if (!role?.editable || role.managed || role.permissions.bitfield !== 0n)
        throw new DomainError('e.roleMissing');
      if (role.name !== eventRoleName(event))
        await role.setName(eventRoleName(event), `11eNexus event:${operationId}`);
    }
  }
  async layout(
    activeId: string,
    archiveId: string,
    active: boolean,
    knownChannels: string[],
  ): Promise<void> {
    const guild = await this.gateway.guild();
    const channels = await guild.channels.fetch();
    const category = channels.get(activeId),
      archive = channels.get(archiveId),
      games = channels.get(this.gateway.config.activeCategoryId);
    if (
      category?.type !== ChannelType.GuildCategory ||
      archive?.type !== ChannelType.GuildCategory ||
      games?.type !== ChannelType.GuildCategory
    )
      throw new DomainError('e.categoriesMissing');
    const children = channels.filter((c) => c?.parentId === activeId);
    if (!active && children.some((c) => c && !knownChannels.includes(c.id)))
      throw new DomainError('needsReview');
    if (!active) {
      const world = await this.inspect();
      if (children.some((c) => c && !world.channels.find((o) => o.id === c.id)?.hidden))
        throw new DomainError('needsReview');
    }
    if (LEGACY_EVENT_CATEGORY_NAMES.includes(category.name))
      await category.setName(EVENT_CATEGORY_NAME, '11eNexus: align event category style');
    await category.permissionOverwrites.set(
      this.overwrites(!active),
      '11eNexus event category visibility',
    );
    const ordered = [...channels.values()]
      .filter((c) => c?.type === ChannelType.GuildCategory && c.id !== activeId)
      .sort((a, b) => a!.rawPosition - b!.rawPosition || a!.id.localeCompare(b!.id));
    const anchor = active ? games.id : archive.id;
    let position = ordered.findIndex((c) => c!.id === anchor);
    if (!active) position++;
    ordered.splice(position, 0, category);
    const current = [...channels.values()]
      .filter((c) => c?.type === ChannelType.GuildCategory)
      .sort((a, b) => a!.rawPosition - b!.rawPosition || a!.id.localeCompare(b!.id));
    if (current.some((c, i) => c!.id !== ordered[i]!.id))
      await guild.channels.setPositions(ordered.map((c, i) => ({ channel: c!.id, position: i })));
    const positions = activeChannelPositions(
      [...channels.values()].filter((c): c is NonNullable<typeof c> => c !== null),
      activeId,
    );
    if (positions.length) await guild.channels.setPositions(positions);
  }
  async sortChannels(activeId: string): Promise<void> {
    const guild = await this.gateway.guild();
    const channels = await guild.channels.fetch();
    if (channels.get(activeId)?.type !== ChannelType.GuildCategory)
      throw new DomainError('e.categoriesMissing');
    const positions = activeChannelPositions(
      [...channels.values()].filter((c): c is NonNullable<typeof c> => c !== null),
      activeId,
    );
    if (positions.length) await guild.channels.setPositions(positions);
  }
  subscribed(roleId: string, userId: string): Promise<boolean> {
    return this.gateway.subscription(roleId, userId);
  }
  subscribe(roleId: string, userId: string, enabled: boolean): Promise<void> {
    return this.gateway.setSubscription(roleId, userId, enabled);
  }
}
