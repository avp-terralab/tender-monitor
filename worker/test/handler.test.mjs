import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHandler } from '../src/handler.mjs';

const RAW_OK = {
  data: {
    tenderID: 'UA-2026-04-30-010542-a',
    title: 'Реактиви',
    status: 'active.tendering',
    tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
    procuringEntity: { name: 'КНП', identifier: { id: '11111111' } },
    items: [],
  },
};
const ID = 'UA-2026-04-30-010542-a';

const makeDeps = (overrides = {}) => {
  const sent = [];
  return {
    sent,
    deps: {
      loadWatchlist: async () => ({ watchlist: [], sha: 'fake-sha' }),
      saveWatchlist: async () => ({}),
      fetchTender: async () => RAW_OK,
      extractSnapshot: (raw) => raw.data,
      sendReply: async (args) => { sent.push(args); },
      loadWatchedEntities: async () => ({ entities: [], sha: null }),
      saveWatchedEntities: async () => ({}),
      loadWatchedSeen: async () => ({ seen: {}, sha: null }),
      saveWatchedSeen: async () => ({}),
      fetchTendersFeed: async () => ({ items: [], next: null }),
      loadAllowedUsers: async () => ({ users: [], sha: null }),
      loadArchivedTenders: async () => ({ archive: [], sha: null }),
      saveArchivedTenders: async () => ({}),
      fetchContract: async () => ({ documents: [] }),
      setMyCommands: async () => {},
      ...overrides,
    },
  };
};

const ENV = {
  TELEGRAM_BOT_TOKEN: 'TOK',
  ADMIN_CHAT_ID: '123',
};

test('runHandler: no message → no-op', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({ update: { update_id: 1 }, env: ENV, deps });
  assert.equal(sent.length, 0);
});

test('runHandler: edited_message instead of message → no-op', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { edited_message: { text: '/help', chat: { id: 123 } } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: message from wrong chat → silent skip', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: invited user from allowed_users.json is allowed', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Olha' }], sha: 'sha' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 9 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 456);
});

test('runHandler: allowed user reply carries reply_markup keyboard', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].replyMarkup, 'replyMarkup must be set for allowed user');
  assert.ok(Array.isArray(sent[0].replyMarkup.keyboard));
  const flat = sent[0].replyMarkup.keyboard.flat().map(b => b.text);
  assert.deepEqual(flat, [
    '📋 Моніторинг закупівель',
    '👁 Моніторинг замовників',
    '📦 Архів закупівель',
    '❓ Допомога (список команд)',
  ]);
});

test('runHandler: button label "📋 Моніторинг закупівель" triggers /info logic and replies with keyboard', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '📋 Моніторинг закупівель', message_id: 2 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  // Empty watchlist → /info renders "📭 Немає активних тендерів."
  assert.match(sent[0].text, /Немає активних тендерів/);
  assert.ok(sent[0].replyMarkup);
});

test('runHandler: /menu → unknown command (removed)', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/menu', message_id: 3 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Не розумію/);
});

test('runHandler: /start for allowed user also carries the keyboard', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 7 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].replyMarkup);
});

test('runHandler: /start for non-allowed user does NOT carry keyboard', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/start', message_id: 7 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyMarkup, undefined);
});

test('runHandler: non-admin chat_id not in allowed_users.json is rejected', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 789 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /start from non-allowed → reply with their chat_id and access prompt', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/start', message_id: 5 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 999);
  assert.match(sent[0].text, /<code>999<\/code>/);
  assert.match(sent[0].text, /приватний бот/i);
  assert.match(sent[0].text, /Надішли цей id адміну/i);
});

test('runHandler: /start from allowed → friendly greeting with chat_id and /help hint', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 6 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 123);
  assert.match(sent[0].text, /<code>123<\/code>/);
  assert.match(sent[0].text, /\/help/);
  assert.doesNotMatch(sent[0].text, /приватний бот/i);
});

test('runHandler: /start@botusername variant works', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/start@terralab_tenders_bot', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<code>999<\/code>/);
});

test('runHandler: non-/start command from non-allowed → still silent', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: message without text → no-op', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

import { HELP_TEXT } from '../../commands.mjs';

test('runHandler: /help → sendReply HELP_TEXT', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 7 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, HELP_TEXT);
  assert.equal(sent[0].chatId, 123);
  assert.equal(sent[0].replyToMessageId, 7);
  assert.equal(sent[0].token, 'TOK');
});

test('runHandler: /unknown → sendReply "Не розумію"', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/foo', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не розумію/);
});

test('runHandler: free text → no-op', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: 'hello', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /add invalid id → reply, no GitHub call', async () => {
  let loadCalled = false;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => { loadCalled = true; return { watchlist: [], sha: 'x' }; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/add bad-id', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(loadCalled, false);
  assert.match(sent[0].text, /Невалідний/);
});

test('runHandler: /add missing id → reply', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/add', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не вказано/);
});

