import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEphemeral, saveEphemeral } from '../src/ephemeral.mjs';

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
