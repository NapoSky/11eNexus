import { config } from './infrastructure/config.js';
import { Store } from './infrastructure/store.js';
import { Rawg } from './infrastructure/rawg.js';
import { discordClient, DiscordCommunity } from './infrastructure/discord.js';
import { Nexus } from './application/nexus.js';
import { Controller } from './presentation/controller.js';
import { setImmediate } from 'node:timers/promises';
export function bootstrap() {
  const settings = config();
  const repository = new Store(settings.databasePath);
  const client = discordClient();
  const gateway = new DiscordCommunity(client, settings, repository);
  const catalogue = new Rawg(settings.rawgKey, repository);
  const nexus = new Nexus(
    repository,
    gateway,
    catalogue,
    {
      maxGames: settings.maxGames,
      minActive: settings.minActive,
      roleReserve: settings.roleReserve,
      activeCategoryId: settings.activeCategoryId,
      notificationCooldown: settings.notificationCooldown,
    },
    undefined,
    { yield: () => setImmediate() },
  );
  return {
    settings,
    repository,
    client,
    gateway,
    nexus,
    controller: new Controller(nexus, gateway),
  };
}