test('runHandler: /add new tender → load + save + reply ✅ Додано', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
    saveWatchlist: async (env, wl, sha) => { saved.push({ wl, sha }); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sha, 'sha1');
  assert.equal(saved[0].wl[0].tender_id, ID);
  assert.match(sent[0].text, /✅ Додано/);
});

test('runHandler: /add existing-enabled → no save, ⚠️ Вже моніторю', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: ID, enabled: true, notes: 'old' }],
      sha: 'sha1',
    }),
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /⚠️ Вже моніторю/);
});

test('runHandler: /add fake (Prozorro 404) → no save, ❌ reply', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    fetchTender: async () => { throw new Error('Prozorro summary 404'); },
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /❌/);
});

test('runHandler: /add saveWatchlist 409 once → retry success', async () => {
  let saveAttempts = 0;
  let loadCalls = 0;
  const { ConflictError } = await import('../src/github.mjs');
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => {
      loadCalls++;
      return { watchlist: [], sha: `sha${loadCalls}` };
    },
    saveWatchlist: async () => {
      saveAttempts++;
      if (saveAttempts === 1) throw new ConflictError('409');
      return {};
    },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveAttempts, 2);
  assert.equal(loadCalls, 2);
  assert.match(sent[0].text, /✅ Додано/);
});

test('runHandler: /add saveWatchlist 409 twice → ⚠️ reply', async () => {
  const { ConflictError } = await import('../src/github.mjs');
  const { deps, sent } = makeDeps({
    saveWatchlist: async () => { throw new ConflictError('409'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /⚠️ Не зміг зберегти/);
});

test('runHandler: /add when loadWatchlist 5xx → ⚠️ reply, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => { throw new Error('GitHub GET 503'); },
    saveWatchlist: async () => { saveCalled = true; },
    fetchTender: async () => RAW_OK,
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /⚠️ GitHub/);
});

test('runHandler: /status with watchlist → reply with counts and sha', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-A', enabled: true },
        { tender_id: 'UA-B', enabled: false },
      ],
      sha: 'fedcba9876543210',
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/status', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🟢 Worker live/);
  assert.match(sent[0].text, /Watchlist: 2 tenders \(1 active\)/);
  assert.match(sent[0].text, /sha fedcba9/);
});

test('runHandler: /status when loadWatchlist throws → reply with GitHub error note', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => { throw new Error('GitHub GET 503: timeout'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/status', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Worker live, але GitHub недоступний/);
  assert.match(sent[0].text, /503/);
});

test('runHandler: /remove existing tender → save + reply ✅ Видалено', async () => {
  const saved = [];
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: ID, enabled: true, notes: 'old' }],
      sha: 'sha1',
    }),
    saveWatchlist: async (env, wl, sha) => { saved.push({ wl, sha }); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].wl.length, 0);
  assert.match(sent[0].text, /✅ Видалено/);
});

test('runHandler: /remove non-existing tender → ❓, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /❓.*не у watchlist/);
});

test('runHandler: /remove invalid id → error reply, no GitHub call', async () => {
  let loadCalled = false;
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => { loadCalled = true; return { watchlist: [], sha: 'x' }; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/remove bad-id', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(loadCalled, false);
  assert.match(sent[0].text, /Невалідний/);
});

test('runHandler: /remove without id → "Не вказано"', async () => {
  const { deps, sent } = await makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/remove', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не вказано/);
});

test('runHandler: /info with active tenders → fetch each + reply', async () => {
  const RAW = (id) => ({
    data: {
      tenderID: id, title: 'X', status: 'active.tendering',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'Тест', identifier: { id: '11111111' } },
      items: [{ classification: { id: '72260000-5', description: 'Test', scheme: 'ДК021' } }],
      value: { amount: 100, currency: 'UAH', valueAddedTaxIncluded: false },
    },
  });
  const fetched = [];
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-A', enabled: true },
        { tender_id: 'UA-B', enabled: true },
        { tender_id: 'UA-C', enabled: false },
      ],
      sha: 'abc',
    }),
    fetchTender: async (id) => { fetched.push(id); return RAW(id); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 1 } },
    env: ENV,
    deps,
  });
  // Disabled UA-C must NOT be fetched
  assert.deepEqual(fetched.sort(), ['UA-A', 'UA-B']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📋 Статус тендерів/);
  assert.match(sent[0].text, /UA-A/);
  assert.match(sent[0].text, /UA-B/);
  assert.doesNotMatch(sent[0].text, /UA-C/);
});

test('runHandler: /info UA-... existing in watchlist → fetches just that one', async () => {
  const RAW = (id) => ({
    data: {
      tenderID: id, title: 'X', status: 'active.tendering',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'T', identifier: { id: '1' } },
      items: [],
    },
  });
  const fetched = [];
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-2026-04-30-010542-a', enabled: true },
        { tender_id: 'UA-2026-04-30-010543-a', enabled: true },
      ],
      sha: 'abc',
    }),
    fetchTender: async (id) => { fetched.push(id); return RAW(id); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info UA-2026-04-30-010542-a', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.deepEqual(fetched, ['UA-2026-04-30-010542-a']);
  assert.match(sent[0].text, /UA-2026-04-30-010542-a/);
  assert.doesNotMatch(sent[0].text, /UA-2026-04-30-010543-a/);
});

