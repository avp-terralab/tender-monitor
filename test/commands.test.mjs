import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand, buildAutoNotes, formatAddReply, handleList,
  applyMutation, handleAdd, handleStatus, handleRemove, formatInfo,
  abbreviateLegalForm, handleWatched, handleUnwatch, applyEntityMutation,
  handleWatch, handleInvite,
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
  assert.deepEqual(parseCommand('/delete UA-...'), { cmd: 'unknown' });
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

test('handleList: customer truncated to 150 chars', () => {
  const longCustomer = 'X'.repeat(200);
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: longCustomer }
  ]});
  assert.ok(reply.includes('X'.repeat(149) + '…'));
});

test('abbreviateLegalForm: КНП', () => {
  assert.equal(
    abbreviateLegalForm('Комунальне некомерційне підприємство «Центральна районна лікарня»'),
    'КНП «Центральна районна лікарня»'
  );
});

test('abbreviateLegalForm: КП', () => {
  assert.equal(
    abbreviateLegalForm('Комунальне підприємство «Київтепло»'),
    'КП «Київтепло»'
  );
});

test('abbreviateLegalForm: ТОВ', () => {
  assert.equal(
    abbreviateLegalForm('Товариство з обмеженою відповідальністю «ТерраЛаб»'),
    'ТОВ «ТерраЛаб»'
  );
});

test('abbreviateLegalForm: ДП', () => {
  assert.equal(
    abbreviateLegalForm('Державне підприємство «Укрзалізниця»'),
    'ДП «Укрзалізниця»'
  );
});

test('abbreviateLegalForm: ФОП (з тире)', () => {
  assert.equal(
    abbreviateLegalForm('Фізична особа-підприємець Іван Петренко'),
    'ФОП Іван Петренко'
  );
});

test('abbreviateLegalForm: longer КНП wins over short КП', () => {
  // The phrase starts with "Комунальне некомерційне підприємство" — must abbreviate to КНП, not КП
  assert.equal(
    abbreviateLegalForm('Комунальне некомерційне підприємство «Тест»'),
    'КНП «Тест»'
  );
});

test('abbreviateLegalForm: name without legal form returns unchanged', () => {
  assert.equal(abbreviateLegalForm('Acme Inc'), 'Acme Inc');
});

test('abbreviateLegalForm: empty/null returns unchanged', () => {
  assert.equal(abbreviateLegalForm(''), '');
  assert.equal(abbreviateLegalForm(null), null);
});

test('handleList: applies legal-form abbreviation to customer', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-A', enabled: true, notes: 'Комунальне некомерційне підприємство «Х» — Реактиви' }
  ]});
  assert.match(reply, /КНП «Х»/);
  assert.doesNotMatch(reply, /Комунальне/);
});

test('handleList: extracts customer from auto-format "entity — title"', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-A', enabled: true, notes: 'КНП «Рівненська ОКЛ» — Реактиви для лабораторії' }
  ]});
  assert.match(reply, /UA-A — КНП «Рівненська ОКЛ»/);
  assert.doesNotMatch(reply, /Реактиви/);
});

test('handleList: numbers entries 1, 2, 3 with blank line between', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-A', enabled: true },
    { tender_id: 'UA-B', enabled: true },
    { tender_id: 'UA-C', enabled: false },
  ]});
  assert.match(reply, /1\. 🟢 UA-A/);
  assert.match(reply, /2\. 🟢 UA-B/);
  assert.match(reply, /3\. 🔴 UA-C/);
  // Blank line between entries (\n\n)
  assert.match(reply, /UA-A\n\n2\. /);
  assert.match(reply, /UA-B\n\n3\. /);
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

