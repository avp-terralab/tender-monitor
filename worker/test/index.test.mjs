import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const SECRET = 'mysecret123';
const ENV = { TELEGRAM_WEBHOOK_SECRET: SECRET };

const makeCtx = () => {
  const tasks = [];
  return {
    ctx: { waitUntil: (p) => tasks.push(p) },
    tasks,
  };
};

test('worker.fetch: GET → 405', async () => {
  const { ctx } = makeCtx();
  const req = new Request('https://w.example/', { method: 'GET' });
  const res = await worker.fetch(req, ENV, ctx);
  assert.equal(res.status, 405);
});

test('worker.fetch: POST without secret header → 403', async () => {
  const { ctx } = makeCtx();
  const req = new Request('https://w.example/', {
    method: 'POST',
    body: JSON.stringify({ update_id: 1 }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  assert.equal(res.status, 403);
});

test('worker.fetch: POST with wrong secret → 403', async () => {
  const { ctx } = makeCtx();
  const req = new Request('https://w.example/', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
    body: JSON.stringify({ update_id: 1 }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  assert.equal(res.status, 403);
});

test('worker.fetch: POST with valid secret + invalid JSON → 400', async () => {
  const { ctx } = makeCtx();
  const req = new Request('https://w.example/', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: 'not-json',
  });
  const res = await worker.fetch(req, ENV, ctx);
  assert.equal(res.status, 400);
});

test('worker.fetch: POST with valid secret + valid JSON → 200, runHandler queued', async () => {
  const { ctx, tasks } = makeCtx();
  const req = new Request('https://w.example/', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: JSON.stringify({ update_id: 1, message: null }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  assert.equal(res.status, 200);
  assert.equal(tasks.length, 1);
  // Allow waitUntil promise to resolve (no-op since message null)
  await Promise.all(tasks);
});