test('runHandler: /info UA-... not in watchlist → ❓ reply, no fetch', async () => {
  let fetched = false;
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'x' }),
    fetchTender: async () => { fetched = true; return RAW_OK; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info UA-2026-04-30-010542-a', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(fetched, false);
  assert.match(sent[0].text, /❓ UA-2026-04-30-010542-a не у watchlist/);
  assert.match(sent[0].text, /\/add UA-2026-04-30-010542-a/);
});

test('runHandler: /info UA-... existing but disabled → still fetched and shown', async () => {
  const fetched = [];
  const RAW = {
    data: {
      tenderID: ID, title: 'X', status: 'complete',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'T', identifier: { id: '1' } },
      items: [],
    },
  };
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: ID, enabled: false, notes: 'auto-disabled: 404' }],
      sha: 'x',
    }),
    fetchTender: async (id) => { fetched.push(id); return RAW; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/info ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.deepEqual(fetched, [ID]);
  assert.match(sent[0].text, new RegExp(ID));
});

test('runHandler: /info empty enabled watchlist → friendly reply', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: 'UA-A', enabled: false }],
      sha: 'x',
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /📭 Немає активних тендерів/);
});

test('runHandler: /info partial Prozorro errors are listed in footer', async () => {
  let count = 0;
  const RAW = {
    data: {
      tenderID: 'UA-A', title: 'X', status: 'active.tendering',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'T', identifier: { id: '1' } },
      items: [],
    },
  };
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-A', enabled: true },
        { tender_id: 'UA-B', enabled: true },
      ],
      sha: 'x',
    }),
    fetchTender: async (id) => {
      count++;
      if (id === 'UA-B') throw new Error('Prozorro 503');
      return RAW;
    },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /UA-A/);
  assert.match(sent[0].text, /⚠️ не вдалось перевірити/);
  assert.match(sent[0].text, /UA-B — Prozorro 503/);
});

test('runHandler: /info when loadWatchlist throws → ⚠️ reply', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => { throw new Error('GitHub GET 503'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /⚠️ GitHub недоступний/);
});

test('runHandler: /watched empty → 📭 reply', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: null }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /📭/);
});

test('runHandler: /watched with entities → list reply', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => ({
      entities: [
        { edrpou: '02000010', name: 'КП «Х»', enabled: true },
        { edrpou: '11111111', name: '(unknown)', enabled: true },
      ],
      sha: 'x',
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /02000010/);
  assert.match(sent[0].text, /11111111/);
  assert.match(sent[0].text, /Всього: 2/);
});

test('runHandler: /watched when GitHub fails → ⚠️ reply', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => { throw new Error('GitHub GET 503'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /⚠️ GitHub/);
});

test('runHandler: /unwatch invalid edrpou → ❌ reply, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = await makeDeps({
    saveWatchedEntities: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unwatch abc', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /ЄДРПОУ має бути 8 цифр/);
  assert.equal(saveCalled, false);
});

test('runHandler: /unwatch missing edrpou → "Не вказано" reply', async () => {
  const { deps, sent } = await makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unwatch', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не вказано/);
});

test('runHandler: /unwatch existing → save + reply ✅', async () => {
  const saved = [];
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => ({
      entities: [{ edrpou: '11111111', name: 'X', enabled: true }],
      sha: 'sha1',
    }),
    saveWatchedEntities: async (env, entities, sha) => { saved.push({ entities, sha }); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unwatch 11111111', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /✅ Прибрав 11111111/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entities.length, 0);
});

test('runHandler: /unwatch non-existing → ❓, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 'sha1' }),
    saveWatchedEntities: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unwatch 11111111', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /❓ 11111111/);
  assert.equal(saveCalled, false);
});

test('runHandler: /watch invalid → ❌ reply, no calls', async () => {
  let loadCalled = false;
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => { loadCalled = true; return { entities: [], sha: null }; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watch abc', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /ЄДРПОУ має бути 8 цифр/);
  assert.equal(loadCalled, false);
});

test('runHandler: /watch missing → "Не вказано"', async () => {
  const { deps, sent } = await makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watch', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не вказано/);
});

test('runHandler: /watch new EDRPOU → save entity + bootstrap seen', async () => {
  const savedEntities = [];
  const savedSeen = [];
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: null }),
    saveWatchedEntities: async (env, entities) => { savedEntities.push(entities); },
    loadWatchedSeen: async () => ({ seen: {}, sha: null }),
    saveWatchedSeen: async (env, seen) => { savedSeen.push(seen); },
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-A', procuringEntity: { identifier: { id: '11111111' }, name: 'КНП «Тест»' } },
      ],
      next: null,
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-A',
        status: 'active.tendering',
        procuringEntity: { name: 'КНП «Тест»', identifier: { id: '11111111' } },
        items: [],
      },
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watch 11111111', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /✅ Стежу за 11111111/);
  assert.equal(savedEntities.length, 1);
  assert.equal(savedEntities[0].length, 1);
  assert.equal(savedEntities[0][0].edrpou, '11111111');
  assert.equal(savedSeen.length, 1);
  assert.deepEqual(savedSeen[0]['11111111'], ['UA-A']);
});