test('parseCommand: /remove with valid id', () => {
  assert.deepEqual(
    parseCommand('/remove UA-2026-04-30-010542-a'),
    { cmd: 'remove', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /remove with bot suffix', () => {
  assert.deepEqual(
    parseCommand('/remove@my_bot UA-2026-04-30-010542-a'),
    { cmd: 'remove', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /remove without args → error', () => {
  assert.deepEqual(parseCommand('/remove'), { cmd: 'remove', error: 'missing_id' });
});

test('parseCommand: /remove invalid id → error', () => {
  assert.deepEqual(parseCommand('/remove bad-id'), { cmd: 'remove', error: 'invalid_id' });
});

test('parseCommand: /remove rejects extra args after id', () => {
  // /remove takes only id, no notes — extra text → invalid
  assert.deepEqual(
    parseCommand('/remove UA-2026-04-30-010542-a extra'),
    { cmd: 'remove', error: 'invalid_id' }
  );
});

test('handleRemove: existing tender → mutation:delete + ✅ Видалено', () => {
  const result = handleRemove(
    { watchlist: [{ tender_id: 'UA-X', enabled: true, notes: 'X' }] },
    { tender_id: 'UA-X' }
  );
  assert.match(result.reply, /✅ Видалено UA-X/);
  assert.match(result.reply, /Додати знову: \/add UA-X/);
  assert.deepEqual(result.mutation, { type: 'delete', tender_id: 'UA-X' });
});

test('handleRemove: not in watchlist → ❓ + no mutation', () => {
  const result = handleRemove(
    { watchlist: [{ tender_id: 'UA-Y', enabled: true }] },
    { tender_id: 'UA-X' }
  );
  assert.match(result.reply, /❓ UA-X не у watchlist/);
  assert.equal(result.mutation, null);
});

test('handleRemove: disabled tender still removable', () => {
  const result = handleRemove(
    { watchlist: [{ tender_id: 'UA-X', enabled: false, notes: 'auto-disabled: 404' }] },
    { tender_id: 'UA-X' }
  );
  assert.match(result.reply, /✅ Видалено/);
  assert.equal(result.mutation.type, 'delete');
});

test('applyMutation: delete removes the matching row', () => {
  const wl = [
    { tender_id: 'UA-A', enabled: true },
    { tender_id: 'UA-B', enabled: true },
    { tender_id: 'UA-C', enabled: false },
  ];
  const result = applyMutation(wl, { type: 'delete', tender_id: 'UA-B' });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.tender_id), ['UA-A', 'UA-C']);
});

test('applyMutation: delete on non-existent id → no change', () => {
  const wl = [{ tender_id: 'UA-A', enabled: true }];
  const result = applyMutation(wl, { type: 'delete', tender_id: 'UA-XX' });
  assert.deepEqual(result, wl);
});

test('parseCommand: /info', () => {
  assert.deepEqual(parseCommand('/info'), { cmd: 'info' });
});

test('parseCommand: /info with bot suffix', () => {
  assert.deepEqual(parseCommand('/info@my_bot'), { cmd: 'info' });
});

test('parseCommand: /info with trailing text → unknown', () => {
  assert.deepEqual(parseCommand('/info extra'), { cmd: 'unknown' });
});

const SAMPLE_GROUP = {
  tender_id: 'UA-2026-04-29-008605-a',
  prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-04-29-008605-a',
  status: 'active.qualification',
  deadline: '2026-05-07T01:00:00+03:00',
  procuring_entity: { name: 'КНП «Центральна районна лікарня»', edrpou: '33578224' },
  value: { amount: 800147, currency: 'UAH', valueAddedTaxIncluded: true },
  classification: { id: '72260000-5', description: 'Послуги, пов\'язані з програмним забезпеченням' },
  contact: { name: 'Дмитерчук Микола', email: 'mykola@ukr.net', telephone: '+380956623651' },
};

test('formatInfo: full entry contains all fields from spec', () => {
  const reply = formatInfo({
    runIso: '2026-05-08T13:00:00+03:00',
    groups: [SAMPLE_GROUP],
  });
  assert.match(reply, /📋 Статус тендерів \(13:00, 08\.05\.2026\)/);
  assert.match(reply, /1\. 🆔 Ідентифікатор закупівлі: <a href=".*">UA-2026-04-29-008605-a<\/a>/);
  assert.match(reply, /👥 Замовник: КНП «Центральна районна лікарня» \(ЄДРПОУ 33578224\)/);
  assert.match(reply, /🔖 ДК: 72260000-5 — Послуги, пов'язані з програмним забезпеченням/);
  assert.match(reply, /💰 Вартість: 800 147 UAH \(з ПДВ\)/);
  assert.match(reply, /📞 Дмитерчук Микола: \+380 95 662-36-51/);
  assert.match(reply, /✉️ mykola@ukr\.net/);
  assert.match(reply, /ℹ️ Статус: Розгляд пропозицій до 07\.05\.2026 до 01:00/);
});

test('formatInfo: empty groups → reply about no tenders', () => {
  const reply = formatInfo({ runIso: '2026-05-08T13:00:00+03:00', groups: [] });
  assert.match(reply, /📭 Немає активних тендерів/);
});

test('formatInfo: errors footer with failures', () => {
  const reply = formatInfo({
    runIso: '2026-05-08T13:00:00+03:00',
    groups: [],
    errors: [{ tender_id: 'UA-X', error: 'Prozorro 503' }],
  });
  assert.match(reply, /⚠️ не вдалось перевірити/);
  assert.match(reply, /UA-X — Prozorro 503/);
});

test('formatInfo: skips fields when null', () => {
  const minimal = {
    tender_id: 'UA-X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    status: 'active.tendering',
  };
  const reply = formatInfo({ runIso: '2026-05-08T13:00:00+03:00', groups: [minimal] });
  assert.match(reply, /UA-X/);
  assert.doesNotMatch(reply, /👥/);
  assert.doesNotMatch(reply, /🔖/);
  assert.doesNotMatch(reply, /💰/);
  assert.doesNotMatch(reply, /📞/);
});

test('formatInfo: multiple entries are numbered and separated by line', () => {
  const reply = formatInfo({
    runIso: '2026-05-08T13:00:00+03:00',
    groups: [
      { tender_id: 'UA-A', prozorro_url: 'https://prozorro.gov.ua/tender/UA-A', status: 'active.tendering' },
      { tender_id: 'UA-B', prozorro_url: 'https://prozorro.gov.ua/tender/UA-B', status: 'active.tendering' },
    ],
  });
  assert.match(reply, /1\. 🆔.*UA-A/s);
  assert.match(reply, /2\. 🆔.*UA-B/s);
  // Separator between entries
  assert.match(reply, /━{20,}/);
});

test('handleList: shows value when _value present on row', () => {
  const reply = handleList({ watchlist: [
    {
      tender_id: 'UA-A',
      enabled: true,
      notes: 'КНП «Х»',
      _value: { amount: 800147, currency: 'UAH', valueAddedTaxIncluded: true },
    },
  ]});
  assert.match(reply, /UA-A — КНП «Х» — 800 147 UAH/);
});

test('handleList: omits value if _value missing (e.g. failed fetch)', () => {
  const reply = handleList({ watchlist: [
    { tender_id: 'UA-A', enabled: true, notes: 'КНП «Х»' },
  ]});
  assert.match(reply, /UA-A — КНП «Х»\n\nВсього/);
  assert.doesNotMatch(reply, /UAH/);
});

test('formatAddReply: abbreviates entity legal form', () => {
  const reply = formatAddReply(
    {
      tender_id: 'UA-X',
      title: 'Послуги',
      status: 'active.tendering',
      tenderPeriod: { endDate: '2026-05-15T14:30:00+03:00' },
      procuringEntity: { name: 'Товариство з обмеженою відповідальністю «ТерраЛаб»' },
    },
    { reEnable: false }
  );
  assert.match(reply, /👥 ТОВ «ТерраЛаб»/);
  assert.doesNotMatch(reply, /Товариство з обмеженою/);
});

test('formatInfo: abbreviates entity in 👥 line', () => {
  const reply = formatInfo({
    runIso: '2026-05-08T13:00:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.tendering',
      procuring_entity: { name: 'Комунальне підприємство «Київтепло»', edrpou: '11111111' },
    }],
  });
  assert.match(reply, /👥 Замовник: КП «Київтепло»/);
  assert.doesNotMatch(reply, /Комунальне підприємство/);
});

test('parseCommand: /watched', () => {
  assert.deepEqual(parseCommand('/watched'), { cmd: 'watched' });
});

test('parseCommand: /watched with bot suffix', () => {
  assert.deepEqual(parseCommand('/watched@my_bot'), { cmd: 'watched' });
});

test('parseCommand: /watch with valid EDRPOU', () => {
  assert.deepEqual(parseCommand('/watch 12345678'), { cmd: 'watch', edrpou: '12345678' });
});

test('parseCommand: /watch with bot suffix', () => {
  assert.deepEqual(parseCommand('/watch@my_bot 12345678'), { cmd: 'watch', edrpou: '12345678' });
});

test('parseCommand: /watch without args → error', () => {
  assert.deepEqual(parseCommand('/watch'), { cmd: 'watch', error: 'missing_edrpou' });
});

test('parseCommand: /watch with non-8-digit → error', () => {
  assert.deepEqual(parseCommand('/watch 12345'), { cmd: 'watch', error: 'invalid_edrpou' });
  assert.deepEqual(parseCommand('/watch 123456789'), { cmd: 'watch', error: 'invalid_edrpou' });
  assert.deepEqual(parseCommand('/watch abcdefgh'), { cmd: 'watch', error: 'invalid_edrpou' });
});

test('parseCommand: /unwatch with valid EDRPOU', () => {
  assert.deepEqual(parseCommand('/unwatch 12345678'), { cmd: 'unwatch', edrpou: '12345678' });
});

test('parseCommand: /unwatch without args → error', () => {
  assert.deepEqual(parseCommand('/unwatch'), { cmd: 'unwatch', error: 'missing_edrpou' });
});

test('parseCommand: /unwatch invalid → error', () => {
  assert.deepEqual(parseCommand('/unwatch 12345'), { cmd: 'unwatch', error: 'invalid_edrpou' });
});

test('handleWatched: empty list', () => {
  assert.match(handleWatched({ watchedEntities: [] }), /порожн|жодним/i);
});

test('handleWatched: list with entities and abbreviation', () => {
  const reply = handleWatched({ watchedEntities: [
    { edrpou: '02000010', name: 'Комунальне підприємство «Х»', enabled: true },
    { edrpou: '11111111', name: '(unknown)', enabled: true },
  ]});
  assert.match(reply, /1\. 🟢 02000010 — КП «Х»/);
  assert.match(reply, /2\. 🟢 11111111$/m);
  assert.match(reply, /Всього: 2/);
});

test('handleUnwatch: existing → mutation:delete_entity + ✅', () => {
  const result = handleUnwatch(
    { watchedEntities: [{ edrpou: '02000010', name: 'Test', enabled: true }] },
    { edrpou: '02000010' }
  );
  assert.match(result.reply, /✅ Прибрав 02000010/);
  assert.deepEqual(result.mutation, { type: 'delete_entity', edrpou: '02000010' });
});

test('handleUnwatch: not in list → ❓ + null mutation', () => {
  const result = handleUnwatch(
    { watchedEntities: [] },
    { edrpou: '02000010' }
  );
  assert.match(result.reply, /❓ 02000010 не у watched/);
  assert.equal(result.mutation, null);
});

test('applyEntityMutation: append', () => {
  const wl = [{ edrpou: '11111111', enabled: true }];
  const result = applyEntityMutation(wl, {
    type: 'append',
    row: { edrpou: '22222222', enabled: true },
  });
  assert.equal(result.length, 2);
  assert.equal(result[1].edrpou, '22222222');
});

test('applyEntityMutation: delete_entity', () => {
  const wl = [
    { edrpou: '11111111', enabled: true },
    { edrpou: '22222222', enabled: true },
  ];
  const result = applyEntityMutation(wl, { type: 'delete_entity', edrpou: '11111111' });
  assert.equal(result.length, 1);
  assert.equal(result[0].edrpou, '22222222');
});

test('applyEntityMutation: unknown type → unchanged', () => {
  const wl = [{ edrpou: '11111111', enabled: true }];
  const result = applyEntityMutation(wl, { type: 'foo' });
  assert.deepEqual(result, wl);
});

test('handleWatch: existing edrpou → ⚠️ no mutation', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [{ edrpou: '11111111', name: 'X', enabled: true }],
      fetchTendersFeed: async () => ({ items: [], next: null }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (r) => r.data,
    },
    { edrpou: '11111111' }
  );
  assert.match(result.reply, /⚠️ Вже стежу/);
  assert.equal(result.mutation, null);
});

