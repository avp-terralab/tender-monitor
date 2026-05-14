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
      fetchDescendingFeed: async () => ({ items: [], next: null }),
      fetchTender: async () => ({ data: {} }),
      extractSnapshot,
      searchTenderByEdrpou: async () => ({ name: null }),
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
        items: [{ classification: { id: '72250000-2', scheme: 'ДК021' } }],
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
        items: [{ classification: { id: '72250000-2', scheme: 'ДК021' } }],
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
  // Safety cap kicks in (current FEED_PAGE_CAP = 500). Must be finite.
  assert.ok(calls <= 500 && calls >= 1, `expected bounded walk, got ${calls} calls`);
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

test('checkWatchedEntities: backfill descending walk runs ONLY for entities with name="(unknown)"', async () => {
  const descCalls = [];
  const { deps } = baseDeps({
    watchedEntities: [
      { edrpou: '11111111', name: 'Відомий замовник', enabled: true },
      { edrpou: '22222222', name: '(unknown)', enabled: true },
    ],
    fetchDescendingFeed: async ({ pageOffset }) => {
      descCalls.push({ edrpou: 'check', pageOffset });
      return { items: [], next: null };
    },
  });
  await checkWatchedEntities(deps);
  // Only 1 entity is (unknown) → 1 backfill walk × 1 page (empty result) = 1 call
  assert.equal(descCalls.length, 1);
});

test('checkWatchedEntities: backfill finds tender published before cursor, alerts on it', async () => {
  // Scenario: /watch 02007472 at T0, first monitor tick sets forward cursor at T1.
  // Tender published at T0+1h (between T0 and T1). Forward feed (cursor=T1) misses it.
  // Backfill descending walk catches it.
  let descPage = 0;
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '02007472', name: '(unknown)', enabled: true }],
    loadCursor: async () => ({ offset: 'past-cursor' }),
    fetchChangesFeed: async () => ({ items: [], nextOffset: 'past-cursor' }),
    fetchDescendingFeed: async () => {
      if (descPage++ === 0) {
        return {
          items: [
            { tenderID: 'UA-2026-05-08-005338-a', procuringEntity: { identifier: { id: '02007472' } } },
            { tenderID: 'UA-OTHER', procuringEntity: { identifier: { id: '99999999' } } },
          ],
          next: '/path',
        };
      }
      return { items: [], next: null };
    },
    fetchTender: async (id) => ({
      data: {
        tenderID: id,
        title: 'ЛІС для лабораторії',
        status: 'active.tendering',
        procuringEntity: { name: 'КНП «Охтирська ЦРЛ»', identifier: { id: '02007472' } },
        tenderPeriod: { endDate: '2026-05-16T08:00:00+03:00' },
        items: [{ classification: { id: '72250000-2', scheme: 'ДК021' } }],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].tender_id, 'UA-2026-05-08-005338-a');
  assert.deepEqual(state.seenStore.value['02007472'], ['UA-2026-05-08-005338-a']);
  assert.equal(result.discoveredNames['02007472'], 'КНП «Охтирська ЦРЛ»');
});

test('checkWatchedEntities: backfill dedupes via seen (already-alerted tender NOT realerted)', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: true }],
    loadSeen: async () => ({ '11111111': ['UA-OLD'] }),
    fetchDescendingFeed: async () => ({
      items: [
        { tenderID: 'UA-OLD', procuringEntity: { identifier: { id: '11111111' } } },
      ],
      next: null,
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});

test('checkWatchedEntities: backfill respects page cap (10 pages of descending feed)', async () => {
  let calls = 0;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: true }],
    fetchDescendingFeed: async () => {
      calls++;
      return {
        items: [{ tenderID: `UA-${calls}`, procuringEntity: { identifier: { id: '99999999' } } }],
        next: '/path',
      };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(calls, 10);
});

