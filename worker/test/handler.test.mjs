import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHandler, describeGithubError, githubUnavailableText, githubUnavailableAck } from '../src/handler.mjs';

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
    '📜 Історія',
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

// Repeated /start taps (people re-checking their chat_id) used to pile up a
// fresh "👋 Привіт!" every time — now it shares the same "one ephemeral view"
// KV slot the view commands use, so the previous exchange gets deleted first.
const fakeEphemeralKV = () => {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
};

test('runHandler: /start with an ephemeral KV configured → nothing to delete on the first tap', async () => {
  const deleted = [];
  let nextId = 100;
  const { deps, sent } = makeDeps({
    ephemeralKV: fakeEphemeralKV(),
    sendReply: async (a) => { sent.push(a); return { result: { message_id: nextId++ } }; },
    deleteMessage: async (a) => { deleted.push(a); return true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 7 } }, env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(deleted.length, 0, 'nothing to clean up yet');
});

test('runHandler: /start twice → the second tap deletes the first exchange (trigger + greeting)', async () => {
  const deleted = [];
  let nextId = 100;
  const { deps, sent } = makeDeps({
    ephemeralKV: fakeEphemeralKV(),
    sendReply: async (a) => { sent.push(a); return { result: { message_id: nextId++ } }; },
    deleteMessage: async (a) => { deleted.push(a); return true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 7 } }, env: ENV, deps,
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 8 } }, env: ENV, deps,
  });
  assert.equal(sent.length, 2);
  assert.equal(deleted.length, 2, 'deletes both the earlier trigger and the earlier greeting');
  assert.deepEqual(deleted.map((d) => d.messageId).sort((a, b) => a - b), [7, 100]);
});

// Regression: /start used to share the SAME ephemeral slot as /help and the
// other view commands, so the very next unrelated view command deleted the
// /start reply — the one message carrying the persistent ReplyKeyboardMarkup
// — off the chat. /start now has its own namespace (see ephemeral.test.mjs).
test('runHandler: /start then /help → /help does NOT delete the /start greeting (separate slots)', async () => {
  const deleted = [];
  let nextId = 100;
  const { deps, sent } = makeDeps({
    ephemeralKV: fakeEphemeralKV(),
    sendReply: async (a) => { sent.push(a); return { result: { message_id: nextId++ } }; },
    deleteMessage: async (a) => { deleted.push(a); return true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 7 } }, env: ENV, deps,
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 9 } }, env: ENV, deps,
  });
  assert.equal(deleted.length, 0, 'the /start greeting must survive an unrelated view command');
});

test('runHandler: /start from allowed editor → access confirmed, no "ask the admin" wording', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Olha', role: 'editor' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/start', message_id: 6 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 456);
  assert.match(sent[0].text, /<code>456<\/code>/);
  assert.doesNotMatch(sent[0].text, /Надішли цей id адміну/i);
  assert.doesNotMatch(sent[0].text, /приватний бот/i);
  assert.ok(sent[0].replyMarkup, 'allowed editor still gets the keyboard');
});

test('runHandler: /start from a stranger still asks them to send their chat_id to the admin', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/start', message_id: 6 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Надішли цей id адміну/i);
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
  assert.match(sent[0].text, /додати в моніторинг/);
});

test('runHandler: /add missing id → reply', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/add', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /додати в моніторинг/);
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
  assert.match(sent[0].text, /прибрати з моніторингу/);
});

test('runHandler: /remove without id → "Не вказано"', async () => {
  const { deps, sent } = await makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/remove', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /прибрати з моніторингу/);
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
  // Single message: content + inline nav keyboard
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📋.*Моніторинг закупівель/);
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
  // Single message: content + inline nav keyboard; error count surfaced in header
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
  // Single message: content + inline nav keyboard (not multi-page dump)
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
  assert.equal(sent.length, 1);
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
  assert.equal(sent.length, 1);
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
  assert.match(sent[0].text, /ЄДРПОУ замовника/);
  assert.equal(loadCalled, false);
});

test('runHandler: /watch missing → prompt', async () => {
  const { deps, sent } = await makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watch', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /ЄДРПОУ замовника/);
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
  assert.deepEqual(names, ['start'], 'the "/" menu is one entry for every role');
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
  assert.deepEqual(names, ['start'], 'the "/" menu is one entry for every role');
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
  assert.equal(sent.length, 1, 'archive shows 1 message — content + nav');
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

// ── Кнопка з оголошення замовника знімає його зі стеження (11.08.2026) ──────
// Кнопка `add:` існує ТІЛЬКИ під сповіщенням `new_tender_announced`, тож гілка
// колбека — це й є «тільки кнопка з оголошення»; /add вручну нічого не чіпає.
const addBtnDeps = (overrides = {}, entities = []) => {
  const savedEntities = [];
  const acks = [];
  const base = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
    saveWatchlist: async () => ({}),
    // Реальний extractSnapshot віддає procuringEntity.edrpou — фейк робить так само.
    extractSnapshot: (raw) => ({
      ...raw.data,
      procuringEntity: { name: 'КНП «Тест»', edrpou: '11111111' },
    }),
    loadWatchedEntities: async () => ({ entities, sha: 'e-sha' }),
    saveWatchedEntities: async (env, next) => { savedEntities.push(next); },
    ...overrides,
  });
  return {
    deps: { ...base.deps, answerCallbackQuery: async (a) => acks.push(a),
            editMessageReplyMarkup: async () => {} },
    sent: base.sent, savedEntities, acks,
  };
};

test('add-кнопка: замовника, за яким стежили, знято зі стеження', async () => {
  const { deps, sent, savedEntities } = addBtnDeps({}, [
    { edrpou: '11111111', name: 'КНП «Тест»', enabled: true },
    { edrpou: '22222222', name: 'Інший', enabled: true },
  ]);
  await runHandler({
    update: { callback_query: { id: 'c1', data: `add:${ID}`, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV, deps,
  });
  assert.equal(savedEntities.length, 1, 'watched_entities збережено один раз');
  assert.deepEqual(savedEntities[0].map(e => e.edrpou), ['22222222'], 'лишився тільки інший');
  const notice = sent.find(s => /прибрано зі стеження/.test(s.text ?? ''));
  assert.ok(notice, 'користувач має отримати повідомлення');
  assert.match(notice.text, /11111111/);
  assert.match(notice.text, new RegExp(ID));
});

test('add-кнопка: якщо за замовником не стежили — нічого не чіпаємо', async () => {
  const { deps, sent, savedEntities } = addBtnDeps({}, [
    { edrpou: '99999999', name: 'Хтось інший', enabled: true },
  ]);
  await runHandler({
    update: { callback_query: { id: 'c1', data: `add:${ID}`, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV, deps,
  });
  assert.equal(savedEntities.length, 0, 'жодного запису у watched_entities');
  assert.ok(!sent.some(s => /прибрано зі стеження/.test(s.text ?? '')));
});

test('add-кнопка: тендер уже в моніторингу → замовник лишається у стеженні', async () => {
  const { deps, savedEntities } = addBtnDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 'sha1' }),
  }, [{ edrpou: '11111111', name: 'КНП «Тест»', enabled: true }]);
  await runHandler({
    update: { callback_query: { id: 'c1', data: `add:${ID}`, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV, deps,
  });
  assert.equal(savedEntities.length, 0, 'нічого не додали → нічого не знімаємо');
});

test('/add вручну: стеження за замовником НЕ чіпається', async () => {
  const { deps, savedEntities } = addBtnDeps({}, [
    { edrpou: '11111111', name: 'КНП «Тест»', enabled: true },
  ]);
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(savedEntities.length, 0, 'ручний /add не знімає замовника');
});

test('add-кнопка: збій запису watched_entities не ламає додавання тендера', async () => {
  const savedWl = [];
  const { deps, acks } = addBtnDeps({
    saveWatchlist: async (env, wl) => { savedWl.push(wl); },
    saveWatchedEntities: async () => { throw new Error('GitHub GET 503'); },
  }, [{ edrpou: '11111111', name: 'КНП «Тест»', enabled: true }]);
  await runHandler({
    update: { callback_query: { id: 'c1', data: `add:${ID}`, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV, deps,
  });
  assert.equal(savedWl.length, 1, 'тендер усе одно додано');
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
  assert.deepEqual(names, ['start'], 'the "/" menu is one entry for every role');
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
  assert.deepEqual(names, ['start'], 'the "/" menu is one entry for every role');
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
  assert.deepEqual(names, ['start'], 'the "/" menu is one entry for every role');
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
  // Expect at least one call with chatId 456 (the "/" menu is re-sent on the
  // role change; its contents are role-independent — one /start entry).
  const targetCall = calls.find(c => c.chatId === '456');
  assert.ok(targetCall, 'expected setMyCommands for target chat 456');
  const names = targetCall.commands.map(c => c.command);
  assert.deepEqual(names, ['start'], 'the "/" menu is one entry for every role');
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
    // agent:start now requires the tender to already be monitored (see the
    // "не в моніторингу" tests below, which override this back to []).
    loadWatchlist: async () => ({ watchlist: [{ tender_id: AGENT_TID, enabled: true }], sha: 'w-sha' }),
    now: () => new Date('2026-06-21T10:00:00.000Z'),
    ...overrides,
  }).deps;
  return { deps: base, store, sent, acks, edits, jobs };
};

const agentMsg = (text, chatId = 123) => ({
  message: { chat: { id: chatId }, from: { first_name: 'Андрій' }, text, message_id: 7 },
});

test('agent:start on a tender NOT in the watchlist → refused, no company keyboard', async () => {
  const { deps, store, edits, acks } = makeAgentDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'w-sha' }),
  });
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  assert.equal(edits.length, 0, 'no company keyboard for an unmonitored tender');
  assert.equal(store.pending['123'], undefined, 'no dialog state written');
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /моніторинг/i);
});

