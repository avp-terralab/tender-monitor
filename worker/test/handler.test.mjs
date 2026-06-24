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
      fetchLastCommit: async () => null,
      loadPendingDigest: async () => null,
      loadTenderState: async () => null,
      fetchLatestDeployCommit: async () => null,
      fetchAuditLog: async () => [],
      editMessageText: async () => {},
      answerCallbackQuery: async () => {},
      loadAgentJob: async () => null,
      listAgentJobs: async () => [],
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
    '👁 Моніторинг замовників',
    '📋 Моніторинг закупівель',
    '📦 Архів закупівель',
    '🤖 Агент',
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
    statusCache: new Map(), // isolate from other /status tests
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/status', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🟢 Worker live/);
  assert.match(sent[0].text, /Watchlist: 2 тендерів \(1 активних\)/);
  assert.match(sent[0].text, /sha fedcba9/);
});

test('runHandler: /status when loadWatchlist throws → reply with GitHub error note', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => { throw new Error('GitHub GET 503: timeout'); },
    statusCache: new Map(), // isolate: skip any previously cached response
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
  // New behavior: single phase-menu message instead of multi-page dump
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📋.*Моніторинг закупівель/);
  // Phase buttons in replyMarkup, not inline text ids
  assert.ok(sent[0].replyMarkup?.inline_keyboard, 'should have inline keyboard');
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

test('runHandler: /info partial Prozorro errors → single menu message with error count', async () => {
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
      if (id === 'UA-B') throw new Error('Prozorro 503');
      return RAW;
    },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 1 } },
    env: ENV, deps,
  });
  // New behavior: single menu message; error count surfaced in header
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📋.*Моніторинг закупівель/);
  assert.match(sent[0].text, /⚠️ Не вдалось перевірити: 1/);
});

test('runHandler: /info with multiple phases → single menu with phase buttons', async () => {
  const RAW = (id, status) => ({
    data: {
      tenderID: id, title: 'X', status,
      tenderPeriod: { endDate: '2026-06-01T14:00:00+03:00' },
      procuringEntity: { name: 'Тест', identifier: { id: '11111111' } },
      items: [],
    },
  });
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-T', enabled: true },
        { tender_id: 'UA-Q', enabled: true },
      ],
      sha: 'x',
    }),
    fetchTender: async (id) => RAW(id, id === 'UA-T' ? 'active.tendering' : 'active.qualification'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 7 } },
    env: ENV, deps,
  });
  // New behavior: single menu message with phase buttons (not multi-page dump)
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📋.*Моніторинг закупівель/);
  assert.equal(sent[0].replyToMessageId, 7);
  const kb = sent[0].replyMarkup?.inline_keyboard;
  assert.ok(Array.isArray(kb) && kb.length >= 2, 'should have at least 2 phase buttons');
  // Phase buttons contain phase identifiers in their callback_data
  const cbDatas = kb.flat().map(b => b.callback_data);
  assert.ok(cbDatas.some(d => d?.startsWith('mon:ph:')), 'phase buttons have mon:ph: callback_data');
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

test('runHandler: /watched with entities → paginated menu reply', async () => {
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
  assert.match(sent[0].text, /Моніторинг замовників/);
  assert.match(JSON.stringify(sent[0].replyMarkup), /wat:e:02000010/);
  assert.match(JSON.stringify(sent[0].replyMarkup), /wat:e:11111111/);
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

const WATCHED_TWO = [
  { edrpou: '12345678', name: 'КНП «Лікарня №1»', enabled: true },
  { edrpou: '01999106', name: 'ТОВ «TERRALAB IT»', enabled: true },
];

test('runHandler: /watched VIEW shows entity buttons (paginated menu) for editor', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  const kb = sent[0].replyMarkup;
  assert.ok(kb && kb.inline_keyboard, 'should have inline keyboard');
  assert.match(JSON.stringify(kb), /wat:e:12345678/);
  assert.match(JSON.stringify(kb), /wat:e:01999106/);
});

test('runHandler: /watched VIEW for viewer → shows paginated menu keyboard (read-only nav)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  const kb = sent[0].replyMarkup;
  assert.ok(kb && kb.inline_keyboard, 'viewer gets menu keyboard too');
  assert.match(JSON.stringify(kb), /wat:e:/);
});

