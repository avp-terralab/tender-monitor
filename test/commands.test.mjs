import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand, buildAutoNotes, formatAddReply, handleList,
  applyMutation, handleAdd, handleStatus,
} from '../commands.mjs';

test('parseCommand: /list', () => {
  assert.deepEqual(parseCommand('/list'), { cmd: 'list' });
});

test('parseCommand: /list with bot suffix', () => {
  assert.deepEqual(parseCommand('/list@my_bot'), { cmd: 'list' });
});

test('parseCommand: /list and /help reject trailing text (strict)', () => {
  assert.deepEqual(parseCommand('/list extra'), { cmd: 'unknown' });
  assert.deepEqual(parseCommand('/help please'), { cmd: 'unknown' });
});

test('parseCommand: /help', () => {
  assert.deepEqual(parseCommand('/help'), { cmd: 'help' });
});

test('parseCommand: /add with valid id, no notes', () => {
  assert.deepEqual(
    parseCommand('/add UA-2026-04-30-010542-a'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: null }
  );
});

test('parseCommand: /add with id and notes', () => {
  assert.deepEqual(
    parseCommand('/add UA-2026-04-30-010542-a Рівне ОКЛ — ISO 15189'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: 'Рівне ОКЛ — ISO 15189' }
  );
});

test('parseCommand: /add normalizes uppercase suffix to lowercase', () => {
  assert.deepEqual(
    parseCommand('/add UA-2026-04-30-010542-A'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: null }
  );
});

test('parseCommand: /add with bot suffix', () => {
  assert.deepEqual(
    parseCommand('/add@my_bot UA-2026-04-30-010542-a'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: null }
  );
});

test('parseCommand: /add with garbage id → error', () => {
  assert.deepEqual(
    parseCommand('/add not-a-valid-id'),
    { cmd: 'add', error: 'invalid_id' }
  );
});

test('parseCommand: /add without args → error', () => {
  assert.deepEqual(
    parseCommand('/add'),
    { cmd: 'add', error: 'missing_id' }
  );
});

test('parseCommand: unknown slash command', () => {
  assert.deepEqual(parseCommand('/foo'), { cmd: 'unknown' });
  assert.deepEqual(parseCommand('/remove UA-...'), { cmd: 'unknown' });
});

test('parseCommand: free text — null', () => {
  assert.deepEqual(parseCommand('привіт'), { cmd: null });
  assert.deepEqual(parseCommand(''), { cmd: null });
});

test('parseCommand: non-string input — null', () => {
  assert.deepEqual(parseCommand(null), { cmd: null });
  assert.deepEqual(parseCommand(undefined), { cmd: null });
  assert.deepEqual(parseCommand(123), { cmd: null });
});

test('parseCommand: leading/trailing whitespace tolerated', () => {
  assert.deepEqual(parseCommand('  /list  '), { cmd: 'list' });
});

const SAMPLE_SNAP = {
  tender_id: 'UA-2026-04-30-010542-a',
  title: 'Реактиви для лабораторії, код ДК 33696500-0',
  procuringEntity: { name: 'КНП «Рівненська ОКЛ»', edrpou: '12345678' },
};

test('buildAutoNotes: combines entity name and stripped title', () => {
  assert.equal(
    buildAutoNotes(SAMPLE_SNAP),
    'КНП «Рівненська ОКЛ» — Реактиви для лабораторії'
  );
});

test('buildAutoNotes: missing procuringEntity → just title', () => {
  assert.equal(
    buildAutoNotes({ ...SAMPLE_SNAP, procuringEntity: null }),
    'Реактиви для лабораторії'
  );
});

test('buildAutoNotes: missing title → just entity name', () => {
  assert.equal(
    buildAutoNotes({ ...SAMPLE_SNAP, title: null }),
    'КНП «Рівненська ОКЛ»'
  );
});

test('buildAutoNotes: empty snapshot → empty string', () => {
  assert.equal(buildAutoNotes({}), '');
});

test('buildAutoNotes: truncates at 200 chars', () => {
  const longTitle = 'А'.repeat(300);
  const result = buildAutoNotes({ title: longTitle });
  assert.ok(result.length <= 200);
  assert.ok(result.endsWith('…'));
});

const FULL_SNAP = {
  tender_id: 'UA-2026-04-30-010542-a',
  title: 'Реактиви для лабораторії',
  status: 'active.tendering',
  tenderPeriod: { endDate: '2026-05-15T14:30:00+03:00' },
  procuringEntity: { name: 'КНП «Рівненська ОКЛ»', edrpou: '12345678' },
};

test('formatAddReply: new tender — full template', () => {
  const reply = formatAddReply(FULL_SNAP, { reEnable: false });
  assert.match(reply, /✅ Додано UA-2026-04-30-010542-a/);
  assert.match(reply, /📦 Реактиви для лабораторії/);
  assert.match(reply, /👥 КНП «Рівненська ОКЛ»/);
  assert.match(reply, /Статус: Приймання пропозицій/);
  assert.match(reply, /дедлайн 15\.05\.2026 до 14:30/);
  assert.match(reply, /Перший snapshot/);
});