test('agent:start on a tender that IS in the watchlist (even if disabled) → proceeds', async () => {
  const { deps, edits } = makeAgentDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: AGENT_TID, enabled: false }], sha: 'w-sha' }),
  });
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  assert.equal(edits.length, 1, 'monitored-but-muted still counts as monitored');
});

test('agent:start watchlist lookup failure → fails open, does not block a legitimate start', async () => {
  const { deps, edits } = makeAgentDeps({
    loadWatchlist: async () => { throw new Error('gh down'); },
  });
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  assert.equal(edits.length, 1, 'a watchlist-check failure must not block the picker');
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

test('agent:start (viewer) → rejected, no keyboard, no state write', async () => {
  let pendingSaved = false;
  const { deps, edits, acks } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveAgentPending: async () => { pendingSaved = true; },
  });
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`, 456), env: ENV, deps });
  assert.equal(edits.length, 0, 'no company keyboard for viewer');
  assert.equal(pendingSaved, false, 'no pending state written');
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /редактор/i);
});

// Editors got agent rights on 11.08.2026 — the whole menu, prepare AND amend.
test('agent:start (editor) → company keyboard shown, same as admin', async () => {
  const { deps, edits, acks } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
  });
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`, 456), env: ENV, deps });
  assert.equal(edits.length, 1, 'editor gets the company keyboard');
  assert.match(edits[0].text, /Оберіть компанію/);
  assert.equal(acks.length, 1);
});

test('/agent (editor) → menu; (viewer) → no reply', async () => {
  const editorDeps = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
  });
  await runHandler({ update: agentMsg('/agent', 456), env: ENV, deps: editorDeps.deps });
  assert.equal(editorDeps.sent.length, 1);
  assert.match(editorDeps.sent[0].text, /Агент/);

  const viewerDeps = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({ update: agentMsg('/agent', 456), env: ENV, deps: viewerDeps.deps });
  assert.equal(viewerDeps.sent.length, 0, 'viewer gets no agent menu');
});

test('editor confirm → job queued, audit commit message, admin notified', async () => {
  const saved = [];
  const { deps, store, sent } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Едітор', role: 'editor' }], sha: 's' }),
    saveAgentJob: async (_e, job, opts) => { saved.push({ job, opts }); },
  });
  store.pending['456'] = { tid: AGENT_TID, company: 'МАЙЛАБ', price: '181200', step: 'confirm' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`, 456), env: ENV, deps });

  assert.equal(saved.length, 1, 'job queued');
  assert.equal(saved[0].job.requested_by, '456', 'result goes back to the editor');
  assert.match(saved[0].opts?.message ?? '', /^audit: agent /, 'commit message lands in /log');
  assert.match(saved[0].opts?.message ?? '', /\[456\/editor\]/);

  const toAdmin = sent.filter(s => String(s.chatId) === String(ENV.ADMIN_CHAT_ID));
  assert.equal(toAdmin.length, 1, 'admin gets one heads-up');
  assert.match(toAdmin[0].text, /запустив агента по/);
  assert.match(toAdmin[0].text, /МАЙЛАБ/);
});

test('admin confirm → job queued, but no self-notification', async () => {
  const { deps, store, sent, jobs } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', price: '181200', step: 'confirm' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(sent.filter(s => /запустив агента/.test(s.text ?? '')).length, 0,
    'admin is not notified about their own run');
});

test('agent:co:<tid>:maylab → pending saved with company МАЙЛАБ + price prompt', async () => {
  const { deps, store, edits, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.deepEqual(store.pending['123'],
    { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price', messageId: 9, at: '2026-06-21T10:00:00.000Z' });
  assert.equal(edits.length, 1, 'edits the company-picker message in place, no new message');
  assert.match(edits[0].text, /Введіть ціну/);
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

test('agent instruction reply → stored, amend confirm shown', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'amend', step: 'await_instruction', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: agentMsg('додай довідку КВЕД'), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'confirm');
  assert.equal(store.pending['123'].instruction, 'додай довідку КВЕД');
  assert.match(sent.at(-1).text, /Доробити/);
  assert.match(JSON.stringify(sent.at(-1).replyMarkup), new RegExp(`agent:confirm:${AGENT_TID}`));
});

test('agent empty instruction → stays at await_instruction, no advance', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'amend', step: 'await_instruction', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: agentMsg('   '), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_instruction');
  assert.match(sent.at(-1).text, /Порожня інструкція/);
});

// A second confirm for the SAME tender while one is already in flight used to
// silently overwrite the job file (one file per tender_id) — two "запустив
// агента" admin notices a few minutes apart with no sign the second one did
// nothing. Refuse outright instead.
test('agent:confirm (prepare) when a job for this tender is already pending → refused, not re-queued', async () => {
  const { deps, store, edits, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'pending', company: 'МАЙЛАБ', price: '181200' }),
  });
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', price: '181200', step: 'confirm' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0, 'must not overwrite the in-flight job');
  assert.equal(store.pending['123'], undefined, 'dialog cleared regardless');
  assert.match(edits.at(-1).text, /вже в черзі/i);
  assert.equal(acks.at(-1).text, '⚠️ Вже в черзі');
});

test('agent:confirm (prepare) when a job for this tender is already running → refused, distinct wording', async () => {
  const { deps, store, jobs, edits } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'running' }),
  });
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', price: '181200', step: 'confirm' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(edits.at(-1).text, /вже виконується/i);
});

test('agent:confirm (prepare) when the prior job is done/error → proceeds normally (not a duplicate)', async () => {
  const { deps, store, jobs } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'done' }),
  });
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', price: '181200', step: 'confirm' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1, 'a finished prior job is not "in flight" — a fresh prepare is a normal re-run');
});

test('agent:confirm → saveAgentJob with contract-valid job, pending cleared, queued reply', async () => {
  const { deps, store, edits, jobs, acks } = makeAgentDeps();
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
  assert.match(edits.at(-1).text, /черг/i);
  assert.equal(acks.length, 1);
});

test('agent:confirm without matching pending → no job, soft ack', async () => {
  const { deps, jobs, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /Немає активного|Невідома/i);
});

test('agent:confirm with kind=amend → amend job saved, target from prior done, pending cleared', async () => {
  const { deps, store, edits, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ', result: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' } }),
  });
  store.pending['123'] = { tid: AGENT_TID, kind: 'amend', step: 'confirm', instruction: 'додай КВЕД', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    tender_id: AGENT_TID,
    link: `https://prozorro.gov.ua/tender/${AGENT_TID}`,
    job_type: 'amend',
    instruction: 'додай КВЕД',
    company: 'МАЙЛАБ',
    target: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' },
    requested_by: '123',
    status: 'pending',
    created_at: '2026-06-21T10:00:00.000Z',
  });
  assert.equal(store.pending['123'], undefined, 'pending cleared');
  assert.match(edits.at(-1).text, /доробку/);
  assert.equal(acks.length, 1);
});

