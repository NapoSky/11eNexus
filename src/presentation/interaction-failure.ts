import { DomainError } from '../domain/model.js';
import { adminDiagnostic } from '../infrastructure/admin-diagnostics.js';

export function interactionFailure(error: unknown): {
  code: string;
  values: Record<string, string | number>;
  expected: boolean;
} {
  if (error instanceof DomainError)
    return { code: error.code, values: error.values, expected: true };
  const diagnostic = adminDiagnostic(error, 'interaction');
  if (diagnostic.errorCode === 'GatewayRateLimitError')
    return {
      code: 'discordRateLimited',
      values: { seconds: Math.max(1, Math.ceil(Number(diagnostic.retryAfterSeconds) || 1)) },
      expected: true,
    };
  return { code: 'unknownError', values: {}, expected: false };
}
