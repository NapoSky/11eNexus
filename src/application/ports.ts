import type { Actor, Asset, Candidate, Game, Operation, Proposal } from '../domain/model.js';
import type { CommunityEvent, EventOperation } from '../domain/community-event.js';
export interface Session {
  id: string;
  userId: string;
  kind: string;
  data: Record<string, unknown>;
  expiresAt: number;
}
export interface Repository {
  events(): CommunityEvent[];
  event(id: string): CommunityEvent | undefined;
  saveEvent(event: CommunityEvent): void;
  eventOperations(): EventOperation[];
  saveEventOperation(operation: EventOperation): void;
  transaction<T>(task: () => T): T;
  games(includeRetired?: boolean): Game[];
  game(id: string): Game | undefined;
  byRawg(id: number): Game | undefined;
  saveGame(game: Game): void;
  subscribers(gameId: string): string[];
  subscribed(gameId: string, userId: string): boolean;
  subscribe(gameId: string, userId: string, enabled: boolean): void;
  replaceSubscribers(gameId: string, userIds: string[]): void;
  asset(id: string): Asset | null;
  saveAsset(asset: Asset): void;
  cooldown(userId: string): number | null;
  setCooldown(userId: string, at: number): void;
  operations(): Operation[];
  saveOperation(operation: Operation): void;
  proposals(userId?: string): Proposal[];
  proposal(id: string): Proposal | undefined;
  saveProposal(proposal: Proposal): void;
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  session(id: string): Session | undefined;
  saveSession(session: Session): void;
  audit(action: string, actorId: string | null, target: string, at: number): void;
  maintain(now: number): void;
}
export interface RoleObservation {
  id: string;
  name: string;
  members: string[];
  managed: boolean;
  permissions: string;
  mentionable: boolean;
  references: string[];
  editable: boolean;
  position?: number;
}
export interface ChannelObservation {
  id: string;
  name: string;
  parentId: string | null;
  type: number;
  topic: string | null;
  permissions?: string;
  editable?: boolean;
}
export interface World {
  channels: ChannelObservation[];
  roles: RoleObservation[];
  memberIds: string[];
  complete: boolean;
  archiveCategoryIds: string[];
  roleIcons: boolean;
}
export interface Activity {
  at: number | null;
  complete: boolean;
}
export interface Community {
  authorize(actor: Actor): Promise<Actor>;
  snapshot(signal?: AbortSignal): Promise<World>;
  activity(game: Game, since: number, signal?: AbortSignal): Promise<Activity>;
  createChannel(game: Game, operationId: string): Promise<string>;
  createRole(game: Game, asset: Asset | null, operationId: string): Promise<string>;
  move(
    game: Game,
    archive: boolean,
    operationId: string,
    stillCurrent?: () => boolean,
  ): Promise<void>;
  repairResources(game: Game): Promise<void>;
  renameGame(game: Game, name: string, operationId: string): Promise<void>;
  setSubscription(
    roleId: string,
    memberId: string,
    enabled: boolean,
    selfService?: boolean,
  ): Promise<void>;
  subscription(roleId: string, memberId: string): Promise<boolean>;
  deleteRole(roleId: string, operationId: string): Promise<void>;
  notify(game: Game, actorId: string, message: string): Promise<void>;
  announceNewGame(game: Game): Promise<string>;
  alert(key: string, textKey: string, values?: Record<string, string | number>): Promise<void>;
}
export interface Catalogue {
  search(query: string): Promise<Candidate[]>;
  get(id: number): Promise<Candidate>;
  image(candidate: Candidate, signal?: AbortSignal): Promise<Asset | null>;
}
export interface Clock {
  now(): number;
}
export interface Scheduler {
  yield(): Promise<void>;
}
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private completed = 0;
  get revision(): number {
    return this.completed;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      this.completed++;
      release();
    }
  }
}
