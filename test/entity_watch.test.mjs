import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWatchedEntities } from '../entity_watch.mjs';

const baseDeps = (overrides = {}) => {
  const cursorStore = { value: null };
  const seenStore = { value: {} };
  return {
    state: { cursorStore, seenStore },
    deps: {
      watchedEntities: [],
      loadCursor: async () => cursorStore.value,
      saveCursor: async (c) => { cursorStore.value = c; },
      loadSeen: async () => seenStore.value,
      saveSeen: async (s) => { seenStore.value = s; },
      fetchTendersFeed: async () => ({ items: [], next: null }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot: (raw) => raw.data,
      ...overrides,
    },
  };
};

test('checkWatchedEntities: empty watched list → no-op', async () => {
  const { deps } = baseDeps();
  const result = await checkWatchedEntities(deps);
  assert.deepEqual(result, { alerts: [], errors: [] });
});

test('checkWatchedEntities: feed has no candidates for watched EDRPOU → no alerts, cursor saved', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-A', dateModified: '2026-05-08T10:00:00Z', procuringEntity: { identifier: { id: '99999999' } } },
      ],
      next: null,
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(state.cursorStore.value.last_dateModified, '2026-05-08T10:00:00Z');
});

test('checkWatchedEntities: candidate matches EDRPOU + status active.tendering + not in seen → alert + seen updated', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-NEW', dateModified: '2026-05-08T10:00:00Z', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      next: null,
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-NEW',
        title: 'Тест',
        status: 'active.tendering',
        tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
        procuringEntity: { name: 'Замовник', identifier: { id: '11111111' } },
        items: [],
        value: { amount: 1000, currency: 'UAH' },
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].tender_id, 'UA-NEW');
  assert.deepEqual(result.alerts[0].events, [{ type: 'new_tender_announced' }]);
  assert.deepEqual(state.seenStore.value['11111111'], ['UA-NEW']);
});

test('checkWatchedEntities: candidate in seen → skipped', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    loadSeen: async () => ({ '11111111': ['UA-NEW'] }),
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-NEW', dateModified: '2026-05-08T10:00:00Z', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      next: null,
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});

test('checkWatchedEntities: candidate status=complete → skipped', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-DONE', dateModified: '2026-05-08T10:00:00Z', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      next: null,
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-DONE',
        title: 'Завершений',
        status: 'complete',
        procuringEntity: { name: 'X', identifier: { id: '11111111' } },
        items: [],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});

test('checkWatchedEntities: feed walk stops at cursor', async () => {
  let calls = 0;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    loadCursor: async () => ({ last_dateModified: '2026-05-08T09:00:00Z' }),
    fetchTendersFeed: async () => {
      calls++;
      return {
        items: [
          { tenderID: 'UA-OLD', dateModified: '2026-05-08T08:00:00Z', procuringEntity: { identifier: { id: '11111111' } } },
        ],
        next: '/path',
      };
    },
  });
  await checkWatchedEntities(deps);
  // Feed call returned 1 entry, but it's <= cursor → reachedCursor=true → break, no second feed call
  assert.equal(calls, 1);
});

test('checkWatchedEntities: feed walk stops when next is null', async () => {
  let calls = 0;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchTendersFeed: async () => {
      calls++;
      return { items: [], next: null };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(calls, 1);
});

test('checkWatchedEntities: fetchTender 404 → goes to errors, alert NOT generated, seen NOT updated', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-FAKE', dateModified: '2026-05-08T10:00:00Z', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      next: null,
    }),
    fetchTender: async () => { throw new Error('Prozorro 404'); },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].tender_id, 'UA-FAKE');
  // seen NOT updated for failed fetch
  assert.equal(state.seenStore.value['11111111'], undefined);
});

test('checkWatchedEntities: feed 5xx → returns errors with source=feed, cursor unchanged', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    loadCursor: async () => ({ last_dateModified: '2026-05-08T09:00:00Z' }),
    fetchTendersFeed: async () => { throw new Error('Prozorro feed 503'); },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'feed');
  // cursor unchanged on feed failure
  assert.equal(state.cursorStore.value, null);
});

test('checkWatchedEntities: disabled entity ignored', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: false }],
    fetchTendersFeed: async () => ({
      items: [
        { tenderID: 'UA-X', dateModified: '2026-05-08T10:00:00Z', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      next: null,
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});
