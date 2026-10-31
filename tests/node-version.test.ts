import { requireNode26 } from '../src/infrastructure/node-version.js';
test('Node 26 is the supported runtime family', () => {
  expect(() => requireNode26('26.0.0')).not.toThrow();
  expect(() => requireNode26(process.versions.node)).not.toThrow();
});
test.each(['24.22.1', '25.0.0', '27.0.0', '26.0.0-rc.1', 'invalid'])(
  'rejects unsupported runtime %s',
  (version) => {
    expect(() => requireNode26(version)).toThrow('Node.js 26 is required.');
  },
);