test('agent:retry → resets error job to pending, acks ✅', async () => {
  const errorJob = {
    tender_id: AGENT_TID, link: 'https://prozorro.gov.ua/tender/' + AGENT_TID,
    company: 'МАЙЛАБ', price: '100000',
    status: 'error', created_at: '2026-06-21T08:00:00.000Z',
    result: { detail: 'no .docx generated (claude rc=1)' },
  };
  const { deps, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => structuredClone(errorJob),
  });
  await runHandler({ update: CB(`agent:retry:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].result, undefined);
  assert.match(acks[0].text, /повтор/i);
});

test('agent:retry on non-error job → acks info, no save', async () => {
  const { deps, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'running' }),
  });
  await runHandler({ update: CB(`agent:retry:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /не в стані error/i);
});

test('agent:retry on missing job → acks warning', async () => {
  const { deps, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => null,
  });
  await runHandler({ update: CB(`agent:retry:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /не знайдено/i);
});

test('agent:cancel → pending cleared, returns to the tender card (not a dead end)', async () => {
  const { deps, store, edits, acks } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price' };
  await runHandler({ update: CB(`agent:cancel:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined);
  // Раніше тут було голе «Скасовано.» без жодної кнопки (реальна скарга
  // власника 17.08.2026) — тепер повертає ту саму картку тендера, з якої
  // й почали, з робочою клавіатурою.
  assert.match(edits.at(-1).text, new RegExp(AGENT_TID));
  assert.ok(edits.at(-1).replyMarkup, 'tender card keyboard is back');
  assert.match(acks[0].text, /Скасовано/);
  assert.equal(acks.length, 1);
});

test('agent:amend on prepared tender → instruction dialog started', async () => {
  const { deps, store, edits, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ', result: { drive_link: 'https://drive/x' } }),
  });
  await runHandler({ update: CB(`agent:amend:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_instruction');
  assert.equal(store.pending['123'].kind, 'amend');
  assert.equal(store.pending['123'].messageId, 9);
  assert.match(edits.at(-1).text, /що доробити/);
  assert.equal(acks.length, 1);
});

test('agent:amend on not-prepared tender → rejected, no dialog', async () => {
  const { deps, store, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'pending' }),
  });
  await runHandler({ update: CB(`agent:amend:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined);
  assert.match(acks[0].text, /не готова/);
});

// ── Task 8: agent:winner callback + confirm ────────────────────────────────

test('agent:winner with a done prior job → straight to confirm, company from prior job', async () => {
  const { deps, store, edits, acks } = makeAgentDeps({
    loadAgentJob: async () => ({
      tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ',
      result: { drive_link: 'https://drive/x', package_dir: 'P', published_dir: 'PUB' },
    }),
  });
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /Документи переможця/);
  assert.match(edits.at(-1).text, /МАЙЛАБ/);
  assert.match(JSON.stringify(edits.at(-1).replyMarkup), new RegExp(`agent:confirm:${AGENT_TID}`));
  assert.equal(acks.length, 1);
});

test('agent:winner with no prior job at all → asks for company (not an error)', async () => {
  // Default loadAgentJob stub resolves to null: a winner run for a tender the
  // agent never prepared is a normal path, not a GitHub-unavailable error.
  const { deps, store, edits, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'winner', step: 'await_company', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /Оберіть компанію-переможця/);
  const kb = JSON.stringify(edits.at(-1).replyMarkup);
  assert.match(kb, new RegExp(`agent:co:${AGENT_TID}:maylab`));
  assert.equal(acks.length, 1);
  assert.ok(!acks.some(a => /⚠️/.test(a.text ?? '')), 'no error ack for a missing prior job');
});

// I4: a tender re-prepared under a different legal entity overwrites the
// per-tender job file, so the prior job can easily name an entity that LOST.
// Prozorro's award tells us who actually won — that slug, carried in the
// callback, must beat the job file.
test('agent:winner with a slug in the callback → slug wins over a conflicting prior job', async () => {
  let loadedJob = false;
  const { deps, store, edits } = makeAgentDeps({
    loadAgentJob: async () => {
      loadedJob = true;
      return { tender_id: AGENT_TID, status: 'done', company: 'ТЕРРАЛАБ ПРО', result: { drive_link: 'https://d/x' } };
    },
  });
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.equal(store.pending['123'].company, 'МАЙЛАБ',
    'the awarded entity from the callback, not the prior job company');
  assert.equal(store.pending['123'].step, 'confirm');
  assert.match(edits.at(-1).text, /МАЙЛАБ/);
  assert.ok(!/ТЕРРАЛАБ ПРО/.test(edits.at(-1).text));
  assert.equal(loadedJob, false, 'a known winner needs no job-file lookup at all');
});

test('agent:winner with an UNKNOWN slug → falls back to the prior job company', async () => {
  const { deps, store, edits } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'done', company: 'ТЕРРАЛАБ ПРО' }),
  });
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}:not_a_company`), env: ENV, deps });
  assert.equal(store.pending['123'].company, 'ТЕРРАЛАБ ПРО');
  assert.match(edits.at(-1).text, /ТЕРРАЛАБ ПРО/);
});

test('agent:winner from the jobs page (no slug, no prior job) → still falls back to the picker', async () => {
  const { deps, store, edits } = makeAgentDeps();
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_company');
  assert.match(edits.at(-1).text, /Оберіть компанію-переможця/);
});

// M2: the confirmation showed only a tender id and a company. The customer name
// comes from the monitor's own saved snapshot — no Prozorro round-trip — and is
// purely cosmetic (it gates nothing).
test('agent:winner confirm text names the замовник when a saved snapshot has one', async () => {
  const { deps, edits } = makeAgentDeps({
    loadTenderState: async () => ({
      procuringEntity: { name: 'Комунальне некомерційне підприємство «Черкаська міська інфекційна лікарня»' },
    }),
  });
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.match(edits.at(-1).text, /Замовник: КНП «Черкаська міська інфекційна лікарня»/);
  assert.match(edits.at(-1).text, /МАЙЛАБ/);
});

test('agent:winner confirm text: no saved snapshot / lookup throws → id + company only, no crash', async () => {
  const { deps, edits, acks } = makeAgentDeps({
    loadTenderState: async () => { throw new Error('gh down'); },
  });
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.match(edits.at(-1).text, /Документи переможця/);
  assert.ok(!/Замовник:/.test(edits.at(-1).text));
  assert.equal(acks.length, 1);
  assert.ok(!acks.some(a => /⚠️/.test(a.text ?? '')));
});

test('agent:co winner continuation also names the замовник', async () => {
  const { deps, store, edits } = makeAgentDeps({
    loadTenderState: async () => ({ procuringEntity: { name: 'КНП «Тестова лікарня»' } }),
  });
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'await_company', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.match(edits.at(-1).text, /Замовник: КНП «Тестова лікарня»/);
});

test('agent:winner when loadAgentJob throws → still asks for company, does not abort', async () => {
  const { deps, store, edits, acks } = makeAgentDeps({
    loadAgentJob: async () => { throw new Error('boom'); },
  });
  await runHandler({ update: CB(`agent:winner:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_company');
  assert.match(edits.at(-1).text, /Оберіть компанію-переможця/);
  assert.equal(acks.length, 1);
  assert.ok(!acks.some(a => /⚠️/.test(a.text ?? '')), 'a thrown prior-job lookup must not surface as an error');
});