test('runHandler: /watched empty list → no inline keyboard even for admin', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  const kb = sent[0].replyMarkup;
  assert.ok(!kb || !kb.inline_keyboard);
});

test('runHandler: /unwatch command → hint pointing to /watched', async () => {
  const { deps, sent } = makeDeps({});
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unwatch 12345678', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/watched/);
  assert.match(sent[0].text, /🗑/);
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

test('runHandler: /archive (no arg) shows the grouped-nav menu in one message', async () => {
  const archive = Array.from({ length: 100 }, (_, i) => ({
    tender_id: `UA-2026-05-01-${String(i).padStart(6, '0')}-a`,
    archived_at: `2026-05-12T08:${String(i % 60).padStart(2, '0')}:00Z`,
    final_status: 'complete',
    final_snapshot: { procuringEntity: { name: 'КНП Лікарня' }, value: { amount: 350000, currency: 'UAH' } },
  }));
  const { deps, sent } = makeDeps({
    loadArchivedTenders: async () => ({ archive, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/archive', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1, 'archive button shows a single menu message');
  assert.match(sent[0].text, /усього 100/);
  assert.deepEqual(
    sent[0].replyMarkup.inline_keyboard[0].map(b => b.callback_data),
    ['arch:co', 'arch:pe'],
  );
});

test('runHandler: arch: callback navigates the archive (edits in place)', async () => {
  const archive = [{
    tender_id: 'UA-2026-05-01-000001-a', archived_at: '2026-05-12T08:00:00Z', final_status: 'complete',
    final_snapshot: {
      procuringEntity: { name: 'КНП Лікарня', edrpou: '111' }, value: { amount: 350000, currency: 'UAH' },
      awards: [{ status: 'active', suppliers: [{ name: 'ТОВ МАЙЛАБ', identifier: { id: '41087617' } }] }],
      contracts: [{ id: 'c1', status: 'active', documents: [{ url: 'https://x/c.pdf', datePublished: '2026-04-10T00:00:00Z' }] }],
    },
  }];
  const acks = [];
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbq1', data: 'arch:co', message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadArchivedTenders: async () => ({ archive, sha: 's' }) }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1, 'callback edits the message in place');
  assert.match(edits[0].text, /компанією/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /arch:co:0:0/);
  assert.equal(acks.length, 1);
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

// ── /status cache tests ───────────────────────────────────────────────────────

test('runHandler: /status cache returns same response within 60s for admin', async () => {
  // Use an isolated cache Map so this test doesn't interact with others.
  const CACHE_ENV = { ...ENV, ADMIN_CHAT_ID: '7001' };
  let ghCallCount = 0;
  const ownCache = new Map();
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => { ghCallCount++; return { watchlist: [], sha: 'sha-x' }; },
    loadAllowedUsers: async () => ({ users: [], sha: null }),
    loadInvites: async () => ({ invites: [], sha: null }),
    fetchLastCommit: async () => null,
    loadArchivedTenders: async () => ({ archive: [], sha: null }),
    loadWatchedEntities: async () => ({ entities: [], sha: null }),
    loadPendingDigest: async () => null,
    loadTenderState: async () => null,
    fetchLatestDeployCommit: async () => null,
    statusCache: ownCache,
  });

  // First call — fresh fetch.
  await runHandler({
    update: { message: { chat: { id: 7001 }, text: '/status', message_id: 1 } },
    env: CACHE_ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🟢 Worker live/);
  const callsAfterFirst = ghCallCount;
  assert.ok(callsAfterFirst >= 1, 'should have fetched on first call');
  assert.doesNotMatch(sent[0].text, /cached/);

  // Second call immediately — should hit cache, no new GH calls.
  await runHandler({
    update: { message: { chat: { id: 7001 }, text: '/status', message_id: 2 } },
    env: CACHE_ENV,
    deps,
  });
  assert.equal(sent.length, 2);
  assert.equal(ghCallCount, callsAfterFirst, 'no new GitHub calls on cache hit');
  assert.match(sent[1].text, /cached/);
  assert.match(sent[1].text, /с тому/);
});

test('runHandler: /status cache expires after 60s and rebuilds', async () => {
  // Use an isolated cache Map so this test doesn't interact with others.
  const CACHE_ENV = { ...ENV, ADMIN_CHAT_ID: '7002' };
  let ghCallCount = 0;
  const ownCache = new Map();
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => { ghCallCount++; return { watchlist: [], sha: 'sha-y' }; },
    loadAllowedUsers: async () => ({ users: [], sha: null }),
    loadInvites: async () => ({ invites: [], sha: null }),
    fetchLastCommit: async () => null,
    loadArchivedTenders: async () => ({ archive: [], sha: null }),
    loadWatchedEntities: async () => ({ entities: [], sha: null }),
    loadPendingDigest: async () => null,
    loadTenderState: async () => null,
    fetchLatestDeployCommit: async () => null,
    statusCache: ownCache,
  });

  // Seed the cache with a first call.
  await runHandler({
    update: { message: { chat: { id: 7002 }, text: '/status', message_id: 1 } },
    env: CACHE_ENV,
    deps,
  });
  const callsAfterFirst = ghCallCount;

  // Simulate cache expiry by advancing Date.now past 60s.
  const realDateNow = Date.now;
  try {
    Date.now = () => realDateNow() + 61_000;
    await runHandler({
      update: { message: { chat: { id: 7002 }, text: '/status', message_id: 2 } },
      env: CACHE_ENV,
      deps,
    });
  } finally {
    Date.now = realDateNow;
  }

  assert.equal(sent.length, 2);
  // Cache expired → fresh fetch → no "(cached)" marker in the new response.
  assert.doesNotMatch(sent[1].text, /cached/);
  // New GH calls were made.
  assert.ok(ghCallCount > callsAfterFirst, 'should have re-fetched after cache expiry');
});

// ── Task 8: audit commit message on /add, /remove, callback add: ─────────────

test('runHandler: /add records audit commit message with actor + role', async () => {
  let savedOpts;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_env, _wl, _sha, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.ok(savedOpts, 'saveWatchlist received opts');
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Андрій \\[123/admin\\]$`));
});

test('runHandler: /remove records audit commit message', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: remove ${ID} `));
});

test('runHandler: /remove no-op does NOT save (nothing to log)', async () => {
  let saved = false;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async () => { saved = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(saved, false);
});

test('runHandler: actor falls back to allowed_users label when from is absent', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Оксана', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Оксана \\[456/editor\\]$`));
});

test('runHandler: actor name with separators is sanitized in commit message', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Ан·ій', last_name: '[x]' }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  const { parseAuditCommit } = await import('../../commands.mjs');
  assert.ok(parseAuditCommit(savedOpts.message), 'message remains parseable');
  assert.doesNotMatch(parseAuditCommit(savedOpts.message).actor, /[·\[\]]/, 'actor must not contain separator characters');
});

test('runHandler: callback add: records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
    editMessageReplyMarkup: async () => {},
    answerCallbackQuery: async () => {},
  });
  await runHandler({
    update: { callback_query: { id: 'cq1', data: `add:${ID}`, from: { first_name: 'Оксана' }, message: { chat: { id: 123 }, message_id: 5 } } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Оксана `));
});

test('runHandler: callback add: uses label from allowed_users when from has no display name', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Оксана', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
    editMessageReplyMarkup: async () => {},
    answerCallbackQuery: async () => {},
  });
  await runHandler({
    update: { callback_query: { id: 'cq2', data: `add:${ID}`, from: { id: 456 }, message: { chat: { id: 456 }, message_id: 6 } } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Оксана \\[456/editor\\]$`));
});