test('handleWatch: new EDRPOU + feed has matches + active.tendering → bootstrap with ids', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({
        items: [
          { tenderID: 'UA-OPEN', procuringEntity: { identifier: { id: '11111111' }, name: 'КНП Тест' } },
          { tenderID: 'UA-CLOSED', procuringEntity: { identifier: { id: '11111111' } } },
        ],
        next: null,
      }),
      fetchTender: async (id) => ({
        data: {
          tenderID: id,
          status: id === 'UA-OPEN' ? 'active.tendering' : 'complete',
          procuringEntity: { name: 'КНП Тест', identifier: { id: '11111111' } },
          items: [],
        },
      }),
      extractSnapshot: (r) => r.data,
    },
    { edrpou: '11111111' }
  );
  assert.match(result.reply, /✅ Стежу за 11111111/);
  assert.match(result.reply, /КНП Тест/);
  assert.match(result.reply, /1 активних тендерів/);
  assert.equal(result.mutation.type, 'append');
  assert.equal(result.mutation.row.edrpou, '11111111');
  assert.equal(result.mutation.row.name, 'КНП Тест');
  assert.equal(result.mutation.row.enabled, true);
  assert.deepEqual(result.mutation.bootstrap, { edrpou: '11111111', ids: ['UA-OPEN'] });
});

