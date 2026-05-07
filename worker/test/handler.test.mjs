import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHandler } from '../src/handler.mjs';

const makeDeps = (overrides = {}) => {
  const sent = [];
  return {
    sent,
    deps: {
      loadWatchlist: async () => ({ watchlist: [], sha: 'fake-sha' }),
      saveWatchlist: async () => ({}),
      fetchTender: async () => ({ data: { tenderID: 'UA-FAKE' } }),
      extractSnapshot: (raw) => raw.data,
      sendReply: async (args) => { sent.push(args); },
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
