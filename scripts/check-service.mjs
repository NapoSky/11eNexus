import { spawnSync } from 'node:child_process';

// Host-side, read-only probe. Never dump docker inspect or service environment.
let reason = 'docker_unavailable';
try {
  if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('runtime');
  const run = (args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error('docker');
    return result.stdout.trim();
  };
  const container =
    process.argv[2] === '--container'
      ? process.argv[3]
      : run(['compose', 'ps', '--all', '--quiet', 'bot']);
  reason = 'container_missing';
  if (!container || !/^[a-f0-9]{12,64}$/.test(container)) throw new Error('container');
  reason = 'health_unknown';
  const state = JSON.parse(
    run([
      'inspect',
      '--format',
      '{"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"oomKilled":{{json .State.OOMKilled}},"restarts":{{.RestartCount}}}',
      container,
    ]),
  );
  const ready = state.running === true && state.health === 'healthy';
  const starting = state.running === true && state.health === 'starting';
  console.info(
    JSON.stringify({
      event: 'service_health',
      ready,
      status: state.running ? state.health : 'stopped',
      oomKilled: state.oomKilled === true,
      restarts: state.restarts,
    }),
  );
  process.exitCode = ready || starting ? 0 : 1;
} catch {
  console.info(JSON.stringify({ event: 'service_health', ready: false, reason }));
  process.exitCode = 1;
}
