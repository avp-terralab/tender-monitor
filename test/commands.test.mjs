import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand, mainKeyboard, buildAutoNotes, formatAddReply,
  applyMutation, handleAdd, handleStatus, handleRemove, formatInfo,
  abbreviateLegalForm, handleWatched, handleUnwatch, applyEntityMutation,
  handleWatch, handleInvite, applyInviteMutation, applyAllowedUsersMutation,
  handleRedeem, handleRevoke, handleRole, handleNotify, buildNotifyButton, handleWhoami, handleUsersList, handleInvitesList, HELP_TEXT,
  buildHelpText, buildWelcomeText, buildRoleChangeNotice,
  applyArchiveMutation, handleArchive, handleArchiveDetail,
  handleUnarchive,
  BOT_COMMANDS_BY_ROLE,
  sanitizeActor, formatAuditMessage,
  parseAuditCommit,
  formatAuditLog,
  buildWatchedKeyboard,
  buildWatchedViewKeyboard, buildWatchedManageKeyboard, WATCHED_MANAGE_PROMPT,
  paginateArchiveGroup, ARCHIVE_PAGE_LIMIT,
  findContractDate, buildArchiveMenu, groupArchiveByProvider, buildArchiveCompanyList,
  groupArchiveByYear, buildArchiveYearList, buildArchiveMonthList, renderArchivePage, handleArchiveNav,
  AGENT_COMPANIES, companyForSlug, slugForCompany,
  agentTriggerButtonRow, buildAgentTenderListKeyboard, buildAgentCompanyKeyboard, validateAgentPrice,
  buildAgentConfirmKeyboard, buildAgentJob, buildAgentConfirmText,
  monitorPhaseBuckets, buildMonitorMenu, renderMonitorPage, handleMonitorNav,
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

test('parseCommand: /menu → cmd: unknown (command removed)', () => {
  assert.deepEqual(parseCommand('/menu'), { cmd: 'unknown' });
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

test('abbreviateLegalForm: matches when name follows form without a space (quote-attached)', () => {
  // Real Prozorro entry: EDRPOU 42409961 — no space between "ПІДПРИЄМСТВО" and the opening quote.
  assert.equal(
    abbreviateLegalForm('КОМУНАЛЬНЕ НЕКОМЕРЦІЙНЕ ПІДПРИЄМСТВО"ЛЮБОТИНСЬКА МІСЬКА ЛІКАРНЯ" ЛЮБОТИНСЬКОЇ МІСЬКОЇ РАДИ ХАРКІВСЬКОЇ ОБЛАСТІ'),
    'КНП "ЛЮБОТИНСЬКА МЛ" ЛЮБОТИНСЬКОЇ МР ХАРКІВСЬКОЇ ОБЛАСТІ'
  );
  // Same issue, other forms — also covered.
  assert.equal(
    abbreviateLegalForm('КОМУНАЛЬНЕ ПІДПРИЄМСТВО"X"'),
    'КП "X"'
  );
  assert.equal(
    abbreviateLegalForm('Товариство з обмеженою відповідальністю«Y»'),
    'ТОВ «Y»'
  );
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
    'КНП "Дніпропетровська ОКЛ ім. І. І. Мечникова"'
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
    'КП "Балтська БПЛ" Балтської МР',
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
  assert.match(reply, /Watchlist: 3 тендерів \(2 активних\)/);
  assert.match(reply, /sha abc1234/);
});

test('handleStatus: empty watchlist', () => {
  const reply = handleStatus({ watchlist: [], sha: '0000000' });
  assert.match(reply, /Watchlist: 0 тендерів \(0 активних\)/);
});

test('handleStatus: extended — users + invites + lastCommit', () => {
  const reply = handleStatus({
    watchlist: [{ tender_id: 'UA-A', enabled: true }],
    sha: 'sha12345',
    users: [
      { chat_id: '1', notifications: true },
      { chat_id: '2', notifications: false },
      { chat_id: '3', notifications: true },
    ],
    invites: [
      { status: 'pending', expires_at: '2099-01-01T00:00:00Z' },
      { status: 'pending', expires_at: '2020-01-01T00:00:00Z' }, // expired
      { status: 'redeemed', expires_at: '2099-01-01T00:00:00Z' },
    ],
    lastCommit: { sha: 'abc1234', date: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    now: () => new Date(),
  });
  assert.match(reply, /Користувачі: 4 \(admin \+ 3; opted-in на сповіщення: 2\)/);
  assert.match(reply, /Активних invite-посилань: 1/);
  assert.match(reply, /Останній tick: 5 хв тому \(abc1234\)/);
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

test('parseCommand: /unwatch with valid EDRPOU → unwatch_removed (command retired)', () => {
  assert.deepEqual(parseCommand('/unwatch 12345678'), { cmd: 'unwatch_removed' });
});

test('parseCommand: /unwatch without args → unwatch_removed (command retired)', () => {
  assert.deepEqual(parseCommand('/unwatch'), { cmd: 'unwatch_removed' });
});

test('parseCommand: /unwatch invalid → unwatch_removed (command retired)', () => {
  assert.deepEqual(parseCommand('/unwatch 12345'), { cmd: 'unwatch_removed' });
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
  assert.match(result.reply, /⚠️ Не зміг перевірити ЄДРПОУ/);
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

test('formatInfo: shows bidder under review for active.qualification', () => {
  const reply = formatInfo({
    runIso: '2026-05-19T22:22:00+03:00',
    groups: [{
      tender_id: 'UA-2026-04-30-010542-a',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-04-30-010542-a',
      status: 'active.qualification',
      awards: [
        { id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ «ТерраЛаб»', identifier: { id: '40123456' } }] },
      ],
    }],
  });
  assert.match(reply, /ℹ️ Статус: Розгляд пропозицій/);
  assert.match(reply, /👤 Учасник: ТОВ «ТерраЛаб» \(ЄДРПОУ 40123456\)/);
});

test('formatInfo: lists multiple bidders under review when multiple awards are pending', () => {
  const reply = formatInfo({
    runIso: '2026-05-19T22:22:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.qualification',
      awards: [
        { id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ «ТерраЛаб»', identifier: { id: '40123456' } }] },
        { id: 'a2', status: 'pending', suppliers: [{ name: 'ТОВ «Інший»', identifier: { id: '40999999' } }] },
      ],
    }],
  });
  assert.match(reply, /👤 Учасники:/);
  assert.match(reply, /• ТОВ «ТерраЛаб» \(ЄДРПОУ 40123456\)/);
  assert.match(reply, /• ТОВ «Інший» \(ЄДРПОУ 40999999\)/);
});

test('formatInfo: skips disqualified/cancelled awards, shows only pending', () => {
  const reply = formatInfo({
    runIso: '2026-05-19T22:22:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.qualification',
      awards: [
        { id: 'a1', status: 'unsuccessful', suppliers: [{ name: 'Старий ФОП', identifier: { id: '11111111' } }] },
        { id: 'a2', status: 'pending', suppliers: [{ name: 'ТОВ «Поточний»', identifier: { id: '22222222' } }] },
      ],
    }],
  });
  assert.match(reply, /👤 Учасник: ТОВ «Поточний» \(ЄДРПОУ 22222222\)/);
  assert.doesNotMatch(reply, /Старий ФОП/);
});

test('formatInfo: no bidder line for active.tendering even if awards present', () => {
  const reply = formatInfo({
    runIso: '2026-05-19T22:22:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.tendering',
      awards: [
        { id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ X', identifier: { id: '11111111' } }] },
      ],
    }],
  });
  assert.doesNotMatch(reply, /👤 Учасник/);
});

test('formatInfo: abbreviates supplier legal form in 👤 line', () => {
  const reply = formatInfo({
    runIso: '2026-05-19T22:22:00+03:00',
    groups: [{
      tender_id: 'UA-X',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
      status: 'active.qualification',
      awards: [
        { id: 'a1', status: 'pending', suppliers: [{ name: 'Товариство з обмеженою відповідальністю «ТерраЛаб»', identifier: { id: '40123456' } }] },
      ],
    }],
  });
  assert.match(reply, /👤 Учасник: ТОВ «ТерраЛаб» \(ЄДРПОУ 40123456\)/);
  assert.doesNotMatch(reply, /Товариство з обмеженою/);
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
  assert.equal(result.mutation.row.expires_at, '2026-05-13T10:00:00.000Z');
  assert.equal(result.mutation.row.redeemed_by, null);
  assert.equal(result.mutation.row.redeemed_at, null);
  assert.match(result.reply, /t\.me\/terralab_tenders_bot\?start=a{32}/);
  assert.match(result.reply, /Olha/);
  assert.match(result.reply, /24 години/);
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
  assert.match(HELP_TEXT, /\/role/);
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
  }]}).join('\n\n');
  assert.match(reply, /<a href="https:\/\/prozorro\.gov\.ua\/tender\/UA-2026-04-16-005830-a">UA-2026-04-16-005830-a<\/a>/);
});

test('handleArchive: empty', () => {
  assert.deepEqual(
    handleArchive({ archive: [] }),
    ['📭 Архів порожній.']
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
  ]}).join('\n\n');
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
  ]}).join('\n\n');
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
  }]}).join('\n\n');
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
  }]}).join('\n\n');
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
  }]}).join('\n\n');
  assert.doesNotMatch(reply, /Завантажити договір/);
});

