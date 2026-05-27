import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWatchlist, ConflictError, saveWatchlist, loadWatchedEntities, saveWatchedEntities, loadWatchedSeen, saveWatchedSeen, loadInvites, saveInvites, loadAllowedUsers, saveAllowedUsers, loadArchivedTenders } from '../src/github.mjs';

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

test('loadWatchlist: decodes UTF-8 (Cyrillic notes round-trip)', async () => {
  const wl = [{ tender_id: 'UA-X', enabled: true, notes: 'Рівне ОКЛ — ISO 15189 консалтинг' }];
  const json = JSON.stringify(wl);
  const content = Buffer.from(json, 'utf-8').toString('base64');
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content, sha: 'abc' }),
  });
  const result = await loadWatchlist(ENV, { fetch: fakeFetch });
  assert.deepEqual(result.watchlist, wl);
  assert.equal(result.watchlist[0].notes, 'Рівне ОКЛ — ISO 15189 консалтинг');
});

test('saveWatchlist: encodes UTF-8 (Cyrillic round-trips through base64)', async () => {
  const wl = [{ tender_id: 'UA-X', enabled: true, notes: 'Рівне ОКЛ — ISO 15189' }];
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({}) };
  };
  await saveWatchlist(ENV, wl, 'sha', { fetch: fakeFetch });
  // Decode the base64 → bytes → UTF-8 string and verify it parses back to the original
  const decodedBytes = Buffer.from(capturedBody.content, 'base64');
  const decodedJson = decodedBytes.toString('utf-8');
  assert.match(decodedJson, /Рівне ОКЛ/);
  assert.deepEqual(JSON.parse(decodedJson), wl);
});

test('loadWatchedEntities: GET watched_entities.json', async () => {
  const json = JSON.stringify([{ edrpou: '12345678', name: 'X', enabled: true }]);
  const content = Buffer.from(json, 'utf-8').toString('base64');
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ content, sha: 'sha1' }) };
  };
  const result = await loadWatchedEntities(ENV, { fetch: fakeFetch });
  assert.match(calls[0], /watched_entities\.json/);
  assert.deepEqual(result.entities, [{ edrpou: '12345678', name: 'X', enabled: true }]);
  assert.equal(result.sha, 'sha1');
});

test('loadWatchedEntities: 404 returns empty array (file may not exist)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const result = await loadWatchedEntities(ENV, { fetch: fakeFetch });
  assert.deepEqual(result.entities, []);
  assert.equal(result.sha, null);
});

test('saveWatchedEntities: PUT to correct path with sha', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
  await saveWatchedEntities(ENV, [{ edrpou: '12345678', enabled: true }], 'sha1', { fetch: fakeFetch });
  assert.match(calls[0].url, /watched_entities\.json/);
  assert.equal(calls[0].opts.method, 'PUT');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.sha, 'sha1');
});

test('saveWatchedEntities: handles null sha (file does not exist yet)', async () => {
  const fakeFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.sha, undefined); // omit sha when null
    return { ok: true, json: async () => ({}) };
  };
  await saveWatchedEntities(ENV, [], null, { fetch: fakeFetch });
});

test('loadWatchedSeen: GET _state/_watched_seen.json', async () => {
  const seen = { '12345678': ['UA-A'] };
  const content = Buffer.from(JSON.stringify(seen), 'utf-8').toString('base64');
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ content, sha: 's' }) };
  };
  const result = await loadWatchedSeen(ENV, { fetch: fakeFetch });
  assert.match(calls[0], /_state\/_watched_seen\.json/);
  assert.deepEqual(result.seen, seen);
});

test('loadWatchedSeen: 404 → empty object', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const result = await loadWatchedSeen(ENV, { fetch: fakeFetch });
  assert.deepEqual(result.seen, {});
  assert.equal(result.sha, null);
});

test('saveWatchedSeen: PUT to _state/_watched_seen.json', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
  await saveWatchedSeen(ENV, { '12345678': ['UA-A'] }, 'sha1', { fetch: fakeFetch });
  assert.match(calls[0].url, /_state\/_watched_seen\.json/);
});

test('loadInvites: missing file returns empty list + null sha', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  const { invites, sha } = await loadInvites(ENV, { fetch: fakeFetch });
  assert.deepEqual(invites, []);
  assert.equal(sha, null);
});

test('loadInvites: parses array', async () => {
  const json = JSON.stringify([{ token: 't', label: 'X' }]);
  const content = Buffer.from(json).toString('base64');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ content, sha: 'abc' }) });
  const { invites, sha } = await loadInvites(ENV, { fetch: fakeFetch });
  assert.deepEqual(invites, [{ token: 't', label: 'X' }]);
  assert.equal(sha, 'abc');
});

test('saveInvites: PUTs JSON body with sha', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await saveInvites(ENV, [{ token: 't', label: 'X' }], 'abc', { fetch: fakeFetch });
  assert.equal(captured.opts.method, 'PUT');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.sha, 'abc');
  const decoded = Buffer.from(body.content, 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(decoded), [{ token: 't', label: 'X' }]);
});

test('loadAllowedUsers: 404 returns empty', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  const { users, sha } = await loadAllowedUsers(ENV, { fetch: fakeFetch });
  assert.deepEqual(users, []);
  assert.equal(sha, null);
});

test('loadAllowedUsers: parses array', async () => {
  const json = JSON.stringify([{ chat_id: '1', label: 'A' }]);
  const content = Buffer.from(json).toString('base64');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ content, sha: 'def' }) });
  const { users, sha } = await loadAllowedUsers(ENV, { fetch: fakeFetch });
  assert.deepEqual(users, [{ chat_id: '1', label: 'A' }]);
  assert.equal(sha, 'def');
});

test('saveAllowedUsers: PUTs with sha', async () => {
  let captured;
  const fakeFetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({}) }; };
  await saveAllowedUsers(ENV, [{ chat_id: '1' }], 'def', { fetch: fakeFetch });
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.sha, 'def');
});

test('loadArchivedTenders: parses array', async () => {
  const payload = JSON.stringify([{ tender_id: 'UA-X', final_status: 'complete' }]);
  const b64 = Buffer.from(payload, 'utf-8').toString('base64');
  const env = { GITHUB_PAT: 'pat' };
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ content: b64, sha: 'sha-arch' }),
  });
  const { archive, sha } = await loadArchivedTenders(env, { fetch: fetchImpl });
  assert.equal(archive.length, 1);
  assert.equal(archive[0].tender_id, 'UA-X');
  assert.equal(sha, 'sha-arch');
});

test('loadArchivedTenders: 404 → empty + sha null', async () => {
  const env = { GITHUB_PAT: 'pat' };
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  const { archive, sha } = await loadArchivedTenders(env, { fetch: fetchImpl });
  assert.deepEqual(archive, []);
  assert.equal(sha, null);
});

test('saveWatchlist: uses custom message when provided', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch, message: 'audit: add UA-x · A [1/editor]' });
  assert.equal(JSON.parse(calls[0].opts.body).message, 'audit: add UA-x · A [1/editor]');
});

test('saveWatchlist: default message unchanged when no message (back-compat)', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch });
  assert.match(JSON.parse(calls[0].opts.body).message, /^bot: update watchlist /);
});

test('saveAllowedUsers: threads custom message through saveFile', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveAllowedUsers(ENV, [], 'sha', { fetch: fakeFetch, message: 'audit: revoke 1 · admin [9/admin]' });
  assert.equal(JSON.parse(calls[0].opts.body).message, 'audit: revoke 1 · admin [9/admin]');
});