test('handleWatch: new EDRPOU + feed has zero matches → warn but accept', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({
        items: [{ tenderID: 'UA-OTHER', procuringEntity: { identifier: { id: '99999999' } } }],
        next: null,
      }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (r) => r.data,
    },
    { edrpou: '11111111' }
  );
  assert.match(result.reply, /✅ 11111111 збережено/);
  assert.match(result.reply, /нормально, якщо замовник публікує рідко/i);
  assert.equal(result.mutation.type, 'append');
  assert.equal(result.mutation.row.edrpou, '11111111');
  assert.equal(result.mutation.row.name, '(unknown)');
  assert.deepEqual(result.mutation.bootstrap, { edrpou: '11111111', ids: [] });
});

test('handleWatch: feed throws → ⚠️ + null mutation', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => { throw new Error('Prozorro 503'); },
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (r) => r.data,
    },
    { edrpou: '11111111' }
  );
  assert.match(result.reply, /⚠️ Не зміг перевірити EDRPOU/);
  assert.equal(result.mutation, null);
});

test('parseCommand: /info with valid tender_id', () => {
  assert.deepEqual(
    parseCommand('/info UA-2026-04-30-010542-a'),
    { cmd: 'info', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /info with bot suffix and id', () => {
  assert.deepEqual(
    parseCommand('/info@my_bot UA-2026-04-30-010542-a'),
    { cmd: 'info', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /info normalizes uppercase suffix to lowercase', () => {
  assert.deepEqual(
    parseCommand('/info UA-2026-04-30-010542-A'),
    { cmd: 'info', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /info bad-id → unknown (strict)', () => {
  assert.deepEqual(parseCommand('/info bad-id'), { cmd: 'unknown' });
});

test('formatAddReply: countdown line when nowIso provided and deadline future', () => {
  const reply = formatAddReply(FULL_SNAP, {
    reEnable: false,
    nowIso: '2026-05-15T11:30:00+03:00', // FULL_SNAP deadline 14:30 same day → 3h
  });
  assert.match(reply, /⏰ Залишилось:.*3 год/);
});

test('formatAddReply: no countdown line when nowIso missing', () => {
  const reply = formatAddReply(FULL_SNAP, { reEnable: false });
  assert.doesNotMatch(reply, /⏰ Залишилось/);
});

test('formatAddReply: no countdown when deadline missing', () => {
  const reply = formatAddReply(
    { ...FULL_SNAP, tenderPeriod: null },
    { reEnable: false, nowIso: '2026-05-15T11:30:00+03:00' }
  );
  assert.doesNotMatch(reply, /⏰ Залишилось/);
});

test('formatInfo: countdown ⏰ Залишилось appears when runIso < deadline', () => {
  const reply = formatInfo({
    runIso: '2026-05-15T11:30:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.tendering',
      deadline: '2026-05-15T14:30:00+03:00', // 3h ahead
    }],
  });
  assert.match(reply, /⏰ Залишилось:.*3 год/);
});

test('formatInfo: countdown shows "минув" for past deadline', () => {
  const reply = formatInfo({
    runIso: '2026-05-15T15:30:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.qualification',
      deadline: '2026-05-15T14:30:00+03:00', // 1h ago
    }],
  });
  assert.match(reply, /⏰ Залишилось:.*минув/);
});

test('handleAdd: passes nowIso through deps to formatAddReply countdown', async () => {
  const result = await handleAdd(
    await mockDeps({
      nowIso: '2026-05-15T11:30:00+03:00', // 3h before RAW_OK deadline 14:30
    }),
    { tender_id: ID, notes: null }
  );
  assert.match(result.reply, /⏰ Залишилось:.*3 год/);
});

test('handleWatch: fetchTender failure during bootstrap is silently skipped', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({
        items: [{ tenderID: 'UA-X', procuringEntity: { identifier: { id: '11111111' }, name: 'Замовник' } }],
        next: null,
      }),
      fetchTender: async () => { throw new Error('Prozorro 404'); },
      extractSnapshot: (r) => r.data,
    },
    { edrpou: '11111111' }
  );
  // Reply still positive (entity name from feed match)
  assert.match(result.reply, /✅ Стежу за 11111111/);
  assert.equal(result.mutation.row.name, 'Замовник');
  // Bootstrap ids empty since fetch failed
  assert.deepEqual(result.mutation.bootstrap.ids, []);
});

