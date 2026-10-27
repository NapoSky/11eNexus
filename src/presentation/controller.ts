import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import { resolve } from 'node:path';
import {
  DomainError,
  normalize,
  requireAdmin,
  requireMember,
  type Actor,
} from '../domain/model.js';
import type { Nexus } from '../application/nexus.js';
import type { Session } from '../application/ports.js';
import type { DiscordCommunity } from '../infrastructure/discord.js';
import { discordAttachment } from '../infrastructure/images.js';
import { commands } from './commands.js';
import { locale, translator } from './i18n.js';
import { ownedSession, session, Views, type Mode } from './views.js';

const string = (s: Session, key: string): string => {
  const value = s.data[key];
  if (typeof value !== 'string') throw new DomainError('invalidInput');
  return value;
};
export class Controller {
  readonly views: Views;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    readonly nexus: Nexus,
    readonly gateway: DiscordCommunity,
  ) {
    this.views = new Views(nexus.repository, gateway.config.guildId);
  }
  listen(): void {
    this.gateway.client.on(Events.InteractionCreate, (i) => {
      const task = this.handle(i).catch(() =>
        console.error(JSON.stringify({ level: 'error', event: 'interaction_handler_failed' })),
      );
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
  }
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  private actor(i: Interaction): Actor {
    if (i.guildId !== this.gateway.config.guildId || !i.member) throw new DomainError('forbidden');
    const roles =
      i.member instanceof GuildMember ? [...i.member.roles.cache.keys()] : i.member.roles;
    return {
      id: i.user.id,
      member: roles.includes(this.gateway.config.memberRoleId),
      admin: roles.includes(this.gateway.config.adminRoleId) || i.guild?.ownerId === i.user.id,
    };
  }
  private modal(
    id: string,
    title: string,
    fields: { id: string; label: string; value?: string; max?: number; paragraph?: boolean }[],
  ): ModalBuilder {
    const modal = new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45));
    for (const field of fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label.slice(0, 45))
        .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(field.max || 100);
      if (field.value) input.setValue(field.value.slice(0, field.max || 100));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
    return modal;
  }
  async installPanel(channelId?: string): Promise<void> {
    const channel = await this.gateway.panelChannel(channelId);
    await this.gateway.securePanel(channel);
    const fr = translator('fr');
    const en = translator('en');
    const embed = new EmbedBuilder()
      .setColor(0x557c5b)
      .setTitle('11eNexus')
      .setDescription(`${fr('panelIntro')}\n${en('panelIntro')}`)
      .setThumbnail('attachment://logo_nexus.png')
      .setImage('attachment://banner_nexus.png');
    const payload = {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('nx:games')
            .setLabel('Jeux / Games')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('nx:notifications')
            .setLabel('Notifications')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('nx:propose')
            .setLabel('Proposer / Suggest')
            .setStyle(ButtonStyle.Success),
        ),
      ],
      files: [
        new AttachmentBuilder(resolve('logo_nexus.png')),
        new AttachmentBuilder(resolve('banner_nexus.png')),
      ],
      allowedMentions: { parse: [] as [] },
    };
    const previous = this.nexus.repository.get<{ channelId: string; messageId: string }>('panel');
    if (previous && previous.channelId !== channel.id) {
      try {
        const oldChannel = await (await this.gateway.guild()).channels.fetch(previous.channelId);
        if (oldChannel && 'messages' in oldChannel) {
          const old = await oldChannel.messages.fetch(previous.messageId);
          if (old.author.id !== this.gateway.client.user!.id)
            throw new DomainError('configuration');
          await old.edit({
            content: `${fr('panelMoved')}\n${en('panelMoved')}\n<#${channel.id}>`,
            embeds: [],
            components: [],
            attachments: [],
            allowedMentions: { parse: [] },
          });
        }
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          ![10003, 10008].includes(Number(error.code))
        )
          throw error;
      }
    }
    let message: Message | undefined;
    if (previous?.channelId === channel.id) {
      try {
        const existing = await channel.messages.fetch(previous.messageId);
        if (existing.author.id !== this.gateway.client.user!.id)
          throw new DomainError('configuration');
        message = await existing.edit({ ...payload, attachments: [] });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10008)
          throw error;
      }
    }
    if (!message) message = await channel.send(payload);
    this.nexus.repository.set('panel', { channelId: channel.id, messageId: message.id });
    this.nexus.repository.set('panelChannel', channel.id);
  }
  async installCommands(): Promise<void> {
    await (await this.gateway.guild()).commands.set(commands());
  }
  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      try {
        const actor = this.actor(interaction);
        requireAdmin(actor);
        const focused = interaction.options.getFocused(true);
        const query = normalize(String(focused.value));
        const options =
          focused.name === 'proposal'
            ? this.nexus.repository
                .proposals()
                .filter((p) => p.status === 'pending' || p.status === 'needs_info')
                .map((p) => ({ name: p.name, value: p.id }))
            : this.nexus.repository.games().map((g) => ({ name: g.name, value: g.id }));
        await interaction.respond(
          options
            .filter((o) => normalize(o.name).includes(query))
            .slice(0, 25)
            .map((o) => ({ ...o, name: o.name.slice(0, 100) })),
        );
      } catch {
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isButton() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isModalSubmit()
    )
      return;
    const i = interaction;
    const language = locale(i.locale);
    const t = translator(language);
    try {
      let actor = this.actor(i);
      requireMember(actor);
      if (i.isChatInputCommand() && i.commandName === 'nexus-admin') requireAdmin(actor);
      const parts = ('customId' in i ? i.customId : '').split(':');
      if ('customId' in i && parts[0] !== 'nx' && parts[0] !== 'nxm') return;
      const action = parts[1] || '';
      const token = parts[2];
      let s: Session | undefined;
      if (token) s = ownedSession(this.nexus.repository, actor.id, token);
      if (i.isButton() && ['propose', 'search', 'manual', 'notify', 'amend'].includes(action)) {
        const data = s || session(this.nexus.repository, actor.id, 'entry', {});
        if (action === 'amend') {
          const p = this.nexus.repository.proposal(string(data, 'proposalId'));
          if (!p || p.actorId !== actor.id || p.status !== 'needs_info')
            throw new DomainError('forbidden');
          await i.showModal(
            this.modal(`nxm:amend:${data.id}`, t('amend'), [
              { id: 'name', label: t('query'), value: p.name },
              { id: 'url', label: t('officialUrl'), value: p.url, max: 500 },
            ]),
          );
          return;
        }
        if (action === 'manual') {
          await i.showModal(
            this.modal(`nxm:manual:${data.id}`, t('request'), [
              {
                id: 'name',
                label: t('query'),
                value:
                  typeof data.data.name === 'string'
                    ? data.data.name
                    : typeof data.data.query === 'string'
                      ? data.data.query
                      : undefined,
              },
              { id: 'url', label: t('officialUrl'), max: 500 },
            ]),
          );
          return;
        }
        if (action === 'notify') {
          if (data.kind !== 'game') throw new DomainError('invalidInput');
          await i.showModal(
            this.modal(`nxm:notify:${data.id}`, t('notify'), [
              { id: 'message', label: t('notificationText'), max: 1000, paragraph: true },
            ]),
          );
          return;
        }
        await i.showModal(
          this.modal(
            `nxm:${action === 'propose' ? 'catalogue' : 'search'}:${data.id}`,
            t('search'),
            [{ id: 'query', label: t('query') }],
          ),
        );
        return;
      }
      if (i.isButton() || i.isStringSelectMenu()) {
        if (s) await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
      } else await i.deferReply({ flags: MessageFlags.Ephemeral });
      // Fresh REST role observation for every state-changing operation after acknowledgement.
      if (
        i.isChatInputCommand() ||
        i.isModalSubmit() ||
        ['activate', 'create', 'subscribe', 'unsubscribe'].includes(action)
      ) {
        actor = await this.gateway.actor(i.user.id);
        requireMember(actor);
      }
      if (i.isChatInputCommand()) {
        if (i.commandName === 'nexus') {
          await i.editReply(this.views.browse(actor, language));
          return;
        }
        if (i.commandName === 'nexus-admin') {
          requireAdmin(actor);
          await this.admin(i, actor);
          return;
        }
        throw new DomainError('notFound');
      }
      if (i.isModalSubmit()) {
        if (!s) throw new DomainError('expired');
        if (action === 'amend') {
          const p = await this.nexus.amendProposal(
            actor,
            string(s, 'proposalId'),
            i.fields.getTextInputValue('name'),
            i.fields.getTextInputValue('url'),
          );
          await i.editReply({
            ...this.views.proposal(actor, language, p),
            content: t('requestUpdated'),
          });
          return;
        }
        if (action === 'manual') {
          const proposal = await this.nexus.propose(
            actor,
            i.fields.getTextInputValue('name'),
            i.fields.getTextInputValue('url'),
            language,
          );
          await i.editReply({
            ...this.views.proposal(actor, language, proposal),
            content: t('requestRecorded', { game: proposal.name }),
          });
          return;
        }
        if (action === 'notify') {
          await this.nexus.notify(
            actor,
            string(s, 'gameId'),
            i.fields.getTextInputValue('message'),
          );
          await i.editReply(
            this.views.game(actor, language, string(s, 'gameId'), t('notificationSent')),
          );
          return;
        }
        const query = i.fields.getTextInputValue('query').trim();
        if (action === 'search') {
          await i.editReply(this.views.browse(actor, language, 'all', 0, query));
          return;
        }
        if (action === 'catalogue') {
          const local = this.nexus.repository
            .games()
            .filter(
              (g) =>
                normalize(g.name) === normalize(query) ||
                g.aliases.some((a) => normalize(a) === normalize(query)),
            );
          if (local.length === 1) {
            await i.editReply(this.views.game(actor, language, local[0]!.id));
            return;
          }
          const key = `search:${actor.id}`;
          const recent = this.nexus.repository.get<number[]>(key) || [];
          const active = recent.filter((at) => at + 60000 > Date.now());
          if (active.length >= 5) throw new DomainError('searchLimited');
          this.nexus.repository.set(key, [...active, Date.now()]);
          try {
            const candidates = await this.nexus.catalogue.search(query);
            await i.editReply(this.views.candidates(actor, language, query, candidates));
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            await i.editReply(this.views.candidates(actor, language, query, [], t(error.code)));
          }
          return;
        }
        throw new DomainError('invalidInput');
      }
      if (!s) {
        if (action === 'games' || action === 'notifications')
          await i.editReply(
            this.views.browse(actor, language, action === 'games' ? 'active' : 'subscribed'),
          );
        else throw new DomainError('invalidInput');
        return;
      }
      if (i.isStringSelectMenu()) {
        const selected = i.values[0];
        if (!selected) throw new DomainError('invalidInput');
        if (action === 'filter' && ['active', 'archived', 'all', 'subscribed'].includes(selected)) {
          await i.editReply(this.views.browse(actor, language, selected as Mode));
          return;
        }
        if (action === 'game') {
          if (s.kind !== 'browse' || !(s.data.ids as string[]).includes(selected))
            throw new DomainError('invalidInput');
          await i.editReply(this.views.game(actor, language, selected));
          return;
        }
        if (action === 'candidate') {
          const id = Number(selected);
          if (s.kind !== 'candidates' || !(s.data.ids as number[]).includes(id))
            throw new DomainError('invalidInput');
          const existing = this.nexus.repository.byRawg(id);
          if (existing) {
            await i.editReply(this.views.game(actor, language, existing.id));
            return;
          }
          const candidate = await this.nexus.catalogue.get(id);
          const asset = await this.nexus.catalogue.image(candidate).catch(() => null);
          if (asset) this.nexus.repository.saveAsset(asset);
          await i.editReply(
            this.views.candidate(actor, language, candidate, asset?.id || null, string(s, 'query')),
          );
          return;
        }
        if (action === 'proposal') {
          if (!(s.data.ids as string[]).includes(selected)) throw new DomainError('invalidInput');
          const p = this.nexus.repository.proposal(selected);
          if (!p) throw new DomainError('notFound');
          await i.editReply(this.views.proposal(actor, language, p));
          return;
        }
        throw new DomainError('invalidInput');
      }
      if (action === 'results') {
        if (s.kind !== 'candidate') throw new DomainError('invalidInput');
        const query = string(s, 'query');
        await i.editReply(
          this.views.candidates(actor, language, query, await this.nexus.catalogue.search(query)),
        );
        return;
      }
      if (action === 'back') {
        await i.editReply(this.views.browse(actor, language));
        return;
      }
      if (action === 'requests' || action === 'admin') {
        if (action === 'admin') requireAdmin(actor);
        await i.editReply(this.views.proposals(actor, language, action === 'admin'));
        return;
      }
      if (action === 'next' || action === 'previous') {
        const page = Number(s.data.page) + (action === 'next' ? 1 : -1);
        if (s.kind === 'proposals') {
          await i.editReply(this.views.proposals(actor, language, s.data.admin === true, page));
          return;
        }
        if (s.kind !== 'browse') throw new DomainError('invalidInput');
        await i.editReply(
          this.views.browse(actor, language, s.data.mode as Mode, page, String(s.data.query || '')),
        );
        return;
      }
      if (action === 'create') {
        if (s.kind !== 'candidate') throw new DomainError('invalidInput');
        const game = await this.nexus.create(actor, Number(s.data.rawgId));
        await i.editReply(
          this.views.game(actor, language, game.id, t('created', { game: game.name })),
        );
        return;
      }
      if (s.kind !== 'game') throw new DomainError('invalidInput');
      const id = string(s, 'gameId');
      if (action === 'activate') {
        const game = await this.nexus.activate(actor, id);
        await i.editReply(
          this.views.game(actor, language, id, t('activated', { game: game.name })),
        );
        return;
      }
      if (action === 'subscribe' || action === 'unsubscribe') {
        await this.nexus.subscribe(actor, id, action === 'subscribe');
        await i.editReply(this.views.game(actor, language, id));
        return;
      }
      throw new DomainError('invalidInput');
    } catch (error) {
      const key = error instanceof DomainError ? error.code : 'unknownError';
      console.error(JSON.stringify({ level: 'warn', event: 'interaction_error', code: key }));
      const content = t(key, error instanceof DomainError ? error.values : {});
      try {
        if (i.deferred || i.replied)
          await i.editReply({ content, embeds: [], components: [], attachments: [] });
        else
          await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch {
        console.error(JSON.stringify({ level: 'warn', event: 'interaction_reply_expired' }));
      }
    }
  }
  private async admin(i: ChatInputCommandInteraction, actor: Actor): Promise<void> {
    const t = translator(locale(i.locale));
    const sub = i.options.getSubcommand();
    if (sub === 'setup') {
      await this.installPanel(i.options.getChannel('channel')?.id);
      await i.editReply(t('panelInstalled'));
      return;
    }
    if (sub === 'proposals') {
      await i.editReply(this.views.proposals(actor, locale(i.locale), true));
      return;
    }
    if (sub === 'status') {
      await i.editReply(
        t('adminStatus', {
          games: this.nexus.repository.games().length,
          pending: this.nexus.repository
            .proposals()
            .filter((p) => p.status === 'pending' || p.status === 'needs_info').length,
          operations: this.nexus.repository
            .operations()
            .filter((o) => o.status === 'pending' || o.status === 'review').length,
        }),
      );
      return;
    }
    if (sub === 'reconcile') {
      await this.nexus.synchronize();
      await i.editReply(t('saved'));
      return;
    }
    if (sub === 'reject' || sub === 'clarify') {
      await (
        sub === 'reject' ? this.nexus.reject.bind(this.nexus) : this.nexus.clarify.bind(this.nexus)
      )(actor, i.options.getString('proposal', true), i.options.getString('reason', true));
      await i.editReply(t('saved'));
      return;
    }
    if (sub === 'approve') {
      const p = this.nexus.repository.proposal(i.options.getString('proposal', true));
      if (!p) throw new DomainError('notFound');
      const parent = i.options.getString('parent');
      const attachment = i.options.getAttachment('icon');
      const asset = parent
        ? this.nexus.repository.asset(this.nexus.repository.game(parent)?.assetId || '')
        : attachment
          ? await discordAttachment(attachment.url)
          : null;
      if (!asset) throw new DomainError('invalidImage');
      const requester = await this.gateway.actor(p.actorId);
      const game = await this.nexus.approve(actor, requester, p.id, asset, parent || undefined);
      await i.editReply(this.views.game(actor, locale(i.locale), game.id));
      return;
    }
    const id = i.options.getString('game', true);
    if (sub === 'repair') {
      await this.nexus.repair(
        actor,
        id,
        i.options.getChannel('channel', true).id,
        i.options.getRole('role', true).id,
      );
      await i.editReply(t('saved'));
      return;
    }
    if (sub === 'edit')
      await this.nexus.edit(
        actor,
        id,
        i.options.getString('name', true),
        (i.options.getString('aliases') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (sub === 'retire') await this.nexus.retire(actor, id);
    else if (sub === 'block' || sub === 'unblock')
      await this.nexus.block(actor, id, sub === 'block');
    else throw new DomainError('invalidInput');
    await i.editReply(t('saved'));
  }
}
