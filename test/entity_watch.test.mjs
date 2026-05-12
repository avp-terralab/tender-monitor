import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWatchedEntities } from '../entity_watch.mjs';
import { extractSnapshot } from '../prozorro.mjs';

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
      fetchChangesFeed: async () => ({ items: [], nextOffset: null }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot,
      ...overrides,
    },
  };
};

test('checkWatchedEntities: empty watched list → no-op', async () => {
  const { deps } = baseDeps();
  const result = await checkWatchedEntities(deps);
  assert.deepEqual(result, { alerts: [], errors: [] });
});

test('checkWatchedEntities: feed has no candidates for watched EDRPOU → no alerts, cursor advanced to nextOffset', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async () => ({
      items: [
        { tenderID: 'UA-A', procuringEntity: { identifier: { id: '99999999' } } },
      ],
      nextOffset: '1715000010.0.0.checkpoint',
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(state.cursorStore.value.offset, '1715000010.0.0.checkpoint');
});

test('checkWatchedEntities: candidate matches EDRPOU + status active.tendering + not in seen → alert + seen updated', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async () => ({
      items: [
        { tenderID: 'UA-NEW', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      nextOffset: '1715000020.0.0.x',
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
    fetchChangesFeed: async () => ({
      items: [
        { tenderID: 'UA-NEW', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      nextOffset: '1715000020.0.0.x',
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});

test('checkWatchedEntities: candidate status=complete → skipped', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async () => ({
      items: [
        { tenderID: 'UA-DONE', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      nextOffset: '1715000020.0.0.x',
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

test('checkWatchedEntities: walks pages forward until items empty, advances offset each call', async () => {
  const calls = [];
  let page = 0;
  const pages = [
    { items: [{ tenderID: 'UA-1', procuringEntity: { identifier: { id: '11111111' } } }], nextOffset: 'off-1' },
    { items: [{ tenderID: 'UA-2', procuringEntity: { identifier: { id: '11111111' } } }], nextOffset: 'off-2' },
    { items: [], nextOffset: 'off-2' }, // checkpoint stays same
  ];
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async ({ offset }) => {
      calls.push(offset);
      return pages[page++];
    },
    fetchTender: async (id) => ({
      data: {
        tenderID: id,
        title: 't',
        status: 'active.tendering',
        procuringEntity: { name: 'X', identifier: { id: '11111111' } },
        items: [],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], null); // cold start
  assert.equal(calls[1], 'off-1');
  assert.equal(calls[2], 'off-2');
  assert.equal(result.alerts.length, 2);
  assert.equal(state.cursorStore.value.offset, 'off-2');
});

test('checkWatchedEntities: cursor has offset → passed to first feed call', async () => {
  const calls = [];
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    loadCursor: async () => ({ offset: 'resume-from-here' }),
    fetchChangesFeed: async ({ offset }) => {
      calls.push(offset);
      return { items: [], nextOffset: 'resume-from-here' };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(calls[0], 'resume-from-here');
});

test('checkWatchedEntities: legacy cursor {last_dateModified} → migrated to unix-seconds offset', async () => {
  const calls = [];
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    // 2026-05-08T09:00:00Z = unix 1778230800
    loadCursor: async () => ({ last_dateModified: '2026-05-08T09:00:00Z' }),
    fetchChangesFeed: async ({ offset }) => {
      calls.push(offset);
      return { items: [], nextOffset: 'new-opaque-cursor' };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(calls[0], '1778230800');
});

test('checkWatchedEntities: legacy cursor migration uses Math.floor of milliseconds/1000', async () => {
  const calls = [];
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    loadCursor: async () => ({ last_dateModified: '2026-05-08T09:00:00.999Z' }),
    fetchChangesFeed: async ({ offset }) => {
      calls.push(offset);
      return { items: [], nextOffset: 'x' };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(calls[0], '1778230800');
});

test('checkWatchedEntities: cold start (no cursor) → first call offset=null', async () => {
  const calls = [];
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async ({ offset }) => {
      calls.push(offset);
      return { items: [], nextOffset: 'first-cp' };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(calls[0], null);
});

test('checkWatchedEntities: page cap stops infinite walk on full pages', async () => {
  let calls = 0;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async () => {
      calls++;
      // Always returns full page + nextOffset → would loop forever without cap
      const items = Array.from({ length: 100 }, (_, i) => ({
        tenderID: `UA-${calls}-${i}`,
        procuringEntity: { identifier: { id: '99999999' } },
      }));
      return { items, nextOffset: `off-${calls}` };
    },
  });
  await checkWatchedEntities(deps);
  // Safety cap kicks in (current FEED_PAGE_CAP = 100). Must be finite.
  assert.ok(calls <= 100 && calls >= 1, `expected bounded walk, got ${calls} calls`);
});

test('checkWatchedEntities: fetchTender 404 → goes to errors, alert NOT generated, seen NOT updated', async () => {
  let page = 0;
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async () => {
      if (page++ === 0) {
        return {
          items: [{ tenderID: 'UA-FAKE', procuringEntity: { identifier: { id: '11111111' } } }],
          nextOffset: 'cp',
        };
      }
      return { items: [], nextOffset: 'cp' };
    },
    fetchTender: async () => { throw new Error('Prozorro 404'); },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].tender_id, 'UA-FAKE');
  assert.equal(state.seenStore.value['11111111'], undefined);
});

test('checkWatchedEntities: feed 5xx → returns errors with source=feed, saveCursor NOT called', async () => {
  let saveCursorCalls = 0;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    loadCursor: async () => ({ offset: 'unchanged' }),
    saveCursor: async () => { saveCursorCalls++; },
    fetchChangesFeed: async () => { throw new Error('Prozorro feed 503'); },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'feed');
  assert.equal(saveCursorCalls, 0);
});

test('checkWatchedEntities: disabled entity ignored', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: false }],
    fetchChangesFeed: async () => ({
      items: [
        { tenderID: 'UA-X', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      nextOffset: 'cp',
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});

test('checkWatchedEntities: discoveredNames populated when watched name is "(unknown)" and snapshot has real name', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: true }],
    fetchChangesFeed: async () => ({
      items: [{ tenderID: 'UA-N', procuringEntity: { identifier: { id: '11111111' } } }],
      nextOffset: 'cp',
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-N',
        title: 't',
        status: 'active.tendering',
        procuringEntity: { name: 'Реальна назва', identifier: { id: '11111111' } },
        items: [],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.discoveredNames['11111111'], 'Реальна назва');
});