test('parseCommand: /invite with label', () => {
  assert.deepEqual(parseCommand('/invite Olha'), { cmd: 'invite', label: 'Olha' });
});

test('parseCommand: /invite with multi-word label', () => {
  assert.deepEqual(parseCommand('/invite Olha Petrenko'), { cmd: 'invite', label: 'Olha Petrenko' });
});

test('parseCommand: /invite with Cyrillic label', () => {
  assert.deepEqual(parseCommand('/invite Ольга'), { cmd: 'invite', label: 'Ольга' });
});

test('parseCommand: /invite without label → error', () => {
  assert.deepEqual(parseCommand('/invite'), { cmd: 'invite', error: 'missing_label' });
});

test('parseCommand: /invite with bot suffix', () => {
  assert.deepEqual(parseCommand('/invite@my_bot Olha'), { cmd: 'invite', label: 'Olha' });
});

test('parseCommand: /invite trims label whitespace', () => {
  assert.deepEqual(parseCommand('/invite   Olha   '), { cmd: 'invite', label: 'Olha' });
});

test('parseCommand: /invites', () => {
  assert.deepEqual(parseCommand('/invites'), { cmd: 'invites' });
});

test('parseCommand: /invites with bot suffix', () => {
  assert.deepEqual(parseCommand('/invites@my_bot'), { cmd: 'invites' });
});

