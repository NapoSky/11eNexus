import { MessageFlags, type Interaction, type InteractionEditReplyOptions } from 'discord.js';
import { editView, type View } from './views.js';

interface ReplyState {
  token: symbol;
  expiresAt: number;
  abort: AbortController;
  writes: Promise<void>;
}
type ReplyInteraction = Interaction & {
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
};

/** One navigation generation and write queue across every controller of a personal message. */
export class Replies {
  private readonly states = new Map<string, ReplyState>();

  private key(i: Interaction): string | undefined {
    return 'message' in i && i.message?.flags.has(MessageFlags.Ephemeral)
      ? `${i.user.id}:${i.message.id}`
      : undefined;
  }

  invalidate(i: Interaction): void {
    const key = this.key(i);
    if (key) this.states.get(key)?.abort.abort();
  }

  begin(i: ReplyInteraction) {
    const now = Date.now();
    for (const [key, state] of this.states)
      if (state.expiresAt <= now) {
        state.abort.abort();
        this.states.delete(key);
      }
    let key = this.key(i);
    const existing = key ? this.states.get(key) : undefined;
    existing?.abort.abort();
    const token = Symbol(),
      abort = new AbortController();
    const state = existing || { token, abort, expiresAt: now, writes: Promise.resolve() };
    Object.assign(state, { token, abort, expiresAt: now + 15 * 60000 });
    if (key) this.states.set(key, state);
    const current = () => state.token === token && !abort.signal.aborted;
    const bind = (messageId?: string | null) => {
      if (!messageId || !current()) return;
      const target = `${i.user.id}:${messageId}`;
      const newer = this.states.get(target);
      if (newer && newer !== state) {
        abort.abort();
        return;
      }
      key = target;
      this.states.set(key, state);
    };
    return {
      signal: abort.signal,
      current,
      bind,
      write: (payload: View): Promise<void> => {
        const write = state.writes.then(async () => {
          if (!current()) return;
          const message = await i.editReply(editView(payload));
          // Public entrypoints acquire their personal message ID on the first edit.
          if (!key && message && typeof message === 'object' && 'id' in message)
            bind(String(message.id));
        });
        // Preserve ordering even when an older HTTP edit fails or is already in flight.
        state.writes = write.catch(() => {});
        return write;
      },
    };
  }
}
