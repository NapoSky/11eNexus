import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Events } from 'discord.js';
import { bootstrap } from './bootstrap.js';
import { DomainError } from './domain/model.js';
import { languagesReady } from './presentation/i18n.js';

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
  const health = (ready: boolean) => {
    mkdirSync(dirname(settings.healthPath), { recursive: true });
    const temporary = `${settings.healthPath}.${owner}`;
    writeFileSync(temporary, JSON.stringify({ ready, at: Date.now(), lastSync }), { mode: 0o600 });
    renameSync(temporary, settings.healthPath);
  };
  const heartbeat = setInterval(() => {
    if (!repository.acquireLease(owner, Date.now())) {
      console.error(JSON.stringify({ level: 'error', event: 'lease_lost' }));
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
  process.once('uncaughtException', () => {
    console.error(JSON.stringify({ level: 'error', event: 'uncaught_exception' }));
    void stop(1);
  });
  process.once('unhandledRejection', () => {
    console.error(JSON.stringify({ level: 'error', event: 'unhandled_rejection' }));
    void stop(1);
  });
  app.controller.listen();
  app.gateway.onActivity((id, at) => app.nexus.recordActivity(id, at));
  const synchronize = async () => {
    if (busy || stopping || !client.isReady()) return;
    busy = true;
    try {
      await app.nexus.synchronize();
      repository.maintain(Date.now());
      lastSync = Date.now();
      health(true);
      console.info(
        JSON.stringify({ level: 'info', event: 'reconciled', games: repository.games().length }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'reconciliation_failed',
          code: error instanceof DomainError ? error.code : 'discordError',
        }),
      );
      health(false);
    } finally {
      busy = false;
    }
  };
  client.once(Events.ClientReady, () => {
    console.info(JSON.stringify({ level: 'info', event: 'ready', bot: '11eNexus' }));
    const run = () => {
      if (!busy && !stopping) syncing = synchronize();
    };
    run();
    scheduler = setInterval(run, settings.intervalSeconds * 1000);
  });
  client.on(Events.Error, () =>
    console.error(JSON.stringify({ level: 'error', event: 'discord_client_error' })),
  );
  health(false);
  try {
    await client.login(settings.token);
  } catch {
    await stop(1);
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'startup_failed',
      message:
        error instanceof Error && /^(Missing|Invalid) configuration:/.test(error.message)
          ? error.message
          : 'Check configuration, database and instance lease.',
    }),
  );
  process.exitCode = 1;
});
