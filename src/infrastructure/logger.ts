import pino, { type DestinationStream, type Logger } from 'pino';
import pretty from 'pino-pretty';
import { adminDiagnostic } from './admin-diagnostics.js';

const levels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'DomainError',
  'DiscordAPIError',
  'HTTPError',
  'AbortError',
  'TimeoutError',
  'GatewayRateLimitError',
  'ValidationError',
  'CombinedError',
]);
const validationFields = new Set([
  'components',
  'component',
  'accessory',
  'custom_id',
  'content',
  'label',
  'description',
  'type',
  'style',
  'options',
  'value',
  'values',
  'url',
  'emoji',
  'media',
  'items',
  'embeds',
  'attachments',
  'files',
  'flags',
  'required',
  'min_values',
  'max_values',
  'min_length',
  'max_length',
]);
const validationCodes = new Set([
  'COMPONENT_CUSTOM_ID_DUPLICATED',
  'COMPONENT_TOTAL_COMPONENT_COUNT_EXCEEDED',
  'BASE_TYPE_REQUIRED',
  'BASE_TYPE_BAD_LENGTH',
  'BASE_TYPE_MAX_LENGTH',
  'BASE_TYPE_MIN_LENGTH',
  'BASE_TYPE_CHOICES',
  'BASE_TYPE_INVALID',
  'STRING_TOO_LONG',
  'STRING_TOO_SHORT',
  'NUMBER_TYPE_COERCE',
]);
const sdkCodes = new Set([
  'ModalSubmitInteractionFieldNotFound',
  'ModalSubmitInteractionFieldType',
  'ModalSubmitInteractionFieldEmpty',
  'ModalSubmitInteractionComponentInvalidChannelType',
  'GuildMembersTimeout',
  'InteractionNotReplied',
  'InteractionAlreadyReplied',
  'ClientNotReady',
]);
function validationIssues(value: unknown): { path: string; code: string }[] {
  const issues: { path: string; code: string }[] = [],
    visited = new Set<unknown>();
  const walk = (node: unknown, path: string[], depth: number) => {
    if (!node || typeof node !== 'object' || depth > 12 || visited.has(node) || issues.length >= 12)
      return;
    visited.add(node);
    const item = node as Record<string, unknown>;
    if (Array.isArray(item._errors))
      for (const error of item._errors.slice(0, 12)) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (typeof code === 'string' && validationCodes.has(code))
          issues.push({ path: path.join('.'), code });
      }
    for (const key of Object.keys(item))
      if (validationFields.has(key) || /^\d{1,4}$/.test(key))
        walk(item[key], [...path, key], depth + 1);
  };
  walk(value, [], 0);
  return issues.slice(0, 12);
}
export function safeError(error: unknown): Record<string, unknown> {
  const result = adminDiagnostic(error, 'runtime');
  delete result.stage;
  if (!error || typeof error !== 'object') return result;
  const item = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    stack?: unknown;
    message?: unknown;
    rawError?: { errors?: unknown };
    constructor?: { name?: unknown };
  };
  const type = typeof item.name === 'string' ? item.name.replace(/\[\d+\]$/, '') : 'Error';
  result.type = errorTypes.has(type) ? type : 'Error';
  if (typeof item.code === 'number' && Number.isSafeInteger(item.code) && item.code >= 0)
    result.code = item.code;
  else if (typeof item.code === 'string' && /^\d{1,7}$/.test(item.code))
    result.code = Number(item.code);
  if (
    typeof item.status === 'number' &&
    Number.isInteger(item.status) &&
    item.status >= 100 &&
    item.status <= 599
  )
    result.status = item.status;
  if (typeof item.code === 'string' && sdkCodes.has(item.code)) result.libraryCode = item.code;
  const issues = validationIssues(item.rawError?.errors);
  if (issues.length) result.validation = issues;
  if (
    typeof item.constructor?.name === 'string' &&
    [
      'CombinedPropertyError',
      'CombinedError',
      'ExpectedConstraintError',
      'ValidationError',
    ].includes(item.constructor.name)
  )
    result.validationType = item.constructor.name;
  // Keep project source locations, never the error message, request URL, body or interaction token.
  if (
    typeof item.stack === 'string' &&
    typeof item.message === 'string' &&
    typeof item.name === 'string'
  ) {
    const heading = `${item.name}: ${item.message}`;
    if (item.stack.startsWith(heading)) {
      const locations = item.stack
        .slice(heading.length)
        .match(
          /(?:dist|src)\/(?:main|cli|bootstrap|(?:application|domain|infrastructure|presentation)\/[a-z-]+)\.[jt]s:\d+:\d+/g,
        );
      if (locations?.length) result.locations = [...new Set(locations)].slice(0, 8);
    }
  }
  return result;
}

export function createLogger(
  options: { level?: string; format?: string } = {},
  destination?: DestinationStream,
): Logger {
  const requested = options.level || process.env.LOG_LEVEL || 'info';
  const output =
    destination ||
    ((options.format || process.env.LOG_FORMAT) === 'pretty'
      ? pretty({
          destination: 2,
          colorize: false,
          singleLine: true,
          messageKey: 'event',
          translateTime: 'SYS:standard',
          sync: true,
        })
      : pino.destination({ dest: 2, sync: true }));
  return pino(
    {
      name: '11eNexus',
      level: levels.has(requested) ? requested : 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: { err: safeError, error: safeError },
      // Pino otherwise copies err.message into msg before calling the safe serializer.
      hooks: {
        logMethod(args, method) {
          const first = args[0];
          if (
            args.length === 1 &&
            first &&
            typeof first === 'object' &&
            (first instanceof Error || 'err' in first)
          ) {
            const event =
              'event' in first && typeof first.event === 'string' ? first.event : 'error';
            method.call(this, first, event);
          } else method.apply(this, args);
        },
      },
      redact: {
        paths: [
          'token',
          'authorization',
          'BOT_TOKEN',
          'RAWG_API_KEY',
          '*.token',
          '*.authorization',
          'requestBody',
          'rawError',
          'interaction',
          'req.headers.authorization',
        ],
        remove: true,
      },
    },
    output,
  );
}
export const logger = createLogger();
export type AppLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error' | 'fatal'>;
