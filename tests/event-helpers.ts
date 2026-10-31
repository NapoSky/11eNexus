import { randomUUID } from 'node:crypto';
import type { EventCommunity, EventWorld } from '../src/application/event-ports.js';
import { EventService } from '../src/application/events.js';
import { type CommunityEvent, eventRoleName } from '../src/domain/community-event.js';
import { DomainError, type Actor } from '../src/domain/model.js';
import { activeId, admin, fixture, game, member } from './helpers.js';

export class FakeEvents implements EventCommunity {
  world: EventWorld = {
    channels: [
      { id: activeId, type: 4, name: 'Games', parentId: null, topic: null, editable: true },
    ],
    roles: [],
    complete: true,
  };
  actors = new Map<string, Actor>([
    [admin.id, admin],
    [member.id, member],
  ]);
  messages = new Map<string, string>();
  announcements = new Map<string, string>();
  subscriptions = new Map<string, Set<string>>();
  inspect = jest.fn(async () => structuredClone(this.world));
  authorize = jest.fn(async (id: string, isAdmin: boolean) => {
    const actor = this.actors.get(id);
    if (!actor || (isAdmin ? !actor.admin : !actor.admin && !actor.member))
      throw new DomainError('forbidden');
  });
  recoverCategory = jest.fn(async () => null as string | null);
  recoverRole = jest.fn(async () => null as string | null);
  createCategory = jest.fn(async (archived: boolean) => {
    const id = archived ? 'event-archive' : 'event-active';
    this.world.channels.push({
      id,
      type: 4,
      name: id,
      parentId: null,
      topic: null,
      editable: true,
      hidden: true,
    });
    return id;
  });
  createRole = jest.fn(async (event: CommunityEvent) => {
    const id = `role-${event.id}`;
    this.world.roles.push({
      id,
      name: eventRoleName(event),
      members: [],
      managed: false,
      permissions: '0',
      mentionable: true,
      references: [],
      editable: true,
    });
    return id;
  });
  createChannel = jest.fn(async (event: CommunityEvent, parentId: string) => {
    const id = `channel-${event.id}`;
    this.world.channels.push({
      id,
      name: event.name,
      type: 0,
      parentId,
      topic: `11eNexus:event:${event.id}`,
      editable: true,
      hidden: false,
    });
    return id;
  });
  publish = jest.fn(async (event: CommunityEvent) => {
    const id = `message-${event.id}`;
    this.messages.set(event.id, id);
    return id;
  });
  findMessage = jest.fn(
    async (event: CommunityEvent, announcement: boolean) =>
      (announcement ? this.announcements : this.messages).get(event.id) || null,
  );
  messageStatus = jest.fn(async () => 'present' as 'present' | 'missing' | 'unpinned');
  pin = jest.fn(async () => {});
  updateMessage = jest.fn(async () => {});
  announce = jest.fn(async (event: CommunityEvent) => {
    const id = `announcement-${event.id}`;
    this.announcements.set(event.id, id);
    return id;
  });
  hide = jest.fn(async (event: CommunityEvent) => {
    this.world.channels.find((c) => c.id === event.channelId)!.hidden = true;
  });
  archive = jest.fn(async (event: CommunityEvent, parentId: string) => {
    this.world.channels.find((c) => c.id === event.channelId)!.parentId = parentId;
  });
  deleteRole = jest.fn(async (id: string) => {
    this.world.roles = this.world.roles.filter((r) => r.id !== id);
  });
  deleteChannel = jest.fn(async (id: string) => {
    this.world.channels = this.world.channels.filter((c) => c.id !== id);
  });
  edit = jest.fn(async () => {});
  layout = jest.fn(async () => {});
  sortChannels = jest.fn(async () => {});
  subscribed = jest.fn(
    async (roleId: string, userId: string) => this.subscriptions.get(roleId)?.has(userId) || false,
  );
  subscribe = jest.fn(async (roleId: string, userId: string, enabled: boolean) => {
    const users = this.subscriptions.get(roleId) || new Set<string>();
    if (enabled) users.add(userId);
    else users.delete(userId);
    this.subscriptions.set(roleId, users);
  });
}
export function eventFixture() {
  const f = fixture();
  const community = new FakeEvents();
  const parent = f.add(game({ name: 'Project Zomboid' }));
  community.world.channels.push({
    id: parent.channelId!,
    name: parent.name,
    type: 0,
    parentId: activeId,
    topic: null,
    editable: true,
  });
  const events = new EventService(f.repository, community, f.nexus.mutex, activeId, 5, f.clock);
  const create = async (name = 'Campagne PZ') =>
    events.execute(
      admin,
      await events.plan(admin, {
        kind: 'create',
        draft: { gameId: parent.id, name, description: 'Une campagne ensemble.' },
      }),
    );
  const archived = (index: number): CommunityEvent => {
    const event: CommunityEvent = {
      id: randomUUID(),
      gameId: parent.id,
      gameName: parent.name,
      name: `Old ${index}`,
      description: 'Archive',
      state: 'archived',
      creatorId: admin.id,
      createdAt: index,
      closedAt: index,
      archivedAt: index,
      channelId: `old-${index}`,
      roleId: null,
      roleDeleted: true,
      messageId: null,
      announcementChannelId: null,
      announcementId: null,
      issue: null,
    };
    f.repository.saveEvent(event);
    community.world.channels.push({
      id: event.channelId!,
      name: event.name,
      type: 0,
      parentId: 'event-archive',
      topic: `11eNexus:event:${event.id}`,
      hidden: true,
      editable: true,
    });
    return event;
  };
  return { ...f, parent, eventCommunity: community, events, create, archived };
}
