const hints: Record<string, string> = {
  UnsupportedNodeVersion: 'Use Node.js 26 for development, tests and the runtime image.',
  EACCES: 'Check ownership and permissions: the container runs as UID 1000.',
  EPERM: 'Check ownership and permissions: the container runs as UID 1000.',
  ENOENT: 'Check the mounted manifest path and the database directory.',
  EISDIR: 'A file path points to a directory. Check the manifest mount.',
  EEXIST: 'A required directory path already exists as a file. Check the database mount.',
  EROFS: 'Check that the database and plan output mounts are writable.',
  ENOSPC: 'Free disk space on the host.',
  ENOTDIR: 'Check the mounted file and directory paths.',
  ERR_SQLITE_ERROR: 'Check database permissions, disk space and SQLite migration compatibility.',
  ERR_SQLITE_BUSY: 'Stop other processes using this SQLite database.',
  ENOTFOUND: 'Check container DNS resolution and outbound network access.',
  EAI_AGAIN: 'Check container DNS resolution and retry.',
  ECONNREFUSED: 'Check container outbound network access.',
  ECONNRESET: 'Check container outbound network access and retry.',
  ETIMEDOUT: 'Check container outbound network access and retry.',
  UND_ERR_CONNECT_TIMEOUT: 'Check container outbound network access and retry.',
  TokenInvalid: 'Check that BOT_TOKEN is the Discord bot token.',
  DisallowedIntents: 'Enable Server Members Intent for the bot in the Discord developer portal.',
  InvalidIntents: 'Check the bot gateway intents.',
  AbortError: 'The operation timed out or was aborted. Check Discord connectivity.',
  10004: 'Check GUILD_ID and that the bot belongs to this Discord server.',
  50001: 'The bot cannot access the Discord resource. Check server membership and permissions.',
  50013: 'Check bot permissions and its role position in Discord.',
  10062: 'The interaction expired before Discord acknowledged it. Open a fresh panel.',
  10015: 'The interaction webhook has expired. Open a fresh panel.',
  40060: 'The interaction was already acknowledged. Check for duplicate bot instances.',
  50027: 'The interaction webhook token is invalid or expired. Open a fresh panel.',
  50035: 'Discord rejected the response payload. Check component and message limits.',
  InteractionAlreadyReplied: 'This interaction was already acknowledged; do not reply twice.',
  ModalSubmitInteractionFieldNotFound:
    'A form field is missing. Reopen a fresh form and check modal component mapping.',
  ModalSubmitInteractionFieldType:
    'A form field has an unexpected component type. Check modal component mapping.',
  ModalSubmitInteractionFieldEmpty: 'A required form field is empty.',
  GuildMembersTimeout:
    'Discord member inventory timed out. Check Gateway connectivity and Server Members Intent.',
  GatewayRateLimitError:
    'Discord rate-limited a Gateway request. Use REST pagination for full member inventories and respect retryAfterSeconds.',
  InteractionNotReplied: 'The interaction must be acknowledged before editing its reply.',
  4004: 'Discord rejected authentication. Check BOT_TOKEN.',
  4014: 'Enable Server Members Intent for the bot in the Discord developer portal.',
};
const reasons: Record<string, string> = {
  'Used disallowed intents': 'DisallowedIntents',
  'Disallowed intents specified': 'DisallowedIntents',
  'An invalid token was provided.': 'TokenInvalid',
  'Migration checksum mismatch: 001': 'MigrationChecksumMismatch',
  'Migration checksum mismatch: 002': 'MigrationChecksumMismatch',
};
const stageHints: Record<string, string> = {
  read_manifest: 'Check that /work/import-manifest.json exists and is readable by UID 1000.',
  parse_manifest: 'Check that the manifest contains valid JSON.',
  write_plan: 'Check that the /work directory is writable by UID 1000.',
  discord_login: 'Check the bot token, Server Members Intent and container network access.',
};

// Never serialize raw errors: Discord requests can contain tokens, bodies and member data.
// Only recognized codes and fixed advice may leave this boundary, including nested causes.
export function adminDiagnostic(error: unknown, stage: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    stage,
    hint: stageHints[stage] || 'Check configuration, database access and Discord permissions.',
  };
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const item = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      data?: { opcode?: unknown; retry_after?: unknown };
    };
    if (item.name === 'GatewayRateLimitError') {
      if (
        typeof item.data?.opcode === 'number' &&
        Number.isInteger(item.data.opcode) &&
        item.data.opcode >= 0 &&
        item.data.opcode <= 255
      )
        result.gatewayOpcode = item.data.opcode;
      if (
        typeof item.data?.retry_after === 'number' &&
        Number.isFinite(item.data.retry_after) &&
        item.data.retry_after >= 0
      )
        result.retryAfterSeconds = item.data.retry_after;
    }
    if (typeof item.message === 'string') {
      const setting = /^(?:Missing|Invalid) configuration: ([A-Z][A-Z0-9_]{0,63})$/.exec(
        item.message,
      );
      if (setting) {
        // Config emits names only; do not return the raw message or any values.
        const allowed = new Set([
          'BOT_TOKEN',
          'GUILD_ID',
          'MEMBER_ROLE_ID',
          'ADMIN_ROLE_ID',
          'NEW_GAME_ROLE_ID',
          'NEW_GAME_CHANNEL_ID',
          'ADMIN_CHANNEL_ID',
          'ACTIVE_CATEGORY_ID',
          'PANEL_CHANNEL_ID',
          'RECONCILE_INTERVAL_SECONDS',
          'MAX_GAMES',
          'MIN_ACTIVE_GAMES',
          'MAX_ARCHIVE_CATEGORIES',
          'ROLE_RESERVE',
          'NOTIFICATION_COOLDOWN_SECONDS',
        ]);
        if (allowed.has(setting[1]!)) {
          result.setting = setting[1];
          result.hint = 'Correct this setting in the Compose .env file.';
        }
      }
      if (Object.hasOwn(reasons, item.message)) result.reason = reasons[item.message];
    }
    const code =
      typeof item.code === 'string' || typeof item.code === 'number'
        ? String(item.code)
        : typeof item.name === 'string'
          ? item.name
          : '';
    const recognized = Object.hasOwn(hints, code) ? code : result.reason;
    if (typeof recognized === 'string' && Object.hasOwn(hints, recognized)) {
      result.errorCode = recognized;
      result.hint = hints[recognized];
    }
    if (result.reason === 'MigrationChecksumMismatch')
      result.hint = 'Use the original applied migration; do not modify historical SQL migrations.';
    current = item.cause;
  }
  if (stage === 'parse_manifest' && error instanceof SyntaxError) result.errorCode = 'SyntaxError';
  return result;
}
