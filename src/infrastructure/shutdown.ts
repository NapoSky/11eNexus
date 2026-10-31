import { logger, type AppLogger } from './logger.js';

interface ShutdownSteps {
  stopIntake(): void;
  drain(): Promise<unknown>[];
  drainMutations(): Promise<void>;
  disconnect(): Promise<void>;
  closeStorage(): void;
  exit(code: number): void;
}

/** Keep Discord credentials and the database lease until accepted work has drained. */
export class Shutdown {
  private task?: Promise<void>;
  private code = 0;
  private started = false;

  constructor(
    private readonly steps: ShutdownSteps,
    private readonly log: AppLogger = logger,
    private readonly timeoutMs = 55000,
  ) {}

  get stopping(): boolean {
    return this.started;
  }

  run(code = 0): Promise<void> {
    this.code = Math.max(this.code, code);
    if (this.task) return this.task;
    this.started = true;
    this.task = this.finish();
    return this.task;
  }

  private async finish(): Promise<void> {
    const startedAt = performance.now();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.log.error({
        event: 'shutdown_timeout',
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      // Do not release a lease or close SQLite underneath unfinished mutations.
      this.steps.exit(1);
    }, this.timeoutMs);
    try {
      this.steps.stopIntake();
      this.log.info({ event: 'shutdown_started' });
      const drained = await Promise.allSettled(this.steps.drain());
      for (const result of drained)
        if (result.status === 'rejected') {
          this.code = 1;
          this.log.error({ event: 'shutdown_drain_failed', err: result.reason });
        }
      await this.steps.drainMutations();
      if (timedOut) return;
      await this.steps.disconnect();
      if (timedOut) return;
      this.steps.closeStorage();
      this.log.info({
        event: 'shutdown_completed',
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      this.code = 1;
      this.log.error({ event: 'shutdown_failed', err });
    } finally {
      clearTimeout(deadline);
      if (!timedOut) this.steps.exit(this.code);
    }
  }
}
