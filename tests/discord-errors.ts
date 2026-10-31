import { createRequire } from 'node:module';

// Exercise the actual error emitted by the installed Discord.js version.
const { GatewayRateLimitError } = createRequire(require.resolve('discord.js'))(
  '@discordjs/util',
) as {
  GatewayRateLimitError: new (data: unknown, payload: unknown) => Error;
};
export function memberRateLimit(seconds = 23): Error {
  return new GatewayRateLimitError(
    {
      opcode: 8,
      retry_after: seconds,
      meta: { guild_id: '100000000000000000', nonce: 'private-nonce' },
    },
    {
      guild_id: '100000000000000000',
      query: 'private-member-query',
      limit: 0,
      token: 'private-token',
    },
  );
}
