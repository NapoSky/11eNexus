import { Script, runInNewContext } from 'node:vm';
import {
  prepareInventory,
  readInventory,
  enrichPreparation,
  LEGACY_ACTIVE,
  LEGACY_STANDBY,
} from '../src/application/import-preparation.js';
import { renderImportReview } from '../src/presentation/import-review.js';
import type { World } from '../src/application/ports.js';
import type { Candidate } from '../src/domain/model.js';
const cid = '100000000000000001';
const rid = '100000000000000002';
const member = '100000000000000003';
function world(): World {
  return {
    complete: true,
    roleIcons: true,
    archiveCategoryIds: [],
    memberIds: [member],
    channels: [
      { id: LEGACY_ACTIVE, name: 'Active', type: 4, parentId: null, topic: null },
      { id: LEGACY_STANDBY, name: 'Standby', type: 4, parentId: null, topic: null },
      { id: cid, name: 'project-zomboid', type: 0, parentId: LEGACY_ACTIVE, topic: null },
    ],
    roles: [
      {
        id: rid,
        name: 'Project Zomboid',
        permissions: '0',
        managed: false,
        mentionable: false,
        editable: false,
        members: [member],
        references: [],
      },
    ],
  };
}
test('only the two explicit categories are considered and all proposals remain unconfirmed', () => {
  const w = world();
  w.channels.push(
    { id: '100000000000000004', name: 'private-game', type: 0, parentId: 'other', topic: null },
    { id: '100000000000000005', name: 'Voice', type: 2, parentId: LEGACY_ACTIVE, topic: null },
  );
  const p = prepareInventory(w);
  expect(p.channels).toHaveLength(1);
  expect(p.channels[0]).toMatchObject({
    confirmed: false,
    roleId: rid,
    confidence: 'exact',
    issues: ['hierarchy'],
  });
  expect(p.archiveCategoryIds).toEqual([LEGACY_STANDBY]);
  expect(p.ignoredNonTextual).toBe(1);
  expect(JSON.stringify(p)).not.toContain(member);
  expect(p.roles[0]?.subscribers).toBe(1);
});
test('standby keeps its ID as the first archive and produces archived entries', () => {
  const w = world();
  w.channels[2]!.parentId = LEGACY_STANDBY;
  expect(prepareInventory(w).channels[0]?.state).toBe('archived');
});
test('generic access overwrites never turn Syndiqué into a proposed game role', () => {
  const w = world();
  w.channels[2]!.name = 'unknown-game';
  w.roles.push({
    id: '100000000000000006',
    name: 'Syndiqué',
    permissions: '8',
    managed: false,
    editable: false,
    mentionable: false,
    members: [member],
    references: [cid],
  });
  expect(prepareInventory(w).channels[0]).toMatchObject({ roleId: null, confidence: 'none' });
});
test('weak prefixes do not confuse Abiotic Factor with Factorio', () => {
  const w = world();
  w.channels[2]!.name = 'abiotic-factor';
  w.roles[0]!.name = 'Factorio';
  expect(prepareInventory(w).channels[0]?.roleId).toBeNull();
});
test('an explicit short alias is matched without rewriting role identity', () => {
  const w = world();
  w.channels[2]!.name = 'bar';
  w.roles[0]!.name = 'Beyond all reason (BAR)';
  expect(prepareInventory(w).channels[0]).toMatchObject({ confidence: 'exact', roleId: rid });
});
test('matching-name ties never select an arbitrary role', () => {
  const w = world();
  w.roles.push({ ...w.roles[0]!, id: '100000000000000007' });
  expect(prepareInventory(w).channels[0]).toMatchObject({ roleId: null, confidence: 'none' });
});
test('duplicates, event-like names and role privileges are visible for human decisions', () => {
  const w = world();
  w.roles[0]!.permissions = '8';
  w.roles[0]!.references = [cid];
  w.channels.push(
    { ...w.channels[2]!, id: '100000000000000008', name: 'general-pz' },
    { ...w.channels[2]!, id: '100000000000000009', name: 'pz-2026-b42' },
  );
  const p = prepareInventory(w);
  expect(p.channels.find((c) => c.channelId === cid)?.issues).toEqual(
    expect.arrayContaining(['permissions', 'references', 'duplicate']),
  );
  expect(p.channels.find((c) => c.channelName === 'pz-2026-b42')?.issues).toContain('event');
});
test('invalid or duplicate inventory identities fail before any output', () => {
  const w = world();
  w.channels.push({ ...w.channels[2]! });
  expect(() => readInventory(w)).toThrow('invalidInput');
  expect(() => readInventory({ channels: [] })).toThrow('invalidInput');
  expect(() => prepareInventory(world(), LEGACY_ACTIVE, LEGACY_ACTIVE)).toThrow('invalidInput');
});
test('RAWG enriches proposals without silently accepting a single homonym', async () => {
  const p = prepareInventory(world());
  const result: Candidate = {
    id: 123,
    name: 'Project Zomboid',
    studio: 'Studio',
    released: '2013-11-08',
    url: 'https://rawg.io/games/123',
    imageUrl: null,
  };
  const search = jest.fn(async () => [result]);
  await enrichPreparation(p, { search });
  expect(p.channels[0]?.rawgCandidates).toEqual([result]);
  expect(p.channels[0]?.rawgId).toBeUndefined();
});
test('a provider outage preserves the preparation and indicates the affected candidates', async () => {
  const p = prepareInventory(world());
  await enrichPreparation(p, {
    search: async () => {
      throw new Error('offline');
    },
  });
  expect(p.channels[0]?.issues).toContain('catalogueUnavailable');
  expect(p.channels[0]?.channelId).toBe(cid);
});
test('review output contains no executable inventory text and its client JavaScript parses', () => {
  const w = world();
  w.channels[2]!.name = '</script><img src=x onerror=alert(1)>';
  const html = renderImportReview(prepareInventory(w));
  expect(html).not.toContain(w.channels[2]!.name);
  expect(html).toContain('\\u003c/script>');
  const data = JSON.parse(
    html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!,
  );
  expect(data.preparation.channels[0].name).toBe(w.channels[2]!.name);
  const code = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Script(code)).not.toThrow();
});
test('the local review exports a confirmed manifest only after selection, with archive adoption explicit', async () => {
  const p = prepareInventory(world());
  p.channels[0]!.rawgCandidates = [
    {
      id: 123,
      name: 'Project Zomboid (verified)',
      studio: 'Studio',
      released: null,
      imageUrl: null,
      url: 'https://rawg.io/games/123',
    },
  ];
  const html = renderImportReview(p);
  const payload = html.match(
    /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/,
  )![1]!;
  const code = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const listeners: Record<string, () => void> = {};
  const fields: Record<string, { value: string; checked?: boolean }> = {
    selected: { value: '', checked: false },
    name: { value: p.channels[0]!.name },
    role: { value: rid },
    'icon-role': { value: '' },
    rawg: { value: '' },
    state: { value: 'active' },
  };
  let change: (event: { target: unknown }) => void = () => {};
  const row = {
    dataset: { id: cid },
    textContent: 'Project Zomboid Other role not selected',
    hidden: false,
    querySelectorAll: () => [],
    addEventListener: (_event: string, handler: typeof change) => {
      change = handler;
    },
    querySelector: (selector: string) =>
      selector === '[data-subscribers]'
        ? { textContent: '1' }
        : selector === '[data-new-role]'
          ? { hidden: true }
          : fields[selector.match(/data-field="([^"]+)"/)![1]!],
  };
  const elements: Record<
    string,
    {
      textContent?: string;
      checked?: boolean;
      disabled?: boolean;
      value?: string;
      addEventListener?: (event: string, handler: () => void) => void;
    }
  > = {};
  for (const key of ['status', 'download', 'exact', 'clear', 'search', 'onboarding'])
    elements[key] = {
      checked: true,
      value: '',
      addEventListener: (_event, handler) => {
        listeners[key] = handler;
      },
    };
  const document = {
    getElementById: (id: string) =>
      id === 'review-data' ? { textContent: payload } : elements[id],
    querySelectorAll: () => [row],
    body: { appendChild: () => {} },
    createElement: () => ({ click: () => {}, remove: () => {} }),
  };
  let blob: Blob | undefined;
  const URL = {
    createObjectURL: (value: Blob) => {
      blob = value;
      return 'blob:test';
    },
    revokeObjectURL: () => {},
  };
  runInNewContext(code, { document, URL, Blob, setTimeout: (callback: () => void) => callback() });
  expect(elements.download!.disabled).toBe(true);
  listeners.exact!();
  expect(fields.selected!.checked).toBe(true);
  expect(elements.download!.disabled).toBe(false);
  elements.search!.value = 'Other role not selected';
  listeners.search!();
  expect(row.hidden).toBe(true);
  elements.search!.value = 'zomboid';
  listeners.search!();
  expect(row.hidden).toBe(false);
  fields.rawg!.value = '123';
  change({ target: fields.rawg });
  listeners.download!();
  const manifest = JSON.parse(await blob!.text());
  expect(manifest.archiveCategoryIds).toEqual([LEGACY_STANDBY]);
  expect(manifest.entries).toEqual([
    expect.objectContaining({
      confirmed: true,
      channelId: cid,
      roleId: rid,
      rawgId: 123,
      name: 'Project Zomboid (verified)',
    }),
  ]);
  expect(manifest.removeGameOptions).toBe(true);
  fields.role!.value = '__create__';
  fields.rawg!.value = '';
  change({ target: fields.role });
  expect(elements.download!.disabled).toBe(true);
  fields['icon-role']!.value = rid;
  change({ target: fields['icon-role'] });
  listeners.download!();
  const parentManifest = JSON.parse(await blob!.text());
  expect(parentManifest.entries[0]).toMatchObject({ createRole: true, iconRoleId: rid });
  expect(parentManifest.entries[0].roleId).toBeUndefined();
  fields['icon-role']!.value = '';
  fields.rawg!.value = '123';
  change({ target: fields.rawg });
  listeners.download!();
  const rawgManifest = JSON.parse(await blob!.text());
  expect(rawgManifest.entries[0]).toMatchObject({ createRole: true, rawgId: 123 });
  expect(rawgManifest.entries[0].iconRoleId).toBeUndefined();
});
test.each(['fr', 'en'] as const)(
  'notification and parent icon roles are alphabetical in %s, even when a candidate is suggested',
  (language) => {
    const p = prepareInventory(world());
    p.roles.push(
      { ...p.roles[0]!, id: '100000000000000011', name: 'Zelda' },
      { ...p.roles[0]!, id: '100000000000000012', name: 'éco' },
      { ...p.roles[0]!, id: '100000000000000013', name: 'Alpha' },
    );
    const html = renderImportReview(p, language);
    for (const field of ['role', 'icon-role']) {
      const select = html.match(
        new RegExp(`<select data-field="${field}"[^>]*>([\\s\\S]*?)</select>`),
      )![1]!;
      const values = Array.from(select.matchAll(/<option value="(\d+)"/g), (m) => m[1]);
      expect(values).toEqual([
        '100000000000000013',
        '100000000000000012',
        rid,
        '100000000000000011',
      ]);
    }
    expect(html).toContain(`value="${rid}" selected`);
  },
);