// ── Task 9: audit commit message on /watch and /unwatch ───────────────────────

test('runHandler: /watch records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
    searchTenderByEdrpou: async () => ({ name: 'КНП', ids: [] }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: '/watch 12345678', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: watch 12345678 · Андрій \[123\/admin\]$/);
});

// ── Task 10: audit commit message on /invite, /revoke, /role, /unarchive ──────

const ADMIN_FROM = { first_name: 'Адмін' };

test('runHandler: /invite records audit commit (label sanitized)', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 's' }),
    saveInvites: async (_e, _inv, _s, opts) => { savedOpts = opts; },
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-27T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/invite editor Олег', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: invite editor:Олег /);
});

test('runHandler: /invite label with separator chars is sanitized — commit remains parseable', async () => {
  // Label contains all three separator chars used by parseAuditCommit: · [ ]
  // Parser uses parts.slice(1).join(' ') so multi-word labels are kept intact.
  let savedOpts;
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 's' }),
    saveInvites: async (_e, _inv, _s, opts) => { savedOpts = opts; },
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-27T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/invite editor Олег · [boss]', message_id: 1 } },
    env: ENV, deps,
  });
  const { parseAuditCommit } = await import('../../commands.mjs');
  const parsed = parseAuditCommit(savedOpts.message);
  assert.ok(parsed, 'commit message must remain parseable after label sanitization');
  assert.doesNotMatch(parsed.target, /[·\[\]]/, 'sanitized target must not contain separator chars');
  assert.equal(parsed.action, 'invite', 'action must still be "invite"');
  assert.equal(parsed.chatId, '123', 'chatId must still be "123"');
  assert.equal(parsed.role, 'admin', 'role must still be "admin"');
});

