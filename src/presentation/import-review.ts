import type { ImportPreparation, PreparedChannel } from '../application/import-preparation.js';
import type { Locale } from '../domain/model.js';
import { translator } from './i18n.js';

const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const json = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
function reviewClient(): void {
  const data = JSON.parse(document.getElementById('review-data')!.textContent!) as {
    preparation: ImportPreparation;
    labels: Record<string, string>;
  };
  const { preparation, labels } = data;
  const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'));
  const value = (row: HTMLTableRowElement, key: string) =>
    (row.querySelector(`[data-field="${key}"]`) as HTMLInputElement | HTMLSelectElement).value;
  const status = document.getElementById('status')!;
  const download = document.getElementById('download') as HTMLButtonElement;
  function validate(): { entries: Record<string, unknown>[]; errors: string[] } {
    const entries: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const roles = new Set<string>();
    const rawgIds = new Set<number>();
    const names = new Set<string>();
    for (const row of rows) {
      if (!(row.querySelector('[data-field="selected"]') as HTMLInputElement).checked) continue;
      const original = preparation.channels.find((c) => c.channelId === row.dataset.id)!;
      const name = value(row, 'name').trim();
      const roleId = value(row, 'role');
      const createRole = roleId === '__create__';
      const iconRoleId = createRole ? value(row, 'icon-role') : '';
      const rawg = value(row, 'rawg').trim();
      const rawgId = Number(rawg);
      const canonical = name
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      if (
        !name ||
        name.length > 100 ||
        (!createRole && !preparation.roles.some((r) => r.id === roleId))
      )
        errors.push(`${original.channelName}: ${labels.missing}`);
      if ((!createRole && roles.has(roleId)) || names.has(canonical))
        errors.push(`${name}: ${labels.duplicate}`);
      if (!createRole) roles.add(roleId);
      names.add(canonical);
      if (rawg && (!Number.isSafeInteger(rawgId) || rawgId < 1 || rawgIds.has(rawgId)))
        errors.push(`${name}: ${labels.invalidRawg}`);
      if (rawg) rawgIds.add(rawgId);
      if (
        createRole &&
        ((!rawg && !iconRoleId) ||
          (iconRoleId && !preparation.roles.some((r) => r.id === iconRoleId)))
      )
        errors.push(`${name}: ${labels.iconRequired}`);
      entries.push({
        confirmed: true,
        name,
        channelId: original.channelId,
        ...(createRole ? { createRole: true, ...(iconRoleId ? { iconRoleId } : {}) } : { roleId }),
        state: value(row, 'state'),
        aliases: original.aliases,
        ...(rawg ? { rawgId } : {}),
      });
    }
    if (!preparation.complete) errors.push(labels.incomplete!);
    if (!entries.length) errors.push(labels.empty!);
    return { entries, errors };
  }
  function update(): void {
    const { entries, errors } = validate();
    status.textContent = errors.length
      ? errors.join('\n')
      : labels.selected!.replace('{{count}}', String(entries.length));
    download.disabled = errors.length > 0;
  }
  for (const row of rows)
    row.addEventListener('change', (event) => {
      if (event.target === row.querySelector('[data-field="rawg"]')) {
        const original = preparation.channels.find((c) => c.channelId === row.dataset.id)!;
        const candidate = original.rawgCandidates.find((c) => String(c.id) === value(row, 'rawg'));
        if (candidate)
          (row.querySelector('[data-field="name"]') as HTMLInputElement).value = candidate.name;
      }
      const role = preparation.roles.find((r) => r.id === value(row, 'role'));
      const original = preparation.channels.find((c) => c.channelId === row.dataset.id)!;
      for (const hint of row.querySelectorAll<HTMLElement>('[data-role-issue]'))
        hint.hidden = value(row, 'role') !== original.roleId;
      const source = row.querySelector('[data-new-role]') as HTMLElement | null;
      if (source) source.hidden = value(row, 'role') !== '__create__';
      const count = row.querySelector('[data-subscribers]');
      if (count)
        count.textContent = role
          ? String(role.subscribers)
          : value(row, 'role') === '__create__'
            ? '0'
            : '—';
      update();
    });
  document.getElementById('exact')!.addEventListener('click', () => {
    for (const row of rows) {
      const original = preparation.channels.find((c) => c.channelId === row.dataset.id)!;
      if (
        original.confidence === 'exact' &&
        !original.issues.some((i) =>
          ['duplicate', 'family', 'event', 'permissions', 'references'].includes(i),
        )
      )
        (row.querySelector('[data-field="selected"]') as HTMLInputElement).checked = true;
    }
    update();
  });
  document.getElementById('clear')!.addEventListener('click', () => {
    for (const row of rows)
      (row.querySelector('[data-field="selected"]') as HTMLInputElement).checked = false;
    update();
  });
  const search = document.getElementById('search') as HTMLInputElement;
  search.addEventListener('input', () => {
    const query = search.value.toLocaleLowerCase();
    for (const row of rows) {
      const original = preparation.channels.find((c) => c.channelId === row.dataset.id)!;
      const role = preparation.roles.find((r) => r.id === value(row, 'role'));
      row.hidden = ![original.channelName, value(row, 'name'), role?.name || '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(query);
    }
  });
  download.addEventListener('click', () => {
    const { entries, errors } = validate();
    if (errors.length) {
      update();
      return;
    }
    const result = {
      version: 1,
      removeGameOptions: (document.getElementById('onboarding') as HTMLInputElement).checked,
      archiveCategoryIds: preparation.archiveCategoryIds,
      entries,
    };
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'import-manifest.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  update();
}
function sortedRoles(p: ImportPreparation, language: Locale) {
  const collator = new Intl.Collator(language, {
    sensitivity: 'base',
    numeric: true,
    ignorePunctuation: true,
  });
  return [...p.roles].sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
}
function options(row: PreparedChannel, p: ImportPreparation, language: Locale): string {
  const t = translator(language);
  return `<option value="">—</option><option value="__create__"${row.roleId ? '' : ' selected'}>${escapeHtml(t('importReviewCreateRole'))}</option>${sortedRoles(
    p,
    language,
  )
    .map((role) => {
      return `<option value="${escapeHtml(role.id)}"${role.id === row.roleId ? ' selected' : ''}>${escapeHtml(role.name)} (${role.subscribers})</option>`;
    })
    .join('')}`;
}
export function renderImportReview(p: ImportPreparation, language: Locale = 'fr'): string {
  const t = translator(language);
  const e = (key: string) => escapeHtml(t(`importReview${key}`));
  const iconOptions = `<option value="">${e('RawgIcon')}</option>${sortedRoles(p, language)
    .map((role) => `<option value="${escapeHtml(role.id)}">${escapeHtml(role.name)}</option>`)
    .join('')}`;
  const rows = p.channels
    .map(
      (row) =>
        `<tr data-id="${escapeHtml(row.channelId)}"><td><input type="checkbox" data-field="selected" aria-label="${e('Select')} ${escapeHtml(row.channelName)}"></td><td><input data-field="name" maxlength="100" value="${escapeHtml(row.name)}" aria-label="${e('Name')}"><small>${escapeHtml(row.channelName)}<br>${escapeHtml(row.channelId)} · ${escapeHtml(row.type === 15 || row.type === 16 ? 'Forum' : 'Text')}</small></td><td><select data-field="role" aria-label="${e('Role')}">${options(row, p, language)}</select><small>${e('Subscribers')}: <span data-subscribers>${p.roles.find((r) => r.id === row.roleId)?.subscribers ?? 0}</span></small><details data-new-role${row.roleId ? ' hidden' : ' open'}><summary>${e('NewRoleIcon')}</summary><p>${e('NewRoleHint')}</p><select data-field="icon-role" aria-label="${e('NewRoleIcon')}">${iconOptions}</select></details></td><td><select data-field="state" aria-label="${e('State')}"><option value="active"${row.state === 'active' ? ' selected' : ''}>${escapeHtml(t('active'))}</option><option value="archived"${row.state === 'archived' ? ' selected' : ''}>${escapeHtml(t('archived'))}</option></select></td><td><select data-field="rawg" aria-label="RAWG"><option value="">${e('NoReference')}</option>${row.rawgCandidates.map((c) => `<option value="${c.id}"${c.id === row.rawgId ? ' selected' : ''}>${escapeHtml(c.name)} · ${escapeHtml(c.released || '')}</option>`).join('')}</select><details><summary>${e('Candidates')} (${row.rawgCandidates.length})</summary>${row.rawgCandidates.map((c) => `<p><a href="https://rawg.io/games/${c.id}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.name)}</a> · ${escapeHtml(c.released || '')} · ${escapeHtml(c.studio)}<br>RAWG ID: ${c.id}</p>`).join('')}</details></td><td>${row.issues.map((issue) => `<p${['fuzzy', 'hierarchy', 'permissions', 'references', 'duplicate'].includes(issue) ? ' data-role-issue' : ''} class="issue ${['duplicate', 'event', 'family', 'permissions', 'unmatched'].includes(issue) ? 'important' : ''}">${escapeHtml(t(`importIssue${issue}`))}</p>`).join('') || e('Exact')}</td></tr>`,
    )
    .join('');
  const labels = {
    missing: t('importReviewMissing'),
    duplicate: t('importIssueduplicate'),
    invalidRawg: t('importReviewInvalidRawg'),
    incomplete: t('incomplete'),
    empty: t('importReviewEmpty'),
    selected: t('importReviewSelected', { count: '{{count}}' }),
    iconRequired: t('importReviewIconRequired'),
  };
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e('Title')}</title><style>body{font:16px system-ui,sans-serif;color:#e6ece9;background:#111b18;margin:0;padding:24px}main{max-width:1600px;margin:auto}h1{margin:0}p{line-height:1.5}header,.toolbar,footer{background:#1c2b24;padding:20px;border-radius:12px;margin-bottom:20px}button,input,select{font:inherit;border-radius:6px;padding:9px;border:1px solid #597564;color:#e6ece9;background:#24382e}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:#426c51}.toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #385041}th{background:#1c2b24;position:sticky;top:0}input[data-field=name],select{width:100%;box-sizing:border-box}input[data-field=rawg]{width:110px}small{display:block;color:#b1c5b9;margin-top:8px;overflow-wrap:anywhere}.issue{font-size:13px;margin:0 0 8px;color:#c6d6cd}.important{color:#ffd59b}a{color:#a9d6bc}footer{margin-top:20px}#status{white-space:pre-line}.table-scroll{overflow:auto}td:nth-child(2){min-width:220px}td:nth-child(3){min-width:240px}td:last-child{min-width:200px}label{display:block;margin:12px 0}</style></head><body><main><header><h1>11eNexus · ${e('Title')}</h1><p>${e('Intro')}</p><p>${e('Scope')}<br><strong>${escapeHtml(p.activeCategoryId)}</strong> → ${escapeHtml(t('active'))}<br><strong>${escapeHtml(p.standbyCategoryId)}</strong> → ${e('FirstArchive')}</p><p>${e('ArchiveExplanation')}</p><p>${escapeHtml(t('importReviewCounts', { channels: p.channels.length, ignored: p.ignoredNonTextual }))}</p></header><div class="toolbar"><button id="exact">${e('ApproveExact')}</button><button id="clear">${e('Clear')}</button><input id="search" type="search" placeholder="${e('Search')}" aria-label="${e('Search')}"></div><div class="table-scroll"><table><thead><tr>${['Select', 'Name', 'Role', 'State', 'Rawg', 'Issues'].map((key) => `<th>${e(key)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><footer><label><input id="onboarding" type="checkbox" checked> ${e('Onboarding')}</label><p>${e('ExportHint')}</p><p id="status" role="status"></p><button id="download" class="primary">${e('Download')}</button></footer></main><script id="review-data" type="application/json">${json({ preparation: p, labels })}</script><script>(${reviewClient.toString()})();</script></body></html>`;
}
export function renderImportSummary(p: ImportPreparation, language: Locale = 'fr'): string {
  const t = translator(language);
  const cell = (value: unknown) =>
    String(value)
      .replace(/\|/g, '\\|')
      .replace(/[\r\n]/g, ' ');
  return `# 11eNexus — ${t('importReviewTitle')}\n\n${t('importReviewIntro')}\n\n${t('importReviewScope')} : ${p.activeCategoryId}, ${p.standbyCategoryId}.\n\n${t('importReviewArchiveExplanation')}\n\n| ${['Name', 'Channel', 'Role', 'State', 'Issues'].map((k) => t(`importReview${k}`)).join(' | ')} |\n|---|---|---|---|---|\n${p.channels.map((row) => `| ${cell(row.name)} | ${cell(row.channelName)} (${row.channelId}) | ${cell(p.roles.find((r) => r.id === row.roleId)?.name || '—')} ${row.roleId ? `(${row.roleId})` : ''} | ${t(row.state)} | ${row.issues.map((i) => cell(t(`importIssue${i}`))).join('; ') || t('importReviewExact')} |`).join('\n')}\n`;
}
