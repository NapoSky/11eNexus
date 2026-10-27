import type { AuditResource, ResourceAudit } from '../application/resource-audit.js';
import type { Locale } from '../domain/model.js';
import { translator } from './i18n.js';

const cell = (value: unknown) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[[\]!*`]/g, '\\$&')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');

export function renderResourceAudit(report: ResourceAudit, language: Locale): string {
  const t = translator(language);
  const lines = [
    `# ${t('resourceAuditTitle')}`,
    '',
    t('resourceAuditDefinition'),
    '',
    `${t('resourceAuditSource')}: SQLite · ${report.catalogueGames} ${t('games').toLowerCase()}`,
    `${t('resourceAuditMarker')}: ${cell(report.marker?.name || '?')} (${report.marker?.id || '?'})`,
    `${t('resourceAuditCategories')}: ${report.categories.map((c) => `${cell(c.name)} (${c.id})`).join(', ')}`,
    '',
    `${t('resourceAuditComplete')}: ${report.complete ? '✅' : '❌'}`,
    '',
  ];
  if (report.errors.length)
    lines.push(
      `## ${t('resourceAuditErrors')}`,
      '',
      ...report.errors.map((e) => `- ${cell(e)}`),
      '',
    );
  const section = (label: string, resources: AuditResource[]) => {
    lines.push(
      `## ${label}`,
      '',
      `| ${t('importReviewName')} | ID | ${t('resourceAuditStatus')} | ${t('games')} | ${t('resourceAuditUsage')} |`,
      '| --- | --- | --- | --- | --- |',
    );
    for (const r of resources) {
      const usage =
        r.kind === 'role'
          ? `${r.subscribers || 0} ${t('resourceAuditSubscribers')}; ${r.references?.map(cell).join(', ') || '—'}; permissions=${r.permissions}`
          : cell(r.category || '');
      lines.push(
        `| ${cell(r.name)} | ${r.id} | ${t(`resourceAudit_${r.status}`)} | ${r.games.map(cell).join(', ') || '—'} | ${usage} |`,
      );
    }
    if (!resources.length) lines.push(`| ${t('empty')} | | | | |`);
    lines.push('');
  };
  section(
    `${t('resourceAuditUntrackedRoles')} (${report.roles.filter((r) => r.status === 'untracked').length})`,
    report.roles.filter((r) => r.status === 'untracked'),
  );
  section(
    `${t('resourceAuditUntrackedChannels')} (${report.channels.filter((r) => r.status === 'untracked').length})`,
    report.channels.filter((r) => r.status === 'untracked'),
  );
  section(`${t('resourceAuditAllRoles')} (${report.roles.length})`, report.roles);
  section(`${t('resourceAuditAllChannels')} (${report.channels.length})`, report.channels);
  section(t('resourceAuditOutside'), report.trackedOutsideScope);
  lines.push(
    `## ${t('resourceAuditNames')}`,
    '',
    t('resourceAuditRenameHint'),
    '',
    `| ${t('resourceAuditKind')} | ID | ${t('resourceAuditCurrentName')} | ${t('resourceAuditProposedName')} | ${t('resourceAuditNameConflicts')} |`,
    '| --- | --- | --- | --- | --- |',
  );
  for (const diff of report.nameDifferences)
    lines.push(
      `| ${t(diff.kind === 'role' ? 'importReviewRole' : 'importReviewChannel')} | ${diff.id} | ${cell(diff.current)} | ${cell(diff.proposed)} | ${diff.conflictingIds.join(', ') || '—'} |`,
    );
  lines.push('', `## ${t('resourceAuditMissing')}`, '');
  for (const missing of report.missing)
    lines.push(
      `- ${cell(missing.game)} · ${t(missing.kind === 'role' ? 'importReviewRole' : 'importReviewChannel')} · ${missing.id}`,
    );
  return `${lines.join('\n')}\n`;
}
