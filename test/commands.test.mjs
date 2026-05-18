import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand, buildAutoNotes, formatAddReply,
  applyMutation, handleAdd, handleStatus, handleRemove, formatInfo,
  abbreviateLegalForm, handleWatched, handleUnwatch, applyEntityMutation,
  handleWatch, handleInvite, applyInviteMutation, applyAllowedUsersMutation,
  handleRedeem, handleRevoke, handleUsersList, handleInvitesList, HELP_TEXT,
  applyArchiveMutation, handleArchive, handleArchiveDetail,
  handleUnarchive,
} from '../commands.mjs';

test('parseCommand: /list is treated as unknown after removal', () => {
  assert.deepEqual(parseCommand('/list'), { cmd: 'unknown' });
});

test('parseCommand: /help reject trailing text (strict)', () => {
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
  assert.deepEqual(parseCommand('  /help  '), { cmd: 'help' });
});

test('parseCommand: reply-keyboard button labels alias to commands', () => {
  assert.deepEqual(parseCommand('📋 Моніторинг закупівель'), { cmd: 'info' });
  assert.deepEqual(parseCommand('👁 Моніторинг замовників'), { cmd: 'watched' });
  assert.deepEqual(parseCommand('📦 Архів закупівель'), { cmd: 'archive' });
  assert.deepEqual(parseCommand('❓ Допомога (список команд)'), { cmd: 'help' });
});

test('parseCommand: button labels tolerate surrounding whitespace', () => {
  assert.deepEqual(parseCommand('  📋 Моніторинг закупівель  '), { cmd: 'info' });
});

test('parseCommand: free text that just contains an emoji stays null', () => {
  assert.deepEqual(parseCommand('📋'), { cmd: null });
  assert.deepEqual(parseCommand('Моніторинг'), { cmd: null });
});