test('handleArchive: appends EDRPOU after procuring entity name', () => {
  const reply = handleArchive({ archive: [{
    tender_id: 'UA-2026-04-30-010542-a',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: {
      procuringEntity: { name: 'КНП "Лікарня"', edrpou: '02000010' },
      value: { amount: 350000, currency: 'UAH' },
    },
  }]}).join('\n\n');
  assert.match(reply, /КНП "Лікарня" \(ЄДРПОУ 02000010\) — 350 000 UAH/);
});

test('handleArchive: omits EDRPOU when missing on entity', () => {
  const reply = handleArchive({ archive: [{
    tender_id: 'UA-X',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: {
      procuringEntity: { name: 'КНП Лікарня' },
      value: { amount: 350000, currency: 'UAH' },
    },
  }]}).join('\n\n');
  assert.match(reply, /КНП Лікарня — 350 000 UAH/);
  assert.doesNotMatch(reply, /ЄДРПОУ/);
});

test('handleArchive: groups by service provider with local numbering', () => {
  // Two suppliers; provider A signed 2 contracts (newer), provider B signed 1.
  // Group order: by max(archived_at) desc. Numbering restarts within each group.
  const reply = handleArchive({ archive: [
    {
      tender_id: 'UA-A1',
      archived_at: '2026-05-18T00:00:00Z',
      final_status: 'complete',
      final_snapshot: {
        procuringEntity: { name: 'Замовник X' },
        awards: [{ id: 'aw1', status: 'active', suppliers: [{ name: 'ТОВ «ТерраЛаб»', identifier: { id: '40123456' } }] }],
      },
    },
    {
      tender_id: 'UA-A2',
      archived_at: '2026-05-17T00:00:00Z',
      final_status: 'complete',
      final_snapshot: {
        procuringEntity: { name: 'Замовник Y' },
        awards: [{ id: 'aw2', status: 'active', suppliers: [{ name: 'ТОВ «ТерраЛаб»', identifier: { id: '40123456' } }] }],
      },
    },
    {
      tender_id: 'UA-B1',
      archived_at: '2026-05-15T00:00:00Z',
      final_status: 'complete',
      final_snapshot: {
        procuringEntity: { name: 'Замовник Z' },
        awards: [{ id: 'aw3', status: 'active', suppliers: [{ name: 'ФОП Іванов', identifier: { id: '1234567890' } }] }],
      },
    },
  ]}).join('\n\n');
  // Group A header with count (2 contracts)
  assert.match(reply, /👤 ТОВ «ТерраЛаб» \(ЄДРПОУ 40123456\) — 2 контракти/);
  // Group B header with count (1 contract)
  assert.match(reply, /👤 ФОП Іванов \(ЄДРПОУ 1234567890\) — 1 контракт/);
  // A group appears before B group (newer max archived_at)
  const idxA = reply.indexOf('ТерраЛаб');
  const idxB = reply.indexOf('ФОП Іванов');
  assert.ok(idxA < idxB, 'group with newer max archived_at comes first');
  // Within group A: UA-A1 (newer) before UA-A2
  const idxA1 = reply.indexOf('UA-A1');
  const idxA2 = reply.indexOf('UA-A2');
  assert.ok(idxA1 < idxA2, 'within group, newer item first');
  // Local numbering restarts: B group's only item is "1.", not "3."
  const bGroupSection = reply.slice(idxB);
  assert.match(bGroupSection, /1\. .*UA-B1/);
  // Total stays at the bottom
  assert.match(reply, /Всього в архіві: 3$/);
});

test('handleArchive: single service provider still gets group header', () => {
  const reply = handleArchive({ archive: [
    {
      tender_id: 'UA-X1',
      archived_at: '2026-05-18T00:00:00Z',
      final_status: 'complete',
      final_snapshot: {
        procuringEntity: { name: 'Замовник' },
        awards: [{ id: 'aw1', status: 'active', suppliers: [{ name: 'ТОВ «ТерраЛаб»', identifier: { id: '40123456' } }] }],
      },
    },
  ]}).join('\n\n');
  assert.match(reply, /👤 ТОВ «ТерраЛаб» \(ЄДРПОУ 40123456\) — 1 контракт/);
});

test('handleArchive: archive entry without active award falls into "Без договору" group', () => {
  const reply = handleArchive({ archive: [
    {
      tender_id: 'UA-CANCEL',
      archived_at: '2026-05-18T00:00:00Z',
      final_status: 'cancelled',
      final_snapshot: { procuringEntity: { name: 'X' }, awards: [] },
    },
  ]}).join('\n\n');
  assert.match(reply, /📦 Без укладеного договору — 1 контракт/);
});

test('handleArchive: pluralizes контракт/контракти/контрактів correctly', () => {
  const mk = (i, edrpou) => ({
    tender_id: `UA-${i}`,
    archived_at: `2026-05-${10 + i}T00:00:00Z`,
    final_status: 'complete',
    final_snapshot: {
      procuringEntity: { name: 'X' },
      awards: [{ id: `aw${i}`, status: 'active', suppliers: [{ name: 'S', identifier: { id: edrpou } }] }],
    },
  });
  // 5 contracts → "5 контрактів"
  const reply5 = handleArchive({ archive: [mk(1,'X'), mk(2,'X'), mk(3,'X'), mk(4,'X'), mk(5,'X')] }).join('\n\n');
  assert.match(reply5, /— 5 контрактів/);
  // 3 contracts → "3 контракти"
  const reply3 = handleArchive({ archive: [mk(1,'Y'), mk(2,'Y'), mk(3,'Y')] }).join('\n\n');
  assert.match(reply3, /— 3 контракти/);
});

test('handleArchive: ignores non-active awards when picking service provider', () => {
  // Disqualified bidder must not be picked as the contracting party.
  const reply = handleArchive({ archive: [
    {
      tender_id: 'UA-W',
      archived_at: '2026-05-18T00:00:00Z',
      final_status: 'complete',
      final_snapshot: {
        procuringEntity: { name: 'X' },
        awards: [
          { id: 'aw1', status: 'unsuccessful', suppliers: [{ name: 'Дискваліфікований', identifier: { id: '99999999' } }] },
          { id: 'aw2', status: 'active', suppliers: [{ name: 'Переможець', identifier: { id: '40123456' } }] },
        ],
      },
    },
  ]}).join('\n\n');
  assert.match(reply, /👤 Переможець \(ЄДРПОУ 40123456\)/);
  assert.doesNotMatch(reply, /Дискваліфікований/);
});

test('handleArchive: sorts by archived_at desc', () => {
  const reply = handleArchive({ archive: [
    { tender_id: 'UA-2026-05-01-000001-a', archived_at: '2026-05-10T00:00:00Z', final_status: 'complete', final_snapshot: {} },
    { tender_id: 'UA-2026-05-01-000002-a', archived_at: '2026-05-12T00:00:00Z', final_status: 'complete', final_snapshot: {} },
  ]}).join('\n\n');
  const idx1 = reply.indexOf('UA-2026-05-01-000001-a');
  const idx2 = reply.indexOf('UA-2026-05-01-000002-a');
  assert.ok(idx2 < idx1, 'newer should come first');
});

test('handleArchive: returns an array; total only on the last page', () => {
  const archive = [
    { tender_id: 'UA-2026-05-01-000001-a', archived_at: '2026-05-12T08:00:00Z', final_status: 'complete', final_snapshot: {} },
    { tender_id: 'UA-2026-05-01-000002-a', archived_at: '2026-05-12T07:00:00Z', final_status: 'complete', final_snapshot: {} },
  ];
  const pages = handleArchive({ archive });
  assert.ok(Array.isArray(pages));
  const withTotal = pages.filter(p => /Всього в архіві:/.test(p));
  assert.equal(withTotal.length, 1);
  assert.ok(/Всього в архіві: 2/.test(pages[pages.length - 1]));
  assert.ok(pages.every(p => !/Сторінка/.test(p)), 'no footer when it all fits');
});

test('handleArchive: a group with many contracts splits into footered pages', () => {
  // All entries share the same (no-provider) group → one group, many entries → must split.
  const archive = Array.from({ length: 100 }, (_, i) => ({
    tender_id: `UA-2026-05-01-${String(i).padStart(6, '0')}-a`,
    archived_at: `2026-05-12T08:${String(i % 60).padStart(2, '0')}:00Z`,
    final_status: 'complete',
    final_snapshot: { procuringEntity: { name: 'КНП Лікарня' }, value: { amount: 350000, currency: 'UAH' } },
  }));
  const pages = handleArchive({ archive });
  assert.ok(pages.length >= 2, 'large group split across pages');
  const paged = pages.filter(p => /Сторінка \d+\/\d+/.test(p));
  assert.ok(paged.length >= 2, 'split pages carry Сторінка k/n');
  assert.ok(/Всього в архіві: 100/.test(pages[pages.length - 1]));
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
  }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(result.reply, /❓ UA-2026-04-30-010542-a не в архіві/);
  assert.equal(result.archiveMutation, null);
});

test('handleUnarchive: success — deletes from archive only', () => {
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    notes: 'КНП — Реактиви',
    final_status: 'complete',
    final_snapshot: {},
  }];
  const result = handleUnarchive({ archive }, { tender_id: 'UA-2026-04-30-010542-a' });
  assert.match(result.reply, /✅ UA-2026-04-30-010542-a видалено з архіву/);
  assert.deepEqual(result.archiveMutation, {
    type: 'remove_archive',
    tender_id: 'UA-2026-04-30-010542-a',
  });
  // No watchlistMutation field — handleUnarchive no longer re-adds to monitoring
  assert.equal(result.watchlistMutation, undefined);
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
  assert.match(result.reply, /⚠️ UA-2026-04-30-010542-a в архіві \(complete\)/);
  assert.match(result.reply, /\/unarchive UA-2026-04-30-010542-a/);
  assert.match(result.reply, /потім \/add знову/);
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