test('runHandler: /watch existing → no save, no bootstrap', async () => {
  let saveEntityCalled = false;
  let saveSeenCalled = false;
  const { deps, sent } = await makeDeps({
    loadWatchedEntities: async () => ({
      entities: [{ edrpou: '11111111', name: 'X', enabled: true }],
      sha: 's',
    }),
    saveWatchedEntities: async () => { saveEntityCalled = true; },
    saveWatchedSeen: async () => { saveSeenCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watch 11111111', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /⚠️ Вже стежу/);
  assert.equal(saveEntityCalled, false);
  assert.equal(saveSeenCalled, false);
});

test('runHandler: ADMIN_CHAT_ID always allowed without GitHub load', async () => {
  let loadCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => { loadCalled = true; return { users: [], sha: null }; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(loadCalled, false);
});

// Task 10: /start <token> redeem branch
test('runHandler: /start <token> valid → mutates both files, replies, notifies admin', async () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    expires_at: '2099-01-01T00:00:00Z',
    redeemed_by: null,
    redeemed_at: null,
  };
  let savedInvites = null;
  let savedUsers = null;
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [invite], sha: 'inv-sha' }),
    saveInvites: async (env, next, sha) => { savedInvites = { next, sha }; return {}; },
    loadAllowedUsers: async () => ({ users: [], sha: 'usr-sha' }),
    saveAllowedUsers: async (env, next, sha) => { savedUsers = { next, sha }; return {}; },
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 555 }, text: `/start ${'a'.repeat(32)}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites.sha, 'inv-sha');
  assert.equal(savedInvites.next[0].status, 'redeemed');
  assert.equal(savedInvites.next[0].redeemed_by, '555');
  assert.equal(savedUsers.sha, 'usr-sha');
  assert.equal(savedUsers.next[0].chat_id, '555');
  assert.equal(savedUsers.next[0].label, 'Olha');

  assert.equal(sent.length, 2);
  const toUser = sent.find(s => s.chatId === 555);
  const toAdmin = sent.find(s => String(s.chatId) === '123');
  assert.ok(toUser);
  assert.ok(toAdmin);
  assert.match(toUser.text, /Доступ надано/);
  assert.match(toAdmin.text, /приєднався/);
});

test('runHandler: /start <token> redeem with role:editor → setMyCommands for new editor', async () => {
  const invite = {
    token: 'b'.repeat(32),
    label: 'Andrii',
    role: 'editor',
    status: 'pending',
    expires_at: '2099-01-01T00:00:00Z',
    redeemed_by: null,
    redeemed_at: null,
  };
  const calls = [];
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [invite], sha: 'inv-sha' }),
    saveInvites: async () => ({}),
    loadAllowedUsers: async () => ({ users: [], sha: 'usr-sha' }),
    saveAllowedUsers: async () => ({}),
    setMyCommands: async (args) => { calls.push(args); },
    now: () => new Date('2026-05-18T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 777 }, text: `/start ${'b'.repeat(32)}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  const targetCall = calls.find(c => c.chatId === '777');
  assert.ok(targetCall, 'expected setMyCommands for new redeemer 777');
  const names = targetCall.commands.map(c => c.command);
  assert.ok(names.includes('add'), 'editor commands should include /add');
});

test('runHandler: /start <token> redeem with role:viewer → setMyCommands for new viewer', async () => {
  const invite = {
    token: 'c'.repeat(32),
    label: 'Olha',
    role: 'viewer',
    status: 'pending',
    expires_at: '2099-01-01T00:00:00Z',
    redeemed_by: null,
    redeemed_at: null,
  };
  const calls = [];
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [invite], sha: 'inv-sha' }),
    saveInvites: async () => ({}),
    loadAllowedUsers: async () => ({ users: [], sha: 'usr-sha' }),
    saveAllowedUsers: async () => ({}),
    setMyCommands: async (args) => { calls.push(args); },
    now: () => new Date('2026-05-18T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 888 }, text: `/start ${'c'.repeat(32)}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  const targetCall = calls.find(c => c.chatId === '888');
  assert.ok(targetCall, 'expected setMyCommands for new redeemer 888');
  const names = targetCall.commands.map(c => c.command);
  assert.ok(!names.includes('add'), 'viewer commands should NOT include /add');
  assert.ok(names.includes('info'), 'viewer commands should include /info');
});