test('runHandler: /revoke records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X', role: 'viewer' }], sha: 's' }),
    saveAllowedUsers: async (_e, _u, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/revoke 456', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: revoke 456 /);
});

test('runHandler: /role records audit commit with role suffix', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X', role: 'viewer' }], sha: 's' }),
    saveAllowedUsers: async (_e, _u, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/role editor 456', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: role→editor 456 /);
});

test('runHandler: /unarchive records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadArchivedTenders: async () => ({ archive: [{ tender_id: ID, notes: '' }], sha: 's' }),
    saveArchivedTenders: async (_e, _a, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: `/unarchive ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: unarchive ${ID} `));
});

// ── Task 11: /log admin-only audit log command ────────────────────────────────

const COMMITS = [
  { message: 'audit: add UA-2026-04-30-010542-a · Андрій [786078813/editor]', date: '2026-05-26T11:00:00Z' },
  { message: 'bot: update watchlist 2026', date: '2026-05-26T10:30:00Z' },
  { message: 'monitor: state update', date: '2026-05-26T10:00:00Z' },
  { message: 'audit: revoke 1402480451 · admin [123/admin]', date: '2026-05-25T09:00:00Z' },
];

test('runHandler: /log (admin) renders parsed audit actions only', async () => {
  const { deps, sent } = makeDeps({ fetchAuditLog: async () => COMMITS });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/log', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Журнал дій/);
  assert.match(sent[0].text, /Андрій додав UA-2026-04-30-010542-a/);
  assert.match(sent[0].text, /admin прибрав доступ 1402480451/);
  assert.doesNotMatch(sent[0].text, /update watchlist/);
  assert.doesNotMatch(sent[0].text, /state update/);
});

test('runHandler: /log non-admin → silent skip', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X', role: 'editor' }], sha: 's' }),
    fetchAuditLog: async () => COMMITS,
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/log', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /log handles GitHub failure gracefully', async () => {
  const { deps, sent } = makeDeps({ fetchAuditLog: async () => { throw new Error('GitHub 500'); } });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/log', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /недоступн/);
});

// ── Task 5: unwatch:<edrpou> callback ────────────────────────────────────────

const CB = (data, fromChatId = 123, from = { first_name: 'Андрій' }) => ({
  callback_query: { id: 'cq1', data, from, message: { chat: { id: fromChatId }, message_id: 9 } },
});

test('callback unwatch: removes entity, audits, toast (stays in MANAGE mode)', async () => {
  let savedOpts, edited, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
    editMessageText: async (args) => { edited = args; },
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.match(savedOpts.message, /^audit: unwatch 12345678 · Андрій \[123\/admin\]$/);
  // MANAGE mode text is the prompt (not the entity list)
  assert.match(edited.text, /Прибрати|Кого|Готово/);
  // MANAGE mode keyboard: 1 remaining entity row + Готово button
  assert.equal(edited.replyMarkup.inline_keyboard.length, 2);
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'unwatch:01999106');
  assert.equal(edited.replyMarkup.inline_keyboard[1][0].callback_data, 'watched:done');
  assert.match(acked.text, /Прибрано/);
});

test('callback unwatch: double-tap (already gone) → "вже прибрано", no save', async () => {
  let saved = false, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [{ edrpou: '01999106', name: 'X', enabled: true }], sha: 's' }),
    saveWatchedEntities: async () => { saved = true; },
    editMessageText: async () => {},
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.equal(saved, false);
  assert.match(acked.text, /[Вв]же прибрано/);
});