test('agent:co after agent:winner (await_company) → confirm shown directly, no price prompt', async () => {
  const { deps, store, edits, acks } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'await_company', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'winner', company: 'МАЙЛАБ', step: 'confirm', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /Документи переможця/);
  assert.ok(!/Введіть ціну/.test(edits.at(-1).text), 'winner co must not ask for a price');
  assert.equal(acks.length, 1);
});

test('agent:co WITHOUT a winner pending (plain prepare) → unaffected, still asks for price', async () => {
  const { deps, store, edits } = makeAgentDeps();
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, company: 'МАЙЛАБ', step: 'await_price', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /Введіть ціну/);
});

// Fix round 1: `co` must scope the winner-vs-prepare routing to the SAME tid
// as the current callback, not just `pending[chatId]?.kind`. A stale winner
// pending left over from an abandoned tender A must not hijack a later,
// unrelated prepare dialog for tender B.
const AGENT_TID_B = 'UA-2026-05-01-010777-b';

test('agent:co for tender B with a STALE winner pending from tender A → falls through to prepare (price prompt)', async () => {
  const { deps, store, edits } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'await_company', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:co:${AGENT_TID_B}:maylab`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID_B, company: 'МАЙЛАБ', step: 'await_price', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  }, 'pending is rewritten as an ordinary prepare dialog scoped to tender B, not carried over from A');
  assert.match(edits.at(-1).text, /Введіть ціну/);
  assert.ok(!/Документи переможця/.test(edits.at(-1).text), 'must not show the winner confirm for an unrelated tender');
});

test('agent:co for tender B with stale winner pending from A, then price + confirm → ordinary job with price, no job_type winner', async () => {
  const { deps, store, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
  });
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'await_company', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:co:${AGENT_TID_B}:maylab`), env: ENV, deps });
  await runHandler({ update: agentMsg('50000'), env: ENV, deps });
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID_B}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.tender_id, AGENT_TID_B);
  assert.equal(jobs[0].job.price, '50000');
  assert.equal('job_type' in jobs[0].job, false, 'must be an ordinary prepare job, not job_type: winner');
});

test('agent:co with a SAME-tid winner pending → still routes to the winner confirmation (regression guard)', async () => {
  const { deps, store, edits } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'await_company', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:maylab`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'winner', company: 'МАЙЛАБ', step: 'confirm', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /Документи переможця/);
});

// Fix round 2 (C1): the tid guard alone does NOT close the same-tender case.
// `agent:start` neither writes nor clears the pending record and button steps
// have no TTL, so an abandoned winner dialog for tender A (left at
// step:'confirm') would hijack a later PREPARE for that same tender A: `co`
// saw kind==='winner' && tid===A, skipped the price step and queued a winner
// job for a tender that was never awarded. Only `await_company` — the one step
// from which `co` can legitimately continue a winner dialog — may continue it.
test('agent:co with a SAME-tid winner pending stuck at step confirm → falls through to prepare, price asked', async () => {
  const { deps, store, edits, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', at: '2026-06-21T09:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:terralab_pro`), env: ENV, deps });
  assert.match(edits.at(-1).text, /Введіть ціну/, 'a fresh prepare must reach the price step');
  assert.ok(!/Документи переможця/.test(edits.at(-1).text), 'stale same-tid winner pending must not hijack a prepare');
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, company: 'ТЕРРАЛАБ ПРО', step: 'await_price', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  await runHandler({ update: agentMsg('50000'), env: ENV, deps });
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.price, '50000', 'the confirmed job is a prepare job with a price');
  assert.equal('job_type' in jobs[0].job, false, 'must not be job_type: winner');
});

// Fix round 3 (R2): narrowing the continuation to `await_company` closed C1 but
// broke an ordinary correction — tap 📄, tap the WRONG company (pending moves to
// step:'confirm'), then tap the RIGHT one on the same still-visible picker. That
// second tap fell through to prepare: price asked, and a confirm queued a FULL
// prepare run instead of the winner package. The two sequences are told apart by
// `agent:start`, which now clears a stale winner dialog for the SAME tender —
// so `confirm` is a legitimate continuation step only when no start intervened.
test('agent:co correcting a mis-tapped company (winner pending at confirm, no intervening start) → winner confirm again', async () => {
  const { deps, store, edits, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', at: '2026-06-21T09:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:co:${AGENT_TID}:terralab_pro`), env: ENV, deps });
  assert.match(edits.at(-1).text, /Документи переможця/, 'the winner confirmation must be shown again');
  assert.match(edits.at(-1).text, /ТЕРРАЛАБ ПРО/, 'with the CORRECTED company');
  assert.ok(!/Введіть ціну/.test(edits.at(-1).text), 'a correction must never ask for a price');
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'winner', company: 'ТЕРРАЛАБ ПРО', step: 'confirm', messageId: 9, at: '2026-06-21T10:00:00.000Z',
  });
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.job_type, 'winner', 'confirming a correction queues a winner job, not a prepare');
  assert.equal(jobs[0].job.company, 'ТЕРРАЛАБ ПРО');
  assert.equal(jobs[0].job.price, undefined);
});

test('agent:start for tender A clears an abandoned winner dialog for that SAME tender A', async () => {
  const { deps, store } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', at: '2026-06-21T09:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined,
    'a fresh prepare of the same tender supersedes the abandoned winner dialog');
});

// The clear must be surgical: clearing pending unconditionally would trade C1
// for a new bug — an in-flight instruction dialog for an UNRELATED tender would
// be silently dropped and the user's next message parsed as an ordinary command.
test('agent:start for tender A leaves an in-flight amend dialog for tender B alone', async () => {
  const { deps, store } = makeAgentDeps();
  const amend = { tid: AGENT_TID_B, kind: 'amend', step: 'await_instruction', at: '2026-06-21T09:00:00.000Z' };
  store.pending['123'] = { ...amend };
  await runHandler({ update: CB(`agent:start:${AGENT_TID}`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], amend, 'an unrelated amend dialog must survive');
});

test('agent:confirm with kind=winner → winner job saved, target from prior done job, price omitted', async () => {
  const { deps, store, sent, edits, jobs, acks } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Едітор', role: 'editor' }], sha: 's' }),
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    loadAgentJob: async () => ({
      tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ',
      result: { drive_link: 'https://drive/x', package_dir: 'P', published_dir: 'PUB' },
    }),
  });
  store.pending['456'] = { tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`, 456), env: ENV, deps });

  assert.equal(jobs.length, 1);
  const saved = jobs[0];
  assert.deepEqual(saved.job, {
    tender_id: AGENT_TID,
    link: `https://prozorro.gov.ua/tender/${AGENT_TID}`,
    job_type: 'winner',
    company: 'МАЙЛАБ',
    target: { drive_link: 'https://drive/x', package_dir: 'P', published_dir: 'PUB' },
    requested_by: '456',
    status: 'pending',
    created_at: '2026-06-21T10:00:00.000Z',
  });
  assert.equal('price' in saved.job, false, 'winner job never carries a price');
  assert.match(saved.opts.message, /^audit: agent_winner /);
  assert.match(saved.opts.message, /\[456\/editor\]/);
  assert.equal(store.pending['456'], undefined, 'pending cleared');
  const toUser = edits.filter(e => String(e.chatId) === '456');
  assert.equal(toUser.length, 1, 'edits the confirm message in place rather than sending a new one');
  assert.match(toUser[0].text, /поставлено в чергу/);

  const toAdmin = sent.filter(s => String(s.chatId) === String(ENV.ADMIN_CHAT_ID));
  assert.equal(toAdmin.length, 1, 'admin gets one heads-up (actor is not admin)');
  assert.match(toAdmin[0].text, /запустив документи переможця по/);
  assert.equal(acks.at(-1).text, '✅ В черзі');
});

