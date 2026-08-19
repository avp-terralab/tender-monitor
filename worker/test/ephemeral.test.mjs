import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEphemeral, saveEphemeral, loadAgentPending, saveAgentPending } from '../src/ephemeral.mjs';

function fakeKV(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    delete: async (k) => { delete store[k]; },
  };
}

test('loadEphemeral: missing key → []', async () => {
  assert.deepEqual(await loadEphemeral(fakeKV(), '123'), []);
});

test('loadEphemeral: returns the stored array', async () => {
  const kv = fakeKV({ 'eph:123': JSON.stringify([10, 11]) });
  assert.deepEqual(await loadEphemeral(kv, '123'), [10, 11]);
});

test('loadEphemeral: null kv → []; bad JSON → []', async () => {
  assert.deepEqual(await loadEphemeral(null, '123'), []);
  assert.deepEqual(await loadEphemeral(fakeKV({ 'eph:1': 'not json' }), '1'), []);
});

test('saveEphemeral: stores JSON with a 48h TTL', async () => {
  const kv = fakeKV();
  let ttlOpts;
  kv.put = async (k, v, o) => { kv.store[k] = v; ttlOpts = o; };
  await saveEphemeral(kv, '123', [7, 555]);
  assert.equal(kv.store['eph:123'], JSON.stringify([7, 555]));
  assert.equal(ttlOpts.expirationTtl, 172800);
});

test('saveEphemeral: null kv → no-op (no throw)', async () => {
  await saveEphemeral(null, '123', [1]);   // must not throw
});

// /start's slot must be independent of the shared view-command slot — a fix
// for a real regression where /info-family cleanup deleted /start's message
// (the one carrying the persistent keyboard) as "the previous ephemeral view".
test('namespaced slots do not collide: default vs "start" for the same chatId', async () => {
  const kv = fakeKV();
  await saveEphemeral(kv, '123', [7, 100]);            // default (view-command) slot
  await saveEphemeral(kv, '123', [8, 200], 'start');   // /start's own slot
  assert.deepEqual(await loadEphemeral(kv, '123'), [7, 100]);
  assert.deepEqual(await loadEphemeral(kv, '123', 'start'), [8, 200]);
  assert.equal(kv.store['eph:123'], JSON.stringify([7, 100]));
  assert.equal(kv.store['eph:start:123'], JSON.stringify([8, 200]));
});

// agent_pending moved here from GitHub-committed state (2026-08-19) — see
// docs/superpowers/plans/2026-08-19-agent-pending-to-kv.md. Worker-only state
// (never read/written by ci.mjs or the Python poller), so KV is a clean fit —
// unlike watchlist/agent_jobs/_watched_seen, which stay in git because more
// than one execution context needs to reach them.

test('loadAgentPending: missing key → empty object + null sha', async () => {
  const { pending, sha } = await loadAgentPending({ EPHEMERAL_KV: fakeKV() });
  assert.deepEqual(pending, {});
  assert.equal(sha, null);
});

test('loadAgentPending: returns the stored keyed-by-chatId object', async () => {
  const state = { '123': { tid: 'UA-X', company: 'МАЙЛАБ', step: 'await_price' } };
  const env = { EPHEMERAL_KV: fakeKV({ agent_pending: JSON.stringify(state) }) };
  const { pending, sha } = await loadAgentPending(env);
  assert.deepEqual(pending, state);
  assert.equal(sha, null);
});

test('loadAgentPending: bad JSON → empty object (no throw)', async () => {
  const env = { EPHEMERAL_KV: fakeKV({ agent_pending: 'not json' }) };
  const { pending } = await loadAgentPending(env);
  assert.deepEqual(pending, {});
});

test('loadAgentPending: missing EPHEMERAL_KV binding → empty object (no throw)', async () => {
  const { pending, sha } = await loadAgentPending({});
  assert.deepEqual(pending, {});
  assert.equal(sha, null);
});

test('saveAgentPending: stores the whole object as JSON under one fixed key, ignores sha', async () => {
  const kv = fakeKV();
  const env = { EPHEMERAL_KV: kv };
  await saveAgentPending(env, { '123': { tid: 'UA-X', step: 'confirm' } }, 'unused-sha-value');
  assert.equal(kv.store['agent_pending'], JSON.stringify({ '123': { tid: 'UA-X', step: 'confirm' } }));
});

test('saveAgentPending: missing EPHEMERAL_KV binding → no-op (no throw)', async () => {
  await saveAgentPending({}, { '1': { step: 'confirm' } }, null); // must not throw
});

test('agentPending round-trip: save then load returns the same object', async () => {
  const env = { EPHEMERAL_KV: fakeKV() };
  const state = { '456': { tid: 'UA-Y', step: 'await_company' } };
  await saveAgentPending(env, state, null);
  const { pending } = await loadAgentPending(env);
  assert.deepEqual(pending, state);
});
