import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { Events } from 'discord.js';
import { bootstrap } from './bootstrap.js';
import { applyPlan, buildPlan, parseManifest, type ImportPlan } from './application/migration.js';
import { DomainError } from './domain/model.js';
import { languagesReady } from './presentation/i18n.js';
import { Store } from './infrastructure/store.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function output(path: string, data: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}
async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === 'help') {
    console.info(
      '11eNexus admin: doctor | inventory --output FILE | plan --manifest FILE --output FILE | apply --plan FILE --apply | setup [--channel ID] | backup --output FILE',
    );
    return;
  }
  if (command === 'backup') {
    const target = option('output');
    if (!target) throw new DomainError('invalidInput');
    const store = new Store(resolve(process.env.DATABASE_PATH || './data/nexus.sqlite'));
    try {
      await store.backup(resolve(target));
      console.info('SQLite backup completed.');
    } finally {
      store.close();
    }
    return;
  }
  await languagesReady;
  const app = bootstrap();
  const owner = randomUUID();
  const mutations = ['setup', 'apply'];
  let leased = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    // Read-only probes may coexist with runtime. Mutations may not.
    if (mutations.includes(command)) {
      leased = app.repository.acquireLease(owner, Date.now());
      if (!leased) throw new DomainError('inProgress');
      heartbeat = setInterval(() => {
        if (!app.repository.acquireLease(owner, Date.now())) {
          console.error('Database lease lost; stopping administrative process.');
          process.exit(1);
        }
      }, 10000);
    }
    await Promise.all([
      once(app.client, Events.ClientReady, { signal: AbortSignal.timeout(30000) }),
      app.client.login(app.settings.token),
    ]);
    if (command === 'doctor') {
      const world = await app.gateway.snapshot();
      console.info(
        JSON.stringify(
          {
            guildId: app.settings.guildId,
            complete: world.complete,
            roleIcons: world.roleIcons,
            roles: world.roles.length,
            channels: world.channels.length,
            rawgConfigured: Boolean(app.settings.rawgKey),
            uneditableOrdinaryRoles: world.roles.filter(
              (r) => !r.managed && !r.editable && r.permissions === '0',
            ).length,
            importedGames: app.repository.games().length,
            uneditableImportedRoles: app.repository
              .games()
              .filter((g) => !world.roles.find((r) => r.id === g.roleId)?.editable)
              .map((g) => g.name),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'inventory') {
      const target = option('output');
      if (!target) throw new DomainError('invalidInput');
      output(target, await app.gateway.snapshot());
      console.info('Inventory written; treat role assignments as private server data.');
      return;
    }
    if (command === 'plan') {
      const file = option('manifest');
      const target = option('output');
      if (!file || !target) throw new DomainError('invalidInput');
      const manifest = parseManifest(JSON.parse(readFileSync(file, 'utf8')));
      const plan = buildPlan(
        manifest,
        await app.gateway.snapshot(),
        app.repository,
        app.settings.maxGames,
        app.settings.activeCategoryId,
        app.settings.maxArchives,
      );
      output(target, plan);
      console.info(JSON.stringify({ changes: plan.changes, errors: plan.errors }, null, 2));
      if (plan.errors.length) process.exitCode = 1;
      return;
    }
    if (command === 'apply') {
      const file = option('plan');
      if (!file || !process.argv.includes('--apply')) throw new DomainError('invalidInput');
      const plan = JSON.parse(readFileSync(file, 'utf8')) as ImportPlan;
      await applyPlan(plan, app.repository, app.gateway);
      console.info(
        'Reviewed import applied. Run doctor and inspect Discord before starting the runtime.',
      );
      return;
    }
    if (command === 'setup') {
      await app.controller.installCommands();
      await app.controller.installPanel(option('channel'));
      console.info('Commands and bilingual panel installed.');
      return;
    }
    throw new DomainError('invalidInput');
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await app.client.destroy();
    if (leased) app.repository.releaseLease(owner);
    app.repository.close();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'admin_command_failed',
      code: error instanceof DomainError ? error.code : 'configuration_or_discord_error',
    }),
  );
  process.exitCode = 1;
});
