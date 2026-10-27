import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { Events } from 'discord.js';
import { bootstrap } from './bootstrap.js';
import {
  applyPlan,
  buildPlan,
  parseManifest,
  prepareRoleIcons,
  type ImportPlan,
} from './application/migration.js';
import { DomainError } from './domain/model.js';
import { languagesReady } from './presentation/i18n.js';
import { Store } from './infrastructure/store.js';
import { Rawg } from './infrastructure/rawg.js';
import {
  prepareInventory,
  readInventory,
  enrichPreparation,
  LEGACY_ACTIVE,
  LEGACY_STANDBY,
} from './application/import-preparation.js';
import { renderImportReview, renderImportSummary } from './presentation/import-review.js';
import { adminDiagnostic } from './infrastructure/admin-diagnostics.js';
import { enableRoleMentions } from './application/role-mentions.js';

let stage = 'initialization';

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
      '11eNexus admin: doctor | inventory --output FILE | prepare --inventory FILE --output FILE [--rawg] [--locale fr|en] | plan --manifest FILE --output FILE | apply --plan FILE --apply | role-mentions [--apply] | setup [--channel ID] | backup --output FILE',
    );
    return;
  }
  if (command === 'prepare') {
    await languagesReady;
    const file = option('inventory') || 'data/inventory.json';
    const target = option('output') || 'data/import-preparation.json';
    if (!target.toLowerCase().endsWith('.json')) throw new DomainError('invalidInput');
    const language = option('locale') || 'fr';
    if (!['fr', 'en'].includes(language)) throw new DomainError('invalidInput');
    const preparation = prepareInventory(
      readInventory(JSON.parse(readFileSync(file, 'utf8'))),
      option('active-category') || LEGACY_ACTIVE,
      option('standby-category') || LEGACY_STANDBY,
    );
    if (process.argv.includes('--rawg')) {
      const store = new Store(resolve(process.env.DATABASE_PATH || './data/nexus.sqlite'));
      try {
        await enrichPreparation(preparation, new Rawg(process.env.RAWG_API_KEY || '', store));
      } finally {
        store.close();
      }
    }
    const base = target.replace(/\.json$/i, '');
    const html = `${base}.html`;
    const markdown = `${base}.md`;
    if (
      [target, html, markdown].some((path) => resolve(path) === resolve(file)) ||
      new Set([target, html, markdown].map((p) => resolve(p))).size !== 3
    )
      throw new DomainError('invalidInput');
    output(target, preparation);
    writeFileSync(html, renderImportReview(preparation, language as 'fr' | 'en'), { mode: 0o600 });
    writeFileSync(markdown, renderImportSummary(preparation, language as 'fr' | 'en'), {
      mode: 0o600,
    });
    console.info(
      JSON.stringify(
        {
          channels: preparation.channels.length,
          exact: preparation.channels.filter(
            (c) =>
              c.confidence === 'exact' &&
              !c.issues.some((i) =>
                ['duplicate', 'event', 'family', 'permissions', 'references'].includes(i),
              ),
          ).length,
          review: html,
          summary: markdown,
          draft: target,
          archiveCategoryIds: preparation.archiveCategoryIds,
          complete: preparation.complete,
          discordChanges: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'backup') {
    stage = 'backup';
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
  const mutation =
    ['setup', 'apply'].includes(command) ||
    (command === 'role-mentions' && process.argv.includes('--apply'));
  let leased = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    // Read-only probes may coexist with runtime. Mutations may not.
    if (mutation) {
      leased = app.repository.acquireLease(owner, Date.now());
      if (!leased) throw new DomainError('inProgress');
      heartbeat = setInterval(() => {
        if (!app.repository.acquireLease(owner, Date.now())) {
          console.error('Database lease lost; stopping administrative process.');
          process.exit(1);
        }
      }, 10000);
    }
    stage = 'discord_login';
    await Promise.all([
      once(app.client, Events.ClientReady, { signal: AbortSignal.timeout(30000) }),
      app.client.login(app.settings.token),
    ]);
    stage = command;
    if (command === 'role-mentions') {
      const report = await enableRoleMentions(
        app.repository,
        app.gateway,
        process.argv.includes('--apply'),
      );
      console.info(JSON.stringify(report, null, 2));
      if (report.errors.length) process.exitCode = 1;
      return;
    }
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
            unmentionableImportedRoles: app.repository
              .games()
              .filter((g) => world.roles.some((r) => r.id === g.roleId && !r.mentionable))
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
      stage = 'read_manifest';
      const contents = readFileSync(file, 'utf8');
      stage = 'parse_manifest';
      const parsed = JSON.parse(contents);
      stage = 'validate_manifest';
      const manifest = parseManifest(parsed);
      stage = 'discord_snapshot';
      const world = await app.gateway.snapshot();
      stage = 'build_plan';
      const initial = buildPlan(
        manifest,
        world,
        app.repository,
        app.settings.maxGames,
        app.settings.activeCategoryId,
        app.settings.maxArchives,
        app.settings.roleReserve,
      );
      stage = 'prepare_icons';
      const plan = await prepareRoleIcons(
        initial,
        app.repository,
        app.gateway,
        app.nexus.catalogue,
      );
      stage = 'write_plan';
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
      ...adminDiagnostic(error, stage),
    }),
  );
  process.exitCode = 1;
});
