import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../monitor.mjs';

// Use valid tender_id format throughout (UA-YYYY-MM-DD-NNNNNN-x)
const T_X      = 'UA-2026-05-01-000001-a';
const T_OK     = 'UA-2026-05-01-000002-a';
const T_BAD    = 'UA-2026-05-01-000003-a';
const T_STABLE = 'UA-2026-05-01-000004-a';
const T_CHANGE = 'UA-2026-05-01-000005-a';

const baseSnap = (overrides = {}) => ({
  tender_id: T_X,
  title: 'X',
  status: 'active.tendering',
  dateModified: '2026-05-01',
  tenderPeriod: { endDate: '2026-05-15' },
  auctionPeriod: null,
  documents: [],
  questions: [],
  complaints: [],
  awards: [],
  contracts: [],
  cancellations: [],
  ...overrides,
});

test('runOnce: silent when nothing changed', async () => {
  const snap = baseSnap();
  const sent = [];
  const saved = [];
  const result = await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap,
    saveState: async (id, s) => { saved.push([id, s]); },
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(result.sent, false);
});

test('runOnce: sends digest on monitoring_started', async () => {
  const snap = baseSnap();
  const sent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Статус:/);
});

test('runOnce: skips disabled rows', async () => {
  const sent = [];
  let fetched = 0;
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: T_X, enabled: false }],
    fetchTender: async () => { fetched++; return { data: baseSnap() }; },
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (t) => sent.push(t),
    updateSheet: async () => {},
  });
  assert.equal(fetched, 0);
  assert.equal(sent.length, 0);
});

test('runOnce: continues on per-tender error and reports it', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [
      { tender_id: T_OK, enabled: true },
      { tender_id: T_BAD, enabled: true },
    ],
    fetchTender: async (id) => {
      if (id === T_BAD) throw new Error('500');
      return { data: baseSnap({ tender_id: T_OK }) };
    },
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (t) => sent.push(t),
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(T_OK));
  assert.match(sent[0], new RegExp(T_BAD));
  assert.match(sent[0], /не вдалось перевірити/);
});

test('runOnce: saves state only for tenders with events', async () => {
  const snapStable = baseSnap({ tender_id: T_STABLE });
  const snapChange = baseSnap({ tender_id: T_CHANGE });
  const saved = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [
      { tender_id: T_STABLE, enabled: true },
      { tender_id: T_CHANGE, enabled: true },
    ],
    fetchTender: async (id) => ({ data: id === T_STABLE ? snapStable : snapChange }),
    extractSnapshot: (r) => r.data,
    loadState: async (id) => id === T_STABLE ? snapStable : null, // CHANGE has no prev
    saveState: async (id, s) => saved.push(id),
    sendDigest: async () => {},
    updateSheet: async () => {},
  });
  // STABLE: no events, no state save. CHANGE: monitoring_started, state saved.
  assert.deepEqual(saved.sort(), [T_CHANGE]);
});

test('runOnce: does not save state if sendDigest throws', async () => {
  const saved = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: baseSnap() }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null, // → monitoring_started
    saveState: async (id, s) => saved.push(id),
    sendDigest: async () => { throw new Error('Telegram down'); },
    updateSheet: async () => {},
  }).catch(err => { assert.match(err.message, /Telegram/); });
  assert.equal(saved.length, 0, 'state must not be saved if Telegram failed');
});

test('runOnce: updateSheet always called for all enabled, even on silent run', async () => {
  const sheetUpdates = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: baseSnap() }),
    extractSnapshot: (r) => r.data,
    loadState: async () => baseSnap(), // identical → no events
    saveState: async () => {},
    sendDigest: async () => {},
    updateSheet: async (id, fields) => sheetUpdates.push({ id, fields }),
  });
  assert.equal(sheetUpdates.length, 1);
  assert.equal(sheetUpdates[0].id, T_X);
  assert.equal(sheetUpdates[0].fields.last_check, '2026-05-08T13:00:00+03:00');
});

// ─── Change 7: validate tender_id format ──────────────────────────────────────
test('runOnce: invalid tender_id format → error in digest, fetchTender NOT called', async () => {
  const sent = [];
  let fetchCount = 0;
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: 'INVALID-ID', enabled: true }],
    fetchTender: async () => { fetchCount++; return { data: baseSnap() }; },
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
  });
  assert.equal(fetchCount, 0, 'fetchTender must not be called for invalid tender_id');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /невалідний формат|відключено/);
});

// ─── Change 8: auto-disable on 404 ───────────────────────────────────────────
test('runOnce: 404 error → disableTender called with tender_id and reason', async () => {
  const disabled = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: 'UA-2026-01-01-000001-a', enabled: true }],
    fetchTender: async () => { throw new Error('Prozorro summary 404: UA-2026-01-01-000001-a'); },
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async () => {},
    updateSheet: async () => {},
    disableTender: async (id, reason) => { disabled.push({ id, reason }); },
  });
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].id, 'UA-2026-01-01-000001-a');
  assert.match(disabled[0].reason, /404/);
});

