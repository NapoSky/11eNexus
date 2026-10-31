import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, chmodSync, statSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

// Host-side online backup, verified in the exact running image before publication.
// No service environment, member data or raw Docker output is printed.
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
let directory;
let container;
let source;
let stage = 'runtime';
const run = (args, timeout = 120000) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 1048576 });
  if (result.status !== 0) throw new Error('Docker operation failed');
  return result.stdout.trim();
};
try {
  if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('Node 26 required');
  stage = 'container';
  container = option('--container') || run(['compose', 'ps', '--quiet', 'bot'], 10000);
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Container missing');
  const node = run(['exec', container, 'node', '--version'], 10000);
  if (!/^v26\./.test(node)) throw new Error('Container must use Node 26');
  const image = run(['inspect', '--format', '{{.Image}}', container], 10000);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Invalid image');
  stage = 'destination';
  const destination = resolve(option('--directory') || './backups');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  if ((statSync(destination).mode & 0o077) !== 0)
    throw new Error('Backup directory must be private');
  directory = mkdtempSync(join(destination, '.nexus-backup-'));
  source = `/data/${basename(directory)}.sqlite`;
  stage = 'snapshot';
  run(['exec', container, 'node', 'dist/cli.js', 'backup', '--output', source]);
  stage = 'copy';
  const partial = join(directory, 'backup.sqlite');
  run(['cp', `${container}:${source}`, partial]);
  chmodSync(partial, 0o600);
  stage = 'verify';
  run([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    '256m',
    '--pids-limit',
    '64',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--mount',
    `type=bind,src=${directory},dst=/backup,readonly`,
    image,
    'node',
    'scripts/verify-database.mjs',
    '/backup/backup.sqlite',
  ]);
  stage = 'publish';
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const output = join(destination, `${stamp}-${basename(directory).slice(1)}.sqlite`);
  renameSync(partial, output);
  console.info(
    JSON.stringify({ event: 'backup_verified', output, bytes: statSync(output).size, node, image }),
  );
} catch {
  console.info(JSON.stringify({ event: 'backup_failed', stage }));
  process.exitCode = 1;
} finally {
  if (source && container) {
    // Remove only this invocation's temporary snapshot, never an existing backup.
    try {
      run(
        [
          'exec',
          container,
          'node',
          '-e',
          'require("node:fs").rmSync(process.argv[1],{force:true})',
          source,
        ],
        10000,
      );
    } catch {
      console.info(JSON.stringify({ event: 'backup_temporary_cleanup_failed' }));
      process.exitCode = 1;
    }
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
}
