import { adminDiagnostic } from '../src/infrastructure/admin-diagnostics.js';

test.each(['EACCES', 'ENOENT', 'EROFS', 'EEXIST', 'ERR_SQLITE_ERROR', 'TokenInvalid', 50013])(
  'recognizes operational failure %s without exposing error contents',
  (code) => {
    const error = Object.assign(new Error('secret-token https://api.rawg.io/?key=secret-key'), {
      code,
      path: '/private/secret-token',
      requestBody: { token: 'secret-token' },
    });
    const result = adminDiagnostic(error, 'read_manifest');
    expect(result.errorCode).toBe(String(code));
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.stage).toBe('read_manifest');
  },
);

test('nested network failures identify DNS problems without printing request URLs', () => {
  const cause = Object.assign(new Error('https://discord.com?token=secret'), { code: 'ENOTFOUND' });
  const result = adminDiagnostic(new TypeError('fetch failed', { cause }), 'discord_login');
  expect(result.errorCode).toBe('ENOTFOUND');
  expect(result.hint).toContain('DNS');
  expect(JSON.stringify(result)).not.toContain('secret');
});

test('recognizes gateway intent failures and configuration keys without leaking values', () => {
  expect(adminDiagnostic(new Error('Used disallowed intents'), 'discord_login')).toMatchObject({
    errorCode: 'DisallowedIntents',
    hint: expect.stringContaining('Server Members Intent'),
  });
  expect(
    adminDiagnostic(new Error('Invalid configuration: GUILD_ID'), 'initialization'),
  ).toMatchObject({
    setting: 'GUILD_ID',
  });
  const unsafe = adminDiagnostic(
    new Error('Invalid configuration: SECRET_VALUE'),
    'initialization',
  );
  expect(unsafe).not.toHaveProperty('setting');
  expect(JSON.stringify(unsafe)).not.toContain('SECRET_VALUE');
});

test('unrecognized and cyclic error payloads remain private and terminate', () => {
  const error = { code: 'secret-token', name: 'secret-token', message: 'secret-token', cause: {} };
  error.cause = error;
  const result = adminDiagnostic(error, 'write_plan');
  expect(result.hint).toContain('writable');
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(adminDiagnostic('secret-token', 'initialization')).not.toHaveProperty('errorCode');
});

test('malformed JSON is identified without including the potentially private input excerpt', () => {
  const result = adminDiagnostic(
    new SyntaxError('Unexpected token secret-token'),
    'parse_manifest',
  );
  expect(result.errorCode).toBe('SyntaxError');
  expect(JSON.stringify(result)).not.toContain('secret-token');
});