test('runOnce: generic 500 error → disableTender NOT called', async () => {
  const disabled = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: 'UA-2026-01-01-000001-a', enabled: true }],
    fetchTender: async () => { throw new Error('500 Internal Server Error'); },
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async () => {},
    updateSheet: async () => {},
    disableTender: async (id, reason) => { disabled.push({ id, reason }); },
  });
  assert.equal(disabled.length, 0, 'disableTender must not be called for non-404 errors');
});

// ─── Change C: heartbeat ──────────────────────────────────────────────────────
test('runOnce: heartbeat hour with no events sends heartbeat message', async () => {
  // 09:00 Kyiv = 06:00 UTC in summer (EEST = UTC+3); use a UTC time that maps to 09 Kyiv
  const sent = [];
  await runOnce({
    runIso: '2026-05-08T06:00:00.000Z', // → 09:00 EEST (Kyiv summer)
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: baseSnap() }),
    extractSnapshot: (r) => r.data,
    loadState: async () => baseSnap(), // identical → no events
    saveState: async () => {},
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Heartbeat/);
  assert.match(sent[0], /Моніторю 1 тендер/);
});

test('runOnce: non-heartbeat hour with no events stays silent', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-08T10:00:00.000Z', // → 13:00 EEST (NOT heartbeat hour)
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: baseSnap() }),
    extractSnapshot: (r) => r.data,
    loadState: async () => baseSnap(),
    saveState: async () => {},
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 0);
});

test('runOnce: appends entity-watch alerts to digest groups', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [],
    fetchTender: async () => ({ data: {} }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
    checkWatchedEntities: async () => ({
      alerts: [{
        tender_id: 'UA-NEW',
        title: 'Test',
        prozorro_url: 'https://prozorro.gov.ua/tender/UA-NEW',
        procuring_entity: { name: 'КНП Тест', edrpou: '12345678' },
        events: [{ type: 'new_tender_announced' }],
      }],
      errors: [],
    }),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /🆕 Нове оголошення замовника/);
  assert.match(sent[0], /UA-NEW/);
});

test('runOnce: works when checkWatchedEntities not provided (backward compat)', async () => {
  const result = await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [],
    fetchTender: async () => ({ data: {} }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async () => {},
    updateSheet: async () => {},
  });
  assert.equal(result.sent, false);
});

test('runOnce: deadline_approaching → snapshot saved with merged _notifiedDeadlines', async () => {
  // 2h before deadline → first run emits 24h+12h+3h, all merged into _notifiedDeadlines
  const deadline = '2026-05-16T14:00:00Z';
  const snap = baseSnap({ tenderPeriod: { endDate: deadline } });
  const saved = [];
  await runOnce({
    runIso: '2026-05-16T12:00:00Z',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap, // identical → only deadline_approaching events fire
    saveState: async (id, s) => saved.push(s),
    sendDigest: async () => {},
    updateSheet: async () => {},
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]._notifiedDeadlines.sort(), ['12h', '24h', '3h']);
});

test('runOnce: deadline_approaching merges with prior _notifiedDeadlines (no dupes)', async () => {
  // prev already has 24h notified; now 2h left, only 12h+3h should newly fire
  const deadline = '2026-05-16T14:00:00Z';
  const prev = { ...baseSnap({ tenderPeriod: { endDate: deadline } }), _notifiedDeadlines: ['24h'] };
  const curr = { ...baseSnap({ tenderPeriod: { endDate: deadline } }) };
  const saved = [];
  await runOnce({
    runIso: '2026-05-16T12:00:00Z',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: curr }),
    extractSnapshot: (r) => r.data,
    loadState: async () => prev,
    saveState: async (id, s) => saved.push(s),
    sendDigest: async () => {},
    updateSheet: async () => {},
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]._notifiedDeadlines.sort(), ['12h', '24h', '3h']);
});

test('runOnce: entity-watch errors propagate to digest', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [],
    fetchTender: async () => ({ data: {} }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text) => { sent.push(text); },
    updateSheet: async () => {},
    checkWatchedEntities: async () => ({
      alerts: [],
      errors: [{ source: 'feed', error: 'Prozorro 503' }],
    }),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Prozorro 503/);
});

// ─── Task 9: terminal-status archival ─────────────────────────────────────────
const T_DONE = 'UA-2026-05-01-000010-a';
const T_CANC = 'UA-2026-05-01-000011-a';