test('parseCommand: /menu → cmd: menu', () => {
  assert.deepEqual(parseCommand('/menu'), { cmd: 'menu' });
  assert.deepEqual(parseCommand('/menu@my_bot'), { cmd: 'menu' });
  assert.deepEqual(parseCommand('  /menu  '), { cmd: 'menu' });
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
  assert.match(reply, /⏰ Подача пропозиції до: 15\.05\.2026 до 14:30/);
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

test('abbreviateLegalForm: КНП — accepts "некомерцийне" typo from Prozorro registry', () => {
  // Real example: EDRPOU 01985423 — Prozorro stores "некомерцийне" (и instead of і)
  assert.equal(
    abbreviateLegalForm('Комунальне некомерцийне підприємство «Тест»'),
    'КНП «Тест»'
  );
});

test('abbreviateLegalForm: КНП — accepts "товариство" alt form (still semantically КНП)', () => {
  // Real example: EDRPOU 01985423 — "Дніпропетровська обласна клінічна лікарня"
  // registered as "товариство" instead of standard "підприємство"
  assert.equal(
    abbreviateLegalForm('Комунальне некомерційне товариство «Тест»'),
    'КНП «Тест»'
  );
  assert.equal(
    abbreviateLegalForm('Комунальне некомерцийне товариство "Дніпропетровська обласна клінічна лікарня ім. І. І. Мечникова"'),
    'КНП "Дніпропетровська обласна клінічна лікарня ім. І. І. Мечникова"'
  );
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

test('abbreviateLegalForm: leading/trailing whitespace does not block matching (Prozorro registry quirk)', () => {
  assert.equal(
    abbreviateLegalForm(' Комунальне підприємство "Балтська багатопрофільна лікарня" Балтської міської ради'),
    'КП "Балтська багатопрофільна лікарня" Балтської міської ради',
  );
  assert.equal(
    abbreviateLegalForm('Товариство з обмеженою відповідальністю «ТерраЛаб»  '),
    'ТОВ «ТерраЛаб»',
  );
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
  status: 'active.tendering',
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
  assert.match(reply, /━+ 1 ━+/);
  assert.match(reply, /🆔 Ідентифікатор закупівлі: <a href=".*">UA-2026-04-29-008605-a<\/a>/);
  assert.match(reply, /👥 Замовник: КНП «Центральна районна лікарня» \(ЄДРПОУ 33578224\)/);
  assert.match(reply, /🔖 ДК: 72260000-5 — Послуги, пов'язані з програмним забезпеченням/);
  assert.match(reply, /💰 Вартість: 800 147 UAH \(з ПДВ\)/);
  assert.match(reply, /📞 Дмитерчук Микола: \+380 95 662-36-51/);
  assert.match(reply, /✉️ mykola@ukr\.net/);
  assert.match(reply, /ℹ️ Статус: Приймання пропозицій\n⏰ Подача пропозиції до: 07\.05\.2026 до 01:00/);
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

test('formatInfo: each entry preceded by ━ N ━ header (number in separator)', () => {
  const reply = formatInfo({
    runIso: '2026-05-08T13:00:00+03:00',
    groups: [
      { tender_id: 'UA-A', prozorro_url: 'https://prozorro.gov.ua/tender/UA-A', status: 'active.tendering' },
      { tender_id: 'UA-B', prozorro_url: 'https://prozorro.gov.ua/tender/UA-B', status: 'active.tendering' },
    ],
  });
  assert.match(reply, /━+ 1 ━+\n🆔.*UA-A/s);
  assert.match(reply, /━+ 2 ━+\n🆔.*UA-B/s);
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

test('handleWatched: empty-list reply uses [EDRPOU], not <EDRPOU> (HTML parse_mode safety)', () => {
  // <EDRPOU> would be parsed by Telegram as an invalid tag → Bad Request →
  // sendReply silently catches → user sees nothing.
  const reply = handleWatched({ watchedEntities: [] });
  assert.doesNotMatch(reply, /<[A-Za-z]/);
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

test('handleWatch: new EDRPOU + feed has zero matches but search resolves name → name saved', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({
        items: [{ tenderID: 'UA-OTHER', procuringEntity: { identifier: { id: '99999999' } } }],
        next: null,
      }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (r) => r.data,
      searchTenderByEdrpou: async () => ({ name: 'Одеський національний університет' }),
    },
    { edrpou: '02071091' }
  );
  assert.match(result.reply, /Стежу за 02071091/);
  assert.match(result.reply, /Одеський|ОНУ/);
  assert.equal(result.mutation.row.name, 'Одеський національний університет');
  // Still no bootstrapped ids because feed walk found no active tender
  assert.deepEqual(result.mutation.bootstrap.ids, []);
});

test('handleWatch: new EDRPOU + feed empty + search returns null → falls back to "(unknown)"', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({ items: [], next: null }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (r) => r.data,
      searchTenderByEdrpou: async () => ({ name: null }),
    },
    { edrpou: '11111111' }
  );
  assert.match(result.reply, /✅ 11111111 збережено/);
  assert.match(result.reply, /нормально, якщо замовник публікує рідко/i);
  assert.equal(result.mutation.row.name, '(unknown)');
});

test('handleWatch: feed has matches → does NOT call searchTenderByEdrpou (feed name is authoritative)', async () => {
  let searchCalled = false;
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({
        items: [{
          tenderID: 'UA-MATCH',
          procuringEntity: { identifier: { id: '11111111' }, name: 'Замовник з feed' },
        }],
        next: null,
      }),
      fetchTender: async () => ({
        data: { tenderID: 'UA-MATCH', status: 'complete', procuringEntity: { identifier: { id: '11111111' } } },
      }),
      extractSnapshot: (r) => r.data,
      searchTenderByEdrpou: async () => { searchCalled = true; return { name: 'Searched' }; },
    },
    { edrpou: '11111111' }
  );
  assert.equal(searchCalled, false);
  assert.equal(result.mutation.row.name, 'Замовник з feed');
});

test('handleWatch: search dep not provided → falls back to "(unknown)" without crashing', async () => {
  const result = await handleWatch(
    {
      watchedEntities: [],
      fetchTendersFeed: async () => ({ items: [], next: null }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (r) => r.data,
      // no searchTenderByEdrpou
    },
    { edrpou: '11111111' }
  );
  assert.equal(result.mutation.row.name, '(unknown)');
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

test('formatAddReply: deadline line for active.tendering', () => {
  const reply = formatAddReply(FULL_SNAP, { reEnable: false });
  assert.match(reply, /⏰ Подача пропозиції до: 15\.05\.2026 до 14:30/);
});

test('formatAddReply: no deadline line when deadline missing', () => {
  const reply = formatAddReply(
    { ...FULL_SNAP, tenderPeriod: null },
    { reEnable: false }
  );
  assert.doesNotMatch(reply, /⏰ Подача пропозиції/);
});

test('formatInfo: deadline line for active.tendering', () => {
  const reply = formatInfo({
    runIso: '2026-05-15T11:30:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.tendering',
      deadline: '2026-05-15T14:30:00+03:00',
    }],
  });
  assert.match(reply, /⏰ Подача пропозиції до: 15\.05\.2026 до 14:30/);
});

test('formatInfo: no deadline/countdown when status != active.tendering', () => {
  // tenderPeriod.endDate is only meaningful while submissions are open.
  // For active.awarded / active.qualification / complete / cancelled — the
  // submission deadline is in the past and showing it is misleading.
  const reply = formatInfo({
    runIso: '2026-05-15T15:30:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.awarded',
      deadline: '2026-04-30T00:00:00+03:00',
    }],
  });
  assert.match(reply, /ℹ️ Статус: Очікування підписання договору/);
  assert.doesNotMatch(reply, /Подача пропозиції/);
  assert.doesNotMatch(reply, /30\.04\.2026/);
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

test('parseCommand: /invite without role keyword → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite Olha'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite multi-word without role keyword → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite Olha Petrenko'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite Cyrillic without role keyword → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite Ольга'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite without args → missing_role', () => {
  assert.deepEqual(parseCommand('/invite'), { cmd: 'invite', error: 'missing_role' });
});

test('parseCommand: /invite with bot suffix but no role keyword → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite@my_bot Olha'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite trims whitespace, no role keyword → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite   Olha   '), { cmd: 'invite', error: 'invalid_role' });
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

test('handleInvite: escapes HTML in label', () => {
  const result = handleInvite({
    invites: [],
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-12T10:00:00Z'),
    botUsername: 'terralab_tenders_bot',
  }, { role: 'viewer', label: '<script>&"' });
  assert.match(result.reply, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(result.reply, /<script>/);
  assert.equal(result.mutation.row.label, '<script>&"'); // raw label stored, only display escaped
});

test('handleInvite: creates invite with given label, 7-day expiry, returns deep-link', () => {
  const result = handleInvite({
    invites: [],
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-12T10:00:00Z'),
    botUsername: 'terralab_tenders_bot',
  }, { role: 'viewer', label: 'Olha' });
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

test('applyInviteMutation: append_invite adds row', () => {
  const row = { token: 'a'.repeat(32), label: 'X', status: 'pending' };
  assert.deepEqual(
    applyInviteMutation([], { type: 'append_invite', row }),
    [row]
  );
});

test('applyInviteMutation: update_invite_status changes status', () => {
  const existing = [
    { token: 't1', label: 'A', status: 'pending', redeemed_by: null, redeemed_at: null },
    { token: 't2', label: 'B', status: 'pending', redeemed_by: null, redeemed_at: null },
  ];
  const result = applyInviteMutation(existing, {
    type: 'update_invite_status',
    token: 't1',
    fields: { status: 'redeemed', redeemed_by: '999', redeemed_at: '2026-05-12T10:00:00Z' },
  });
  assert.equal(result[0].status, 'redeemed');
  assert.equal(result[0].redeemed_by, '999');
  assert.equal(result[1].status, 'pending'); // unchanged
});

test('applyAllowedUsersMutation: append_user adds row', () => {
  const row = { chat_id: '123', label: 'X', invited_via: 'X', added_at: '2026-05-12T10:00:00Z' };
  assert.deepEqual(
    applyAllowedUsersMutation([], { type: 'append_user', row }),
    [row]
  );
});

test('applyAllowedUsersMutation: remove_user filters by chat_id', () => {
  const users = [
    { chat_id: '1', label: 'A' },
    { chat_id: '2', label: 'B' },
  ];
  const result = applyAllowedUsersMutation(users, { type: 'remove_user', chat_id: '1' });
  assert.deepEqual(result, [{ chat_id: '2', label: 'B' }]);
});

test('applyAllowedUsersMutation: remove_user non-existent id — no change', () => {
  const users = [{ chat_id: '1', label: 'A' }];
  const result = applyAllowedUsersMutation(users, { type: 'remove_user', chat_id: '999' });
  assert.deepEqual(result, users);
});

test('applyInviteMutation: append does not mutate input', () => {
  const invites = [];
  const result = applyInviteMutation(invites, {
    type: 'append_invite',
    row: { token: 'a'.repeat(32), label: 'X' },
  });
  assert.notEqual(result, invites);
  assert.equal(invites.length, 0);
});

test('applyAllowedUsersMutation: append does not mutate input', () => {
  const users = [];
  const result = applyAllowedUsersMutation(users, {
    type: 'append_user',
    row: { chat_id: '1', label: 'A' },
  });
  assert.notEqual(result, users);
  assert.equal(users.length, 0);
});

test('applyInviteMutation: unknown type — returns input unchanged', () => {
  const invites = [{ token: 't1', label: 'A' }];
  const result = applyInviteMutation(invites, { type: 'no_such_op' });
  assert.equal(result, invites);
});

test('applyAllowedUsersMutation: unknown type — returns input unchanged', () => {
  const users = [{ chat_id: '1', label: 'A' }];
  const result = applyAllowedUsersMutation(users, { type: 'no_such_op' });
  assert.equal(result, users);
});

test('handleRedeem: valid pending token → both mutations + reply + adminNotice', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    created_at: '2026-05-10T10:00:00Z',
    expires_at: '2026-05-17T10:00:00Z',
    redeemed_by: null,
    redeemed_at: null,
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });

  assert.equal(result.inviteMutation.type, 'update_invite_status');
  assert.equal(result.inviteMutation.token, 'a'.repeat(32));
  assert.equal(result.inviteMutation.fields.status, 'redeemed');
  assert.equal(result.inviteMutation.fields.redeemed_by, '555');
  assert.equal(result.inviteMutation.fields.redeemed_at, '2026-05-12T10:00:00.000Z');

  assert.equal(result.userMutation.type, 'append_user');
  assert.equal(result.userMutation.row.chat_id, '555');
  assert.equal(result.userMutation.row.label, 'Olha');
  assert.equal(result.userMutation.row.invited_via, 'Olha');
  assert.equal(result.userMutation.row.added_at, '2026-05-12T10:00:00.000Z');

  assert.match(result.reply, /✅/);
  assert.match(result.reply, /Olha/);
  assert.match(result.adminNotice, /🆕/);
  assert.match(result.adminNotice, /Olha/);
  assert.match(result.adminNotice, /555/);
});

test('handleRedeem: token not found', () => {
  const result = handleRedeem({
    invites: [],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.equal(result.adminNotice, null);
  assert.match(result.reply, /Невалідне посилання/);
});

test('handleRedeem: token already redeemed', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'redeemed',
    expires_at: '2026-05-17T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.match(result.reply, /вже використане/);
});

test('handleRedeem: token expired', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    expires_at: '2026-05-01T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.match(result.reply, /застаріло/);
});

test('handleRedeem: user already in allowlist → no consume, "вже маєш доступ"', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    expires_at: '2026-05-17T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [{ chat_id: '555', label: 'Already' }],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.match(result.reply, /вже маєш доступ/);
});

test('handleRedeem: admin redeems own token → "вже маєш доступ", no consume', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Self',
    status: 'pending',
    expires_at: '2026-05-17T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '1744078008',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.match(result.reply, /вже маєш доступ/);
});

test('handleRevoke: removes user', () => {
  const users = [
    { chat_id: '1', label: 'A' },
    { chat_id: '2', label: 'B' },
  ];
  const result = handleRevoke({ allowedUsers: users, adminChatId: '99' }, { chat_id: '1' });
  assert.deepEqual(result.mutation, { type: 'remove_user', chat_id: '1' });
  assert.match(result.reply, /✅/);
  assert.match(result.reply, /A/);
});

test('handleRevoke: refuses to remove admin', () => {
  const result = handleRevoke({ allowedUsers: [], adminChatId: '99' }, { chat_id: '99' });
  assert.equal(result.mutation, null);
  assert.match(result.reply, /Не можу видалити адміна/);
});

test('handleRevoke: chat_id not in allowlist', () => {
  const result = handleRevoke({ allowedUsers: [{ chat_id: '1' }], adminChatId: '99' }, { chat_id: '7' });
  assert.equal(result.mutation, null);
  assert.match(result.reply, /не у allowlist/);
});

test('handleUsersList: empty → only admin row', () => {
  const reply = handleUsersList({
    allowedUsers: [],
    adminChatId: '1744078008',
  });
  assert.match(reply, /1744078008/);
  assert.match(reply, /admin/i);
  assert.match(reply, /Всього: 1/);
});

test('handleUsersList: with users', () => {
  const reply = handleUsersList({
    allowedUsers: [
      { chat_id: '111', label: 'Olha', invited_via: 'Olha', added_at: '2026-05-10T10:00:00Z' },
      { chat_id: '222', label: '(migrated)', invited_via: null, added_at: '2026-05-11T10:00:00Z' },
    ],
    adminChatId: '999',
  });
  assert.match(reply, /999/);
  assert.match(reply, /111/);
  assert.match(reply, /Olha/);
  assert.match(reply, /222/);
  assert.match(reply, /Всього: 3/);
});

test('handleInvitesList: empty', () => {
  const reply = handleInvitesList({
    invites: [],
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  assert.match(reply, /Немає активних invite/);
});

test('handleInvitesList: shows only pending non-expired', () => {
  const invites = [
    { token: 'a'.repeat(32), label: 'Pending1', status: 'pending', created_at: '2026-05-11T10:00:00Z', expires_at: '2026-05-18T10:00:00Z' },
    { token: 'b'.repeat(32), label: 'Redeemed', status: 'redeemed', created_at: '2026-05-10T10:00:00Z', expires_at: '2026-05-17T10:00:00Z' },
    { token: 'c'.repeat(32), label: 'Expired',  status: 'pending', created_at: '2026-04-01T10:00:00Z', expires_at: '2026-04-08T10:00:00Z' },
  ];
  const reply = handleInvitesList({
    invites,
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  assert.match(reply, /Pending1/);
  assert.doesNotMatch(reply, /Redeemed/);
  assert.doesNotMatch(reply, /Expired/);
  assert.match(reply, new RegExp('a'.repeat(6)));
});

test('HELP_TEXT mentions admin commands', () => {
  assert.match(HELP_TEXT, /\/invite/);
  assert.match(HELP_TEXT, /\/users/);
  assert.match(HELP_TEXT, /\/revoke/);
});

test('parseCommand: /archive (no arg)', () => {
  assert.deepEqual(parseCommand('/archive'), { cmd: 'archive' });
});

test('parseCommand: /archive with bot suffix', () => {
  assert.deepEqual(parseCommand('/archive@my_bot'), { cmd: 'archive' });
});

test('parseCommand: /archive UA-...', () => {
  assert.deepEqual(
    parseCommand('/archive UA-2026-04-30-010542-a'),
    { cmd: 'archive', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /archive normalizes uppercase suffix', () => {
  assert.deepEqual(
    parseCommand('/archive UA-2026-04-30-010542-A'),
    { cmd: 'archive', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /archive with invalid arg', () => {
  assert.deepEqual(parseCommand('/archive garbage'), { cmd: 'unknown' });
});

test('parseCommand: /contract is treated as unknown after removal', () => {
  assert.deepEqual(parseCommand('/contract UA-2026-04-30-010542-a'), { cmd: 'unknown' });
});

test('parseCommand: /unarchive requires id', () => {
  assert.deepEqual(parseCommand('/unarchive'), { cmd: 'unarchive', error: 'missing_id' });
});

test('parseCommand: /unarchive with valid id', () => {
  assert.deepEqual(
    parseCommand('/unarchive UA-2026-04-30-010542-a'),
    { cmd: 'unarchive', tender_id: 'UA-2026-04-30-010542-a' }
  );
});

test('parseCommand: /unarchive with invalid id', () => {
  assert.deepEqual(parseCommand('/unarchive xxx'), { cmd: 'unarchive', error: 'invalid_id' });
});

test('applyArchiveMutation: append_archive', () => {
  const result = applyArchiveMutation([], {
    type: 'append_archive',
    row: { tender_id: 'UA-2026-04-30-010542-a', final_status: 'complete' },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].tender_id, 'UA-2026-04-30-010542-a');
});

test('applyArchiveMutation: append_archive is idempotent on tender_id', () => {
  const existing = [{ tender_id: 'UA-2026-04-30-010542-a', final_status: 'complete' }];
  const result = applyArchiveMutation(existing, {
    type: 'append_archive',
    row: { tender_id: 'UA-2026-04-30-010542-a', final_status: 'cancelled' },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].final_status, 'complete'); // first wins
});

test('applyArchiveMutation: remove_archive', () => {
  const existing = [
    { tender_id: 'UA-2026-04-30-010542-a' },
    { tender_id: 'UA-2026-05-01-000002-a' },
  ];
  const result = applyArchiveMutation(existing, {
    type: 'remove_archive',
    tender_id: 'UA-2026-04-30-010542-a',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].tender_id, 'UA-2026-05-01-000002-a');
});

test('applyArchiveMutation: unknown type is no-op', () => {
  const arr = [{ tender_id: 'X' }];
  assert.deepEqual(applyArchiveMutation(arr, { type: 'wat' }), arr);
});

test('handleArchive: tender_id is rendered as Prozorro link', () => {
  const reply = handleArchive({ archive: [{
    tender_id: 'UA-2026-04-16-005830-a',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: {},
  }]});
  assert.match(reply, /<a href="https:\/\/prozorro\.gov\.ua\/tender\/UA-2026-04-16-005830-a">UA-2026-04-16-005830-a<\/a>/);
});

test('handleArchive: empty', () => {
  assert.equal(
    handleArchive({ archive: [] }),
    '📭 Архів порожній.'
  );
});

test('handleArchive: lists complete with icon and money', () => {
  const reply = handleArchive({ archive: [
    {
      tender_id: 'UA-2026-04-30-010542-a',
      archived_at: '2026-05-12T08:30:00Z',
      final_status: 'complete',
      final_snapshot: {
        procuringEntity: { name: 'КНП Лікарня', edrpou: '11111111' },
        value: { amount: 350000, currency: 'UAH' },
      },
    },
  ]});
  assert.match(reply, /✅ <a [^>]+>UA-2026-04-30-010542-a<\/a>/);
  assert.match(reply, /КНП Лікарня/);
  assert.match(reply, /350 000 UAH/);
  assert.match(reply, /12\.05\.2026/);
  assert.match(reply, /Всього в архіві: 1/);
});

test('handleArchive: maps statuses to icons', () => {
  const reply = handleArchive({ archive: [
    { tender_id: 'UA-2026-05-01-000001-a', archived_at: '2026-05-12T08:00:00Z', final_status: 'complete', final_snapshot: {} },
    { tender_id: 'UA-2026-05-01-000002-a', archived_at: '2026-05-12T08:00:00Z', final_status: 'cancelled', final_snapshot: {} },
    { tender_id: 'UA-2026-05-01-000003-a', archived_at: '2026-05-12T08:00:00Z', final_status: 'unsuccessful', final_snapshot: {} },
  ]});
  assert.match(reply, /✅ <a [^>]+>UA-2026-05-01-000001-a/);
  assert.match(reply, /⊘ <a [^>]+>UA-2026-05-01-000002-a/);
  assert.match(reply, /❌ <a [^>]+>UA-2026-05-01-000003-a/);
});

test('handleArchive: adds contract download link line when documents present', () => {
  const reply = handleArchive({ archive: [{
    tender_id: 'UA-2026-04-16-005830-a',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: {
      procuringEntity: { name: 'КНП' },
      contracts: [{
        id: 'C1',
        documents: [
          { id: 'D1', title: 'Договір.pdf', url: 'https://x/d1', documentType: null },
          { id: 'D2', title: 'sign.p7s', url: 'https://x/d2', documentType: 'notice' },
        ],
      }],
    },
  }]});
  // Link should point to the non-'notice' document (signed PDF, not КЕП-signature)
  assert.match(reply, /📄.*Завантажити договір/);
  assert.match(reply, /https:\/\/x\/d1/);
  assert.doesNotMatch(reply, /https:\/\/x\/d2/);
});

test('handleArchive: no link line when no contract docs', () => {
  const reply = handleArchive({ archive: [{
    tender_id: 'UA-2026-05-01-000002-a',
    archived_at: '2026-05-12T08:00:00Z',
    final_status: 'cancelled',
    final_snapshot: { procuringEntity: { name: 'X' }, contracts: [] },
  }]});
  assert.doesNotMatch(reply, /Завантажити договір/);
});

test('handleArchive: no link line when only notice docs present', () => {
  const reply = handleArchive({ archive: [{
    tender_id: 'UA-2026-05-01-000003-a',
    archived_at: '2026-05-12T08:00:00Z',
    final_status: 'complete',
    final_snapshot: {
      contracts: [{ id: 'C1', documents: [
        { id: 'D1', title: 'sign.p7s', url: 'https://x/sign', documentType: 'notice' },
      ]}],
    },
  }]});
  assert.doesNotMatch(reply, /Завантажити договір/);
});

test('handleArchive: sorts by archived_at desc', () => {
  const reply = handleArchive({ archive: [
    { tender_id: 'UA-2026-05-01-000001-a', archived_at: '2026-05-10T00:00:00Z', final_status: 'complete', final_snapshot: {} },
    { tender_id: 'UA-2026-05-01-000002-a', archived_at: '2026-05-12T00:00:00Z', final_status: 'complete', final_snapshot: {} },
  ]});
  const idx1 = reply.indexOf('UA-2026-05-01-000001-a');
  const idx2 = reply.indexOf('UA-2026-05-01-000002-a');
  assert.ok(idx2 < idx1, 'newer should come first');
});

test('handleArchiveDetail: unknown id', async () => {
  const reply = await handleArchiveDetail({
    archive: [],
    fetchTender: async () => { throw new Error('should not call'); },
    extractSnapshot: () => ({}),
  }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(reply, /❓ UA-2026-04-30-010542-a не в архіві/);
});

test('handleArchiveDetail: complete with contract docs', async () => {
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: {
      procuringEntity: { name: 'КНП Лікарня', edrpou: '11111111' },
      value: { amount: 350000, currency: 'UAH', valueAddedTaxIncluded: true },
      classification: { id: '33696500-0', description: 'Реактиви' },
    },
  }];
  const fresh = {
    data: {
      contracts: [{
        id: 'C1',
        status: 'signed',
        documents: [{ id: 'D1', title: 'Договір №1', url: 'https://prozorro.gov.ua/doc/D1', datePublished: '2026-05-12T10:00:00Z' }],
      }],
    },
  };
  const reply = await handleArchiveDetail({
    archive,
    fetchTender: async () => fresh,
    extractSnapshot: (raw) => raw.data,
  }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(reply, /КНП Лікарня/);
  assert.match(reply, /33696500-0 — Реактиви/);
  assert.match(reply, /350 000 UAH/);
  assert.match(reply, /Статус: Завершено/);
  assert.match(reply, /Архівовано: 12\.05\.2026/);
  assert.match(reply, /📄 Договір/);
  assert.match(reply, /Договір №1/);
  assert.match(reply, /prozorro\.gov\.ua\/doc\/D1/);
});

test('handleArchiveDetail: cancelled — no contract section', async () => {
  const archive = [{
    tender_id: 'UA-2026-05-01-000002-a',
    archived_at: '2026-05-12T08:00:00Z',
    final_status: 'cancelled',
    final_snapshot: { procuringEntity: { name: 'X' } },
  }];
  const reply = await handleArchiveDetail({
    archive,
    fetchTender: async () => ({ data: { contracts: [] } }),
    extractSnapshot: (raw) => raw.data,
  }, { tender_id: 'UA-2026-05-01-000002-a' });
  assert.match(reply, /Статус: Скасовано/);
  assert.doesNotMatch(reply, /📄 Договір/);
});

test('handleArchiveDetail: fresh fetch fails — show frozen, no contracts section', async () => {
  const archive = [{
    tender_id: 'UA-2026-05-01-000003-a',
    archived_at: '2026-05-12T08:00:00Z',
    final_status: 'complete',
    final_snapshot: { procuringEntity: { name: 'X' } },
  }];
  const reply = await handleArchiveDetail({
    archive,
    fetchTender: async () => { throw new Error('Prozorro 503'); },
    extractSnapshot: (raw) => raw.data,
  }, { tender_id: 'UA-2026-05-01-000003-a' });
  assert.match(reply, /Статус: Завершено/);
  assert.match(reply, /⚠️ Не вдалось отримати свіжі дані договору/);
});

test('handleArchiveDetail: hydrates contract docs via fetchContract', async () => {
  const archive = [{
    tender_id: 'UA-2026-04-16-005830-a',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: { procuringEntity: { name: 'КНП' } },
  }];
  const reply = await handleArchiveDetail({
    archive,
    fetchTender: async () => ({ data: {
      contracts: [{ id: 'C-UUID', status: 'active' }],
    }}),
    extractSnapshot: (raw) => raw.data,
    fetchContract: async () => ({
      id: 'C-UUID',
      documents: [{ id: 'D1', title: 'Договір.pdf', url: 'https://x/d1' }],
    }),
  }, { tender_id: 'UA-2026-04-16-005830-a' });
  assert.match(reply, /📄 Договір/);
  assert.match(reply, /Договір\.pdf/);
});

test('handleUnarchive: unknown id', () => {
  const result = handleUnarchive({
    archive: [],
    watchlist: [],
  }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(result.reply, /❓ UA-2026-04-30-010542-a не в архіві/);
  assert.equal(result.archiveMutation, null);
  assert.equal(result.watchlistMutation, null);
});

test('handleUnarchive: already in watchlist', () => {
  const archive = [{ tender_id: 'UA-2026-04-30-010542-a', notes: 'X', final_snapshot: {} }];
  const watchlist = [{ tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: 'X' }];
  const result = handleUnarchive({ archive, watchlist }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(result.reply, /⚠️ UA-2026-04-30-010542-a вже у watchlist/);
  assert.equal(result.archiveMutation, null);
  assert.equal(result.watchlistMutation, null);
});

test('handleUnarchive: success', () => {
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    notes: 'КНП — Реактиви',
    final_status: 'complete',
    final_snapshot: {},
  }];
  const result = handleUnarchive({ archive, watchlist: [] }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(result.reply, /✅ UA-2026-04-30-010542-a повернуто/);
  assert.deepEqual(result.archiveMutation, {
    type: 'remove_archive',
    tender_id: 'UA-2026-04-30-010542-a',
  });
  assert.deepEqual(result.watchlistMutation, {
    type: 'append',
    row: { tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: 'КНП — Реактиви' },
  });
});

test('handleAdd: tender already in archive → warning, no fetch', async () => {
  let fetchCalls = 0;
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    final_status: 'complete',
    notes: 'КНП — Реактиви',
  }];
  const result = await handleAdd({
    watchlist: [],
    archive,
    fetchTender: async () => { fetchCalls++; throw new Error('should not call'); },
    extractSnapshot: () => ({}),
    nowIso: '2026-05-12T10:00:00Z',
  }, { tender_id: 'UA-2026-04-30-010542-a', notes: null });
  assert.match(result.reply, /⚠️ UA-2026-04-30-010542-a архівована \(complete\)/);
  assert.match(result.reply, /\/unarchive UA-2026-04-30-010542-a/);
  assert.equal(result.mutation, null);
  assert.equal(fetchCalls, 0);
});

test('handleAdd: archive missing → falls through to existing fetch path', async () => {
  // Smoke test that explicit `archive: []` does not break the happy path.
  const result = await handleAdd({
    watchlist: [],
    archive: [],
    fetchTender: async () => ({ data: {
      tenderID: 'UA-2026-04-30-010542-a',
      status: 'active.tendering',
      title: 'X',
    }}),
    extractSnapshot: (raw) => ({
      tender_id: raw.data.tenderID,
      status: raw.data.status,
      title: raw.data.title,
    }),
    nowIso: '2026-05-12T10:00:00Z',
  }, { tender_id: 'UA-2026-04-30-010542-a', notes: null });
  assert.equal(result.mutation.type, 'append');
});

test('HELP_TEXT: mentions /archive, /unarchive (no /contract — removed)', () => {
  assert.match(HELP_TEXT, /\/archive/);
  assert.match(HELP_TEXT, /\/unarchive/);
  assert.doesNotMatch(HELP_TEXT, /\/contract/);
});

test('HELP_TEXT: uses square brackets for placeholders (no <...>)', () => {
  // <...> breaks Telegram HTML parse_mode — re-check post-edit.
  assert.doesNotMatch(HELP_TEXT, /<UA-/);
});

test('parseCommand: /invite editor Andrii → role+label', () => {
  assert.deepEqual(parseCommand('/invite editor Andrii'), {
    cmd: 'invite', role: 'editor', label: 'Andrii',
  });
});

test('parseCommand: /invite viewer Olha → role+label', () => {
  assert.deepEqual(parseCommand('/invite viewer Olha'), {
    cmd: 'invite', role: 'viewer', label: 'Olha',
  });
});

test('parseCommand: /invite viewer Olha Test → label with spaces', () => {
  assert.deepEqual(parseCommand('/invite viewer Olha Test'), {
    cmd: 'invite', role: 'viewer', label: 'Olha Test',
  });
});

test('parseCommand: /invite (no args) → missing_role', () => {
  assert.deepEqual(parseCommand('/invite'), { cmd: 'invite', error: 'missing_role' });
});

test('parseCommand: /invite Andrii (no role keyword) → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite Andrii'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite admin Test → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite admin Test'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite editor (no label) → missing_label', () => {
  assert.deepEqual(parseCommand('/invite editor'), { cmd: 'invite', error: 'missing_label' });
});

test('parseCommand: /invite viewer (no label) → missing_label', () => {
  assert.deepEqual(parseCommand('/invite viewer'), { cmd: 'invite', error: 'missing_label' });
});

test('parseCommand: /invite@botname editor Andrii → still parses', () => {
  assert.deepEqual(parseCommand('/invite@terralab_tenders_bot editor Andrii'), {
    cmd: 'invite', role: 'editor', label: 'Andrii',
  });
});

test('parseCommand: /role editor 12345 → role+chat_id', () => {
  assert.deepEqual(parseCommand('/role editor 12345'), {
    cmd: 'role', role: 'editor', chat_id: '12345',
  });
});

test('parseCommand: /role viewer 7321709183 → role+chat_id', () => {
  assert.deepEqual(parseCommand('/role viewer 7321709183'), {
    cmd: 'role', role: 'viewer', chat_id: '7321709183',
  });
});

test('parseCommand: /role (no args) → missing_args', () => {
  assert.deepEqual(parseCommand('/role'), { cmd: 'role', error: 'missing_args' });
});

test('parseCommand: /role editor (no chat_id) → missing_chat_id', () => {
  assert.deepEqual(parseCommand('/role editor'), { cmd: 'role', error: 'missing_chat_id' });
});

test('parseCommand: /role admin 12345 → invalid_role', () => {
  assert.deepEqual(parseCommand('/role admin 12345'), { cmd: 'role', error: 'invalid_role' });
});

test('parseCommand: /role 12345 editor (old order) → invalid_role', () => {
  assert.deepEqual(parseCommand('/role 12345 editor'), { cmd: 'role', error: 'invalid_role' });
});

test('parseCommand: /role editor abc → invalid_chat_id', () => {
  assert.deepEqual(parseCommand('/role editor abc'), { cmd: 'role', error: 'invalid_chat_id' });
});

test('parseCommand: /role@botname editor 12345 → still parses', () => {
  assert.deepEqual(parseCommand('/role@terralab_tenders_bot editor 12345'), {
    cmd: 'role', role: 'editor', chat_id: '12345',
  });
});

test('handleInvite: writes role:editor into invite record', () => {
  const result = handleInvite(
    {
      invites: [],
      generateToken: () => 'a'.repeat(32),
      now: () => new Date('2026-05-18T10:00:00.000Z'),
      botUsername: 'bot',
    },
    { role: 'editor', label: 'Andrii' },
  );
  assert.equal(result.mutation.type, 'append_invite');
  assert.equal(result.mutation.row.role, 'editor');
  assert.equal(result.mutation.row.label, 'Andrii');
  assert.match(result.reply, /Andrii/);
});

test('handleInvite: writes role:viewer into invite record', () => {
  const result = handleInvite(
    {
      invites: [],
      generateToken: () => 'b'.repeat(32),
      now: () => new Date('2026-05-18T10:00:00.000Z'),
      botUsername: 'bot',
    },
    { role: 'viewer', label: 'Olha' },
  );
  assert.equal(result.mutation.row.role, 'viewer');
  assert.equal(result.mutation.row.label, 'Olha');
});

test('handleInvite: reply mentions the role', () => {
  const result = handleInvite(
    {
      invites: [],
      generateToken: () => 'c'.repeat(32),
      now: () => new Date('2026-05-18T10:00:00.000Z'),
      botUsername: 'bot',
    },
    { role: 'editor', label: 'Andrii' },
  );
  assert.match(result.reply, /editor/);
});

test('handleRedeem: user inherits role:editor from invite', () => {
  const result = handleRedeem(
    {
      invites: [{
        token: 't'.repeat(32),
        label: 'A',
        role: 'editor',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-18T10:00:00.000Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(result.userMutation.row.role, 'editor');
  assert.equal(result.userMutation.row.chat_id, '222');
});

test('handleRedeem: user inherits role:viewer from invite', () => {
  const result = handleRedeem(
    {
      invites: [{
        token: 't'.repeat(32),
        label: 'A',
        role: 'viewer',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-18T10:00:00.000Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(result.userMutation.row.role, 'viewer');
});

test('handleRedeem: legacy invite without role → user.role defaults to viewer', () => {
  const result = handleRedeem(
    {
      invites: [{
        token: 't'.repeat(32),
        label: 'A',
        // no role field
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-18T10:00:00.000Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(result.userMutation.row.role, 'viewer');
});
