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