test('callback unwatch: viewer rejected, no save', async () => {
  let saved = false, acked;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    saveWatchedEntities: async () => { saved = true; },
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:12345678', 456, { first_name: 'V' }), env: ENV, deps });
  assert.equal(saved, false);
  assert.match(acked.text, /редактор|🚫/);
});

test('callback unwatch: invalid edrpou → toast, no save', async () => {
  let saved = false, acked;
  const { deps } = makeDeps({
    saveWatchedEntities: async () => { saved = true; },
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:abc'), env: ENV, deps });
  assert.equal(saved, false);
  assert.match(acked.text, /Невалідн/);
});

test('runHandler: viewer /unwatch command → hint (not refusal)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/unwatch 12345678', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/watched/);
});

// ── Task 2: VIEW/MANAGE mode callbacks ────────────────────────────────────────

test('callback watched:manage → editMessageText shows delete buttons + Готово', async () => {
  let edited, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async (a) => { acked = a; },
  });
  await runHandler({ update: CB('watched:manage'), env: ENV, deps });
  assert.equal(edited.replyMarkup.inline_keyboard.length, 3);
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'unwatch:12345678');
  assert.equal(edited.replyMarkup.inline_keyboard[2][0].callback_data, 'watched:done');
  assert.ok(acked);
});

test('callback watched:manage → viewer rejected', async () => {
  let edited, acked;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async (a) => { acked = a; },
  });
  await runHandler({ update: CB('watched:manage', 456, { first_name: 'V' }), env: ENV, deps });
  assert.equal(edited, undefined);
  assert.match(acked.text, /редактор|🚫/);
});

test('callback watched:done → editMessageText returns to VIEW (single button)', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('watched:done'), env: ENV, deps });
  assert.equal(edited.replyMarkup.inline_keyboard.length, 1);
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'watched:manage');
  assert.match(edited.text, /12345678/);
});

test('callback watched:manage on empty list (stale) → empty-state, no keyboard', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('watched:manage'), env: ENV, deps });
  assert.match(edited.text, /Не стежу за жодним замовником/);
  assert.ok(edited.replyMarkup == null);
});

test('callback watched:done on empty list (stale) → empty-state, no keyboard', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('watched:done'), env: ENV, deps });
  assert.match(edited.text, /Не стежу за жодним замовником/);
  assert.ok(edited.replyMarkup == null);
});

test('callback unwatch: after delete stays in MANAGE mode', async () => {
  let savedOpts, edited, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async (a) => { acked = a; },
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.match(savedOpts.message, /^audit: unwatch 12345678 /);
  assert.equal(edited.replyMarkup.inline_keyboard.length, 2); // 1 entity + Готово
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'unwatch:01999106');
  assert.equal(edited.replyMarkup.inline_keyboard[1][0].callback_data, 'watched:done');
  assert.match(acked.text, /Прибрано/);
});

test('callback unwatch: last entity → empty-state text, no keyboard', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [{ edrpou: '12345678', name: 'КНП', enabled: true }], sha: 's' }),
    saveWatchedEntities: async () => {},
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.match(edited.text, /Не стежу за жодним замовником/);
  assert.ok(edited.replyMarkup == null);
});

// ── Phase 3 Task 6: agent-trigger dispatch + enqueue ──────────────────────────

const AGENT_TID = 'UA-2026-04-30-010542-a';

// In-memory agent-pending store factory: returns deps + a ref to the saved state.
const makeAgentDeps = (overrides = {}) => {
  const store = { pending: {}, sha: 's-pending' };
  const sent = [];
  const acks = [];
  const edits = [];
  const jobs = [];
  const base = makeDeps({
    sendReply: async (a) => { sent.push(a); },
    answerCallbackQuery: async (a) => { acks.push(a); },
    editMessageText: async (a) => { edits.push(a); },
    editMessageReplyMarkup: async () => {},
    loadAgentPending: async () => ({ pending: structuredClone(store.pending), sha: store.sha }),
    saveAgentPending: async (_e, pending) => { store.pending = structuredClone(pending); },
    saveAgentJob: async (_e, job) => { jobs.push(job); },
    now: () => new Date('2026-06-21T10:00:00.000Z'),
    ...overrides,
  }).deps;
  return { deps: base, store, sent, acks, edits, jobs };
};

const agentMsg = (text, chatId = 123) => ({
  message: { chat: { id: chatId }, from: { first_name: 'Андрій' }, text, message_id: 7 },
});

