import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Events } from 'discord.js';
import { bootstrap } from './bootstrap.js';
import { DomainError } from './domain/model.js';
import { languagesReady } from './presentation/i18n.js';
import { logger } from './infrastructure/logger.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ActiveChannelOrder } from './infrastructure/active-channel-order.js';
import { Shutdown } from './infrastructure/shutdown.js';
import { imageWork } from './infrastructure/image-work.js';
import { GuildRestriction } from './infrastructure/guild-restriction.js';

async function main(): Promise<void> {
  await languagesReady;
  const app = bootstrap();
  const owner = randomUUID();
  const { repository, settings, client } = app;
  const guildRestriction = new GuildRestriction(client);
  if (!repository.acquireLease(owner, Date.now()))
    throw new Error('Another instance owns this database');
  const backgroundReads = new AbortController();
  let lastSync = 0;
  let busy = false;
  let lastHealthLog = 0;
  let syncing: Promise<void> = Promise.resolve();
  const channelOrder = new ActiveChannelOrder(
    client,
    settings.guildId,
    settings.activeCategoryId,
    () =>
      app.nexus.mutex.run(async () => {
        if (!shutdown.stopping && client.isReady()) await app.gateway.sortActiveGameChannels();
      }),
  );
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  const eventOrder = new ActiveChannelOrder(
    client,
    settings.guildId,
    () => app.controller.events.categories().activeId,
    () =>
      app.nexus.mutex.run(async () => {
        const id = app.controller.events.categories().activeId;
        if (!shutdown.stopping && client.isReady() && id)
          await app.controller.events.community.sortChannels(id);
      }),
  );
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
    const ready =
      !shutdown.stopping &&
      client.isReady() &&
      lastSync > 0 &&
      Date.now() - lastSync < Math.max(settings.intervalSeconds * 3000, 15 * 60000);
    health(ready);
    if (Date.now() - lastHealthLog >= 60000) {
      lastHealthLog = Date.now();
      const memory = process.memoryUsage();
      logger.info({
        event: 'runtime_health',
        ready,
        reconciliationRunning: busy,
        lastReconciliationAgeSeconds: lastSync ? Math.round((Date.now() - lastSync) / 1000) : null,
        rssMiB: Math.round(memory.rss / 1048576),
        heapMiB: Math.round(memory.heapUsed / 1048576),
        externalMiB: Math.round(memory.external / 1048576),
        memoryLimitMiB: process.constrainedMemory()
          ? Math.round(process.constrainedMemory() / 1048576)
          : null,
        images: imageWork.stats(),
      });
    }
  }, 10000);
  let scheduler: ReturnType<typeof setInterval> | undefined;
  const shutdown = new Shutdown({
    stopIntake: () => {
      if (scheduler) clearInterval(scheduler);
      loopDelay.disable();
      app.controller.stopAccepting();
      guildRestriction.stopAccepting();
      stopActivity();
      backgroundReads.abort();
      try {
        health(false);
      } catch (err) {
        logger.error({ event: 'shutdown_health_failed', err });
      }
    },
    drain: () => [
      guildRestriction.drain(),
      channelOrder.stop(),
      eventOrder.stop(),
      syncing,
      app.controller.drain(),
    ],
    drainMutations: () => app.nexus.mutex.run(async () => {}),
    disconnect: () => client.destroy(),
    closeStorage: () => {
      clearInterval(heartbeat);
      repository.releaseLease(owner);
      repository.close();
    },
    exit: (code) => process.exit(code),
  });
  const stop = (code = 0) => shutdown.run(code);
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
  guildRestriction.listen();
  app.controller.listen();
  channelOrder.listen();
  eventOrder.listen();
  const stopActivity = app.gateway.onActivity((id, at) => app.nexus.recordActivity(id, at));
  const synchronize = async () => {
    if (busy || shutdown.stopping || !client.isReady()) return;
    void guildRestriction.enforce();
    busy = true;
    const startedAt = performance.now();
    logger.info({ event: 'reconciliation_started' });
    try {
      await app.nexus.maintain();
      await app.nexus.synchronize(true, undefined, undefined, undefined, backgroundReads.signal);
      if (shutdown.stopping) return;
      await app.controller.events.synchronize(backgroundReads.signal);
      if (shutdown.stopping) return;
      channelOrder.request();
      eventOrder.request();
      await app.nexus.deliverNewGameAnnouncements(backgroundReads.signal);
      if (shutdown.stopping) return;
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
      if (backgroundReads.signal.aborted && error === backgroundReads.signal.reason) {
        logger.info({ event: 'reconciliation_cancelled' });
        return;
      }
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
      if (!busy && !shutdown.stopping) syncing = synchronize();
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