test('applyAllowedUsersMutation: set_role updates role in-place', () => {
  const users = [
    { chat_id: '111', label: 'A', role: 'viewer' },
    { chat_id: '222', label: 'B', role: 'viewer' },
  ];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_role', chat_id: '222', role: 'editor',
  });
  assert.equal(result[0].role, 'viewer');
  assert.equal(result[1].role, 'editor');
  assert.equal(result[1].chat_id, '222');
  assert.equal(result[1].label, 'B');
});

test('applyAllowedUsersMutation: set_role on legacy entry (no role field) adds role', () => {
  const users = [{ chat_id: '111', label: 'A' }];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_role', chat_id: '111', role: 'editor',
  });
  assert.equal(result[0].role, 'editor');
});

test('applyAllowedUsersMutation: set_role on non-existing chat_id is a no-op', () => {
  const users = [{ chat_id: '111', label: 'A', role: 'viewer' }];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_role', chat_id: '999', role: 'editor',
  });
  assert.deepEqual(result, users);
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

test('handleRole: viewer → editor for existing user returns mutation', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'Andrii', role: 'viewer' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '222' },
  );
  assert.deepEqual(result.mutation, { type: 'set_role', chat_id: '222', role: 'editor' });
  assert.match(result.reply, /Andrii/);
  assert.match(result.reply, /editor/);
});

test('handleRole: editor → viewer', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X', role: 'editor' }],
      adminChatId: '111',
    },
    { role: 'viewer', chat_id: '222' },
  );
  assert.equal(result.mutation.role, 'viewer');
  assert.match(result.reply, /viewer/);
});

test('handleRole: target == admin → refuse with reply, no mutation', () => {
  const result = handleRole(
    {
      allowedUsers: [],
      adminChatId: '111',
    },
    { role: 'viewer', chat_id: '111' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /адмін/i);
});

test('handleRole: target not found → reply, no mutation', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X', role: 'viewer' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '999' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /не знайдено/i);
});

test('handleRole: target already has this role → no mutation, info reply', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X', role: 'editor' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '222' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /вже.*editor/i);
});

test('handleRole: legacy user without role field; setting editor → mutation issued', () => {
  // legacy = no role field = viewer
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '222' },
  );
  assert.equal(result.mutation.role, 'editor');
});

test('handleRole: legacy user without role; setting viewer → no mutation (effectively same)', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X' }],
      adminChatId: '111',
    },
    { role: 'viewer', chat_id: '222' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /вже.*viewer/i);
});

test('handleUsersList: shows role for each non-admin user', () => {
  const result = handleUsersList({
    allowedUsers: [
      { chat_id: '222', label: 'Andrii', role: 'editor' },
      { chat_id: '333', label: 'Olha', role: 'viewer' },
    ],
    adminChatId: '111',
  });
  assert.match(result, /1\. 👑 <code>111<\/code> — admin/);
  assert.match(result, /✏️.*Andrii.*editor/);
  assert.match(result, /📄.*Olha.*viewer/);
});

test('handleUsersList: legacy user without role → shown as viewer', () => {
  const result = handleUsersList({
    allowedUsers: [{ chat_id: '222', label: 'Legacy' }],
    adminChatId: '111',
  });
  assert.match(result, /Legacy.*viewer/);
});

test('handleInvitesList: shows planned role per active invite', () => {
  const result = handleInvitesList({
    invites: [
      {
        token: 'a'.repeat(32),
        label: 'Andrii',
        role: 'editor',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      {
        token: 'b'.repeat(32),
        label: 'Olha',
        role: 'viewer',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ],
    now: () => new Date('2026-05-18T00:00:00.000Z'),
  });
  assert.match(result, /Andrii.*editor/);
  assert.match(result, /Olha.*viewer/);
});

test('handleInvitesList: legacy invite without role → shown as viewer', () => {
  const result = handleInvitesList({
    invites: [
      {
        token: 'a'.repeat(32),
        label: 'Legacy',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ],
    now: () => new Date('2026-05-18T00:00:00.000Z'),
  });
  assert.match(result, /Legacy.*viewer/);
});

test('buildHelpText("viewer") does NOT contain mutating or admin commands', () => {
  const t = buildHelpText('viewer');
  assert.doesNotMatch(t, /\/add\b/);
  assert.doesNotMatch(t, /\/remove\b/);
  assert.doesNotMatch(t, /\/watch\b/);
  assert.doesNotMatch(t, /\/unwatch\b/);
  assert.doesNotMatch(t, /\/unarchive\b/);
  assert.doesNotMatch(t, /\/invite\b/);
  assert.doesNotMatch(t, /\/role\b/);
  assert.doesNotMatch(t, /\/users\b/);
  assert.doesNotMatch(t, /\/revoke\b/);
  assert.doesNotMatch(t, /\/status\b/);
});

test('buildHelpText("viewer") contains view commands', () => {
  const t = buildHelpText('viewer');
  assert.match(t, /\/info/);
  assert.match(t, /\/watched/);
  assert.match(t, /\/archive/);
  assert.match(t, /\/help/);
});

test('buildHelpText("admin") includes /status (admin-only ops command)', () => {
  const t = buildHelpText('admin');
  assert.match(t, /\/status/);
});

test('buildHelpText("editor") contains mutating, not admin', () => {
  const t = buildHelpText('editor');
  assert.match(t, /\/add/);
  assert.match(t, /\/remove/);
  assert.match(t, /\/watch/);
  assert.doesNotMatch(t, /\/unwatch/);
  assert.match(t, /\/unarchive/);
  assert.doesNotMatch(t, /\/invite\b/);
  assert.doesNotMatch(t, /\/role\b/);
  assert.doesNotMatch(t, /\/users\b/);
  assert.doesNotMatch(t, /\/revoke\b/);
});

test('buildHelpText("admin") contains everything including /role', () => {
  const t = buildHelpText('admin');
  assert.match(t, /\/add/);
  assert.match(t, /\/invite/);
  assert.match(t, /\/role/);
  assert.match(t, /\/users/);
  assert.match(t, /\/revoke/);
});

test('HELP_TEXT (export) === buildHelpText("admin") — back-compat', () => {
  assert.equal(HELP_TEXT, buildHelpText('admin'));
});

test('BOT_COMMANDS_BY_ROLE.viewer does not contain editor/admin commands', () => {
  const names = BOT_COMMANDS_BY_ROLE.viewer.map(c => c.command);
  assert.ok(names.includes('info'));
  assert.ok(names.includes('archive'));
  assert.ok(!names.includes('add'));
  assert.ok(!names.includes('invite'));
  assert.ok(!names.includes('role'));
});

test('BOT_COMMANDS_BY_ROLE.editor contains mutating but not admin', () => {
  const names = BOT_COMMANDS_BY_ROLE.editor.map(c => c.command);
  assert.ok(names.includes('add'));
  assert.ok(names.includes('remove'));
  assert.ok(names.includes('watch'));
  assert.ok(!names.includes('unwatch'));
  assert.ok(names.includes('unarchive'));
  assert.ok(!names.includes('invite'));
  assert.ok(!names.includes('role'));
});

test('BOT_COMMANDS_BY_ROLE.admin contains /role and admin commands', () => {
  const names = BOT_COMMANDS_BY_ROLE.admin.map(c => c.command);
  assert.ok(names.includes('role'));
  assert.ok(names.includes('invite'));
  assert.ok(names.includes('users'));
  assert.ok(names.includes('revoke'));
});

test('BOT_COMMANDS_BY_ROLE: all command names lowercase a-z0-9_, ≤32 chars, descriptions ≤256', () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    for (const c of BOT_COMMANDS_BY_ROLE[role]) {
      assert.ok(c.command.length <= 32, `command ${c.command} too long`);
      assert.ok(c.description.length <= 256, `description ${c.description} too long`);
      assert.match(c.command, /^[a-z][a-z0-9_]*$/, `invalid command name ${c.command}`);
    }
  }
});

test('parseCommand: /notify (no args) → { cmd: notify }', () => {
  assert.deepEqual(parseCommand('/notify'), { cmd: 'notify' });
});

test('parseCommand: /notify on → action on', () => {
  assert.deepEqual(parseCommand('/notify on'), { cmd: 'notify', action: 'on' });
});

test('parseCommand: /notify off → action off', () => {
  assert.deepEqual(parseCommand('/notify off'), { cmd: 'notify', action: 'off' });
});

test('parseCommand: /notify garbage → invalid_arg', () => {
  assert.deepEqual(parseCommand('/notify garbage'), { cmd: 'notify', error: 'invalid_arg' });
});

test('parseCommand: /notify@botname on → still parses', () => {
  assert.deepEqual(parseCommand('/notify@terralab_tenders_bot on'), { cmd: 'notify', action: 'on' });
});

test('handleNotify: admin → always-on reply, no mutation, no button', () => {
  const r = handleNotify({ allowedUsers: [], adminChatId: '111', chatId: '111' }, {});
  assert.match(r.reply, /адмін/i);
  assert.match(r.reply, /увімкнено/i);
  assert.equal(r.mutation, null);
  assert.equal(r.replyMarkup, null);
});

test('handleNotify: viewer show-state (default off) → state-button shows OFF', () => {
  const r = handleNotify(
    { allowedUsers: [{ chat_id: '222', label: 'V', role: 'viewer' }], adminChatId: '111', chatId: '222' },
    {},
  );
  assert.equal(r.mutation, null);
  const btn = r.replyMarkup.inline_keyboard[0][0];
  assert.equal(btn.callback_data, 'notify:on');
  assert.match(btn.text, /ВИМКНЕНО/);
  // Body text is minimal — state lives in the button label
  assert.match(r.reply, /Сповіщення про зміни/);
});

test('handleNotify: viewer show-state when ON → state-button shows ON', () => {
  const r = handleNotify(
    { allowedUsers: [{ chat_id: '222', label: 'V', role: 'viewer', notifications: true }], adminChatId: '111', chatId: '222' },
    {},
  );
  const btn = r.replyMarkup.inline_keyboard[0][0];
  assert.equal(btn.callback_data, 'notify:off');
  assert.match(btn.text, /УВІМКНЕНО/);
});

test('buildNotifyButton: ON state → "УВІМКНЕНО" + callback notify:off (tap turns off)', () => {
  const btn = buildNotifyButton(true).inline_keyboard[0][0];
  assert.match(btn.text, /УВІМКНЕНО/);
  assert.equal(btn.callback_data, 'notify:off');
});

test('buildNotifyButton: OFF state → "ВИМКНЕНО" + callback notify:on (tap turns on)', () => {
  const btn = buildNotifyButton(false).inline_keyboard[0][0];
  assert.match(btn.text, /ВИМКНЕНО/);
  assert.equal(btn.callback_data, 'notify:on');
});

test('handleNotify: viewer /notify on → mutation set_notifications true', () => {
  const r = handleNotify(
    { allowedUsers: [{ chat_id: '222', label: 'V', role: 'viewer' }], adminChatId: '111', chatId: '222' },
    { action: 'on' },
  );
  assert.deepEqual(r.mutation, { type: 'set_notifications', chat_id: '222', value: true });
  assert.match(r.reply, /увімкнено/);
});

test('handleNotify: viewer /notify off → mutation set_notifications false', () => {
  const r = handleNotify(
    { allowedUsers: [{ chat_id: '222', label: 'V', role: 'viewer', notifications: true }], adminChatId: '111', chatId: '222' },
    { action: 'off' },
  );
  assert.deepEqual(r.mutation, { type: 'set_notifications', chat_id: '222', value: false });
  assert.match(r.reply, /вимкнено/);
});

test('handleNotify: viewer /notify on when already on → no mutation, info reply', () => {
  const r = handleNotify(
    { allowedUsers: [{ chat_id: '222', label: 'V', role: 'viewer', notifications: true }], adminChatId: '111', chatId: '222' },
    { action: 'on' },
  );
  assert.equal(r.mutation, null);
  assert.match(r.reply, /вже увімкнено/);
});

test('applyAllowedUsersMutation: set_notifications updates the boolean', () => {
  const users = [
    { chat_id: '111', label: 'A', role: 'viewer', notifications: false },
    { chat_id: '222', label: 'B', role: 'editor', notifications: false },
  ];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_notifications', chat_id: '222', value: true,
  });
  assert.equal(result[0].notifications, false);
  assert.equal(result[1].notifications, true);
});

