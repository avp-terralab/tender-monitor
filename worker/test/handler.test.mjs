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
      ...overrides,
    },
  };
};

const ENV = {
  TELEGRAM_BOT_TOKEN: 'TOK',
  ALLOWED_CHAT_ID: '123',
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

test('runHandler: comma-separated ALLOWED_CHAT_ID → both ids allowed', async () => {
  const { deps, sent } = makeDeps();
  const multiEnv = { ...ENV, ALLOWED_CHAT_ID: '123, 456' };
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 9 } },
    env: multiEnv,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 456);
});

test('runHandler: comma-separated ALLOWED_CHAT_ID → unlisted id still rejected', async () => {
  const { deps, sent } = makeDeps();
  const multiEnv = { ...ENV, ALLOWED_CHAT_ID: '123,456' };
  await runHandler({
    update: { message: { chat: { id: 789 }, text: '/help', message_id: 1 } },
    env: multiEnv,
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
    update: { message: { chat: { id: 999 }, text: '/list', message_id: 1 } },
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

test('runHandler: /list with watchlist → formatted reply', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: 'UA-2026-04-30-010542-a', enabled: true, notes: 'X' }],
      sha: 'abc',
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🟢 UA-2026-04-30-010542-a/);
  assert.match(sent[0].text, /Всього: 1 \(1 active\)/);
});

test('runHandler: /list when loadWatchlist throws → ⚠️ reply', async () => {
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => { throw new Error('GitHub GET 503: timeout'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /⚠️ GitHub тимчасово недоступний/);
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

test('runHandler: /list fetches value for enabled rows; skips disabled', async () => {
  const fetched = [];
  const RAW = (id) => ({
    data: {
      tenderID: id,
      title: 'X',
      status: 'active.tendering',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'Тест', identifier: { id: '1' } },
      items: [],
      value: { amount: 12345, currency: 'UAH', valueAddedTaxIncluded: true },
    },
  });
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-A', enabled: true, notes: 'ТОВ «А»' },
        { tender_id: 'UA-B', enabled: false, notes: 'ТОВ «Б»' },
      ],
      sha: 'x',
    }),
    fetchTender: async (id) => { fetched.push(id); return RAW(id); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.deepEqual(fetched, ['UA-A']);  // disabled UA-B not fetched
  assert.match(sent[0].text, /UA-A — ТОВ «А» — 12 345 UAH/);
  // UA-B disabled — no value
  assert.match(sent[0].text, /🔴 UA-B — ТОВ «Б»\n\nВсього/);
});

test('runHandler: /list fetch failure on enabled row → list still works without value', async () => {
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [{ tender_id: 'UA-A', enabled: true, notes: 'ТОВ «А»' }],
      sha: 'x',
    }),
    fetchTender: async () => { throw new Error('Prozorro 503'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /UA-A — ТОВ «А»/);
  assert.doesNotMatch(sent[0].text, /UAH/);
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
  assert.match(sent[0].text, /EDRPOU має бути 8 цифр/);
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
  assert.match(sent[0].text, /EDRPOU має бути 8 цифр/);
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
