import { readFileSync } from 'node:fs';
try {
  const health = JSON.parse(
    readFileSync(process.env.HEALTH_PATH || './data/health.json', 'utf8'),
  ) as { ready: boolean; at: number };
  process.exit(health.ready && Date.now() - health.at < 60000 ? 0 : 1);
} catch {
  process.exit(1);
}
