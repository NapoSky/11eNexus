import { config } from '../src/infrastructure/config.js';
const valid = { BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' };
test('agreed policy and roles are defaults, with RAWG failure allowed without a key', () => {
  expect(config(valid)).toMatchObject({
    maxGames: 150,
    minActive: 15,
    maxArchives: 3,
    memberRoleId: '948308796416098395',
    rawgKey: '',
  });
});
test.each([
  { MAX_GAMES: '151' },
  { MAX_ARCHIVE_CATEGORIES: '4' },
  { MAX_GAMES: '10' },
  { RECONCILE_INTERVAL_SECONDS: '0' },
  { GUILD_ID: 'invalid' },
  { ADMIN_ROLE_ID: '948308796416098395' },
])('invalid policy is rejected at startup: %p', (override) => {
  expect(() => config({ ...valid, ...override })).toThrow('Invalid configuration');
});
test('missing bot token is rejected without including any secret in the error', () => {
  expect(() => config({ GUILD_ID: valid.GUILD_ID })).toThrow('Missing configuration: BOT_TOKEN');
});