test('formatAddReply: re-enable shows "Поновив" prefix', () => {
  const reply = formatAddReply(FULL_SNAP, { reEnable: true });
  assert.match(reply, /✅ Поновив моніторинг UA-/);
  assert.doesNotMatch(reply, /✅ Додано/);
});

test('formatAddReply: omits 👥 when procuringEntity null', () => {
  const reply = formatAddReply({ ...FULL_SNAP, procuringEntity: null }, { reEnable: false });
  assert.doesNotMatch(reply, /👥/);
  assert.match(reply, /📦 Реактиви/);
});

test('formatAddReply: omits "дедлайн" when tenderPeriod.endDate null', () => {
  const reply = formatAddReply({ ...FULL_SNAP, tenderPeriod: null }, { reEnable: false });
  assert.match(reply, /Статус: Приймання пропозицій/);
  assert.doesNotMatch(reply, /дедлайн/);
});

test('formatAddReply: drops DK code from title', () => {
  const reply = formatAddReply(
    { ...FULL_SNAP, title: 'Реактиви, код ДК 33696500-0' },
    { reEnable: false }
  );
  assert.match(reply, /📦 Реактиви\n/);
  assert.doesNotMatch(reply, /код ДК/);
});

test('formatAddReply: HTML-escapes user-controlled fields', () => {
  const reply = formatAddReply(
    {
      ...FULL_SNAP,
      title: 'A & B <test> "x"',
      procuringEntity: { name: 'ТОВ «A&B>'  },
    },
    { reEnable: false }
  );
  // & must become &amp;, < must become &lt;, > must become &gt;
  assert.doesNotMatch(reply, /& [A-Za-z]/); // no raw "& X" sequences
  assert.match(reply, /A &amp; B/);
  assert.match(reply, /&lt;test&gt;/);
  assert.match(reply, /A&amp;B&gt;/);
});

test('handleList: empty watchlist', () => {
  assert.match(handleList({ watchlist: [] }), /порожній/i);
});

test('handleList: single enabled tender', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: 'Рівне ОКЛ' }
  ]});
  assert.match(reply, /🟢 UA-2026-04-30-010542-a — Рівне ОКЛ/);
  assert.match(reply, /Всього: 1 \(1 active\)/);
});

test('handleList: mix enabled and disabled', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: 'Active' },
    { tender_id: 'UA-2025-01-01-000001-a', enabled: false, notes: 'auto-disabled: 404' },
  ]});
  assert.match(reply, /🟢 UA-2026-04-30-010542-a — Active/);
  assert.match(reply, /🔴 UA-2025-01-01-000001-a — auto-disabled: 404/);
  assert.match(reply, /Всього: 2 \(1 active\)/);
});

test('handleList: notes truncated to 80 chars', () => {
  const longNotes = 'X'.repeat(150);
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: longNotes }
  ]});
  assert.ok(reply.includes('X'.repeat(79) + '…'));
});

test('handleList: row without notes — id only', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-2026-04-30-010542-a', enabled: true }
  ]});
  assert.match(reply, /🟢 UA-2026-04-30-010542-a$/m);
});

test('handleList: HTML-escapes notes', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: 'A & <B>' }
  ]});
  assert.match(reply, /A &amp; &lt;B&gt;/);
});

test('applyMutation: append adds new row', () => {
  const wl = [{ tender_id: 'UA-A', enabled: true, notes: 'A' }];
  const result = applyMutation(wl, {
    type: 'append',
    row: { tender_id: 'UA-B', enabled: true, notes: 'B' },
  });
  assert.equal(result.length, 2);
  assert.equal(result[1].tender_id, 'UA-B');
});

test('applyMutation: append does not mutate input', () => {
  const wl = [{ tender_id: 'UA-A', enabled: true }];
  const result = applyMutation(wl, {
    type: 'append',
    row: { tender_id: 'UA-B', enabled: true },
  });
  assert.equal(wl.length, 1);
  assert.notEqual(result, wl);
});

test('applyMutation: update changes only matching row', () => {
  const wl = [
    { tender_id: 'UA-A', enabled: false, notes: 'old' },
    { tender_id: 'UA-B', enabled: true, notes: 'B' },
  ];
  const result = applyMutation(wl, {
    type: 'update',
    tender_id: 'UA-A',
    fields: { enabled: true, notes: 'new' },
  });
  assert.deepEqual(result[0], { tender_id: 'UA-A', enabled: true, notes: 'new' });
  assert.deepEqual(result[1], wl[1]);
});

test('applyMutation: unknown type — returns input unchanged', () => {
  const wl = [{ tender_id: 'UA-A', enabled: true }];
  const result = applyMutation(wl, { type: 'wat' });
  assert.deepEqual(result, wl);
});

// --- handleAdd tests ---

const RAW_OK = {
  data: {
    tenderID: 'UA-2026-04-30-010542-a',
    title: 'Реактиви для лабораторії',
    status: 'active.tendering',
    tenderPeriod: { endDate: '2026-05-15T14:30:00+03:00' },
    procuringEntity: { name: 'КНП «Рівненська ОКЛ»', identifier: { id: '12345678' } },
    items: [],
  },
};
const ID = 'UA-2026-04-30-010542-a';

