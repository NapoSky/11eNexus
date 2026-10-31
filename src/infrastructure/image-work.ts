import { DomainError } from '../domain/model.js';

/** Admit work before downloading, so queued requests do not retain full image buffers. */
export class ImageWork {
  private active = 0;
  private readonly waiting: { start(): void; cancel(): void }[] = [];
  constructor(
    private readonly concurrency = 2,
    private readonly maximumWaiting = 8,
  ) {}

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active >= this.concurrency && this.waiting.length >= this.maximumWaiting)
      return Promise.reject(new DomainError('imageBusy'));
    return new Promise<T>((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.active++;
          void Promise.resolve()
            .then(() => {
              signal?.throwIfAborted();
              return task();
            })
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.waiting.shift()?.start();
            });
        },
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', entry.cancel);
          reject(signal?.reason);
        },
      };
      if (this.active < this.concurrency) entry.start();
      else {
        this.waiting.push(entry);
        signal?.addEventListener('abort', entry.cancel, { once: true });
      }
    });
  }
}

export const imageWork = new ImageWork();
