import type { CommunityEvent } from '../domain/community-event.js';
import type { ChannelObservation, RoleObservation } from './ports.js';

export interface EventWorld {
  channels: (ChannelObservation & {
    lastMessageId?: string | null;
    hidden?: boolean;
    requiresTag?: boolean;
    tags?: { id: string; name: string }[];
  })[];
  roles: RoleObservation[];
  complete: boolean;
}
export interface EventCommunity {
  authorize(actorId: string, admin: boolean): Promise<void>;
  recoverCategory(archived: boolean, operationId: string): Promise<string | null>;
  recoverRole(event: CommunityEvent, operationId: string): Promise<string | null>;
  inspect(): Promise<EventWorld>;
  createCategory(archived: boolean, operationId: string): Promise<string>;
  createChannel(event: CommunityEvent, parentId: string, operationId: string): Promise<string>;
  createRole(event: CommunityEvent, operationId: string): Promise<string>;
  publish(event: CommunityEvent): Promise<string>;
  findMessage(event: CommunityEvent, announcement: boolean): Promise<string | null>;
  messageStatus(event: CommunityEvent): Promise<'present' | 'missing' | 'unpinned'>;
  pin(event: CommunityEvent): Promise<void>;
  updateMessage(event: CommunityEvent): Promise<void>;
  announce(event: CommunityEvent): Promise<string>;
  hide(event: CommunityEvent, operationId: string): Promise<void>;
  archive(event: CommunityEvent, parentId: string, operationId: string): Promise<void>;
  deleteRole(roleId: string, operationId: string): Promise<void>;
  deleteChannel(
    channelId: string,
    operationId: string,
    expected: EventWorld['channels'][number],
  ): Promise<void>;
  edit(event: CommunityEvent, operationId: string): Promise<void>;
  layout(
    activeId: string,
    archiveId: string,
    active: boolean,
    knownChannels: string[],
  ): Promise<void>;
  sortChannels(activeId: string): Promise<void>;
  subscribed(roleId: string, userId: string): Promise<boolean>;
  subscribe(roleId: string, userId: string, enabled: boolean): Promise<void>;
}