test('agent:confirm with kind=winner and NO prior job → target key omitted entirely', async () => {
  const { deps, store, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    // Default loadAgentJob resolves to null — the agent never prepared this tender.
  });
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal('target' in jobs[0].job, false, 'no prior job → target omitted, not null');
  assert.equal(jobs[0].job.company, 'МАЙЛАБ');
});

test('agent:confirm with kind=winner, admin is the actor → no self-notification', async () => {
  const { deps, store, sent, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
  });
  store.pending['123'] = { tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(sent.filter(s => /запустив документи переможця/.test(s.text ?? '')).length, 0,
    'admin is not notified about their own winner run');
});

// ── Task 8: діалог підписання (agent:sign → дата → confirm) ───────────────────

// Готова пропозиція, з якої можна щось підписувати: sign-job бере
// target.package_dir саме звідси.
const DONE_PREPARED = {
  tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ',
  result: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' },
};

test('agent:sign on a prepared proposal → date keyboard, pending at await_date', async () => {
  const { deps, store, edits, acks } = makeAgentDeps({
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  await runHandler({ update: CB(`agent:sign:${AGENT_TID}`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', company: 'МАЙЛАБ', messageId: 9,
    at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /дату/i);
  const kb = JSON.stringify(edits.at(-1).replyMarkup);
  assert.match(kb, new RegExp(`agent:signdate:${AGENT_TID}:21\\.06\\.2026`),
    'the «сьогодні» button carries the Kyiv date of the injected now');
  assert.match(kb, new RegExp(`agent:signother:${AGENT_TID}`));
  assert.equal(acks.length, 1);
  assert.ok(!acks.some(a => /🚫|⚠️/.test(a.text ?? '')));
});

test('agent:sign refuses when the proposal is not ready', async () => {
  const { deps, store, acks, sent } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'running' }),
  });
  await runHandler({ update: CB(`agent:sign:${AGENT_TID}`), env: ENV, deps });
  assert.match(acks[0].text, /не готова/);
  assert.equal(store.pending['123'], undefined, 'no dialog opened');
  assert.equal(sent.length, 0, 'no date keyboard');
});

// package_dir — це те, ЩО підписують. Без нього агент не має теки з .docx, тож
// кнопка не має відкривати діалог, навіть коли пропозиція «done» і має лінк.
test('agent:sign refuses a done job whose result has no package_dir', async () => {
  const { deps, store, acks } = makeAgentDeps({
    loadAgentJob: async () => ({
      tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ',
      result: { drive_link: 'https://drive/x' },
    }),
  });
  await runHandler({ update: CB(`agent:sign:${AGENT_TID}`), env: ENV, deps });
  assert.match(acks[0].text, /не готова/);
  assert.equal(store.pending['123'], undefined);
});

test('agent:sign when loadAgentJob throws → soft ack, no dialog', async () => {
  const { deps, store, acks } = makeAgentDeps({
    loadAgentJob: async () => { throw new Error('gh down'); },
  });
  await runHandler({ update: CB(`agent:sign:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined);
  assert.match(acks[0].text, /⚠️/);
});

test('agent:signdate → date stored, sign confirmation shown', async () => {
  const { deps, store, edits, acks } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:21.06.2026`), env: ENV, deps });
  assert.deepEqual(store.pending['123'], {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ', messageId: 9,
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  });
  assert.match(edits.at(-1).text, /Підписати й запакувати/);
  assert.match(edits.at(-1).text, /21\.06\.2026/);
  assert.match(JSON.stringify(edits.at(-1).replyMarkup), new RegExp(`agent:confirm:${AGENT_TID}`));
  assert.equal(acks.length, 1);
});

test('agent:signdate with a date outside the ±30-day window → rejected, dialog untouched', async () => {
  const { deps, store, sent, acks } = makeAgentDeps();
  const before = {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  store.pending['123'] = { ...before };
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:21.06.2126`), env: ENV, deps });
  assert.match(acks[0].text, /дата/i);
  assert.deepEqual(store.pending['123'], before, 'a bad date must not advance the dialog');
  assert.equal(sent.length, 0, 'no confirmation for a bad date');
});

test('agent:signother → dialog waits for a typed date', async () => {
  const { deps, store, edits, acks } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:signother:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_letter_date');
  assert.equal(store.pending['123'].kind, 'sign');
  assert.equal(store.pending['123'].messageId, 9);
  assert.match(edits.at(-1).text, /ДД\.ММ\.РРРР/);
  assert.equal(acks.length, 1);
});

// ── Hijack guards ─────────────────────────────────────────────────────────────
// Урок гілки `co` з winner-флоу: коли гілка дивиться лише на ОДНЕ поле pending,
// покинутий діалог одного тендера перехоплює дотик іншого. Тут звіряються всі
// три — kind, tid і step.

test('agent:signdate for tender B with a STALE sign pending from tender A → rejected, A untouched', async () => {
  const { deps, store, sent, acks } = makeAgentDeps();
  const stale = {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  store.pending['123'] = { ...stale };
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID_B}:21.06.2026`), env: ENV, deps });
  assert.match(acks[0].text, /Немає активного запиту/);
  assert.deepEqual(store.pending['123'], stale,
    'a tap on tender B must not write a date into tender A\u2019s dialog');
  assert.equal(sent.length, 0, 'no confirmation for an unrelated tender');
});

test('agent:signdate with a WINNER pending for the same tender → rejected, winner dialog untouched', async () => {
  const { deps, store, sent, acks, jobs } = makeAgentDeps();
  const winner = {
    tid: AGENT_TID, kind: 'winner', step: 'confirm', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  store.pending['123'] = { ...winner };
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:21.06.2026`), env: ENV, deps });
  assert.match(acks[0].text, /Немає активного запиту/);
  assert.deepEqual(store.pending['123'], winner,
    'a sign tap must never inject letterDate into a winner dialog');
  // і підтвердження після цього лишається winner-прогоном, не підписанням
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_type, 'winner');
});

test('agent:signdate with an AMEND pending for the same tender → rejected, amend dialog survives', async () => {
  const { deps, store, acks } = makeAgentDeps();
  const amend = {
    tid: AGENT_TID, kind: 'amend', step: 'await_instruction', at: '2026-06-21T10:00:00.000Z',
  };
  store.pending['123'] = { ...amend };
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:21.06.2026`), env: ENV, deps });
  assert.match(acks[0].text, /Немає активного запиту/);
  assert.deepEqual(store.pending['123'], amend);
});

test('agent:signother for tender B with a stale sign pending from tender A → rejected', async () => {
  const { deps, store, sent, acks } = makeAgentDeps();
  const stale = {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', at: '2026-06-21T10:00:00.000Z',
  };
  store.pending['123'] = { ...stale };
  await runHandler({ update: CB(`agent:signother:${AGENT_TID_B}`), env: ENV, deps });
  assert.match(acks[0].text, /Немає активного запиту/);
  assert.deepEqual(store.pending['123'], stale);
  assert.equal(sent.length, 0);
});