test('handleRedeem: new user gets notifications: false by default', () => {
  const r = handleRedeem(
    {
      invites: [{ token: 't'.repeat(32), label: 'X', role: 'viewer', status: 'pending', expires_at: '2099-01-01T00:00:00.000Z' }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-19T10:00:00Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(r.userMutation.row.notifications, false);
});

test('BOT_COMMANDS_BY_ROLE.viewer includes /notify', () => {
  const names = BOT_COMMANDS_BY_ROLE.viewer.map(c => c.command);
  assert.ok(names.includes('notify'));
});

test('buildHelpText all roles mention /notify', () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    assert.match(buildHelpText(role), /\/notify/, `role ${role} missing /notify`);
  }
});

test('buildWelcomeText: includes label, role, purpose, notify hint, and command list', () => {
  const text = buildWelcomeText('Андрій', 'viewer');
  assert.match(text, /Доступ надано:.*Андрій/);
  assert.match(text, /viewer/);
  assert.match(text, /Prozorro/);
  assert.match(text, /\/notify/);
  assert.match(text, /Сповіщення.*вимкнен/i);
  // Help text included → /info, /watched, /archive present for viewer
  assert.match(text, /\/info/);
  assert.match(text, /\/watched/);
  assert.match(text, /\/archive/);
  // Editor commands absent for viewer
  assert.doesNotMatch(text, /\/add\b/);
  assert.doesNotMatch(text, /\/invite\b/);
});

test('buildWelcomeText: editor role includes mutating commands but not admin', () => {
  const text = buildWelcomeText('Олена', 'editor');
  assert.match(text, /редактор/i);
  assert.match(text, /\/add/);
  assert.match(text, /\/remove/);
  assert.doesNotMatch(text, /\/invite\b/);
  assert.doesNotMatch(text, /\/role\b/);
});

test('buildWelcomeText: HTML-escapes label', () => {
  const text = buildWelcomeText('<script>', 'viewer');
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
});

test('handleRedeem: reply is the full welcome text (not just one-line confirmation)', () => {
  const invite = {
    token: 'a'.repeat(32), label: 'X', role: 'viewer',
    status: 'pending', expires_at: '2099-01-01T00:00:00.000Z',
  };
  const r = handleRedeem(
    { invites: [invite], allowedUsers: [], adminChatId: '111', chatId: '222', now: () => new Date('2026-05-19T10:00:00Z') },
    { token: 'a'.repeat(32) },
  );
  assert.match(r.reply, /Вітаю/);
  assert.match(r.reply, /\/notify/);
  assert.match(r.reply, /\/info/);
});

test('buildRoleChangeNotice: editor includes mutating commands, not admin', () => {
  const text = buildRoleChangeNotice('editor');
  assert.match(text, /Адмін змінив твою роль/);
  assert.match(text, /editor/);
  assert.match(text, /\/add/);
  assert.match(text, /\/remove/);
  assert.doesNotMatch(text, /\/invite\b/);
});

test('buildRoleChangeNotice: viewer only sees view commands', () => {
  const text = buildRoleChangeNotice('viewer');
  assert.match(text, /viewer/);
  assert.match(text, /\/info/);
  assert.doesNotMatch(text, /\/add\b/);
});

test('parseCommand: /whoami → cmd whoami', () => {
  assert.deepEqual(parseCommand('/whoami'), { cmd: 'whoami' });
});

test('handleWhoami: admin → shows admin row with always-on notifications', () => {
  const text = handleWhoami({ allowedUsers: [], adminChatId: '111', chatId: '111' });
  assert.match(text, /Admin/);
  assert.match(text, /111/);
  assert.match(text, /admin/);
  assert.match(text, /завжди увімкнено/i);
});

test('handleWhoami: editor with notifications on → ✏️ role + ✅ notify', () => {
  const text = handleWhoami({
    allowedUsers: [{ chat_id: '222', label: 'Andrii', role: 'editor', notifications: true }],
    adminChatId: '111',
    chatId: '222',
  });
  assert.match(text, /Andrii/);
  assert.match(text, /✏️.*editor/);
  assert.match(text, /✅.*УВІМКНЕНО/);
});

test('handleWhoami: viewer default (no role, no notifications) → 📄 + ❌', () => {
  const text = handleWhoami({
    allowedUsers: [{ chat_id: '222', label: 'Legacy' }],
    adminChatId: '111',
    chatId: '222',
  });
  assert.match(text, /Legacy/);
  assert.match(text, /📄.*viewer/);
  assert.match(text, /❌.*ВИМКНЕНО/);
});

test('handleWhoami: guest (not in allowlist, not admin) → shows guest message', () => {
  const text = handleWhoami({ allowedUsers: [], adminChatId: '111', chatId: '999' });
  assert.match(text, /Гість/);
  assert.match(text, /999/);
  assert.match(text, /Звернись до адміна/);
});

// ── handleStatus rich-mode tests ──────────────────────────────────────────────

test('handleStatus: without rich → unchanged 6-line output', () => {
  const text = handleStatus({
    watchlist: [{ tender_id: 'UA-X', enabled: true }],
    sha: 'abc1234',
    users: [],
    invites: [],
    lastCommit: { sha: '8d66bdd', date: new Date(Date.now() - 25 * 60_000).toISOString() },
    now: () => new Date(),
  });
  assert.match(text, /🟢 Worker live/);
  assert.match(text, /Watchlist: 1 тендер/);
  assert.doesNotMatch(text, /Архівованих/);
  assert.doesNotMatch(text, /Нічний буфер/);
  assert.doesNotMatch(text, /cached/);
});

test('handleStatus: with rich → appends admin-only rows', () => {
  const text = handleStatus({
    watchlist: [{ tender_id: 'UA-X', enabled: true }],
    sha: 'abc1234',
    users: [],
    invites: [],
    lastCommit: { sha: '8d66bdd', date: new Date().toISOString() },
    now: () => new Date(),
    rich: {
      watchlistBreakdown: { activeIntake: 3, waiting: 5, runIso: new Date().toISOString() },
      archiveCount: 24,
      watchedEntitiesCount: 2,
      pendingDigest: null,
      latestDeploy: { sha: 'deadbee', message: 'telegram: heartbeat groups tenders', date: new Date().toISOString() },
      cachedAgeSec: 0,
    },
  });
  assert.match(text, /3 в прийомі \/ 5 очікують/);
  assert.match(text, /📦 Архівованих: 24/);
  assert.match(text, /🏢 Замовників у entity-watch: 2/);
  assert.match(text, /🌙 Нічний буфер: порожній/);
  assert.match(text, /🚀 Деплой: deadbee · telegram: heartbeat groups tenders/);
  assert.doesNotMatch(text, /cached/);
});

test('handleStatus: rich + non-empty buffer renders item count and oldest time', () => {
  const text = handleStatus({
    watchlist: [], sha: 'abc1234', users: [], invites: [],
    lastCommit: null, now: () => new Date('2026-05-23T08:00:00Z'),
    rich: {
      watchlistBreakdown: { activeIntake: 0, waiting: 0, runIso: '2026-05-23T08:00:00Z' },
      archiveCount: 0, watchedEntitiesCount: 0,
      pendingDigest: { itemCount: 3, oldestEventAt: '2026-05-23T02:14:00Z' },
      latestDeploy: null,
      cachedAgeSec: 0,
    },
  });
  // "найстаріша подія HH:MM" — time formatted in Kyiv tz from 02:14 UTC = 05:14 EEST
  assert.match(text, /🌙 Нічний буфер: 3 тендер.*найстаріша подія 05:14/);
  assert.doesNotMatch(text, /🚀 Деплой/);  // omitted when null
});

// ── Task 1: sanitizeActor + formatAuditMessage ────────────────────────────

test('sanitizeActor: strips separators and newlines, collapses spaces', () => {
  assert.equal(sanitizeActor('Ан\nдрій · [x]'), 'Ан дрій x');
});

test('sanitizeActor: empty → "?"', () => {
  assert.equal(sanitizeActor(''), '?');
  assert.equal(sanitizeActor(null), '?');
});

test('sanitizeActor: caps length at 40', () => {
  assert.ok(sanitizeActor('a'.repeat(100)).length <= 40);
});

test('formatAuditMessage: builds audit line', () => {
  assert.equal(
    formatAuditMessage({ action: 'add', target: 'UA-2026-04-30-010542-a', actor: 'Андрій', chatId: '1', role: 'editor' }),
    'audit: add UA-2026-04-30-010542-a · Андрій [1/editor]'
  );
});

test('formatAuditMessage: null target → no double space', () => {
  assert.equal(
    formatAuditMessage({ action: 'role→editor', target: null, actor: 'admin', chatId: '9', role: 'admin' }),
    'audit: role→editor · admin [9/admin]'
  );
});

// ── Task 2: parseAuditCommit ──────────────────────────────────────────────

test('parseAuditCommit: parses a full line', () => {
  assert.deepEqual(
    parseAuditCommit('audit: add UA-2026-04-30-010542-a · Андрій Парасина [786078813/editor]'),
    { action: 'add', target: 'UA-2026-04-30-010542-a', actor: 'Андрій Парасина', chatId: '786078813', role: 'editor' }
  );
});

test('parseAuditCommit: parses role→ and chat_id target', () => {
  assert.deepEqual(
    parseAuditCommit('audit: role→editor 7321709183 · admin [9/admin]'),
    { action: 'role→editor', target: '7321709183', actor: 'admin', chatId: '9', role: 'admin' }
  );
});

test('parseAuditCommit: returns null for non-audit messages', () => {
  assert.equal(parseAuditCommit('bot: update watchlist 2026-05-26T00:00:00Z'), null);
  assert.equal(parseAuditCommit('monitor: state update'), null);
  assert.equal(parseAuditCommit(''), null);
});

test('parseAuditCommit: round-trips formatAuditMessage (cyrillic name with spaces)', () => {
  const x = { action: 'invite', target: 'editor:Олег', actor: 'Андрій Парасина', chatId: '786078813', role: 'admin' };
  const parsed = parseAuditCommit(formatAuditMessage(x));
  assert.deepEqual(parsed, x);
});

test('parseAuditCommit: only reads the first line', () => {
  const msg = 'audit: remove UA-2026-05-01-012131-a · Оксана [7321709183/editor]\n\nbody text';
  assert.equal(parseAuditCommit(msg).action, 'remove');
});

// ── Task 3: auditPhrase + formatAuditLog ─────────────────────────────────

const D = '2026-05-26T11:32:00Z'; // 14:32 Kyiv (UTC+3)

test('formatAuditLog: empty → placeholder', () => {
  assert.match(formatAuditLog([], { limit: 20 }), /порожній/);
});

test('formatAuditLog: renders date, actor, and per-action phrase', () => {
  const out = formatAuditLog([
    { action: 'add', target: 'UA-2026-04-30-010542-a', actor: 'Андрій', date: D },
  ], { limit: 20 });
  assert.match(out, /26\.05 14:32/);
  assert.match(out, /Андрій додав UA-2026-04-30-010542-a/);
});

test('formatAuditLog: phrase per action', () => {
  const mk = (action, target) => formatAuditLog([{ action, target, actor: 'X', date: D }], { limit: 20 });
  assert.match(mk('remove', 'UA-x'), /видалив UA-x/);
  assert.match(mk('watch', '12345678'), /почав стеження за 12345678/);
  assert.match(mk('unwatch', '12345678'), /прибрав стеження за 12345678/);
  assert.match(mk('unarchive', 'UA-x'), /повернув з архіву UA-x/);
  assert.match(mk('invite', 'editor:Олег'), /видав invite \(editor: Олег\)/);
  assert.match(mk('revoke', '123'), /прибрав доступ 123/);
  assert.match(mk('role→editor', '123'), /змінив роль 123 → editor/);
});

test('formatAuditLog: escapes HTML in actor', () => {
  const out = formatAuditLog([{ action: 'add', target: 'UA-x', actor: '<b>x</b>', date: D }], { limit: 20 });
  assert.doesNotMatch(out, /<b>x<\/b>/);
  assert.match(out, /&lt;b&gt;/);
});

test('formatAuditLog: escapes HTML in the target (e.g. invite label)', () => {
  const out = formatAuditLog([{ action: 'invite', target: 'editor:<b>x</b>', actor: 'admin', date: '2026-05-26T11:32:00Z' }], { limit: 20 });
  assert.doesNotMatch(out, /<b>x<\/b>/);
  assert.match(out, /&lt;b&gt;/);
});

test('formatAuditLog: respects limit', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ action: 'add', target: `UA-${i}`, actor: 'X', date: D }));
  const out = formatAuditLog(entries, { limit: 5 });
  assert.match(out, /останні 5/);
  assert.equal((out.match(/^•/gm) || []).length, 5);
});

