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
  'ValidationError',
  'CombinedError',
]);
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