test('checkWatchedEntities: backfill feed error → recorded but does not block forward results', async () => {
  const { deps, state } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: true }],
    fetchChangesFeed: async () => ({ items: [], nextOffset: 'forward-cp' }),
    fetchDescendingFeed: async () => { throw new Error('Prozorro feed 503'); },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'backfill');
  assert.equal(result.errors[0].edrpou, '11111111');
  // forward cursor still saved despite backfill failure
  assert.equal(state.cursorStore.value.offset, 'forward-cp');
});

test('checkWatchedEntities: backfill skips when entity name is already known', async () => {
  let called = false;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: 'Real Name', enabled: true }],
    fetchDescendingFeed: async () => {
      called = true;
      return { items: [], next: null };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(called, false);
});

test('checkWatchedEntities: backfill skips disabled (unknown) entities', async () => {
  let called = false;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: false }],
    fetchDescendingFeed: async () => {
      called = true;
      return { items: [], next: null };
    },
  });
  await checkWatchedEntities(deps);
  assert.equal(called, false);
});

test('checkWatchedEntities: BFF name-resolve fills discoveredNames for unknown entity with no feed/backfill matches', async () => {
  // Real scenario: entity added long ago with name="(unknown)", neither forward
  // feed nor backfill descending walk yields any tender (rare publisher). BFF
  // text-search should still resolve the legalName from historical Prozorro data.
  let searchedEdrpou = null;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '02071091', name: '(unknown)', enabled: true }],
    searchTenderByEdrpou: async (edrpou) => {
      searchedEdrpou = edrpou;
      return { name: 'Одеський національний університет імені І. І. Мечникова' };
    },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(searchedEdrpou, '02071091');
  assert.equal(result.discoveredNames['02071091'], 'Одеський національний університет імені І. І. Мечникова');
});

test('checkWatchedEntities: BFF name-resolve NOT called when entity name is already known', async () => {
  let called = false;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: 'Реальна назва', enabled: true }],
    searchTenderByEdrpou: async () => { called = true; return { name: 'Other' }; },
  });
  await checkWatchedEntities(deps);
  assert.equal(called, false);
});

test('checkWatchedEntities: BFF name-resolve NOT called when backfill already discovered the name', async () => {
  // If backfill descending walk found an active.tendering tender in step 2,
  // discoveredNames[edrpou] is already set — don't waste a BFF call.
  let searchCalled = false;
  let descPage = 0;
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '02007472', name: '(unknown)', enabled: true }],
    fetchDescendingFeed: async () => {
      if (descPage++ === 0) {
        return {
          items: [{ tenderID: 'UA-X', procuringEntity: { identifier: { id: '02007472' } } }],
          next: null,
        };
      }
      return { items: [], next: null };
    },
    fetchTender: async (id) => ({
      data: {
        tenderID: id,
        title: 't', status: 'active.tendering',
        procuringEntity: { name: 'Backfill resolved name', identifier: { id: '02007472' } },
        items: [],
      },
    }),
    searchTenderByEdrpou: async () => { searchCalled = true; return { name: 'BFF name' }; },
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(searchCalled, false);
  assert.equal(result.discoveredNames['02007472'], 'Backfill resolved name');
});

test('checkWatchedEntities: BFF name-resolve returning null leaves entity unknown (graceful)', async () => {
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: true }],
    searchTenderByEdrpou: async () => ({ name: null }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.discoveredNames?.['11111111'], undefined);
});

test('checkWatchedEntities: BFF name-resolve skipped when dep not provided', async () => {
  // Avoids breaking existing callers that don't wire searchTenderByEdrpou.
  // Use undefined explicitly because baseDeps always includes the stub.
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', name: '(unknown)', enabled: true }],
    searchTenderByEdrpou: undefined,
  });
  // Should complete without error.
  const result = await checkWatchedEntities(deps);
  assert.equal(result.discoveredNames?.['11111111'], undefined);
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

