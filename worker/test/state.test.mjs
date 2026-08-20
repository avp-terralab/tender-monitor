import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWatchlist } from '../src/state.mjs';

test('state.mjs: STATE_BACKEND="gitlab" routes to gitlab.mjs (Files API shape)', async () => {
  const env = { STATE_BACKEND: 'gitlab', GITLAB_TOKEN: 't', GITLAB_PROJECT_ID: '1', GITLAB_REF: 'main' };
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    const content = Buffer.from('[]').toString('base64');
    return { ok: true, status: 200, json: async () => ({ content, last_commit_id: 'c1' }) };
  };
  await loadWatchlist(env, { fetch: fakeFetch });
  assert.match(calls[0], /repository\/files\/watchlist\.json/);
});

test('state.mjs: default (no STATE_BACKEND) routes to github.mjs (Contents API shape)', async () => {
  const env = { GITHUB_PAT: 't' };
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const content = Buffer.from('[]').toString('base64');
    return { ok: true, status: 200, json: async () => ({ content, sha: 's1' }) };
  };
  await loadWatchlist(env, { fetch: fakeFetch });
  assert.match(calls[0], /api\.github\.com\/repos/);
});
