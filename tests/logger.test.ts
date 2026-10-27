import { createLogger, safeError } from '../src/infrastructure/logger.js';

test('Pino emits timestamped structured logs with numeric Discord codes and safe error context', () => {
  let output = '';
  const log = createLogger(
    { format: 'json' },
    {
      write: (line: string) => {
        output += line;
      },
    },
  );
  const error = Object.assign(
    new Error('https://discord.com/interactions/id/private-token?key=private-key'),
    {
      code: 10062,
      status: 404,
      requestBody: { token: 'private-token' },
    },
  );
  log.warn({
    event: 'interaction_error',
    err: error,
    token: 'private-token',
    RAWG_API_KEY: 'private-key',
  });
  const entry = JSON.parse(output);
  expect(entry.name).toBe('11eNexus');
  expect(entry.level).toBe(40);
  expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(entry.err).toMatchObject({ code: 10062, status: 404, errorCode: '10062' });
  expect(output).not.toContain('private-token');
  expect(output).not.toContain('private-key');
  expect(output).not.toContain('discord.com');
});

test('debug output is opt-in and log levels are configurable', () => {
  const lines: string[] = [];
  const log = createLogger(
    { level: 'warn', format: 'json' },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  log.debug({ event: 'debug' });
  log.info({ event: 'info' });
  log.warn({ event: 'warn' });
  expect(lines).toHaveLength(1);
});
test('logging an Error directly cannot leak its message through Pino’s automatic msg field', () => {
  let output = '';
  const log = createLogger(
    { format: 'json' },
    {
      write: (line: string) => {
        output += line;
      },
    },
  );
  log.error(new Error('private-token'));
  expect(output).not.toContain('private-token');
  expect(JSON.parse(output).msg).toBe('error');
});

test('source locations are kept while multiline exception text and raw payloads remain private', () => {
  const error = Object.assign(new TypeError('private-member-text\n at /app/dist/main.js:99:1'), {
    requestBody: { content: 'private-member-text' },
  });
  error.stack = `TypeError: ${error.message}\n    at Controller.handle (/app/dist/presentation/controller.js:42:3)`;
  const result = safeError(error);
  expect(result.locations).toEqual(['dist/presentation/controller.js:42:3']);
  expect(result.type).toBe('TypeError');
  expect(JSON.stringify(result)).not.toContain('private-member-text');
  expect(JSON.stringify(result)).not.toContain('main.js:99:1');
});

test('nested network causes remain useful without leaking request credentials', () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('private-key'), { code: 'ENOTFOUND' }),
  });
  expect(safeError(error)).toMatchObject({ type: 'TypeError', errorCode: 'ENOTFOUND' });
  expect(JSON.stringify(safeError(error))).not.toContain('private-key');
});