// ── Task 4: parseCommand /log ─────────────────────────────────────────────

test('parseCommand: /log default limit 20', () => {
  assert.deepEqual(parseCommand('/log'), { cmd: 'log', limit: 20 });
});
test('parseCommand: /log N', () => {
  assert.deepEqual(parseCommand('/log 5'), { cmd: 'log', limit: 5 });
});
test('parseCommand: /log caps at 50', () => {
  assert.deepEqual(parseCommand('/log 999'), { cmd: 'log', limit: 50 });
});
test('parseCommand: /log floors at 1', () => {
  assert.deepEqual(parseCommand('/log 0'), { cmd: 'log', limit: 1 });
});
test('parseCommand: /log abc → unknown', () => {
  assert.deepEqual(parseCommand('/log abc'), { cmd: 'unknown' });
});

// ── Task 5: /log in help text + command list ──────────────────────────────

test('buildHelpText: admin includes /log', () => {
  assert.match(buildHelpText('admin'), /\/log/);
});
test('buildHelpText: editor/viewer do not include /log', () => {
  assert.doesNotMatch(buildHelpText('editor'), /\/log/);
  assert.doesNotMatch(buildHelpText('viewer'), /\/log/);
});
test('BOT_COMMANDS_BY_ROLE: only admin has log', () => {
  assert.ok(BOT_COMMANDS_BY_ROLE.admin.some(c => c.command === 'log'));
  assert.ok(!BOT_COMMANDS_BY_ROLE.editor.some(c => c.command === 'log'));
  assert.ok(!BOT_COMMANDS_BY_ROLE.viewer.some(c => c.command === 'log'));
});
test('BOT_COMMANDS_BY_ROLE: all command names within Telegram 32-char limit', () => {
  for (const set of Object.values(BOT_COMMANDS_BY_ROLE)) {
    for (const c of set) assert.ok(c.command.length <= 32);
  }
});

// ── Task 2: buildWatchedKeyboard ──────────────────────────────────────────

test('buildWatchedKeyboard: one 🗑 row per entity with unwatch: callback_data', () => {
  const kb = buildWatchedKeyboard([
    { edrpou: '12345678', name: 'КОМУНАЛЬНЕ НЕКОМЕРЦІЙНЕ ПІДПРИЄМСТВО "ЛІКАРНЯ №1"', enabled: true },
    { edrpou: '01999106', name: '(unknown)', enabled: true },
  ]);
  assert.equal(kb.inline_keyboard.length, 2);
  const [row1, row2] = kb.inline_keyboard;
  assert.equal(row1[0].callback_data, 'unwatch:12345678');
  assert.match(row1[0].text, /^🗑 12345678 — /);
  assert.equal(row2[0].callback_data, 'unwatch:01999106');
  // name === '(unknown)' → no " — name" suffix, just the ЄДРПОУ
  assert.equal(row2[0].text, '🗑 01999106');
});

