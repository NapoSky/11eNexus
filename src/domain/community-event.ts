import { DomainError, normalize } from './model.js';

export interface CommunityEvent {
  id: string;
  gameId: string;
  gameName: string;
  name: string;
  description: string;
  state: 'creating' | 'active' | 'closed' | 'archived' | 'deleted';
  creatorId: string;
  createdAt: number;
  closedAt: number | null;
  archivedAt: number | null;
  channelId: string | null;
  roleId: string | null;
  roleDeleted: boolean;
  messageId: string | null;
  pinned?: boolean;
  announcementChannelId: string | null;
  announcementId: string | null;
  announcementTagId?: string;
  issue: string | null;
}
export interface EventCategories {
  activeId: string | null;
  archiveId: string | null;
}
export interface EventOperation {
  id: string;
  eventId: string;
  actorId: string;
  kind: 'create' | 'close' | 'edit' | 'repair';
  status: 'pending' | 'review' | 'completed';
  startedAt: number;
  completedAt: number | null;
  attempted: string[];
  cleanupId: string | null;
  cleanupRevision: string | null;
  cleaned: boolean;
}
export interface EventDraft {
  gameId: string;
  name: string;
  description: string;
  announcementTagId?: string;
}
export function validateEventDraft(draft: EventDraft): EventDraft {
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (!normalize(name) || name.length > 80 || !description || description.length > 1000)
    throw new DomainError('invalidInput');
  return {
    gameId: draft.gameId,
    name,
    description,
    ...(draft.announcementTagId ? { announcementTagId: draft.announcementTagId } : {}),
  };
}
export function eventRoleName(event: Pick<CommunityEvent, 'name'>): string {
  return `Event · ${event.name}`;
}
