import { resolve } from 'node:path';
export const NEXUS_GUILD_ID = '389372877818036236';
export interface Config {
  token: string;
  guildId: string;
  rawgKey: string;
  memberRoleId: string;
  adminRoleId: string;
  newGameRoleId: string;
  newGameChannelId: string;
  adminChannelId: string;
  activeCategoryId: string;
  panelChannelId?: string;
  databasePath: string;
  healthPath: string;
  intervalSeconds: number;
  maxGames: number;
  minActive: number;
  maxArchives: number;
  roleReserve: number;
  notificationCooldown: number;
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const id = (key: string, fallback?: string): string => {
    const value = env[key] || fallback;
    if (!value || !/^\d{17,20}$/.test(value)) throw new Error(`Invalid configuration: ${key}`);
    return value;
  };
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Invalid configuration: ${key}`);
    return value;
  };
  if (!env.BOT_TOKEN) throw new Error('Missing configuration: BOT_TOKEN');
  const result: Config = {
    token: env.BOT_TOKEN,
    guildId: id('GUILD_ID'),
    rawgKey: env.RAWG_API_KEY || '',
    memberRoleId: id('MEMBER_ROLE_ID', '948308796416098395'),
    adminRoleId: id('ADMIN_ROLE_ID', '1135603511627890750'),
    newGameRoleId: id('NEW_GAME_ROLE_ID', '1450484079228227674'),
    newGameChannelId: id('NEW_GAME_CHANNEL_ID', '389733957890998294'),
    adminChannelId: id('ADMIN_CHANNEL_ID', '1135602838542749756'),
    activeCategoryId: id('ACTIVE_CATEGORY_ID', '1163827775115890708'),
    panelChannelId: env.PANEL_CHANNEL_ID ? id('PANEL_CHANNEL_ID') : undefined,
    databasePath: resolve(env.DATABASE_PATH || './data/nexus.sqlite'),
    healthPath: resolve(env.HEALTH_PATH || './data/health.json'),
    intervalSeconds: number('RECONCILE_INTERVAL_SECONDS', 300, 60, 3600),
    maxGames: number('MAX_GAMES', 150, 1, 150),
    minActive: number('MIN_ACTIVE_GAMES', 15, 0, 150),
    maxArchives: number('MAX_ARCHIVE_CATEGORIES', 3, 1, 3),
    roleReserve: number('ROLE_RESERVE', 5, 0, 50),
    notificationCooldown: number('NOTIFICATION_COOLDOWN_SECONDS', 900, 60, 86400) * 1000,
  };
  if (result.guildId !== NEXUS_GUILD_ID) throw new Error('Invalid configuration: GUILD_ID');
  if (result.minActive > result.maxGames)
    throw new Error('Invalid configuration: MIN_ACTIVE_GAMES');
  if (result.memberRoleId === result.adminRoleId)
    throw new Error('Invalid configuration: ADMIN_ROLE_ID');
  if ([result.guildId, result.memberRoleId, result.adminRoleId].includes(result.newGameRoleId))
    throw new Error('Invalid configuration: NEW_GAME_ROLE_ID');
  return result;
}
