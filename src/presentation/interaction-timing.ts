import type { AppLogger } from '../infrastructure/logger.js';

export function recordInteraction(
  log: AppLogger,
  startedAt: number,
  details: Record<string, unknown>,
  outcome: 'completed' | 'failed' | 'cancelled',
  superseded: boolean,
): void {
  log.info({
    ...details,
    event: 'interaction_completed',
    outcome: superseded ? 'superseded' : outcome,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
}
