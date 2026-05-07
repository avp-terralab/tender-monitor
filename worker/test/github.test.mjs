import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWatchlist, ConflictError, saveWatchlist } from '../src/github.mjs';

const ENV = { GITHUB_PAT: 'PAT_VALUE' };

test('loadWatchlist: builds correct GET request', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    const json = JSON.stringify([{ tender_id: 'UA-X', enabled: true }]);
    const content = Buffer.from(json).toString('base64');
    return {
      ok: true,
      status: 200,
      json: async () => ({ content, sha: 'abc123' }),
    };
  };
  const result = await loadWatchlist(ENV, { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.github\.com\/repos\/avp-terralab\/tender-monitor\/contents\/watchlist\.json\?ref=main/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer PAT_VALUE');
  assert.equal(calls[0].opts.headers['User-Agent'], 'tender-monitor-worker');
  assert.equal(calls[0].opts.headers.Accept, 'application/vnd.github+json');
  assert.deepEqual(result.watchlist, [{ tender_id: 'UA-X', enabled: true }]);
  assert.equal(result.sha, 'abc123');
});

test('loadWatchlist: handles content with newlines (GitHub wraps base64)', async () => {
  const json = JSON.stringify([{ tender_id: 'UA-X', enabled: true }]);
  // GitHub returns base64 with \n every 60 chars
  const content = Buffer.from(json).toString('base64').match(/.{1,60}/g).join('\n');
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content, sha: 'abc' }),
  });
  const result = await loadWatchlist(ENV, { fetch: fakeFetch });
  assert.deepEqual(result.watchlist, [{ tender_id: 'UA-X', enabled: true }]);
});

test('loadWatchlist: throws on 401', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Bad credentials',
  });
  await assert.rejects(
    () => loadWatchlist(ENV, { fetch: fakeFetch }),
    /401/
  );
});

test('loadWatchlist: throws on 404', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'Not Found',
  });
  await assert.rejects(
    () => loadWatchlist(ENV, { fetch: fakeFetch }),
    /404/
  );
});

test('saveWatchlist: builds correct PUT request', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ content: { sha: 'newSha' } }) };
  };
  const wl = [{ tender_id: 'UA-X', enabled: true, notes: 'X' }];
  await saveWatchlist(ENV, wl, 'oldSha', { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.github\.com\/repos\/avp-terralab\/tender-monitor\/contents\/watchlist\.json/);
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer PAT_VALUE');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.sha, 'oldSha');
  assert.equal(body.branch, 'main');
  assert.match(body.message, /^bot: update watchlist /);
  // Decode content to verify
  const decoded = atob(body.content);
  assert.deepEqual(JSON.parse(decoded), wl);
  assert.ok(decoded.endsWith('\n'), 'JSON should end with newline');
});

test('saveWatchlist: throws ConflictError on 409', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 409,
    text: async () => 'Conflict',
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof ConflictError
  );
});

test('saveWatchlist: throws plain Error on 401', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Bad credentials',
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof Error && !(err instanceof ConflictError) && /401/.test(err.message)
  );
});

test('saveWatchlist: throws plain Error on 5xx', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'Service Unavailable',
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    /503/
  );
});