const mockDeps = async (overrides = {}) => ({
  watchlist: [],
  fetchTender: async () => RAW_OK,
  extractSnapshot: (await import('../prozorro.mjs')).extractSnapshot,
  ...overrides,
});

test('handleAdd: new tender, fetch OK → mutation:append + ✅ Додано', async () => {
  const result = await handleAdd(await mockDeps(), { tender_id: ID, notes: null });
  assert.match(result.reply, /✅ Додано/);
  assert.equal(result.mutation.type, 'append');
  assert.equal(result.mutation.row.tender_id, ID);
  assert.equal(result.mutation.row.enabled, true);
  assert.match(result.mutation.row.notes, /Рівненська ОКЛ/);
});

test('handleAdd: user notes override auto-notes', async () => {
  const result = await handleAdd(
    await mockDeps(),
    { tender_id: ID, notes: 'мій коментар' }
  );
  assert.equal(result.mutation.row.notes, 'мій коментар');
});

test('handleAdd: fetch 404 → ❌ + no mutation', async () => {
  const deps = await mockDeps({
    fetchTender: async () => { throw new Error('Prozorro summary 404: ' + ID); },
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: null });
  assert.match(result.reply, /❌/);
  assert.match(result.reply, /не знайдено/);
  assert.equal(result.mutation, null);
});

test('handleAdd: fetch "no UUID returned" → ❌ (treated as not-found)', async () => {
  const deps = await mockDeps({
    fetchTender: async () => { throw new Error('Prozorro: no UUID returned for ' + ID); },
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: null });
  assert.match(result.reply, /❌/);
  assert.equal(result.mutation, null);
});

test('handleAdd: fetch 5xx → ⚠️ + no mutation', async () => {
  const deps = await mockDeps({
    fetchTender: async () => { throw new Error('Prozorro summary 503: timeout'); },
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: null });
  assert.match(result.reply, /⚠️/);
  assert.match(result.reply, /Спробуй ще раз/);
  assert.equal(result.mutation, null);
});

test('handleAdd: already enabled → short-circuit, no fetch', async () => {
  let fetchCalled = false;
  const deps = await mockDeps({
    watchlist: [{ tender_id: ID, enabled: true, notes: 'old' }],
    fetchTender: async () => { fetchCalled = true; return RAW_OK; },
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: null });
  assert.match(result.reply, /⚠️ Вже моніторю/);
  assert.equal(result.mutation, null);
  assert.equal(fetchCalled, false);
});

test('handleAdd: previously disabled, fetch OK → re-enable + update + ✅ Поновив', async () => {
  const deps = await mockDeps({
    watchlist: [{ tender_id: ID, enabled: false, notes: 'auto-disabled: 404' }],
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: null });
  assert.match(result.reply, /✅ Поновив/);
  assert.equal(result.mutation.type, 'update');
  assert.equal(result.mutation.tender_id, ID);
  assert.equal(result.mutation.fields.enabled, true);
  assert.match(result.mutation.fields.notes, /Рівненська ОКЛ/);
  assert.doesNotMatch(result.mutation.fields.notes, /auto-disabled/);
});

test('handleAdd: previously disabled, fetch still 404 → no re-enable, ❌', async () => {
  const deps = await mockDeps({
    watchlist: [{ tender_id: ID, enabled: false, notes: 'auto-disabled: 404' }],
    fetchTender: async () => { throw new Error('Prozorro summary 404'); },
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: null });
  assert.match(result.reply, /❌/);
  assert.equal(result.mutation, null);
});

test('handleAdd: previously disabled, user-supplied notes used in update', async () => {
  const deps = await mockDeps({
    watchlist: [{ tender_id: ID, enabled: false, notes: 'auto-disabled: 404' }],
  });
  const result = await handleAdd(deps, { tender_id: ID, notes: 'мій новий коментар' });
  assert.equal(result.mutation.fields.notes, 'мій новий коментар');
});

test('parseCommand: /status', () => {
  assert.deepEqual(parseCommand('/status'), { cmd: 'status' });
});

test('parseCommand: /status with bot suffix', () => {
  assert.deepEqual(parseCommand('/status@my_bot'), { cmd: 'status' });
});

test('handleStatus: formats live status', () => {
  const reply = handleStatus({
    watchlist: [
      { tender_id: 'UA-A', enabled: true },
      { tender_id: 'UA-B', enabled: true },
      { tender_id: 'UA-C', enabled: false },
    ],
    sha: 'abc1234567890def',
  });
  assert.match(reply, /🟢 Worker live/);
  assert.match(reply, /Watchlist: 3 tenders \(2 active\)/);
  assert.match(reply, /sha abc1234/);
});

test('handleStatus: empty watchlist', () => {
  const reply = handleStatus({ watchlist: [], sha: '0000000' });
  assert.match(reply, /Watchlist: 0 tenders \(0 active\)/);
});