test('agent:signdate with no pending at all → rejected, nothing written', async () => {
  const { deps, store, acks } = makeAgentDeps();
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:21.06.2026`), env: ENV, deps });
  assert.match(acks[0].text, /Немає активного запиту/);
  assert.equal(store.pending['123'], undefined);
});

// Виправлення дати на тому самому, ще видимому повідомленні — звичайна дія, а не
// перехоплення: тендер той самий, kind той самий, крок — із діалогу підписання.
test('agent:signdate re-tapped after a date was already chosen → date corrected, still a sign dialog', async () => {
  const { deps, store, edits } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:22.06.2026`), env: ENV, deps });
  assert.equal(store.pending['123'].letterDate, '22.06.2026');
  assert.equal(store.pending['123'].kind, 'sign');
  assert.equal(store.pending['123'].step, 'confirm');
  assert.match(edits.at(-1).text, /22\.06\.2026/);
});

test('agent:signother while waiting for a typed date → still allowed (re-prompt)', async () => {
  const { deps, store, edits } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_letter_date', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:signother:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_letter_date');
  assert.match(edits.at(-1).text, /ДД\.ММ\.РРРР/);
});

// ── Typed date ────────────────────────────────────────────────────────────────

test('a typed letter date moves the dialog to confirm', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_letter_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: agentMsg('22.06.2026'), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'confirm');
  assert.equal(store.pending['123'].letterDate, '22.06.2026');
  assert.match(sent.at(-1).text, /22\.06\.2026/);
  assert.match(JSON.stringify(sent.at(-1).replyMarkup), new RegExp(`agent:confirm:${AGENT_TID}`));
});

test('a typed non-date stays at await_letter_date and explains the format', async () => {
  const { deps, store, sent, jobs } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_letter_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  for (const bad of ['181200', 'завтра', '22/06/2026', '31.02.2026', '22.06.2126']) {
    await runHandler({ update: agentMsg(bad), env: ENV, deps });
    assert.equal(store.pending['123'].step, 'await_letter_date', bad);
    assert.equal(store.pending['123'].letterDate, undefined, bad);
    assert.match(sent.at(-1).text, /ДД\.ММ\.РРРР/, bad);
  }
  assert.equal(jobs.length, 0);
});

test('a typed date on a stale (>15 min) sign dialog → not consumed, pending dropped', async () => {
  const { deps, store, jobs } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_letter_date', at: '2026-06-21T09:40:00.000Z',
  };
  await runHandler({ update: agentMsg('22.06.2026'), env: ENV, deps });
  assert.equal(store.pending['123'], undefined, 'stale sign dialog dropped');
  assert.equal(jobs.length, 0);
});

// ── confirm ───────────────────────────────────────────────────────────────────

test('agent:confirm with kind=sign → sign job saved with an agent_sign audit, admin notified', async () => {
  const { deps, store, sent, jobs, acks } = makeAgentDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Едітор', role: 'editor' }], sha: 's' }),
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  store.pending['456'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`, 456), env: ENV, deps });

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].job, {
    tender_id: AGENT_TID,
    link: `https://prozorro.gov.ua/tender/${AGENT_TID}`,
    job_type: 'sign',
    company: 'МАЙЛАБ',
    letter_date: '21.06.2026',
    target: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg', published_dir: null },
    requested_by: '456',
    status: 'pending',
    created_at: '2026-06-21T10:00:00.000Z',
  });
  assert.equal('price' in jobs[0].job, false, 'a sign job never carries a price');
  assert.match(jobs[0].opts.message, /^audit: agent_sign /);
  assert.match(jobs[0].opts.message, /\[456\/editor\]/);
  assert.equal(store.pending['456'], undefined, 'pending cleared');
  const toAdmin = sent.filter(s => String(s.chatId) === String(ENV.ADMIN_CHAT_ID));
  assert.equal(toAdmin.length, 1);
  assert.match(toAdmin[0].text, /підписання/);
  assert.match(toAdmin[0].text, /21\.06\.2026/);
  assert.equal(acks.at(-1).text, '✅ В черзі');
});

// Тека замовника в архіві відділу приходить із ГОТОВОЇ пропозиції, а не
// підбирається за назвою: відділ перейменовує теки руками («79. КНП
// Локачинської СелР Локачинська лікарня» -> «79. Локачинська Лікарня»), і без
// цього поля поллер завів би підписаний пакет у НОВУ нумеровану теку, з'ївши
// номер у чужій ручній послідовності. Winner-флоу передає це поле так само.
test('agent:confirm with kind=sign carries published_dir into the job target', async () => {
  const { deps, store, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    loadAgentJob: async () => ({
      tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ',
      result: {
        drive_link: 'https://drive/x',
        package_dir: 'G:\\pkg',
        published_dir: 'G:\\ТЕНДЕРИ 2026\\79. КНП Локачинської СелР Локачинська лікарня',
      },
    }),
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].job.target, {
    drive_link: 'https://drive/x',
    package_dir: 'G:\\pkg',
    published_dir: 'G:\\ТЕНДЕРИ 2026\\79. КНП Локачинської СелР Локачинська лікарня',
  });
});

test('agent:confirm with kind=sign but no chosen date → no job, soft ack', async () => {
  const { deps, store, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0, 'a package must never be signed with an unset date');
  assert.match(acks[0].text, /Немає активного запиту/);
  assert.equal(store.pending['123'] !== undefined, true, 'nothing queued, dialog left as is');
});

// Між відкриттям діалогу і підтвердженням job-файл могли переписати (напр.
// повторним prepare). Підписувати нема чого — черга має лишитись порожньою.
test('agent:confirm with kind=sign when the prior job lost its package_dir → no job', async () => {
  const { deps, store, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => ({
      tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ',
      result: { drive_link: 'https://d/x' },
    }),
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /не готова/);
});

test('agent:confirm with kind=sign when loadAgentJob throws → no job, soft ack', async () => {
  const { deps, store, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => { throw new Error('gh down'); },
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /⚠️/);
});