test('agent:start (admin) → company keyboard shown', async () => {
  const { deps, edits, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Оберіть компанію/);
  const data = JSON.stringify(edits[0].replyMarkup);
  assert.match(data, new RegExp(`agent:co:${AGENT_TID}:maylab`));
  assert.equal(acks.length, 1);
});

test('agent:start (non-admin) → rejected, no keyboard, no state write', async () => {
  let pendingSaved = false;
  const { deps, edits, acks } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveAgentPending: async () => { pendingSaved = true; },
  });
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`, 456), env: ENV, deps });
  assert.equal(edits.length, 0, 'no company keyboard for non-admin');
  assert.equal(pendingSaved, false, 'no pending state written');
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /адмін/i);
});

test('agent:co:<tid>:maylab → pending saved with company МАЙЛАБ + price prompt', async () => {
  const { deps, store, sent, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price', at: '2026-06-21T10:00:00.000Z' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Введіть ціну/);
  assert.equal(acks.length, 1);
});

test('agent price reply "abc" → invalid, stays at await_price, no job', async () => {
  const { deps, store, sent, jobs } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price' };
  await runHandler({ update: agentMsg('abc'), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.equal(store.pending['123'].step, 'await_price', 'stays at await_price');
  assert.match(sent[0].text, /Невірна ціна/);
});

test('agent price reply "0" → rejected (zero price invalid)', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price' };
  await runHandler({ update: agentMsg('0'), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_price');
  assert.match(sent[0].text, /Невірна ціна/);
});

test('agent price reply "181200" → confirm keyboard + price stored', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price' };
  await runHandler({ update: agentMsg('181200'), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'confirm');
  assert.equal(store.pending['123'].price, '181200');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /МАЙЛАБ/);
  assert.match(sent[0].text, /181200/);
  const kb = JSON.stringify(sent[0].replyMarkup);
  assert.match(kb, new RegExp(`agent:confirm:${AGENT_TID}`));
});

test('agent price reply on stale pending (>15 min) → not consumed, pending dropped', async () => {
  const { deps, store, sent, jobs } = makeAgentDeps();
  // Opened the dialog ~20 min before the injected "now" (10:00:00) → expired.
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price', at: '2026-06-21T09:40:00.000Z' };
  await runHandler({ update: agentMsg('181200'), env: ENV, deps });
  assert.equal(jobs.length, 0, 'no job from a stray number');
  assert.equal(store.pending['123'], undefined, 'stale pending dropped');
  assert.ok(!sent.some(s => /Підтвердити/.test(JSON.stringify(s))), 'no confirm prompt for stale tid');
});

test('agent:confirm → saveAgentJob with contract-valid job, pending cleared, queued reply', async () => {
  const { deps, store, sent, jobs, acks } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', price: '181200', step: 'confirm' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    tender_id: AGENT_TID,
    link: `https://prozorro.gov.ua/tender/${AGENT_TID}`,
    company: 'МАЙЛАБ',
    price: '181200',
    requested_by: '123',
    status: 'pending',
    created_at: '2026-06-21T10:00:00.000Z',
  });
  assert.equal(store.pending['123'], undefined, 'pending cleared');
  assert.match(sent.at(-1).text, /черг/i);
  assert.equal(acks.length, 1);
});

test('agent:confirm without matching pending → no job, soft ack', async () => {
  const { deps, jobs, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /Немає активного|Невідома/i);
});

