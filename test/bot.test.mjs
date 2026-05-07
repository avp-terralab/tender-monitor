import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBot, HELP_TEXT } from '../bot.mjs';

const ID = 'UA-2026-04-30-010542-a';
const RAW_OK = {
  data: {
    tenderID: ID, title: 'Реактиви', status: 'active.tendering',
    tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
    procuringEntity: { name: 'КНП', identifier: { id: '11111111' } },
    items: [],
  },
};

const makeDeps = async (overrides = {}) => {
  const sent = [];
  const offsetStore = { value: 0 };
  const watchlistStore = { value: [] };
  return {
    sent, offsetStore, watchlistStore,
    deps: {
      token: 'TOK',
      allowedChatId: '123',
      getUpdates: async () => [],
      sendReply: async (args) => { sent.push(args); },
      fetchTender: async () => RAW_OK,
      extractSnapshot: (await import('../prozorro.mjs')).extractSnapshot,
      loadOffset: async () => offsetStore.value,
      saveOffset: async (v) => { offsetStore.value = v; },
      loadWatchlist: async () => watchlistStore.value,
      saveWatchlist: async (v) => { watchlistStore.value = v; },
      ...overrides,
    },
  };
};

test('runBot: zero updates → no-op, offset unchanged', async () => {
  const { deps, offsetStore, sent } = await makeDeps({ getUpdates: async () => [] });
  const result = await runBot(deps);
  assert.equal(result.processed, 0);
  assert.equal(offsetStore.value, 0);
  assert.equal(sent.length, 0);
});

test('runBot: ignores updates from other chats', async () => {
  const { deps, sent, offsetStore } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 999 }, text: '/list', message_id: 5 } },
    ],
  });
  await runBot(deps);
  assert.equal(sent.length, 0);
  assert.equal(offsetStore.value, 2); // offset still advances past the update
});

test('runBot: /list from allowed chat → reply sent', async () => {
  const { deps, sent } = await makeDeps({
    getUpdates: async () => [
      { update_id: 10, message: { chat: { id: 123 }, text: '/list', message_id: 3 } },
    ],
    loadWatchlist: async () => [{ tender_id: ID, enabled: true, notes: 'X' }],
  });
  await runBot(deps);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🟢/);
  assert.equal(sent[0].chatId, 123);
  assert.equal(sent[0].replyToMessageId, 3);
});

test('runBot: /add success → watchlist mutated and saved', async () => {
  const { deps, sent, watchlistStore } = await makeDeps({
    getUpdates: async () => [
      { update_id: 5, message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 7 } },
    ],
  });
  await runBot(deps);
  assert.equal(watchlistStore.value.length, 1);
  assert.equal(watchlistStore.value[0].tender_id, ID);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /✅ Додано/);
});

test('runBot: /add when already in watchlist → no save', async () => {
  let saveCalled = false;
  const { deps } = await makeDeps({
    getUpdates: async () => [
      { update_id: 5, message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 7 } },
    ],
    loadWatchlist: async () => [{ tender_id: ID, enabled: true, notes: 'old' }],
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runBot(deps);
  assert.equal(saveCalled, false);
});

test('runBot: /help → HELP_TEXT', async () => {
  const { deps, sent } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: '/help', message_id: 1 } },
    ],
  });
  await runBot(deps);
  assert.equal(sent[0].text, HELP_TEXT);
});

test('runBot: /add invalid id → error reply, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: '/add bad-id', message_id: 1 } },
    ],
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runBot(deps);
  assert.match(sent[0].text, /Невалідний/);
  assert.equal(saveCalled, false);
});

test('runBot: /unknown → "Не розумію" reply', async () => {
  const { deps, sent } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: '/foo', message_id: 1 } },
    ],
  });
  await runBot(deps);
  assert.match(sent[0].text, /Не розумію/);
});

test('runBot: free text → silently ignored, no reply', async () => {
  const { deps, sent, offsetStore } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: 'привіт', message_id: 1 } },
    ],
  });
  await runBot(deps);
  assert.equal(sent.length, 0);
  assert.equal(offsetStore.value, 2); // still advances
});

test('runBot: offset advances to max(update_id) + 1', async () => {
  const { deps, offsetStore } = await makeDeps({
    getUpdates: async () => [
      { update_id: 100, message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
      { update_id: 105, message: { chat: { id: 123 }, text: '/help', message_id: 2 } },
      { update_id: 103, message: { chat: { id: 123 }, text: '/list', message_id: 3 } },
    ],
  });
  await runBot(deps);
  assert.equal(offsetStore.value, 106);
});

test('runBot: getUpdates 5xx → exit gracefully, offset unchanged', async () => {
  const { deps, offsetStore } = await makeDeps({
    getUpdates: async () => { throw new Error('Telegram getUpdates 503: timeout'); },
  });
  const result = await runBot(deps);
  assert.equal(result.error, 'getUpdates_failed');
  assert.equal(offsetStore.value, 0);
});

test('runBot: getUpdates 401 → returns unauthorized error', async () => {
  const { deps } = await makeDeps({
    getUpdates: async () => { throw new Error('Telegram getUpdates 401: bad token'); },
  });
  const result = await runBot(deps);
  assert.equal(result.error, 'unauthorized');
});

test('runBot: sendReply failure does not break loop', async () => {
  let sentCount = 0;
  const { deps, watchlistStore } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
      { update_id: 2, message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 2 } },
    ],
    sendReply: async () => {
      sentCount++;
      throw new Error('Telegram sendReply 500');
    },
  });
  await runBot(deps);
  assert.equal(sentCount, 2); // both attempts made
  assert.equal(watchlistStore.value.length, 1); // /add still mutated despite reply failure
});

test('runBot: /list chunks output when over Telegram limit', async () => {
  const longNotes = 'X'.repeat(80);  // truncated to 80 in handleList
  const bigWatchlist = [];
  for (let i = 0; i < 60; i++) {
    bigWatchlist.push({
      tender_id: `UA-2026-04-30-${String(i).padStart(6, '0')}-a`,
      enabled: true,
      notes: longNotes,
    });
  }
  const { deps, sent } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: '/list', message_id: 1 } },
    ],
    loadWatchlist: async () => bigWatchlist,
  });
  await runBot(deps);
  // 60 rows × ~115 chars ≈ 6900 chars > 4000 → must be ≥2 chunks
  assert.ok(sent.length >= 2, `expected ≥2 chunks, got ${sent.length}`);
  // Each chunk has a "— K/N —" annotation
  assert.match(sent[0].text, /— 1\/\d+ —/);
});

test('runBot: /add without args → "Не вказано tender_id" reply', async () => {
  const { deps, sent } = await makeDeps({
    getUpdates: async () => [
      { update_id: 1, message: { chat: { id: 123 }, text: '/add', message_id: 1 } },
    ],
  });
  await runBot(deps);
  assert.match(sent[0].text, /Не вказано/);
});