test('buildWatchedKeyboard: empty list → null', () => {
  assert.equal(buildWatchedKeyboard([]), null);
  assert.equal(buildWatchedKeyboard(null), null);
});

test('buildWatchedKeyboard: long name truncated in button label', () => {
  const longName = 'А'.repeat(200);
  const kb = buildWatchedKeyboard([{ edrpou: '12345678', name: longName, enabled: true }]);
  assert.ok(kb.inline_keyboard[0][0].text.length < 80);
});

// ── Task 3: retire /unwatch command ──────────────────────────────────────────

test('parseCommand: /unwatch (any args) → unwatch_removed', () => {
  assert.deepEqual(parseCommand('/unwatch'), { cmd: 'unwatch_removed' });
  assert.deepEqual(parseCommand('/unwatch 12345678'), { cmd: 'unwatch_removed' });
  assert.deepEqual(parseCommand('/unwatch@terralab_tenders_bot 12345678'), { cmd: 'unwatch_removed' });
});

test('buildHelpText: editor help no longer mentions /unwatch', () => {
  assert.doesNotMatch(buildHelpText('editor'), /\/unwatch/);
  assert.doesNotMatch(buildHelpText('admin'), /\/unwatch/);
});

test('BOT_COMMANDS_BY_ROLE: no role lists unwatch', () => {
  for (const set of Object.values(BOT_COMMANDS_BY_ROLE)) {
    assert.ok(!set.some(c => c.command === 'unwatch'));
  }
});

// ── Task 1: /watched VIEW + MANAGE keyboard builders ─────────────────────────

test('buildWatchedViewKeyboard: single "Прибрати" button → watched:manage', () => {
  const kb = buildWatchedViewKeyboard([{ edrpou: '12345678', name: 'КНП', enabled: true }]);
  assert.equal(kb.inline_keyboard.length, 1);
  assert.equal(kb.inline_keyboard[0].length, 1);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'watched:manage');
  assert.match(kb.inline_keyboard[0][0].text, /Прибрати/);
});

test('buildWatchedViewKeyboard: empty list → null', () => {
  assert.equal(buildWatchedViewKeyboard([]), null);
  assert.equal(buildWatchedViewKeyboard(null), null);
});

test('buildWatchedManageKeyboard: per-entity 🗑 rows + trailing Готово row', () => {
  const kb = buildWatchedManageKeyboard([
    { edrpou: '12345678', name: 'КНП «Лікарня №1»', enabled: true },
    { edrpou: '01999106', name: 'ТОВ «X»', enabled: true },
  ]);
  assert.equal(kb.inline_keyboard.length, 3); // 2 entities + Готово
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'unwatch:12345678');
  assert.equal(kb.inline_keyboard[1][0].callback_data, 'unwatch:01999106');
  const doneRow = kb.inline_keyboard[2];
  assert.equal(doneRow[0].callback_data, 'watched:done');
  assert.match(doneRow[0].text, /Готово/);
});

test('buildWatchedManageKeyboard: empty list → null', () => {
  assert.equal(buildWatchedManageKeyboard([]), null);
  assert.equal(buildWatchedManageKeyboard(null), null);
});

test('WATCHED_MANAGE_PROMPT: exported non-empty string', () => {
  assert.equal(typeof WATCHED_MANAGE_PROMPT, 'string');
  assert.ok(WATCHED_MANAGE_PROMPT.length > 0);
});

test('paginateArchiveGroup: fits in one page → no footer', () => {
  const pages = paginateArchiveGroup({ header: 'H', entries: ['a', 'b', 'c'] });
  assert.equal(pages.length, 1);
  assert.equal(pages[0], 'H\n\na\n\nb\n\nc');
  assert.doesNotMatch(pages[0], /Сторінка/);
});

test('paginateArchiveGroup: overflow → multiple pages, footer, entries intact', () => {
  const big = (c) => c.repeat(1500);
  const entries = [big('1'), big('2'), big('3'), big('4')];
  const pages = paginateArchiveGroup({ header: 'HDR', entries, limit: 3900 });
  assert.ok(pages.length >= 2, 'splits into >= 2 pages');
  pages.forEach((p, i) => {
    assert.ok(p.startsWith('HDR\n\n'), 'header repeated');
    assert.match(p, new RegExp(`Сторінка ${i + 1}/${pages.length}$`));
  });
  for (const e of entries) {
    const hits = pages.filter(p => p.includes(e)).length;
    assert.equal(hits, 1, 'entry appears whole on exactly one page');
  }
});

test('paginateArchiveGroup: a single oversized entry gets its own page', () => {
  const huge = 'x'.repeat(5000);
  const pages = paginateArchiveGroup({ header: 'H', entries: [huge, 'small'], limit: 3900 });
  assert.equal(pages.length, 2);
  assert.ok(pages[0].includes(huge));
  assert.ok(pages[1].includes('small'));
});

// ── Agent trigger (Phase 3 Task 5) ──────────────────────────────────────

test('companyForSlug / slugForCompany: round-trip', () => {
  assert.equal(companyForSlug('terralab_it'), 'ТЕРРАЛАБ АЙ ТІ');
  assert.equal(companyForSlug('maylab'), 'МАЙЛАБ');
  assert.equal(slugForCompany('МАЙЛАБ'), 'maylab');
  assert.equal(slugForCompany('ТЕРРАЛАБ КОНСАЛТИНГ'), 'terralab_consulting');
  assert.equal(companyForSlug('nope'), null);
  assert.equal(slugForCompany('nope'), null);
  assert.equal(Object.keys(AGENT_COMPANIES).length, 4);
});

test('agentTriggerButtonRow: admin gets row, others null', () => {
  const row = agentTriggerButtonRow('UA-x', 'admin');
  assert.ok(Array.isArray(row));
  assert.equal(row.length, 1);
  assert.equal(row[0].callback_data, 'agent:start:UA-x');
  assert.match(row[0].text, /агенту/);
  assert.equal(agentTriggerButtonRow('UA-x', 'editor'), null);
  assert.equal(agentTriggerButtonRow('UA-x', 'viewer'), null);
});

test('buildAgentCompanyKeyboard: 4 companies + cancel, callback_data ≤ 64', () => {
  const kb = buildAgentCompanyKeyboard('UA-x');
  const buttons = kb.inline_keyboard.flat();
  const companyButtons = buttons.filter(b => b.callback_data.startsWith('agent:co:'));
  assert.equal(companyButtons.length, 4);
  const maylab = companyButtons.find(b => b.callback_data === 'agent:co:UA-x:maylab');
  assert.ok(maylab);
  assert.equal(maylab.text, 'МАЙЛАБ');
  const cancel = buttons.find(b => b.callback_data === 'agent:cancel:UA-x');
  assert.ok(cancel);
  for (const b of buttons) {
    assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, b.callback_data);
  }
});

test('buildAgentCompanyKeyboard: callback_data stays ≤64 with 22-char tender id', () => {
  const tid = 'UA-2026-04-30-010542-a';
  const kb = buildAgentCompanyKeyboard(tid);
  for (const b of kb.inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, b.callback_data);
  }
});

test('validateAgentPrice: accepts numbers and auto, rejects junk', () => {
  assert.ok(validateAgentPrice('181200'));
  assert.ok(validateAgentPrice('181 200'));
  assert.ok(validateAgentPrice('181 200,00'));
  assert.ok(validateAgentPrice('181200.00'));
  assert.equal(validateAgentPrice('auto'), 'auto');
  assert.equal(validateAgentPrice('AUTO'), 'auto');
  assert.equal(validateAgentPrice('  Auto  '), 'auto');
  assert.equal(validateAgentPrice(''), null);
  assert.equal(validateAgentPrice('abc'), null);
  assert.equal(validateAgentPrice('-5'), null);
  assert.equal(validateAgentPrice('12abc'), null);
});

test('buildAgentConfirmKeyboard: confirm + cancel', () => {
  const kb = buildAgentConfirmKeyboard('UA-x');
  const buttons = kb.inline_keyboard.flat();
  assert.ok(buttons.find(b => b.callback_data === 'agent:confirm:UA-x'));
  assert.ok(buttons.find(b => b.callback_data === 'agent:cancel:UA-x'));
});

test('buildAgentJob: matches integration contract', () => {
  const job = buildAgentJob({
    tenderId: 'UA-x', link: 'L', company: 'МАЙЛАБ',
    price: '181200', requestedBy: '42', createdAt: 't',
  });
  assert.deepEqual(job, {
    tender_id: 'UA-x',
    link: 'L',
    company: 'МАЙЛАБ',
    price: '181200',
    requested_by: '42',
    status: 'pending',
    created_at: 't',
  });
});

test('buildAgentConfirmText: one-line prompt with fields', () => {
  const txt = buildAgentConfirmText({
    company: 'МАЙЛАБ', price: '181200', tenderId: 'UA-x', entityName: 'Лікарня',
  });
  assert.equal(typeof txt, 'string');
  assert.match(txt, /МАЙЛАБ/);
  assert.match(txt, /181200/);
  assert.match(txt, /UA-x/);
  assert.match(txt, /Лікарня/);
});


test('parseCommand: /agent', () => {
  assert.deepEqual(parseCommand('/agent'), { cmd: 'agent' });
  assert.deepEqual(parseCommand('/agent@terralab_tenders_bot'), { cmd: 'agent' });
});