test('parseCommand: /users', () => {
  assert.deepEqual(parseCommand('/users'), { cmd: 'users' });
});

test('parseCommand: /users with bot suffix', () => {
  assert.deepEqual(parseCommand('/users@my_bot'), { cmd: 'users' });
});

test('parseCommand: /revoke with numeric chat_id', () => {
  assert.deepEqual(parseCommand('/revoke 123456789'), { cmd: 'revoke', chat_id: '123456789' });
});

test('parseCommand: /revoke with bot suffix', () => {
  assert.deepEqual(parseCommand('/revoke@my_bot 123'), { cmd: 'revoke', chat_id: '123' });
});

test('parseCommand: /revoke without arg → error', () => {
  assert.deepEqual(parseCommand('/revoke'), { cmd: 'revoke', error: 'missing_chat_id' });
});

test('parseCommand: /revoke with non-numeric → error', () => {
  assert.deepEqual(parseCommand('/revoke abc'), { cmd: 'revoke', error: 'invalid_chat_id' });
});

test('parseCommand: /start without payload', () => {
  assert.deepEqual(parseCommand('/start'), { cmd: 'start' });
});

test('parseCommand: /start with token payload', () => {
  const tok = 'a'.repeat(32);
  assert.deepEqual(parseCommand(`/start ${tok}`), { cmd: 'start', token: tok });
});

test('parseCommand: /start with invalid token (wrong length)', () => {
  assert.deepEqual(parseCommand('/start abc'), { cmd: 'start', error: 'invalid_token' });
});

test('parseCommand: /start with bot suffix and token', () => {
  const tok = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(parseCommand(`/start@my_bot ${tok}`), { cmd: 'start', token: tok });
});

test('handleInvite: creates invite with given label, 7-day expiry, returns deep-link', () => {
  const result = handleInvite({
    invites: [],
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-12T10:00:00Z'),
    botUsername: 'terralab_tenders_bot',
  }, { label: 'Olha' });
  assert.equal(result.mutation.type, 'append_invite');
  assert.equal(result.mutation.row.token, 'a'.repeat(32));
  assert.equal(result.mutation.row.label, 'Olha');
  assert.equal(result.mutation.row.status, 'pending');
  assert.equal(result.mutation.row.created_at, '2026-05-12T10:00:00.000Z');
  assert.equal(result.mutation.row.expires_at, '2026-05-19T10:00:00.000Z');
  assert.equal(result.mutation.row.redeemed_by, null);
  assert.equal(result.mutation.row.redeemed_at, null);
  assert.match(result.reply, /t\.me\/terralab_tenders_bot\?start=a{32}/);
  assert.match(result.reply, /Olha/);
  assert.match(result.reply, /7 днів/);
});