test('agent:confirm with kind=sign, admin actor → job queued, no self-notification', async () => {
  const { deps, store, sent, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'confirm', company: 'МАЙЛАБ',
    letterDate: '21.06.2026', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(sent.filter(s => /запустив підписання/.test(s.text ?? '')).length, 0);
});

// Покинутий sign-діалог, який ще не дійшов до вибору дати, не має підтверджуватись
// дотиком по чужій, ще видимій кнопці «✅ Підтвердити» того самого тендера.
test('agent:confirm on a sign dialog still at await_date → no job', async () => {
  const { deps, store, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_date', company: 'МАЙЛАБ',
    at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 0);
  assert.match(acks[0].text, /Немає активного запиту/);
});

test('agent:cancel clears a sign dialog', async () => {
  const { deps, store, edits, acks } = makeAgentDeps();
  store.pending['123'] = {
    tid: AGENT_TID, kind: 'sign', step: 'await_letter_date', at: '2026-06-21T10:00:00.000Z',
  };
  await runHandler({ update: CB(`agent:cancel:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined);
  assert.match(edits.at(-1).text, new RegExp(AGENT_TID));
  assert.match(acks[0].text, /Скасовано/);
});

// Наскрізний прохід: кнопка → дата → підтвердження → job у черзі.
test('sign end to end: 🖊 → «сьогодні» → confirm queues the job', async () => {
  const { deps, store, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  await runHandler({ update: CB(`agent:sign:${AGENT_TID}`), env: ENV, deps });
  await runHandler({ update: CB(`agent:signdate:${AGENT_TID}:21.06.2026`), env: ENV, deps });
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.job_type, 'sign');
  assert.equal(jobs[0].job.letter_date, '21.06.2026');
  assert.equal(jobs[0].job.target.package_dir, 'G:\\pkg');
  assert.equal(store.pending['123'], undefined);
});

test('sign end to end via a typed date', async () => {
  const { deps, store, jobs } = makeAgentDeps({
    saveAgentJob: async (_e, job, opts) => { jobs.push({ job, opts }); },
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  await runHandler({ update: CB(`agent:sign:${AGENT_TID}`), env: ENV, deps });
  await runHandler({ update: CB(`agent:signother:${AGENT_TID}`), env: ENV, deps });
  await runHandler({ update: agentMsg('22.06.2026'), env: ENV, deps });
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.letter_date, '22.06.2026');
  assert.equal(store.pending['123'], undefined);
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


test('runHandler: /agent (admin) → unified list, one row per watched tender', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true, notes: 'Тест' }], sha: 's' }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, new RegExp(`agent:view:${ID}:0`));
  assert.match(sent[0].text, /Агент/);
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
  assert.ok(sent[0].replyMarkup.inline_keyboard, 'agent button expected on /info card');
  assert.equal(sent[0].replyMarkup.inline_keyboard[0][0].callback_data, `agent:start:${ID}`);
});


test('runHandler: /agent (admin, multiple watchlist entries) → one row each, regardless of live Prozorro status', async () => {
  const OTHER = 'UA-2026-04-30-088888-b';
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [
      { tender_id: ID, enabled: true, notes: 'Тендеринг' },
      { tender_id: OTHER, enabled: true, notes: 'Розгляд' },
    ], sha: 's' }),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, new RegExp(`agent:view:${ID}:0`));
  assert.match(cbs, new RegExp(`agent:view:${OTHER}:0`));
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


test('runHandler: /agent with a done job → ✅ icon on that tender\'s row', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true, notes: 'КНП «Х»' }], sha: 's' }),
    listAgentJobs: async () => ([{ tender_id: ID, status: 'done', created_at: '2026-06-01T00:00:00Z',
      milestones: { prepared: true },
      result: { drive_link: 'https://drive.google.com/drive/folders/REAL' } }]),
  });
  await runHandler({ update: { message: { chat: { id: 123 }, text: '/agent', message_id: 1 } }, env: ENV, deps });
  assert.equal(sent.length, 1);
  assert.match(sent[0].replyMarkup.inline_keyboard[0][0].text, /^✅ КНП «Х»/);
  assert.match(JSON.stringify(sent[0].replyMarkup), new RegExp(`agent:view:${ID}:0`));
});

test('runHandler: /agent (admin) → unified list via the 🤖 Агент button alias', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '🤖 Агент', from: { id: 123 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 's' }) }).deps,
      sendReply: async (a) => sent.push(a),
    },
  });
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].replyMarkup), new RegExp(`agent:view:${ID}:0`));
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
  assert.equal(sent.length, 1, 'one message — content + nav');
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

test('runHandler: agent:jobs:0 → edits to the unified list, ✅ row for the done tender', async () => {
  const edits = []; const acks = [];
  await runHandler({
    update: { callback_query: { id: 'ca1', data: 'agent:jobs:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true, notes: 'ТОВ' }], sha: 's' }),
      }).deps,
      listAgentJobs: async () => ([{ tender_id: 'UA-2026-06-01-000002-a', status: 'done', company: 'ТОВ', created_at: '2026-06-20T10:00:00Z', milestones: { prepared: true }, result: { drive_link: 'https://drive/x' } }]),
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async (a) => acks.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Агент/);
  assert.match(edits[0].replyMarkup.inline_keyboard[0][0].text, /^✅/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /agent:view:UA-2026-06-01-000002-a:0/);
});

// Замикає ланцюг: кнопка, яку РЕАЛЬНО малює сторінка задач, має вести саме в ту
// гілку, що відкриває вибір дати. Без цієї перевірки фіча може бути готовою і
// водночас недосяжною — жодна кнопка на неї не веде.
test('runHandler: the sign button reached via list → drill-down opens the date dialog', async () => {
  const { deps, store, edits } = makeAgentDeps({
    listAgentJobs: async () => ([structuredClone(DONE_PREPARED)]),
    loadAgentJob: async () => structuredClone(DONE_PREPARED),
  });
  await runHandler({ update: CB('agent:jobs:0'), env: ENV, deps });
  const listKb = JSON.parse(JSON.stringify(edits.at(-1).replyMarkup));
  const viewBtn = listKb.inline_keyboard.flat()
    .find((b) => typeof b.callback_data === 'string' && b.callback_data.startsWith('agent:view:'));
  assert.ok(viewBtn, `no row for the done tender on the list: ${JSON.stringify(listKb)}`);

  await runHandler({ update: CB(viewBtn.callback_data), env: ENV, deps });
  const detailKb = JSON.parse(JSON.stringify(edits.at(-1).replyMarkup));
  const signBtn = detailKb.inline_keyboard.flat()
    .find((b) => typeof b.callback_data === 'string' && b.callback_data.startsWith('agent:sign:'));
  assert.ok(signBtn, `no sign button in the detail view: ${JSON.stringify(detailKb)}`);
  assert.equal(signBtn.callback_data, `agent:sign:${AGENT_TID}`);

  await runHandler({ update: CB(signBtn.callback_data), env: ENV, deps });
  assert.equal(store.pending['123'].kind, 'sign');
  assert.equal(store.pending['123'].step, 'await_date');
  assert.match(edits.at(-1).text, /дату/i);
});

// 'pick' is kept only as an ALIAS for the merged list (an already-open pre-
// 2026-08-14 keyboard must still resolve to something) — it no longer filters
// by live Prozorro status; the whole watchlist shows, regardless of status.
test('runHandler: agent:pick:0 (legacy alias) → same unified list as agent:jobs', async () => {
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
      }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.match(edits[0].text, /Агент/);
  const cbs = JSON.stringify(edits[0].replyMarkup);
  assert.match(cbs, /agent:view:UA-2026-06-01-000002-a:0/);
  assert.match(cbs, /agent:view:UA-2026-06-01-000003-a:0/);
});

test('runHandler: agent:menu → edits back to the unified list', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca3', data: 'agent:menu', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true }], sha: 's' }) }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.match(JSON.stringify(edits[0].replyMarkup), /agent:view:UA-2026-06-01-000002-a:0/);
});

test('runHandler: agent:view → prepared drive_link surfaces as a url button in the detail view', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca5', data: 'agent:view:UA-2026-06-01-000002-a:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true, notes: 'КНП' }], sha: 's' }),
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

test('runHandler: a VIEW command deletes the previous view + records the new one', async () => {
  const deleted = [];
  const kvStore = { 'eph:123': JSON.stringify([100, 101]) };
  const kv = {
    get: async (k) => (k in kvStore ? kvStore[k] : null),
    put: async (k, v) => { kvStore[k] = v; },
    delete: async (k) => { delete kvStore[k]; },
  };
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '/help', from: { id: 123 } } },
    env: { ...ENV, EPHEMERAL_KV: kv },
    deps: {
      ...makeDeps().deps,
      deleteMessage: async ({ messageId }) => { deleted.push(messageId); return true; },
      sendReply: async () => ({ ok: true, result: { message_id: 555 } }),
    },
  });
  assert.deepEqual(deleted.sort((a, b) => a - b), [100, 101], 'previous view messages deleted');
  assert.equal(kvStore['eph:123'], JSON.stringify([7, 555]), 'new ids = [trigger, reply]');
});

// Almost every recognized command is now a "view" for ephemeral purposes (admin
// utility commands — /log, /notify, /add, /invite, etc. — joined the original
// 8 on 2026-08-14 so THEY stop piling up too). What's left un-ephemeral is
// unrecognized input: no `cmd.cmd` at all, so there is nothing to look up in
// EPHEMERAL_VIEW_CMDS and the exchange is simply left in the chat.
test('runHandler: unrecognized text does NOT delete or record (no cmd to classify)', async () => {
  const deleted = [];
  const kvStore = { 'eph:123': JSON.stringify([100]) };
  const kv = {
    get: async (k) => (k in kvStore ? kvStore[k] : null),
    put: async (k, v) => { kvStore[k] = v; },
    delete: async (k) => { delete kvStore[k]; },
  };
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 8, text: 'привіт боте', from: { id: 123 } } },
    env: { ...ENV, EPHEMERAL_KV: kv },
    deps: {
      ...makeDeps().deps,
      deleteMessage: async ({ messageId }) => { deleted.push(messageId); return true; },
      sendReply: async () => ({ ok: true, result: { message_id: 999 } }),
    },
  });
  assert.equal(deleted.length, 0, 'no deletions for unrecognized text');
  assert.equal(kvStore['eph:123'], JSON.stringify([100]), 'ephemeral state unchanged');
});

test('runHandler: /notify is now an ephemeral view too — deletes the previous exchange', async () => {
  const deleted = [];
  const kvStore = { 'eph:123': JSON.stringify([100]) };
  const kv = {
    get: async (k) => (k in kvStore ? kvStore[k] : null),
    put: async (k, v) => { kvStore[k] = v; },
    delete: async (k) => { delete kvStore[k]; },
  };
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 8, text: '/notify', from: { id: 123 } } },
    env: { ...ENV, EPHEMERAL_KV: kv },
    deps: {
      ...makeDeps().deps,
      deleteMessage: async ({ messageId }) => { deleted.push(messageId); return true; },
      sendReply: async () => ({ ok: true, result: { message_id: 999 } }),
    },
  });
  assert.deepEqual(deleted, [100], 'the previous exchange is cleaned up');
  assert.equal(kvStore['eph:123'], JSON.stringify([8, 999]), 'new ids = [trigger, reply]');
});

test('runHandler: bare /add (editor) → force_reply prompt, no mutation', async () => {
  const sent = []; let saved = false;
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 5, text: '/add', from: { id: 123 } } },
    env: ENV,
    deps: { ...makeDeps({ saveWatchlist: async () => { saved = true; } }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(saved, false, 'no mutation on a bare /add');
  assert.match(sent[0].text, /додати в моніторинг/);
  assert.match(JSON.stringify(sent[0].replyMarkup), /"force_reply":true/);
});

test('runHandler: reply to the add-prompt with a valid UA → add happens', async () => {
  let saved = null;
  await runHandler({
    update: { message: {
      chat: { id: 123 }, message_id: 6, from: { id: 123 },
      text: 'UA-2026-06-19-008800-a',
      reply_to_message: { text: 'додати в моніторинг' },
    } },
    env: ENV,
    deps: { ...makeDeps({
      loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
      saveWatchlist: async (_e, wl) => { saved = wl; },
      fetchTender: async () => ({ data: { status: 'active.tendering', tenderPeriod: {}, procuringEntity: { name: 'X' } } }),
      loadArchivedTenders: async () => ({ archive: [], sha: null }),
    }).deps },
  });
  assert.ok(saved, 'watchlist saved → the reply was treated as the /add argument');
});

test('runHandler: reply to the add-prompt with invalid text → retry prompt, no mutation', async () => {
  const sent = []; let saved = false;
  await runHandler({
    update: { message: {
      chat: { id: 123 }, message_id: 7, from: { id: 123 },
      text: 'абищо',
      reply_to_message: { text: 'додати в моніторинг' },
    } },
    env: ENV,
    deps: { ...makeDeps({ saveWatchlist: async () => { saved = true; } }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(saved, false);
  assert.match(sent[0].text, /❌ Невірний формат/);
  assert.match(JSON.stringify(sent[0].replyMarkup), /"force_reply":true/);
});

test('runHandler: bare /add (non-editor) → permission message, no prompt', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 456 }, message_id: 8, text: '/add', from: { id: 456 } } },
    env: ENV,
    deps: { ...makeDeps({ loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }) }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.match(sent[0].text, /редакторів/);
  assert.ok(!JSON.stringify(sent[0].replyMarkup ?? {}).includes('force_reply'));
});

test('runHandler: /history → calendar with hist:day button for days with events', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '/history', from: { id: 123 } } },
    env: ENV,
    deps: { ...makeDeps({ loadNotificationHistory: async () => ({ items: [{ type: 'digest', summary: '📥 1', text: 'D', sent_at: '2026-06-25T05:55:00Z', recipients: [], deleted: false }] }) }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].replyMarkup), /hist:day:2026-06-25/);
});

test('runHandler: hist:i:0 → edits to the full digest text', async () => {
  const edits = []; const acks = [];
  await runHandler({
    update: { callback_query: { id: 'ch1', data: 'hist:i:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: { ...makeDeps({ loadNotificationHistory: async () => ({ items: [{ type: 'digest', summary: 's', text: 'ПОВНИЙ ТЕКСТ', sent_at: 't', recipients: [], deleted: false }] }) }).deps,
      editMessageText: async (a) => edits.push(a), answerCallbackQuery: async (a) => acks.push(a) },
  });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /ПОВНИЙ ТЕКСТ/);
  assert.equal(acks.length, 1);
});

// --- GitHub error diagnosis (admin-only) ------------------------------------
// Regression guard for the 2026-08-06 incident: an expired PAT and a real
// GitHub outage both surfaced as the same "тимчасово недоступний" line, so the
// cause was only visible in the Worker logs.

const ghErr = (status) => Object.assign(new Error(`GitHub GET ${status}: boom`), { status });

test('describeGithubError: decodes known statuses', () => {
  assert.equal(describeGithubError(ghErr(401)), 'HTTP 401 · токен недійсний або протермінований');
  assert.equal(describeGithubError(ghErr(403)), 'HTTP 403 · немає прав або вичерпано ліміт запитів');
  assert.equal(describeGithubError(ghErr(503)), 'HTTP 503 · збій на боці GitHub');
});

test('describeGithubError: falls back to the message when there was no HTTP status', () => {
  assert.equal(describeGithubError(new Error('Network connection lost')), 'Network connection lost');
  assert.equal(describeGithubError(undefined), 'невідома помилка');
});

test('githubUnavailableText: admin gets the cause, others get the plain line', () => {
  const admin = githubUnavailableText(ghErr(401), true);
  assert.match(admin, /HTTP 401/);
  assert.match(admin, /протермінований/);
  const viewer = githubUnavailableText(ghErr(401), false);
  assert.doesNotMatch(viewer, /HTTP 401/);
  assert.match(viewer, /GitHub тимчасово недоступний/);
});

test('githubUnavailableAck: stays within the Telegram toast limit', () => {
  const ack = githubUnavailableAck(Object.assign(new Error('x'.repeat(500)), {}), true);
  assert.ok(ack.length <= 200, `toast was ${ack.length} chars`);
});

test('runHandler: /watched GitHub failure → admin sees the HTTP status', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => { throw ghErr(401); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 5, text: '/watched', from: { id: 123 } } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /HTTP 401/);
  assert.match(sent[0].text, /протермінований/);
});

test('runHandler: /watched GitHub failure → non-admin sees no internals', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => { throw ghErr(401); },
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', role: 'editor', label: 'Editor' }], sha: null }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, message_id: 5, text: '/watched', from: { id: 456 } } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /HTTP 401/);
  assert.match(sent[0].text, /GitHub тимчасово недоступний/);
});

test('runHandler: callback toast carries the status for the admin', async () => {
  const acks = [];
  await runHandler({
    update: { callback_query: { id: 'cbgh', data: 'wat:menu:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchedEntities: async () => { throw ghErr(403); } }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
    },
  });
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /HTTP 403/);
});
