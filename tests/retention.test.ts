import { DAY, type Proposal, type Operation } from '../src/domain/model.js';
import { fixture, game, admin, member, asset } from './helpers.js';
import { AdminViews } from '../src/presentation/admin-views.js';
import { Views } from '../src/presentation/views.js';
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.repository.close());
function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'request',
    actorId: member.id,
    name: 'A game',
    url: 'https://example.com',
    createdAt: f.clock.now(),
    updatedAt: f.clock.now(),
    closedAt: null,
    status: 'pending',
    reason: null,
    gameId: null,
    locale: 'fr',
    ...overrides,
  };
}
function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'operation',
    gameId: 'game',
    actorId: admin.id,
    kind: 'create',
    status: 'completed',
    startedAt: f.clock.now(),
    completedAt: f.clock.now(),
    data: {},
    error: null,
    ...overrides,
  };
}

test('open requests expire after 30 inactive days and remain visible for 30 days after closure', async () => {
  const p = await f.nexus.propose(admin, 'A game', 'https://example.com', 'fr');
  f.clock.at += 30 * DAY - 1;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)?.status).toBe('pending');
  f.clock.at++;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)).toMatchObject({ status: 'expired', closedAt: f.clock.now() });
  expect(f.community.snapshot).not.toHaveBeenCalled();
  expect(f.community.move).not.toHaveBeenCalled();
  f.clock.at += 30 * DAY - 1;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)).toBeDefined();
  f.clock.at++;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)).toBeUndefined();
});
test('clarification and amendment restart inactivity without creating another request', async () => {
  const p = await f.nexus.propose(member, 'A game', 'https://example.com', 'fr');
  f.clock.at += 29 * DAY;
  await f.nexus.clarify(admin, p.id, 'Which edition?');
  f.clock.at += 29 * DAY;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)?.status).toBe('needs_info');
  await f.nexus.amendProposal(member, p.id, 'The right edition', 'https://example.com/edition');
  f.clock.at += 29 * DAY;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)?.status).toBe('pending');
  f.clock.at += DAY;
  await f.nexus.maintain();
  expect(f.repository.proposal(p.id)?.status).toBe('expired');
});
test('retention uses closure and completion dates rather than old creation dates', async () => {
  const g = f.add(game());
  f.repository.saveOperation(operation({ startedAt: f.clock.now() - 100 * DAY }));
  f.repository.saveProposal(
    proposal({
      createdAt: f.clock.now() - 100 * DAY,
      status: 'accepted',
      closedAt: f.clock.now(),
      gameId: g.id,
    }),
  );
  await f.nexus.maintain();
  expect(f.repository.proposal('request')).toBeDefined();
  expect(f.repository.operations()).toHaveLength(1);
  f.clock.at += 30 * DAY;
  await f.nexus.maintain();
  expect(f.repository.proposal('request')).toBeUndefined();
  expect(f.repository.operations()).toHaveLength(0);
  expect(f.repository.game(g.id)).toBeDefined();
});
test('old audit and terminal operations are purged while unresolved operations and live correlations remain', async () => {
  const start = f.clock.now(),
    g = f.add(game());
  f.repository.subscribe(g.id, member.id, true);
  f.repository.set('retentionStartedAt', start);
  f.repository.set('migration:receipt', { appliedAt: start - 365 * DAY });
  f.repository.audit('old', admin.id, g.id, start);
  f.repository.saveOperation(operation({ gameId: g.id }));
  f.repository.saveOperation(operation({ id: 'failed', status: 'failed', gameId: g.id }));
  for (const status of ['pending', 'review'] as const)
    f.repository.saveOperation(
      operation({
        id: status,
        status,
        startedAt: start - 365 * DAY,
        completedAt: start - 365 * DAY,
        gameId: g.id,
      }),
    );
  f.clock.at += 31 * DAY;
  f.repository.audit('recent', admin.id, g.id, f.clock.now());
  await f.nexus.maintain();
  expect(
    f.repository
      .operations()
      .map((o) => o.id)
      .sort(),
  ).toEqual(['pending', 'review']);
  expect(f.repository.db.prepare('SELECT action FROM audit').all()).toEqual([{ action: 'recent' }]);
  expect(f.repository.game(g.id)).toMatchObject({ channelId: g.channelId, roleId: g.roleId });
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.repository.asset(asset.id)).not.toBeNull();
  expect(f.repository.get('migration:receipt')).toBeDefined();
  expect(f.community.deleteRole).not.toHaveBeenCalled();
});
test('legacy records without update/closure timestamps receive a 30-day rollout grace period', async () => {
  f.repository.saveProposal(
    proposal({
      id: 'closed',
      status: 'rejected',
      createdAt: f.clock.now() - 365 * DAY,
      updatedAt: undefined,
      closedAt: undefined,
    }),
  );
  f.repository.saveProposal(
    proposal({
      id: 'open',
      createdAt: f.clock.now() - 365 * DAY,
      updatedAt: undefined,
      closedAt: undefined,
    }),
  );
  f.repository.saveOperation(
    operation({ startedAt: f.clock.now() - 365 * DAY, completedAt: undefined }),
  );
  await f.nexus.maintain();
  expect(f.repository.proposal('closed')).toBeDefined();
  expect(f.repository.proposal('open')?.status).toBe('pending');
  expect(f.repository.operations()).toHaveLength(1);
  f.clock.at += 30 * DAY;
  await f.nexus.maintain();
  expect(f.repository.proposal('closed')).toBeUndefined();
  expect(f.repository.proposal('open')?.status).toBe('expired');
  expect(f.repository.operations()).toHaveLength(0);
});
test('expired request labels do not reuse the personal-session expiry error', () => {
  const p = proposal({ status: 'expired', closedAt: f.clock.now() });
  f.repository.saveProposal(p);
  const staff = new AdminViews(f.repository, '100000000000000000').render(admin, 'fr', {
    page: 'request',
    id: p.id,
    back: { page: 'home' },
  });
  const personal = new Views(f.repository, '100000000000000000').proposal(member, 'fr', p);
  expect(JSON.stringify(staff)).toContain('Expirée');
  expect(JSON.stringify(personal)).toContain('30 jours');
  expect(JSON.stringify(personal)).not.toContain('panneau personnel a expiré');
});