test('runHandler: /start <token> invalid → reply, no mutations', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: null }),
    saveInvites: async () => { saveCalled = true; return {}; },
  });
  await runHandler({
    update: { message: { chat: { id: 555 }, text: `/start ${'b'.repeat(32)}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Невалідне посилання/);
});

test('runHandler: /start with malformed token → invalid_token reply', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 555 }, text: '/start xyz', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Невалідне посилання/);
});

// Task 11: /invite admin-only command
test('runHandler: /invite as admin → appends invite, replies with link', async () => {
  let savedInvites = null;
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 'i-sha' }),
    saveInvites: async (env, next, sha) => { savedInvites = next; return {}; },
    generateToken: () => 'c'.repeat(32),
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite editor Olha', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites.length, 1);
  assert.equal(savedInvites[0].label, 'Olha');
  assert.equal(savedInvites[0].role, 'editor');
  assert.equal(savedInvites[0].token, 'c'.repeat(32));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /t\.me\/terralab_tenders_bot\?start=c{32}/);
});

test('runHandler: /invite as non-admin → silently ignored', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/invite Y', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /invite without role → error reply (admin)', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Вкажи роль/);
});

// Task 12: /invites, /users, /revoke admin commands
test('runHandler: /invites as admin → lists active invites', async () => {
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({
      invites: [{
        token: 'd'.repeat(32), label: 'Olha', status: 'pending',
        created_at: '2026-05-11T10:00:00Z', expires_at: '2099-01-01T00:00:00Z',
      }],
      sha: 's',
    }),
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invites', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Olha/);
});

test('runHandler: /invites as non-admin → silent', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/invites', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /users as admin → shows admin + invited', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '789', label: 'Olha', invited_via: 'Olha', added_at: '2026-05-11T10:00:00Z' }],
      sha: 's',
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/users', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /123/);
  assert.match(sent[0].text, /789/);
  assert.match(sent[0].text, /Olha/);
});

test('runHandler: /revoke as admin → removes user', async () => {
  let savedUsers = null;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '789', label: 'Olha' }], sha: 's' }),
    saveAllowedUsers: async (env, next) => { savedUsers = next; return {}; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/revoke 789', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.deepEqual(savedUsers, []);
  assert.match(sent[0].text, /видалено/);
});

test('runHandler: /revoke admin chat_id → refused', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/revoke 123', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не можу видалити адміна/);
});

test('runHandler: /archive (no arg) renders empty', async () => {
  const { deps, sent } = makeDeps({
    loadArchivedTenders: async () => ({ archive: [], sha: null }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/archive', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📭 Архів порожній/);
});

test('runHandler: /archive UA-... uses fresh fetchTender for contracts', async () => {
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    archived_at: '2026-05-12T08:30:00Z',
    final_status: 'complete',
    final_snapshot: { procuringEntity: { name: 'КНП' } },
  }];
  let fetched = false;
  const { deps, sent } = makeDeps({
    loadArchivedTenders: async () => ({ archive, sha: 'sha-arch' }),
    fetchTender: async () => {
      fetched = true;
      return { data: { contracts: [{ id: 'C1' }] } };
    },
    // /archive UA-... hydrates contract docs via fetchContract (/contracts/{id})
    fetchContract: async () => ({ documents: [{ title: 'D1', url: 'https://x' }] }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/archive UA-2026-04-30-010542-a', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(fetched, true);
  assert.match(sent[0].text, /📄 Договір/);
});

test('runHandler: /unarchive deletes from archive (no watchlist re-add)', async () => {
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    notes: 'КНП — Реактиви',
    final_status: 'complete',
    final_snapshot: {},
  }];
  let watchlistSaveCalled = false;
  const savedArchives = [];
  const { deps, sent } = makeDeps({
    loadArchivedTenders: async () => ({ archive, sha: 'arch-sha' }),
    saveArchivedTenders: async (env, arr) => { savedArchives.push(arr); return {}; },
    saveWatchlist: async () => { watchlistSaveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unarchive UA-2026-04-30-010542-a', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /✅ UA-2026-04-30-010542-a видалено з архіву/);
  assert.equal(watchlistSaveCalled, false);
  assert.equal(savedArchives.length, 1);
  assert.equal(savedArchives[0].length, 0);
});

test('runHandler: /add for archived UA → warning, no Prozorro fetch', async () => {
  let fetched = false;
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    final_status: 'complete',
    notes: 'X',
  }];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl-sha' }),
    loadArchivedTenders: async () => ({ archive, sha: 'arch-sha' }),
    fetchTender: async () => { fetched = true; return RAW_OK; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/add UA-2026-04-30-010542-a', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(fetched, false);
  assert.match(sent[0].text, /в архіві \(complete\)/);
  assert.match(sent[0].text, /\/unarchive UA-2026-04-30-010542-a/);
  assert.match(sent[0].text, /потім \/add знову/);
});

test('runHandler: /info UA-... with terminal status in watchlist → auto-archive + notice', async () => {
  const TID = 'UA-2026-04-30-010542-a';
  const RAW_TERMINAL = {
    data: {
      tenderID: TID, title: 'Реактиви', status: 'complete',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'КНП', identifier: { id: '11111111' } },
      contracts: [{ id: 'C1', status: 'active' }],
      items: [],
    },
  };
  const savedArchives = [];
  const savedWatchlists = [];
  const contractsFetched = [];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: TID, enabled: true, notes: 'КНП — Реактиви' }],
      sha: 'wl-sha',
    }),
    saveWatchlist: async (env, wl, sha) => { savedWatchlists.push({ wl, sha }); },
    loadArchivedTenders: async () => ({ archive: [], sha: 'arch-sha' }),
    saveArchivedTenders: async (env, arr, sha) => { savedArchives.push({ arr, sha }); },
    fetchTender: async () => RAW_TERMINAL,
    fetchContract: async (id) => {
      contractsFetched.push(id);
      return { documents: [{ id: 'doc1', title: 'Договір.pdf', url: 'http://x', documentType: 'contract' }] };
    },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/info ${TID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  // Reply: regular /info detail + archive notice
  assert.match(sent[0].text, new RegExp(TID));
  assert.match(sent[0].text, /📦 Архівовано/);
  assert.match(sent[0].text, new RegExp(`/archive ${TID}`));
  // Archive written, with hydrated contract documents
  assert.equal(savedArchives.length, 1);
  assert.equal(savedArchives[0].arr[0].tender_id, TID);
  assert.equal(savedArchives[0].arr[0].final_status, 'complete');
  assert.equal(savedArchives[0].arr[0].notes, 'КНП — Реактиви');
  assert.equal(savedArchives[0].arr[0].final_snapshot.contracts[0].documents.length, 1);
  // Contract fetch happened (hydration)
  assert.deepEqual(contractsFetched, ['C1']);
  // Watchlist deletion happened
  assert.equal(savedWatchlists.length, 1);
  assert.equal(savedWatchlists[0].wl.length, 0);
});

test('runHandler: /info UA-... terminal status NOT in watchlist → no archive write', async () => {
  const TID = 'UA-2026-04-30-010542-a';
  let archiveSaveCalled = false;
  let watchlistSaveCalled = false;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl-sha' }),
    loadArchivedTenders: async () => ({ archive: [], sha: 'arch-sha' }),
    saveArchivedTenders: async () => { archiveSaveCalled = true; },
    saveWatchlist: async () => { watchlistSaveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/info ${TID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  // Tender not in watchlist → falls through to "❓ не у watchlist" or archive-redirect.
  // Either way no archive write should happen for this fresh fetch path.
  assert.equal(archiveSaveCalled, false);
  assert.equal(watchlistSaveCalled, false);
});

test('runHandler: /info UA-... active.tendering (non-terminal) → no archive', async () => {
  const TID = 'UA-2026-04-30-010542-a';
  let archiveSaveCalled = false;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: TID, enabled: true, notes: 'X' }],
      sha: 'wl-sha',
    }),
    loadArchivedTenders: async () => ({ archive: [], sha: 'arch-sha' }),
    saveArchivedTenders: async () => { archiveSaveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/info ${TID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /UA-2026-04-30-010542-a/);
  assert.doesNotMatch(sent[0].text, /📦 Архівовано/);
  assert.equal(archiveSaveCalled, false);
});

test('runHandler: /info UA-... terminal, already in archive → notice still shown, no duplicate write', async () => {
  const TID = 'UA-2026-04-30-010542-a';
  const RAW_TERMINAL = {
    data: {
      tenderID: TID, title: 'X', status: 'complete',
      procuringEntity: { name: 'T', identifier: { id: '1' } },
      contracts: [],
      items: [],
    },
  };
  const savedArchives = [];
  const savedWatchlists = [];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: TID, enabled: true, notes: 'X' }],
      sha: 'wl-sha',
    }),
    saveWatchlist: async (env, wl) => { savedWatchlists.push(wl); },
    loadArchivedTenders: async () => ({
      archive: [{ tender_id: TID, final_status: 'complete', final_snapshot: {}, notes: 'X', archived_at: '2026-05-18T10:00:00Z' }],
      sha: 'arch-sha',
    }),
    saveArchivedTenders: async (env, arr) => { savedArchives.push(arr); },
    fetchTender: async () => RAW_TERMINAL,
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/info ${TID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  // Archive write skipped (already present), but watchlist still gets cleaned up
  assert.equal(savedArchives.length, 0);
  assert.equal(savedWatchlists.length, 1);
  assert.equal(savedWatchlists[0].length, 0);
  // Notice still shown (treats already-archived as success)
  assert.match(sent[0].text, /📦 Архівовано/);
});

test('runHandler: /info UA-... for archived → redirect', async () => {
  const archive = [{
    tender_id: 'UA-2026-04-30-010542-a',
    final_status: 'complete',
    final_snapshot: {},
  }];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl-sha' }),
    loadArchivedTenders: async () => ({ archive, sha: null }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info UA-2026-04-30-010542-a', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /📦 Ця закупівля в архіві/);
  assert.match(sent[0].text, /\/archive UA-2026-04-30-010542-a/);
});

test('runHandler: callback_query from non-allowed user → answers "Доступ заборонено", no edit, no add', async () => {
  const sent = [];
  const acks = [];
  const edits = [];
  const adds = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1',
        data: 'add:UA-2026-05-14-008910-a',
        message: { chat: { id: 999 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      sendReply: async (a) => sent.push(a),
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
      saveWatchlist: async () => adds.push('called'),
      loadAllowedUsers: async () => ({ users: [], sha: null }),
    },
  });
  assert.equal(sent.length, 0);
  assert.equal(edits.length, 0);
  assert.equal(adds.length, 0);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Доступ заборонено/);
});

test('runHandler: callback_query data="noop" → empty answer, nothing else', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: 'noop',
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 0);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].text, undefined);
});

test('runHandler: callback_query data="add:bad-format" → answers with error toast, no add, no edit', async () => {
  const acks = [];
  const edits = [];
  const adds = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: 'add:not-a-tender',
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
      saveWatchlist: async () => adds.push('x'),
    },
  });
  assert.equal(adds.length, 0);
  assert.equal(edits.length, 0);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Невалідний tender_id/);
});

test('runHandler: callback_query data="something-unknown" → answers with unknown-button toast', async () => {
  const acks = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: 'frobnicate',
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      answerCallbackQuery: async (a) => acks.push(a),
    },
  });
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Невідома кнопка/);
});

test('runHandler: callback add when tender already in watchlist → keyboard ℹ️ Вже додано, toast', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 'sha1' }),
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].replyMarkup), /Вже додано/);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Вже моніторю/);
});

test('runHandler: callback add when tender in archive → keyboard 📦 В архіві, toast', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
        loadArchivedTenders: async () => ({ archive: [{ tender_id: ID, final_status: 'cancelled' }], sha: null }),
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].replyMarkup), /В архіві/);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /архів/i);
});

test('runHandler: callback add when GitHub conflict → keyboard NOT edited, error toast', async () => {
  const acks = [];
  const edits = [];
  // Simulate persistent ConflictError to exhaust applyMutationWithRetry retries.
  const { ConflictError } = await import('../src/github.mjs');
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
        saveWatchlist: async () => { throw new ConflictError('409'); },
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 0, 'keyboard should NOT be edited on error');
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /спробуй за хвилину/i);
});

test('runHandler: callback_query "add:UA-…" success → handleAdd, edit keyboard to ✅, toast', async () => {
  const acks = [];
  const edits = [];
  const saved = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
        saveWatchlist: async (env, wl) => { saved.push(wl); },
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  // Add happened
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].tender_id, ID);
  // Keyboard swapped
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 42);
  assert.equal(edits[0].chatId, '123');
  assert.match(JSON.stringify(edits[0].replyMarkup), /✅ Додано/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /"callback_data":"noop"/);
  // Toast
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /додано/i);
});

test('runHandler: viewer (no role field, legacy) → /add refused, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V' }], sha: 's' }),
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer (role:viewer) → /remove refused', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer → /watch refused', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchedEntities: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/watch 12345678', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer → /unwatch refused', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchedEntities: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/unwatch 12345678', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer → /unarchive refused', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/unarchive ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: editor (role:editor) → /add succeeds (saveWatchlist called)', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
    saveWatchlist: async (env, wl) => { saved.push(wl); },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.match(sent[0].text, /✅/);
});

test('runHandler: admin (chat_id == ADMIN_CHAT_ID) → /add succeeds', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
    saveWatchlist: async (env, wl) => { saved.push(wl); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
});

test('runHandler: viewer → /info still works (view command)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/info', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Немає активних тендерів/);
});

test('callback add: viewer → ack with refusal, no watchlist save', async () => {
  const acks = [];
  let saveCalled = false;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchlist: async () => { saveCalled = true; },
    answerCallbackQuery: async (args) => { acks.push(args); },
  });
  await runHandler({
    update: {
      callback_query: {
        id: 'cb1',
        data: `add:${ID}`,
        message: { chat: { id: 456 }, message_id: 99 },
      },
    },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /редакторів/);
  assert.equal(acks[0].showAlert, true);
});

test('callback add: editor → success (watchlist saved, ack OK)', async () => {
  const saved = [];
  const acks = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
    saveWatchlist: async (env, wl) => { saved.push(wl); },
    answerCallbackQuery: async (args) => { acks.push(args); },
    editMessageReplyMarkup: async () => {},
  });
  await runHandler({
    update: {
      callback_query: {
        id: 'cb2',
        data: `add:${ID}`,
        message: { chat: { id: 456 }, message_id: 99 },
      },
    },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.match(acks[0].text, /✅/);
});

// Task 14: /invite role-first + /role command wiring
test('runHandler: admin /invite editor Andrii → invite saved with role:editor', async () => {
  const savedInvites = [];
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 'inv' }),
    saveInvites: async (env, inv) => { savedInvites.push(inv); },
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-18T10:00:00.000Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite editor Andrii', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites.length, 1);
  assert.equal(savedInvites[0][0].role, 'editor');
  assert.equal(savedInvites[0][0].label, 'Andrii');
  assert.match(sent[0].text, /Andrii/);
});

test('runHandler: admin /invite viewer Olha → invite saved with role:viewer', async () => {
  const savedInvites = [];
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 'inv' }),
    saveInvites: async (env, inv) => { savedInvites.push(inv); },
    generateToken: () => 'b'.repeat(32),
    now: () => new Date('2026-05-18T10:00:00.000Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite viewer Olha', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites[0][0].role, 'viewer');
});

test('runHandler: admin /invite Andrii (no role keyword) → error reply, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    saveInvites: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite Andrii', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /Невалідна роль|роль/i);
});

test('runHandler: admin /role editor 456 (user is viewer) → role flipped', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '456', label: 'Andrii', role: 'viewer' }],
      sha: 'au',
    }),
    saveAllowedUsers: async (env, users) => { saved.push(users); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 456', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].role, 'editor');
  // Admin gets the role-flip confirmation (find by their chat_id 123)
  const adminMsg = sent.find(s => Number(s.chatId) === 123);
  assert.ok(adminMsg, 'expected admin confirmation message');
  assert.match(adminMsg.text, /Andrii/);
  assert.match(adminMsg.text, /→ editor/);
});

test('runHandler: admin /role viewer 123 (self) → refusal', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [], sha: 'au' }),
    saveAllowedUsers: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role viewer 123', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /адмін/i);
});

test('runHandler: admin /role editor 999 (not found) → error reply', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [], sha: 'au' }),
    saveAllowedUsers: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 999', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /не знайдено/);
});

test('runHandler: viewer /role editor 999 → silent return (admin-only)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/role editor 999', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: editor /invite editor X → silent return (admin-only)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/invite editor X', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: viewer /help → response missing /add and /invite', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.doesNotMatch(sent[0].text, /\/add\b/);
  assert.doesNotMatch(sent[0].text, /\/invite\b/);
  assert.match(sent[0].text, /\/info/);
});

test('runHandler: editor /help → response has /add but no /invite', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /\/add/);
  assert.doesNotMatch(sent[0].text, /\/invite\b/);
});

test('runHandler: admin /help → response has /role and /invite', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /\/role/);
  assert.match(sent[0].text, /\/invite/);
});

// Task 16: syncBotCommands on /start, redeem, /role
test('runHandler: /start (no token), viewer → setMyCommands called with viewer set', async () => {
  const calls = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, '456');
  const names = calls[0].commands.map(c => c.command);
  assert.ok(names.includes('info'));
  assert.ok(!names.includes('add'));
  assert.ok(!names.includes('invite'));
});

test('runHandler: /start (no token), editor → setMyCommands with editor set', async () => {
  const calls = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 1);
  const names = calls[0].commands.map(c => c.command);
  assert.ok(names.includes('add'));
  assert.ok(!names.includes('invite'));
});

test('runHandler: /start (no token), admin → setMyCommands with admin set', async () => {
  const calls = [];
  const { deps } = makeDeps({
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 1);
  const names = calls[0].commands.map(c => c.command);
  assert.ok(names.includes('invite'));
  assert.ok(names.includes('role'));
});

test('runHandler: /start from non-allowed → setMyCommands NOT called', async () => {
  const calls = [];
  const { deps } = makeDeps({
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 0);
});

test('runHandler: /role editor 456 success → setMyCommands for target chat 456', async () => {
  const calls = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '456', label: 'A', role: 'viewer' }], sha: 's',
    }),
    saveAllowedUsers: async () => {},
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 456', message_id: 1 } },
    env: ENV,
    deps,
  });
  // Expect at least one call with chatId 456 and editor commands
  const targetCall = calls.find(c => c.chatId === '456');
  assert.ok(targetCall, 'expected setMyCommands for target chat 456');
  const names = targetCall.commands.map(c => c.command);
  assert.ok(names.includes('add'));
});

test('runHandler: /role editor 456 success → target user receives role-change notice', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '456', label: 'A', role: 'viewer' }], sha: 's',
    }),
    saveAllowedUsers: async () => {},
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 456', message_id: 1 } },
    env: ENV,
    deps,
  });
  // sent[0] = admin's ✅ confirmation; sent[1] = target's role-change notice
  const targetMsg = sent.find(s => String(s.chatId) === '456');
  assert.ok(targetMsg, 'expected message to target chat 456');
  assert.match(targetMsg.text, /Адмін змінив твою роль/);
  assert.match(targetMsg.text, /editor/);
  // role-filtered command list included
  assert.match(targetMsg.text, /\/add/);
  assert.doesNotMatch(targetMsg.text, /\/invite\b/);
});

test('runHandler: /role viewer 456 (no-op, already viewer) → target NOT notified', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '456', label: 'A', role: 'viewer' }], sha: 's',
    }),
    saveAllowedUsers: async () => {},
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role viewer 456', message_id: 1 } },
    env: ENV,
    deps,
  });
  // Admin sees "ℹ️ вже viewer"; target should NOT get a notification
  const targetMsg = sent.find(s => String(s.chatId) === '456');
  assert.equal(targetMsg, undefined);
});

test('runHandler: setMyCommands failure does not block reply', async () => {
  const { deps, sent } = makeDeps({
    setMyCommands: async () => { throw new Error('boom'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1); // reply still went through
});