// ─── CPV filter (TerraLab business: only 48xx software / 72xx IT services) ───
const cpvFilterDeps = (cpvId) => baseDeps({
  watchedEntities: [{ edrpou: '11111111', enabled: true }],
  fetchChangesFeed: async () => ({
    items: [{ tenderID: 'UA-CPV', procuringEntity: { identifier: { id: '11111111' } } }],
    nextOffset: 'cp',
  }),
  fetchTender: async () => ({
    data: {
      tenderID: 'UA-CPV',
      title: 't',
      status: 'active.tendering',
      procuringEntity: { name: 'X', identifier: { id: '11111111' } },
      items: cpvId ? [{ classification: { id: cpvId, scheme: 'ДК021' } }] : [],
    },
  }),
});

test('checkWatchedEntities: CPV starts with 48 → alert generated', async () => {
  const { deps, state } = cpvFilterDeps('48000000-1');
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(state.seenStore.value['11111111'], ['UA-CPV']);
});

test('checkWatchedEntities: CPV starts with 72 → alert generated', async () => {
  const { deps, state } = cpvFilterDeps('72250000-2');
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(state.seenStore.value['11111111'], ['UA-CPV']);
});

test('checkWatchedEntities: CPV outside 48/72 (e.g. 33xxx medical) → no alert, seen NOT updated', async () => {
  const { deps, state } = cpvFilterDeps('33141000-0');
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(state.seenStore.value['11111111'], undefined);
});

test('checkWatchedEntities: tender with no classification → no alert, seen NOT updated', async () => {
  const { deps, state } = cpvFilterDeps(null);
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
  assert.equal(state.seenStore.value['11111111'], undefined);
});

test('checkWatchedEntities: per-entity cpv_prefixes overrides default — alert on 33xxx', async () => {
  // Entity has cpv_prefixes=["33"] → 33xxx (медтехніка) IS relevant for THIS entity
  // even though it's outside the global 48/72 default.
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true, cpv_prefixes: ['33'] }],
    fetchChangesFeed: async () => ({
      items: [{ tenderID: 'UA-MED', procuringEntity: { identifier: { id: '11111111' } } }],
      nextOffset: 'cp',
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-MED',
        title: 't',
        status: 'active.tendering',
        procuringEntity: { name: 'X', identifier: { id: '11111111' } },
        items: [{ classification: { id: '33141000-0', scheme: 'ДК021' } }],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 1);
});

test('checkWatchedEntities: per-entity cpv_prefixes overrides default — global 72 NO LONGER relevant', async () => {
  // Entity has cpv_prefixes=["33"] only → 72xxx (which is in global default) is now irrelevant.
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true, cpv_prefixes: ['33'] }],
    fetchChangesFeed: async () => ({
      items: [{ tenderID: 'UA-IT', procuringEntity: { identifier: { id: '11111111' } } }],
      nextOffset: 'cp',
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-IT',
        title: 't',
        status: 'active.tendering',
        procuringEntity: { name: 'X', identifier: { id: '11111111' } },
        items: [{ classification: { id: '72250000-2', scheme: 'ДК021' } }],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 0);
});

test('checkWatchedEntities: multi-item tender with first item irrelevant + second relevant → alert', async () => {
  // Real Prozorro case: e.g. tender lists [медичне обладнання 33141, ЛІС-послуга 72250].
  // First item is 33xxx — would fail single-item check. Filter must scan ALL items.
  const { deps } = baseDeps({
    watchedEntities: [{ edrpou: '11111111', enabled: true }],
    fetchChangesFeed: async () => ({
      items: [{ tenderID: 'UA-MULTI', procuringEntity: { identifier: { id: '11111111' } } }],
      nextOffset: 'cp',
    }),
    fetchTender: async () => ({
      data: {
        tenderID: 'UA-MULTI',
        title: 't',
        status: 'active.tendering',
        procuringEntity: { name: 'X', identifier: { id: '11111111' } },
        items: [
          { classification: { id: '33141000-0', scheme: 'ДК021' } }, // irrelevant — медтехніка
          { classification: { id: '72250000-2', scheme: 'ДК021' } }, // relevant — ЛІС-послуга
        ],
      },
    }),
  });
  const result = await checkWatchedEntities(deps);
  assert.equal(result.alerts.length, 1);
});
