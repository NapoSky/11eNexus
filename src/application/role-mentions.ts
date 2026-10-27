import type { Game } from '../domain/model.js';
import type { MigrationCommunity } from './migration.js';
import type { Repository, World } from './ports.js';

interface RoleMentionChange {
  game: string;
  roleId: string;
}
export interface RoleMentionsReport {
  changes: RoleMentionChange[];
  updated: RoleMentionChange[];
  alreadyMentionable: number;
  skipped: string[];
  errors: string[];
}
export function planRoleMentions(games: Game[], world: World): RoleMentionsReport {
  const report: RoleMentionsReport = {
    changes: [],
    updated: [],
    alreadyMentionable: 0,
    skipped: [],
    errors: [],
  };
  if (!world.complete) {
    report.errors.push('Incomplete Discord snapshot; no roles will be changed');
    return report;
  }
  const seen = new Set<string>();
  for (const game of games) {
    if (game.retired) continue;
    const role = world.roles.find((r) => r.id === game.roleId);
    if (!role) {
      report.skipped.push(`${game.name}: no existing role; no role will be recreated`);
      continue;
    }
    if (seen.has(role.id)) continue;
    seen.add(role.id);
    if (role.managed || !role.editable || role.permissions !== '0') {
      report.errors.push(
        `${game.name}: role must be ordinary, below the bot and have zero global permissions`,
      );
      continue;
    }
    if (role.mentionable) report.alreadyMentionable++;
    else report.changes.push({ game: game.name, roleId: role.id });
  }
  return report;
}
export async function enableRoleMentions(
  repository: Pick<Repository, 'games' | 'audit'>,
  community: Pick<MigrationCommunity, 'snapshot' | 'prepareImportedRole'>,
  apply: boolean,
): Promise<RoleMentionsReport> {
  const report = planRoleMentions(repository.games(), await community.snapshot());
  if (!apply || report.errors.length) return report;
  for (const change of report.changes) {
    try {
      await community.prepareImportedRole(change.roleId);
      report.updated.push(change);
      repository.audit('enable-role-mentions', null, change.roleId, Date.now());
    } catch {
      report.errors.push(
        `${change.game}: update not confirmed; check permissions and rerun this command`,
      );
      break;
    }
  }
  return report;
}