test('agent:cancel → pending cleared, Скасовано reply', async () => {
  const { deps, store, sent, acks } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price' };
  await runHandler({ update: CB(`agent:cancel:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined);
  assert.match(sent.at(-1).text, /Скасовано/);
  assert.equal(acks.length, 1);
});

test('non-admin text while no pending → normal handling (price step not triggered)', async () => {
  // A viewer typing a number must not be swallowed by the agent price step.
  const { deps, sent } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({ update: agentMsg('181200', 456), env: ENV, deps });
  // Viewer's free-text number isn't a command → no agent confirm prompt.
  assert.ok(!sent.some(s => /Підтвердити|МАЙЛАБ/.test(JSON.stringify(s))));
});


test('runHandler: /agent (admin) → action menu (pick + jobs)', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true, notes: 'Тест' }], sha: 's' }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, /agent:pick:0/);
  assert.match(cbs, /agent:jobs:0/);
});

test('runHandler: /agent for non-admin → no reply', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({ update: { message: { chat: { id: 456 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 0, 'non-admin /agent must be ignored');
});

test('runHandler: /info <id> (admin) attaches the «Надіслати агенту» button', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 's' }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: `/info ${ID}`, message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  assert.ok(sent.at(-1).replyMarkup.inline_keyboard, 'agent button expected on /info card');
  assert.equal(sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data, `agent:start:${ID}`);
});


test('runHandler: /agent (admin, multiple watchlist entries) → menu (filtering moves to pick callback)', async () => {
  const OTHER = 'UA-2026-04-30-088888-b';
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [
      { tender_id: ID, enabled: true, notes: 'Тендеринг' },
      { tender_id: OTHER, enabled: true, notes: 'Розгляд' },
    ], sha: 's' }),
    fetchTender: async (id) => id === ID
      ? RAW_OK
      : { data: { ...RAW_OK.data, tenderID: OTHER, status: 'active.qualification' } },
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, /agent:pick:0/);
});

test('runHandler: /agent with none in tendering → menu shown (pick button shows empty in T6)', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 's' }),
    fetchTender: async () => ({ data: { ...RAW_OK.data, status: 'active.qualification' } }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, /agent:pick:0/);
  assert.match(cbs, /agent:jobs:0/);
});

test('runHandler: /info <id> for non-tendering tender → no agent button', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 's' }),
    fetchTender: async () => ({ data: { ...RAW_OK.data, status: 'active.qualification' } }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: `/info ${ID}`, message_id: 1 } }, env: ENV, deps });
  assert.ok(!JSON.stringify(sent.at(-1).replyMarkup ?? {}).includes('agent:start'),
    'no agent button for a non-tendering tender');
});


test('runHandler: /agent with a done job → menu shown (done-job link moves to pick view in T6)', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true, notes: 'КНП «Х»' }], sha: 's' }),
    loadAgentJob: async () => ({ tender_id: ID, status: 'done', result: { drive_link: 'https://drive.google.com/drive/folders/REAL' } }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, /agent:pick:0/);
  assert.match(cbs, /agent:jobs:0/);
});

test('runHandler: /agent (admin) → menu with pick + jobs buttons', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '🤖 Агент', from: { id: 123 } } },
    env: ENV,
    deps: { ...makeDeps().deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, /agent:pick:0/);
  assert.match(cbs, /agent:jobs:0/);
});

test('runHandler: /info (no id) → single menu message with mon:ph button', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '📋 Моніторинг закупівель', from: { id: 123 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true }], sha: 's' }),
        fetchTender: async () => ({ data: { status: 'active.tendering', tenderPeriod: { endDate: '2026-07-01T00:00:00Z' }, procuringEntity: { name: 'КНП' } } }),
      }).deps,
      sendReply: async (a) => sent.push(a),
    },
  });
  assert.equal(sent.length, 1, 'one message, not a multi-page dump');
  assert.match(JSON.stringify(sent[0].replyMarkup), /mon:ph:0:0/);
});

test('runHandler: /watched → menu message with wat:e button', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '👁 Моніторинг замовників', from: { id: 123 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }) }).deps,
      sendReply: async (a) => sent.push(a),
    },
  });
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].replyMarkup), /wat:e:11111111/);
});

test('runHandler: callback mon:ph:0:0 → edits message in place with cards', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbq-mon', data: 'mon:ph:0:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true }], sha: 's' }),
        fetchTender: async () => ({ data: { status: 'active.tendering', tenderPeriod: { endDate: '2026-07-01T00:00:00Z' }, procuringEntity: { name: 'КНП' } } }),
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1, 'callback edits the message in place');
  assert.match(edits[0].text, /Приймання пропозицій/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /mon:menu/);
  assert.equal(acks.length, 1);
});

test('runHandler: wat:e:<edrpou> → edits to entity card', async () => {
  const acks = []; const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbw1', data: 'wat:e:11111111', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }) }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].replyMarkup), /wat:toggle:11111111/); // chat 123 = admin → canManage
  assert.equal(acks.length, 1);
});

test('runHandler: wat:toggle:<edrpou> → saves set_enabled, re-renders card', async () => {
  const acks = []; const edits = []; let saved = null;
  await runHandler({
    update: { callback_query: { id: 'cbw2', data: 'wat:toggle:11111111', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
        saveWatchedEntities: async (_e, entities) => { saved = entities; },
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(saved.find((e) => e.edrpou === '11111111').enabled, false, 'toggled off');
  assert.match(JSON.stringify(edits[0].replyMarkup), /🟢 Відновити/);
});

test('runHandler: wat:rm:<edrpou> → deletes, re-renders menu', async () => {
  const edits = []; let saved = null;
  await runHandler({
    update: { callback_query: { id: 'cbw3', data: 'wat:rm:11111111', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
        saveWatchedEntities: async (_e, entities) => { saved = entities; },
      }).deps,
      answerCallbackQuery: async () => {},
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(saved.length, 0, 'entity removed');
  assert.match(edits[0].text, /Не стежу за жодним|Моніторинг замовників/);
});

test('runHandler: wat:e for a viewer → card has NO manage buttons', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbw4', data: 'wat:e:11111111', from: { id: 456 }, message: { chat: { id: 456 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
      }).deps,
      answerCallbackQuery: async () => {},
      editMessageText: async (a) => edits.push(a),
    },
  });
  const cbs = JSON.stringify(edits[0].replyMarkup);
  assert.ok(!cbs.includes('wat:toggle'));
  assert.ok(!cbs.includes('wat:rm'));
  assert.match(cbs, /wat:menu:0/);
});

test('runHandler: agent:jobs:0 → edits to jobs page', async () => {
  const edits = []; const acks = [];
  await runHandler({
    update: { callback_query: { id: 'ca1', data: 'agent:jobs:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({}).deps,
      listAgentJobs: async () => ([{ tender_id: 'UA-2026-06-01-000002-a', status: 'done', company: 'ТОВ', created_at: '2026-06-20T10:00:00Z', result: { drive_link: 'https://drive/x' } }]),
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async (a) => acks.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Останні задачі/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /drive\/x/);
});

test('runHandler: agent:pick:0 → tender picker, active.tendering only', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca2', data: 'agent:pick:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [
          { tender_id: 'UA-2026-06-01-000002-a', enabled: true, notes: 'КНП' },
          { tender_id: 'UA-2026-06-01-000003-a', enabled: true, notes: 'Other' },
        ], sha: 's' }),
        fetchTender: async (id) => ({ data: { status: id.includes('000002') ? 'active.tendering' : 'complete' } }),
      }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.match(edits[0].text, /Оберіть тендер/);
  const cbs = JSON.stringify(edits[0].replyMarkup);
  assert.match(cbs, /agent:start:UA-2026-06-01-000002-a/);
  assert.ok(!cbs.includes('UA-2026-06-01-000003-a'), 'non-tendering tender excluded');
});

test('runHandler: agent:menu → edits back to menu', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca3', data: 'agent:menu', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: { ...makeDeps({}).deps, editMessageText: async (a) => edits.push(a), answerCallbackQuery: async () => {} },
  });
  assert.match(JSON.stringify(edits[0].replyMarkup), /agent:pick:0/);
});

test('runHandler: agent:pick:0 → prepared drive_link surfaces as a url button', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca5', data: 'agent:pick:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true, notes: 'КНП' }], sha: 's' }),
        fetchTender: async () => ({ data: { status: 'active.tendering' } }),
        loadAgentJob: async () => ({ tender_id: 'UA-2026-06-01-000002-a', status: 'done', result: { drive_link: 'https://drive/prepared' } }),
      }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.match(JSON.stringify(edits[0].replyMarkup), /drive\/prepared/);
});

test('runHandler: wat:toggle with page → re-rendered card keeps that page in back button', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbw5', data: 'wat:toggle:11111111:2', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
        saveWatchedEntities: async () => {},
      }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.match(JSON.stringify(edits[0].replyMarkup), /wat:menu:2/);
});

test('runHandler: wat:rm with page → re-rendered menu, page preserved (clamped if emptied)', async () => {
  const edits = []; let saved = null;
  await runHandler({
    update: { callback_query: { id: 'cbw6', data: 'wat:rm:11111111:1', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
        saveWatchedEntities: async (_e, entities) => { saved = entities; },
      }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.equal(saved.length, 0, 'entity removed');
  // only entity removed → empty menu; buildWatchedMenu clamps page safely (no crash)
  assert.match(edits[0].text, /Не стежу за жодним|Моніторинг замовників/);
});