test('buildAgentTenderListKeyboard: one agent:start button per enabled tender', () => {
  const kb = buildAgentTenderListKeyboard([
    { tender_id: 'UA-2026-01-01-000001-a', enabled: true, notes: 'Херсон ОНКО' },
    { tender_id: 'UA-2026-01-01-000002-a', enabled: false },
    { tender_id: 'UA-2026-01-01-000003-a', enabled: true },
  ]);
  assert.equal(kb.inline_keyboard.length, 2);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'agent:start:UA-2026-01-01-000001-a');
  assert.match(kb.inline_keyboard[0][0].text, /Херсон ОНКО/);
  assert.match(kb.inline_keyboard[1][0].text, /UA-2026-01-01-000003-a/);
  assert.equal(buildAgentTenderListKeyboard([]), null);
  assert.equal(buildAgentTenderListKeyboard([{ tender_id: 'x', enabled: false }]), null);
});


test('abbreviateLegalForm / buildAgentTenderListKeyboard: abbreviates the legal form', () => {
  assert.match(abbreviateLegalForm('КОМУНАЛЬНЕ НЕКОМЕРЦІЙНЕ ПІДПРИЄМСТВО «Херсонський»'), /^КНП «Херсонський»/);
  assert.equal(abbreviateLegalForm('КОМУНАЛЬНИЙ ЗАКЛАД Київ').startsWith('КЗ '), true);
  const kb = buildAgentTenderListKeyboard([
    { tender_id: 'UA-2026-01-01-000009-a', enabled: true,
      notes: 'КОМУНАЛЬНЕ НЕКОМЕРЦІЙНЕ ПІДПРИЄМСТВО «Дніпро»' },
  ]);
  assert.match(kb.inline_keyboard[0][0].text, /КНП «Дніпро»/);
  assert.doesNotMatch(kb.inline_keyboard[0][0].text, /КОМУНАЛЬНЕ НЕКОМЕРЦІЙНЕ/);
});


test('abbreviateLegalForm: abbreviates governance suffix', () => {
  assert.equal(abbreviateLegalForm('КОМУНАЛЬНЕ ПІДПРИЄМСТВО «Х» ОДЕСЬКОЇ МІСЬКОЇ РАДИ'), 'КП «Х» ОДЕСЬКОЇ МР');
  assert.match(abbreviateLegalForm('«Лікарня» ЛЬВІВСЬКОЇ ОБЛАСНОЇ РАДИ'), /ЛЬВІВСЬКОЇ ОР$/);
  assert.match(abbreviateLegalForm('«ЦРЛ» БРОВАРСЬКОЇ РАЙОННОЇ РАДИ'), /БРОВАРСЬКОЇ РР$/);
  assert.match(abbreviateLegalForm('«А» КИЇВСЬКОЇ ОБЛАСНОЇ ДЕРЖАВНОЇ АДМІНІСТРАЦІЇ'), /КИЇВСЬКОЇ ОДА$/);
});


test('abbreviateLegalForm: ТМО / КУ / селищної ради (new forms)', () => {
  assert.match(abbreviateLegalForm("ТЕРИТОРІАЛЬНЕ МЕДИЧНЕ ОБ'ЄДНАННЯ «Х»"), /^ТМО «Х»/);
  assert.match(abbreviateLegalForm('КОМУНАЛЬНА УСТАНОВА «Y»'), /^КУ «Y»/);
  assert.match(abbreviateLegalForm('«Z» БОЯРСЬКОЇ СЕЛИЩНОЇ РАДИ'), /БОЯРСЬКОЇ СР$/);
});


test('abbreviateLegalForm: facility-type phrases (ТМО mid, МКЛ/ЦМЛ/ОКЛ/БПЛ/ШМД/МЛ)', () => {
  const lviv = abbreviateLegalForm(`КНП "Львівське територіальне медичне об'єднання "Клінічна лікарня"`);
  assert.match(lviv, /Львівське ТМО/);
  assert.doesNotMatch(lviv, /територіальне медичне/i);
  assert.match(abbreviateLegalForm('«Х» міська клінічна лікарня № 1'), /МКЛ № 1/);
  assert.match(abbreviateLegalForm('центральна міська лікарня м. Суми'), /^ЦМЛ м\. Суми/);
  assert.match(abbreviateLegalForm('обласна клінічна лікарня'), /^ОКЛ$/);
  assert.match(abbreviateLegalForm('Балтська багатопрофільна лікарня'), /Балтська БПЛ/);
  assert.match(abbreviateLegalForm('лікарня швидкої медичної допомоги'), /лікарня ШМД/);
  assert.match(abbreviateLegalForm('Сумська міська лікарня № 5'), /Сумська МЛ № 5/);
});


test('mainKeyboard / 🤖 Агент alias: admin gets the agent button, others do not', () => {
  const admin = mainKeyboard('admin').keyboard.flat().map(b => b.text);
  assert.ok(admin.includes('🤖 Агент'), 'admin keyboard must include the agent button');
  const viewer = mainKeyboard('viewer').keyboard.flat().map(b => b.text);
  assert.ok(!viewer.includes('🤖 Агент'), 'non-admin keyboard must NOT include the agent button');
  assert.deepEqual(parseCommand('🤖 Агент'), { cmd: 'agent' });
});


test('buildAgentTenderListKeyboard: prepared tender gets a clickable Drive-link row', () => {
  const kb = buildAgentTenderListKeyboard([
    { tender_id: 'UA-2026-01-01-000007-a', enabled: true, notes: 'КНП «Готовий»',
      preparedUrl: 'https://drive.google.com/drive/folders/ABC' },
    { tender_id: 'UA-2026-01-01-000008-a', enabled: true, notes: 'КНП «Новий»' },
  ]);
  // tender1: agent button + prepared link; tender2: agent button only
  assert.equal(kb.inline_keyboard.length, 3);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'agent:start:UA-2026-01-01-000007-a');
  assert.match(kb.inline_keyboard[1][0].text, /^⬆️ Тендерна пропозиція підготовлена ✅$/);
  assert.equal(kb.inline_keyboard[1][0].url, 'https://drive.google.com/drive/folders/ABC');
  assert.equal(kb.inline_keyboard[2][0].callback_data, 'agent:start:UA-2026-01-01-000008-a');
  assert.equal(kb.inline_keyboard[2][0].url, undefined);
});


// ── Archive grouped + paginated navigation ──────────────────────────────────
function archEntry({ id = 'UA-2026-05-01-000001-a', provEdrpou = '41087617',
  provName = 'ТОВ «МАЙЛАБ»', custName = 'КНП «Лікарня»', custEdrpou = '111',
  amount = 100000, contractDate = '2026-05-10T10:00:00+03:00', status = 'complete' } = {}) {
  return {
    tender_id: id, archived_at: '2026-05-12T12:00:00Z', final_status: status,
    final_snapshot: {
      procuringEntity: { name: custName, edrpou: custEdrpou },
      value: { amount, currency: 'UAH' },
      awards: [{ status: 'active', suppliers: [{ name: provName, identifier: { id: provEdrpou } }] }],
      contracts: [{ id: 'c1', status: 'active', documents: [{ url: 'https://x/c.pdf', datePublished: contractDate }] }],
    },
  };
}

test('findContractDate: datePublished of contract doc', () => {
  assert.equal(findContractDate(archEntry({ contractDate: '2026-03-15T09:00:00+03:00' })), '2026-03-15T09:00:00+03:00');
});

test('findContractDate: skips notice docs, falls back to archived_at', () => {
  const e = { archived_at: '2026-01-02T00:00:00Z', final_snapshot: { contracts: [{ documents: [{ url: 'x', documentType: 'notice', datePublished: '2030-01-01' }] }] } };
  assert.equal(findContractDate(e), '2026-01-02T00:00:00Z');
});

test('buildArchiveMenu: empty archive', () => {
  assert.equal(buildArchiveMenu({ archive: [] }).keyboard, null);
});

test('buildArchiveMenu: two entry buttons + count', () => {
  const m = buildArchiveMenu({ archive: [archEntry()] });
  assert.deepEqual(m.keyboard.inline_keyboard[0].map((b) => b.callback_data), ['arch:co', 'arch:pe']);
  assert.match(m.text, /усього 1/);
});

test('groupArchiveByProvider: groups by provider, no-provider last', () => {
  const g = groupArchiveByProvider([
    archEntry({ provEdrpou: '111', provName: 'A' }),
    archEntry({ provEdrpou: '222', provName: 'B' }),
    archEntry({ provEdrpou: '111', provName: 'A' }),
    { tender_id: 'x', final_snapshot: { awards: [] } },
  ]);
  assert.equal(g.length, 3);
  assert.equal(g[g.length - 1].provider, null);
  assert.equal(g.find((x) => x.provider?.edrpou === '111').entries.length, 2);
});

test('buildArchiveCompanyList: one row per provider + back to menu', () => {
  const rows = buildArchiveCompanyList({ archive: [archEntry({ provEdrpou: '111' }), archEntry({ provEdrpou: '222' })] }).keyboard.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.equal(rows[2][0].callback_data, 'arch:menu');
  assert.match(rows[0][0].callback_data, /^arch:co:0:0$/);
});