test('runOnce: calls archiveTender once per terminal-status tender', async () => {
  const snapDone = baseSnap({ tender_id: T_DONE, status: 'complete' });
  const snapCanc = baseSnap({ tender_id: T_CANC, status: 'cancelled' });
  const archived = [];
  await runOnce({
    runIso: '2026-05-12T13:00:00+03:00',
    watchlist: [
      { tender_id: T_DONE, enabled: true, notes: 'A' },
      { tender_id: T_CANC, enabled: true, notes: 'B' },
    ],
    fetchTender: async (id) => ({ data: id === T_DONE ? snapDone : snapCanc }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async () => {},
    updateSheet: async () => {},
    archiveTender: async (tid, snap) => {
      archived.push({ tid, status: snap.status });
      return true;
    },
  });
  assert.equal(archived.length, 2);
  assert.deepEqual(archived.map(a => a.tid).sort(), [T_DONE, T_CANC].sort());
});

test('runOnce: does NOT call archiveTender for active.tendering', async () => {
  const snap = baseSnap({ status: 'active.tendering' });
  const archived = [];
  await runOnce({
    runIso: '2026-05-12T13:00:00+03:00',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap,
    saveState: async () => {},
    sendDigest: async () => {},
    updateSheet: async () => {},
    archiveTender: async (tid) => { archived.push(tid); return true; },
  });
  assert.equal(archived.length, 0);
});

test('runOnce: digest contains "📦 Архівовано:" block when archived', async () => {
  const snap = baseSnap({ tender_id: T_DONE, status: 'complete' });
  let sentText = '';
  await runOnce({
    runIso: '2026-05-12T13:00:00+03:00',
    watchlist: [{ tender_id: T_DONE, enabled: true, notes: 'X' }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text) => { sentText = text; },
    updateSheet: async () => {},
    archiveTender: async () => true,
  });
  assert.match(sentText, /📦 Архівовано:/);
  assert.match(sentText, new RegExp(T_DONE));
});

test('runOnce: no archive block when archiveTender returns false', async () => {
  const snap = baseSnap({ tender_id: T_DONE, status: 'complete' });
  let sentText = '';
  await runOnce({
    runIso: '2026-05-12T13:00:00+03:00',
    watchlist: [{ tender_id: T_DONE, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text) => { sentText = text; },
    updateSheet: async () => {},
    archiveTender: async () => false, // already archived → idempotent skip
  });
  assert.doesNotMatch(sentText, /📦 Архівовано:/);
});

test('runOnce: does NOT saveState for archived tenders', async () => {
  // Regression: archiveTender unlinks the snapshot file; saveState afterwards
  // would recreate a stale snapshot for a tender that is no longer in watchlist.
  const snapDone = baseSnap({ tender_id: T_DONE, status: 'complete' });
  const snapActive = baseSnap({ tender_id: T_OK, status: 'active.tendering' });
  const savedIds = [];
  await runOnce({
    runIso: '2026-05-12T13:00:00+03:00',
    watchlist: [
      { tender_id: T_DONE, enabled: true },
      { tender_id: T_OK, enabled: true },
    ],
    fetchTender: async (id) => ({ data: id === T_DONE ? snapDone : snapActive }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null, // both produce monitoring_started event
    saveState: async (id) => { savedIds.push(id); },
    sendDigest: async () => {},
    updateSheet: async () => {},
    archiveTender: async (id) => id === T_DONE, // archived
  });
  assert.deepEqual(savedIds, [T_OK], 'saveState should run only for the non-archived tender');
});

test('runOnce: still saveState for tender when archiveTender returns false', async () => {
  // If archive was a no-op (already archived elsewhere), the snapshot is irrelevant
  // anyway because the row will be gone next cycle — but we keep this behavior
  // simple: only the in-this-cycle archived rows are skipped.
  const snap = baseSnap({ tender_id: T_DONE, status: 'complete' });
  const savedIds = [];
  await runOnce({
    runIso: '2026-05-12T13:00:00+03:00',
    watchlist: [{ tender_id: T_DONE, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async (id) => { savedIds.push(id); },
    sendDigest: async () => {},
    updateSheet: async () => {},
    archiveTender: async () => false,
  });
  assert.deepEqual(savedIds, [T_DONE]);
});

test('runOnce: passes addButtonsForTenders for entity-watch alerts (new_tender_announced)', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-14T12:00:00Z',
    watchlist: [],
    fetchTender: async () => { throw new Error('not used'); },
    extractSnapshot: () => ({}),
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text, opts) => { sent.push({ text, opts }); },
    updateSheet: async () => {},
    watchedEntities: [{ edrpou: '01998644', enabled: true }],
    checkWatchedEntities: async () => ({
      alerts: [{
        tender_id: 'UA-2026-05-14-008910-a',
        title: 'X',
        events: [{ type: 'new_tender_announced' }],
        prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-05-14-008910-a',
      }],
      errors: [],
    }),
    loadCursor: async () => null,
    saveCursor: async () => {},
    loadSeen: async () => ({}),
    saveSeen: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { addButtonsForTenders: ['UA-2026-05-14-008910-a'] });
});

test('runOnce: heartbeat path passes no addButtonsForTenders', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-14T09:00:00+03:00', // 09:00 Kyiv = isHeartbeatHour
    watchlist: [],
    fetchTender: async () => { throw new Error('skipped'); },
    extractSnapshot: () => ({}),
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text, opts) => { sent.push({ text, opts }); },
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].opts === undefined || (sent[0].opts.addButtonsForTenders ?? []).length === 0);
});
