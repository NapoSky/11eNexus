import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Events } from 'discord.js';
import { bootstrap } from './bootstrap.js';
import { DomainError } from './domain/model.js';
import { languagesReady } from './presentation/i18n.js';
import { logger } from './infrastructure/logger.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';

async function main(): Promise<void> {
  await languagesReady;
  const app = bootstrap();
  const owner = randomUUID();
  const { repository, settings, client } = app;
  if (!repository.acquireLease(owner, Date.now()))
    throw new Error('Another instance owns this database');
  let stopping = false;
  let lastSync = 0;
  let busy = false;
  let syncing: Promise<void> = Promise.resolve();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const health = (ready: boolean) => {
    mkdirSync(dirname(settings.healthPath), { recursive: true });
    const temporary = `${settings.healthPath}.${owner}`;
    writeFileSync(temporary, JSON.stringify({ ready, at: Date.now(), lastSync }), { mode: 0o600 });
    renameSync(temporary, settings.healthPath);
  };
  const heartbeat = setInterval(() => {
    const maxDelayMs = Math.round(loopDelay.max / 1e6);
    if (maxDelayMs >= 1000)
      logger.warn({ event: 'event_loop_blocked', maxDelayMs, reconciliationRunning: busy });
    loopDelay.reset();
    if (!repository.acquireLease(owner, Date.now())) {
      logger.error({ event: 'lease_lost' });
      void stop(1);
      return;
    }
    health(
      !stopping &&
        client.isReady() &&
        lastSync > 0 &&
        Date.now() - lastSync < Math.max(settings.intervalSeconds * 3000, 15 * 60000),
    );
  }, 10000);
  let scheduler: ReturnType<typeof setInterval> | undefined;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    if (scheduler) clearInterval(scheduler);
    loopDelay.disable();
    health(false);
    await client.destroy();
    await syncing;
    await app.controller.drain();
    await app.nexus.mutex.run(async () => {});
    clearInterval(heartbeat);
    repository.releaseLease(owner);
    repository.close();
    process.exit(code);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.once('uncaughtException', (err) => {
    logger.fatal({ event: 'uncaught_exception', err });
    void stop(1);
  });
  process.once('unhandledRejection', (err) => {
    logger.fatal({ event: 'unhandled_rejection', err });
    void stop(1);
  });
  app.controller.listen();
  app.gateway.onActivity((id, at) => app.nexus.recordActivity(id, at));
  const synchronize = async () => {
    if (busy || stopping || !client.isReady()) return;
    busy = true;
    const startedAt = performance.now();
    logger.info({ event: 'reconciliation_started' });
    try {
      await app.nexus.maintain();
      await app.nexus.synchronize();
      await app.nexus.deliverNewGameAnnouncements();
      lastSync = Date.now();
      health(true);
      const games = repository.games();
      logger.info({
        event: 'reconciled',
        elapsedMs: Math.round(performance.now() - startedAt),
        games: games.length,
        active: games.filter((g) => g.state === 'active').length,
        archived: games.filter((g) => g.state === 'archived').length,
        unavailable: games.filter((g) => g.state === 'unavailable').length,
      });
    } catch (error) {
      logger.error({
        event: 'reconciliation_failed',
        elapsedMs: Math.round(performance.now() - startedAt),
        code: error instanceof DomainError ? error.code : 'discordError',
        err: error,
      });
      health(false);
    } finally {
      busy = false;
    }
  };
  client.once(Events.ClientReady, () => {
    logger.info({ event: 'ready', bot: '11eNexus', instanceId: owner });
    const run = () => {
      if (!busy && !stopping) syncing = synchronize();
    };
    run();
    scheduler = setInterval(run, settings.intervalSeconds * 1000);
  });
  client.on(Events.Error, (err) => logger.error({ event: 'discord_client_error', err }));
  health(false);
  try {
    await client.login(settings.token);
  } catch (err) {
    logger.error({ event: 'discord_login_failed', err });
    await stop(1);
  }
}
main().catch((error) => {
  logger.error({
    event: 'startup_failed',
    err: error,
  });
  process.exitCode = 1;
});