test('groupArchiveByYear: by contract date year, desc', () => {
  const y = groupArchiveByYear([
    archEntry({ contractDate: '2025-06-01T00:00:00Z' }),
    archEntry({ contractDate: '2026-02-01T00:00:00Z' }),
    archEntry({ contractDate: '2026-08-01T00:00:00Z' }),
  ]);
  assert.deepEqual(y.map(([yr]) => yr), ['2026', '2025']);
  assert.equal(y[0][1].length, 2);
});

test('buildArchiveMonthList: months of the year, desc, with counts', () => {
  const rows = buildArchiveMonthList({ archive: [
    archEntry({ contractDate: '2026-02-10T00:00:00Z' }),
    archEntry({ contractDate: '2026-02-20T00:00:00Z' }),
    archEntry({ contractDate: '2026-05-01T00:00:00Z' }),
    archEntry({ contractDate: '2025-01-01T00:00:00Z' }),
  ], year: '2026' }).keyboard.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.match(rows[0][0].text, /Травень 2026 \(1\)/);
  assert.match(rows[1][0].text, /Лютий 2026 \(2\)/);
  assert.equal(rows[0][0].callback_data, 'arch:pe:2026:05:0');
});

test('renderArchivePage: 6 per page with nav arrows', () => {
  const archive = Array.from({ length: 8 }, (_, i) =>
    archEntry({ id: `UA-2026-05-0${i + 1}-00000${i}-a`, provEdrpou: '111', contractDate: `2026-05-0${i + 1}T00:00:00Z` }));
  const nav0 = renderArchivePage({ archive, filter: { type: 'company', index: 0 }, page: 0 }).keyboard.inline_keyboard[0];
  assert.ok(nav0.some((b) => b.text === 'Далі ▶'));
  assert.ok(nav0.some((b) => b.text === '1/2'));
  assert.ok(!nav0.some((b) => b.text === '◀ Назад'));
  const nav1 = renderArchivePage({ archive, filter: { type: 'company', index: 0 }, page: 1 }).keyboard.inline_keyboard[0];
  assert.ok(nav1.some((b) => b.text === '◀ Назад'));
  assert.ok(!nav1.some((b) => b.text === 'Далі ▶'));
});

test('renderArchivePage: shows contract date + UA link + договір', () => {
  const pg = renderArchivePage({ archive: [archEntry({ provEdrpou: '111', contractDate: '2026-03-15T00:00:00Z' })], filter: { type: 'company', index: 0 } });
  assert.match(pg.text, /15\.03\.2026/);
  assert.match(pg.text, /prozorro\.gov\.ua\/tender\//);
  assert.match(pg.text, /Завантажити договір/);
});

test('handleArchiveNav: noop → null; menu/co/pe/month routing', () => {
  const archive = [archEntry({ provEdrpou: '111', contractDate: '2026-04-01T00:00:00Z' })];
  assert.equal(handleArchiveNav({ archive, data: 'arch:noop' }), null);
  assert.deepEqual(handleArchiveNav({ archive, data: 'arch:menu' }).keyboard.inline_keyboard[0].map((b) => b.callback_data), ['arch:co', 'arch:pe']);
  assert.match(handleArchiveNav({ archive, data: 'arch:co' }).text, /компанією/);
  assert.match(handleArchiveNav({ archive, data: 'arch:pe' }).text, /роком/);
  assert.match(handleArchiveNav({ archive, data: 'arch:pe:2026' }).text, /оберіть місяць/);
  assert.match(handleArchiveNav({ archive, data: 'arch:co:0:0' }).text, /Завантажити договір/);
  assert.match(handleArchiveNav({ archive, data: 'arch:pe:2026:04:0' }).text, /Квітень 2026/);
});

// --- Моніторинг закупівель: меню фаз ---
const monGroup = (status, id = 'UA-2026-06-01-000001-a', extra = {}) => ({
  tender_id: id,
  prozorro_url: `https://prozorro.gov.ua/tender/${id}`,
  status,
  deadline: null,
  procuring_entity: { name: 'КНП Лікарня', edrpou: '111' },
  ...extra,
});

test('monitorPhaseBuckets: only non-empty phases, lifecycle order, stable idx', () => {
  const buckets = monitorPhaseBuckets([
    monGroup('active.qualification', 'UA-2026-06-01-000001-a'),
    monGroup('active.tendering', 'UA-2026-06-01-000002-a'),
    monGroup('some.weird.status', 'UA-2026-06-01-000003-a'),
  ]);
  // tendering(idx0) before qualification(idx3) before OTHER(idx5)
  assert.deepEqual(buckets.map((b) => b.idx), [0, 3, 5]);
  assert.equal(buckets.find((b) => b.idx === 5).items.length, 1); // weird → OTHER
});

test('buildMonitorMenu: empty groups → keyboard null', () => {
  assert.equal(buildMonitorMenu({ groups: [], runIso: '2026-06-24T13:00:00Z' }).keyboard, null);
});

test('buildMonitorMenu: one row per non-empty phase, callback mon:ph:<idx>:0, counts', () => {
  const m = buildMonitorMenu({
    groups: [monGroup('active.tendering', 'UA-2026-06-01-000002-a'), monGroup('active.tendering', 'UA-2026-06-01-000004-a')],
    runIso: '2026-06-24T13:00:00Z',
  });
  assert.equal(m.keyboard.inline_keyboard.length, 1);
  assert.equal(m.keyboard.inline_keyboard[0][0].callback_data, 'mon:ph:0:0');
  assert.match(m.keyboard.inline_keyboard[0][0].text, /\(2\)/);
  assert.match(m.text, /Моніторинг закупівель/);
});

test('buildMonitorMenu: errors footer line', () => {
  const m = buildMonitorMenu({
    groups: [monGroup('active.tendering')],
    runIso: '2026-06-24T13:00:00Z',
    errors: [{ tender_id: 'UA-2026-06-01-000009-a', error: '404' }],
  });
  assert.match(m.text, /Не вдалось перевірити: 1/);
});

test('renderMonitorPage: 6/page nav arrows, header, card content', () => {
  const groups = Array.from({ length: 8 }, (_, i) =>
    monGroup('active.qualification', `UA-2026-06-01-00000${i}-a`));
  const pg0 = renderMonitorPage({ groups, phaseIdx: 3, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  const nav0 = pg0.keyboard.inline_keyboard.find((r) => r.some((b) => b.callback_data === 'mon:noop'));
  assert.ok(nav0.some((b) => b.text === 'Далі ▶'));
  assert.ok(nav0.some((b) => b.text === '1/2'));
  assert.ok(!nav0.some((b) => b.text === '◀ Назад'));
  assert.match(pg0.text, /Розгляд пропозицій/);
  assert.match(pg0.text, /prozorro\.gov\.ua\/tender\//);
  const back = pg0.keyboard.inline_keyboard.at(-1)[0];
  assert.equal(back.callback_data, 'mon:menu');
  const pg1 = renderMonitorPage({ groups, phaseIdx: 3, page: 1, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  const nav1 = pg1.keyboard.inline_keyboard.find((r) => r.some((b) => b.callback_data === 'mon:noop'));
  assert.ok(nav1.some((b) => b.text === '◀ Назад'));
  assert.ok(!nav1.some((b) => b.text === 'Далі ▶'));
});

test('renderMonitorPage: admin gets 🤖 buttons only on tendering phase', () => {
  const groups = [monGroup('active.tendering', 'UA-2026-06-01-000002-a')];
  const asAdmin = renderMonitorPage({ groups, phaseIdx: 0, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'admin' });
  assert.match(JSON.stringify(asAdmin.keyboard.inline_keyboard), /agent:start:UA-2026-06-01-000002-a/);
  const asViewer = renderMonitorPage({ groups, phaseIdx: 0, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  assert.ok(!JSON.stringify(asViewer.keyboard.inline_keyboard).includes('agent:start'));
});

test('renderMonitorPage: unknown phaseIdx → falls back to menu', () => {
  const pg = renderMonitorPage({ groups: [monGroup('active.tendering')], phaseIdx: 99, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  assert.match(pg.text, /Моніторинг закупівель/);
});

test('handleMonitorNav: noop→null; menu/ph routing', () => {
  const groups = [monGroup('active.tendering', 'UA-2026-06-01-000002-a')];
  const args = { groups, runIso: '2026-06-24T13:00:00Z', role: 'viewer' };
  assert.equal(handleMonitorNav({ ...args, data: 'mon:noop' }), null);
  assert.match(handleMonitorNav({ ...args, data: 'mon:menu' }).text, /Моніторинг закупівель/);
  assert.match(handleMonitorNav({ ...args, data: 'mon:ph:0:0' }).text, /Приймання пропозицій/);
  // unknown → menu
  assert.match(handleMonitorNav({ ...args, data: 'mon:garbage' }).text, /Моніторинг закупівель/);
  // errors propagate to the menu footer
  assert.match(
    handleMonitorNav({ ...args, data: 'mon:menu', errors: [{ tender_id: 'UA-2026-06-01-000009-a', error: '404' }] }).text,
    /Не вдалось перевірити: 1/,
  );
});

test('applyEntityMutation: set_enabled flips one entity', () => {
  const out = applyEntityMutation(
    [{ edrpou: '11111111', name: 'A', enabled: true }, { edrpou: '22222222', name: 'B', enabled: true }],
    { type: 'set_enabled', edrpou: '22222222', enabled: false });
  assert.equal(out.find((e) => e.edrpou === '22222222').enabled, false);
  assert.equal(out.find((e) => e.edrpou === '11111111').enabled, true);
});
