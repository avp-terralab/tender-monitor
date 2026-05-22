# Night digest (quiet hours 00–06 → 09:00 flush) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buffer all tender-event broadcasts that fall inside 00:00–05:59 Kyiv into `_state/_pending_digest.json` and release them as a single broadcast at the existing 09:00 heartbeat slot.

**Architecture:** Two pure helpers (`isQuietHour`, `mergePending`) drive the logic; storage is a new `_state/_pending_digest.json` accessed via three `runOnce` deps (`load/save/clearPendingDigest`); `monitor.mjs#runOnce` gets a quiet-hour branch (buffer instead of send) and a heartbeat-slot pre-flush (broadcast and clear before falling back to the existing admin heartbeat).

**Tech Stack:** Node.js ESM (`.mjs`), built-in `node:test`, no external deps. Telegram delivery via existing `broadcastDigest` / `sendDigest`. State on disk JSON.

**Reference spec:** `docs/superpowers/specs/2026-05-21-night-digest-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `monitor.mjs` | modify | Add `isQuietHour`, `mergePending`, `emptyPending` (exported). Re-wire `runOnce` with quiet-hour branch + pre-heartbeat flush. |
| `telegram.mjs` | modify | Add `formatNightDigest(runIso, pending)`. Reuses existing `formatDigest`. |
| `ci.mjs` | modify | Wire 3 new deps: `loadPendingDigest`, `savePendingDigest`, `clearPendingDigest` (file at `_state/_pending_digest.json`). |
| `main.mjs` | modify | Same 3 deps under `.local-state/_state/_pending_digest.json` (local parity). |
| `test/monitor.test.mjs` | modify | Tests for `isQuietHour`, `mergePending`, and 6 `runOnce` integration scenarios. |
| `test/telegram.test.mjs` | modify | Tests for `formatNightDigest`. |

No new files. All exports go on existing modules to keep imports terse.

---

### Task 1: `isQuietHour` helper

**Files:**
- Modify: `monitor.mjs` (add export next to `isHeartbeatHour` around line 14–21)
- Modify: `test/monitor.test.mjs` (append at end of file)

- [ ] **Step 1: Write failing tests**

Append to `test/monitor.test.mjs`:

```js
import { isQuietHour } from '../monitor.mjs';

test('isQuietHour: true at 02:00 Kyiv (EEST/summer)', () => {
  // 02:00 Kyiv summer = 23:00 UTC previous day
  assert.equal(isQuietHour('2026-05-21T23:00:00Z'), true);
});

test('isQuietHour: true at 05:59 Kyiv (EEST)', () => {
  assert.equal(isQuietHour('2026-05-22T02:59:00Z'), true);
});

test('isQuietHour: false at 06:00 Kyiv (EEST)', () => {
  assert.equal(isQuietHour('2026-05-22T03:00:00Z'), false);
});

test('isQuietHour: false at 23:59 Kyiv', () => {
  assert.equal(isQuietHour('2026-05-21T20:59:00Z'), false);
});

test('isQuietHour: true at 00:00 Kyiv (boundary, EET/winter)', () => {
  // 00:00 Kyiv winter (EET=+02) = 22:00 UTC previous day
  assert.equal(isQuietHour('2026-01-14T22:00:00Z'), true);
});

test('isQuietHour: false at 15:00 Kyiv', () => {
  assert.equal(isQuietHour('2026-05-22T12:00:00Z'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/monitor.test.mjs 2>&1 | grep -E "isQuietHour|fail"`
Expected: 6 failures with `SyntaxError: The requested module './monitor.mjs' does not provide an export named 'isQuietHour'`.

- [ ] **Step 3: Add `isQuietHour` to `monitor.mjs`**

Insert immediately after the existing `isHeartbeatHour` (after current line 21, before `function kyivDate`):

```js
export function isQuietHour(runIso) {
  const hour = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(runIso));
  const h = parseInt(hour, 10);
  return h >= 0 && h < 6;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/monitor.test.mjs 2>&1 | tail -10`
Expected: `pass` count increased by 6, no `fail`.

- [ ] **Step 5: Commit**

```bash
git add monitor.mjs test/monitor.test.mjs
git commit -m "monitor: add isQuietHour helper (00:00–05:59 Kyiv)"
```

---

### Task 2: `mergePending` + `emptyPending`

**Files:**
- Modify: `monitor.mjs` (add exports below `isQuietHour`)
- Modify: `test/monitor.test.mjs` (append)

- [ ] **Step 1: Write failing tests**

Append to `test/monitor.test.mjs`:

```js
import { mergePending, emptyPending } from '../monitor.mjs';

test('emptyPending: returns shape with empty items/archived/errors', () => {
  const p = emptyPending();
  assert.deepEqual(p, { items: {}, archived: [], errors: [] });
});

test('mergePending: adds new group with first_fired_at and last_fired_at', () => {
  const before = emptyPending();
  const group = {
    tender_id: 'UA-2026-05-22-000001-a',
    title: 'X', status: 'active.tendering', deadline: null,
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-05-22-000001-a',
    events: [{ type: 'td_amended', title: 'Doc' }],
  };
  const after = mergePending(before, { groups: [group], runIso: '2026-05-22T02:14:00Z' });
  const item = after.items['UA-2026-05-22-000001-a'];
  assert.ok(item, 'item present');
  assert.equal(item.first_fired_at, '2026-05-22T02:14:00Z');
  assert.equal(item.last_fired_at, '2026-05-22T02:14:00Z');
  assert.deepEqual(item.events, [{ type: 'td_amended', title: 'Doc' }]);
});

test('mergePending: merges events for repeated tender_id, keeps first_fired_at, updates last_fired_at', () => {
  const before = mergePending(emptyPending(), {
    groups: [{
      tender_id: 'UA-X', title: 'X', events: [{ type: 'td_amended' }],
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    }],
    runIso: '2026-05-22T02:14:00Z',
  });
  const after = mergePending(before, {
    groups: [{
      tender_id: 'UA-X', title: 'X (renamed)', events: [{ type: 'new_question', title: 'Q' }],
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    }],
    runIso: '2026-05-22T04:30:00Z',
  });
  const item = after.items['UA-X'];
  assert.equal(item.first_fired_at, '2026-05-22T02:14:00Z');
  assert.equal(item.last_fired_at, '2026-05-22T04:30:00Z');
  assert.equal(item.title, 'X (renamed)'); // refreshed
  assert.deepEqual(item.events.map(e => e.type), ['td_amended', 'new_question']);
});

test('mergePending: appends archived + errors with fired_at', () => {
  const before = emptyPending();
  const after = mergePending(before, {
    archived: [{ tender_id: 'UA-A', status: 'complete' }],
    errors: [{ tender_id: 'UA-B', error: '500', is_invalid: false }],
    runIso: '2026-05-22T03:00:00Z',
  });
  assert.deepEqual(after.archived, [
    { tender_id: 'UA-A', status: 'complete', fired_at: '2026-05-22T03:00:00Z' },
  ]);
  assert.deepEqual(after.errors, [
    { tender_id: 'UA-B', error: '500', is_invalid: false, fired_at: '2026-05-22T03:00:00Z' },
  ]);
});

test('mergePending: does not mutate input', () => {
  const before = emptyPending();
  const snapshot = JSON.stringify(before);
  mergePending(before, {
    groups: [{ tender_id: 'UA-X', events: [{ type: 'td_amended' }] }],
    runIso: '2026-05-22T03:00:00Z',
  });
  assert.equal(JSON.stringify(before), snapshot);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/monitor.test.mjs 2>&1 | grep -E "mergePending|emptyPending|fail"`
Expected: 5 failures (export not found).

- [ ] **Step 3: Implement in `monitor.mjs`**

Add immediately after `isQuietHour`:

```js
export function emptyPending() {
  return { items: {}, archived: [], errors: [] };
}

export function mergePending(pending, { groups = [], archived = [], errors = [], runIso }) {
  const next = {
    items: { ...pending.items },
    archived: [...pending.archived, ...archived.map(a => ({ ...a, fired_at: runIso }))],
    errors: [...pending.errors, ...errors.map(e => ({ ...e, fired_at: runIso }))],
  };
  for (const g of groups) {
    const existing = next.items[g.tender_id];
    if (existing) {
      next.items[g.tender_id] = {
        ...existing,
        ...g,
        events: [...existing.events, ...g.events],
        first_fired_at: existing.first_fired_at,
        last_fired_at: runIso,
      };
    } else {
      next.items[g.tender_id] = {
        ...g,
        first_fired_at: runIso,
        last_fired_at: runIso,
      };
    }
  }
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/monitor.test.mjs 2>&1 | tail -10`
Expected: 5 new passes, total `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add monitor.mjs test/monitor.test.mjs
git commit -m "monitor: add mergePending + emptyPending (pure)"
```

---

### Task 3: `formatNightDigest`

**Files:**
- Modify: `telegram.mjs` (add export after `formatHeartbeat`, around line 301)
- Modify: `test/telegram.test.mjs` (append after existing `formatDigest` tests)

- [ ] **Step 1: Write failing tests**

Append to `test/telegram.test.mjs`:

```js
import { formatNightDigest } from '../telegram.mjs';

test('formatNightDigest: header + delegates items to formatDigest', () => {
  const pending = {
    items: {
      'UA-X': {
        tender_id: 'UA-X', title: 'Лабораторні реактиви', status: 'active.tendering',
        deadline: '2026-05-23T17:00:00+03:00',
        prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
        events: [{ type: 'td_amended', title: 'Доповнення №1' }],
      },
    },
    archived: [],
    errors: [],
  };
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /🌙 Нічний дайджест/);
  assert.match(text, /Лабораторні реактиви/);
  assert.match(text, /Виправлення\/новий документ ТД/);
});

test('formatNightDigest: appends archived block when present', () => {
  const pending = {
    items: {},
    archived: [{ tender_id: 'UA-A', status: 'complete', fired_at: '2026-05-22T02:00:00Z' }],
    errors: [],
  };
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /📦 Архівовано \(вночі\)/);
  assert.match(text, /UA-A — complete/);
});

test('formatNightDigest: appends errors block when present', () => {
  const pending = {
    items: {},
    archived: [],
    errors: [{ tender_id: 'UA-B', error: 'fetch 500', is_invalid: false, fired_at: '2026-05-22T03:00:00Z' }],
  };
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /⚠️ не вдалось перевірити \(вночі\)/);
  assert.match(text, /UA-B — fetch 500/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/telegram.test.mjs 2>&1 | grep -E "formatNightDigest|fail"`
Expected: 3 failures (export not found).

- [ ] **Step 3: Implement in `telegram.mjs`**

Add after `formatHeartbeat` (after the function block ending around line 320, before any other export):

```js
export function formatNightDigest(runIso, pending) {
  const groups = Object.values(pending.items ?? {});
  let text = '🌙 Нічний дайджест';
  if (groups.length > 0) {
    text += '\n\n' + formatDigest(runIso, groups);
  }
  if ((pending.errors ?? []).length > 0) {
    text += '\n\n⚠️ не вдалось перевірити (вночі):\n' +
      pending.errors.map(e => `  • ${e.tender_id} — ${e.error}`).join('\n');
  }
  if ((pending.archived ?? []).length > 0) {
    text += '\n\n📦 Архівовано (вночі):\n' +
      pending.archived.map(a => `  • ${a.tender_id} — ${a.status}`).join('\n');
  }
  return text;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/telegram.test.mjs 2>&1 | tail -10`
Expected: 3 new passes, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add telegram.mjs test/telegram.test.mjs
git commit -m "telegram: add formatNightDigest"
```

---

### Task 4: Storage deps in `ci.mjs` and `main.mjs`

**Files:**
- Modify: `ci.mjs` (declare `pendingDigestPath` constant alongside `heartbeatStatePath`; add 3 deps inside `runOnce(...)` call)
- Modify: `main.mjs` (parallel additions under `.local-state/_state/`)

No new tests in this task — the file-system deps are validated indirectly by Task 5 (runOnce integration tests use in-memory mocks, but the prod deps are 3-liners with no logic worth unit-testing).

- [ ] **Step 1: Modify `ci.mjs` — add constant and deps**

After current line 60 (`const heartbeatStatePath = join(stateDir, '_heartbeat.json');`) add:

```js
const pendingDigestPath = join(stateDir, '_pending_digest.json');
```

Then inside the `runOnce({...})` call (after `saveHeartbeatDate`, around line 95), add:

```js
  loadPendingDigest: async () => {
    if (!existsSync(pendingDigestPath)) return null;
    try {
      return JSON.parse(readFileSync(pendingDigestPath, 'utf-8'));
    } catch {
      return null;
    }
  },
  savePendingDigest: async (obj) => {
    writeFileSync(pendingDigestPath, JSON.stringify(obj, null, 2));
  },
  clearPendingDigest: async () => {
    if (existsSync(pendingDigestPath)) unlinkSync(pendingDigestPath);
  },
```

Note: `unlinkSync` is already imported (line 5 of current `ci.mjs`).

- [ ] **Step 2: Modify `main.mjs` — add same deps for local parity**

After the existing `mkdirSync(join(ROOT, '_state'), { recursive: true });` (line 10), add:

```js
const pendingDigestPath = join(ROOT, '_state', '_pending_digest.json');
```

Then inside the `runOnce({...})` call (after `updateSheet`, before `disableTender`), add:

```js
  loadPendingDigest: async () => {
    if (!existsSync(pendingDigestPath)) return null;
    try {
      return JSON.parse(readFileSync(pendingDigestPath, 'utf-8'));
    } catch {
      return null;
    }
  },
  savePendingDigest: async (obj) => {
    writeFileSync(pendingDigestPath, JSON.stringify(obj, null, 2));
  },
  clearPendingDigest: async () => {
    // import unlinkSync at top — see step 3
    unlinkSync(pendingDigestPath);
  },
```

- [ ] **Step 3: Update `main.mjs` import line to add `unlinkSync`**

Change line 4 of `main.mjs` from:

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
```

to:

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
```

And guard the `unlinkSync` call in `clearPendingDigest` so it doesn't throw when file is absent:

```js
  clearPendingDigest: async () => {
    if (existsSync(pendingDigestPath)) unlinkSync(pendingDigestPath);
  },
```

- [ ] **Step 4: Run full test suite to verify nothing broke**

Run: `node --test test/*.mjs 2>&1 | tail -8`
Expected: `fail 0` (existing tests unaffected; new deps are not yet called).

- [ ] **Step 5: Commit**

```bash
git add ci.mjs main.mjs
git commit -m "ci/main: wire loadPendingDigest/save/clear deps"
```

---

### Task 5: Wire quiet-hour buffering + flush into `runOnce`

This is the integration. Six new tests plus the body change. Done in two sub-steps: (a) tests first (all fail), (b) implement.

**Files:**
- Modify: `monitor.mjs` (rewrite the heartbeat/digest section at current lines 157–234)
- Modify: `test/monitor.test.mjs` (append 6 tests)

- [ ] **Step 1: Write failing tests**

Append to `test/monitor.test.mjs`. Reuse existing helpers `baseSnap`, `T_X` where present (see existing block at line 270+).

```js
test('runOnce: quiet hour with events → buffer NOT send', async () => {
  const deadline = '2026-05-22T17:00:00+03:00';
  const prev = baseSnap({ tenderPeriod: { endDate: deadline } });
  const curr = { ...baseSnap({ tenderPeriod: { endDate: deadline } }), questions: [{ id: 'q1', title: 'Q?' }] };
  const sent = [], saved = [], savedState = [];
  let pending = null;
  await runOnce({
    runIso: '2026-05-22T01:00:00Z', // 04:00 Kyiv (EEST) — quiet
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: curr }),
    extractSnapshot: (r) => r.data,
    loadState: async () => prev,
    saveState: async (id, s) => savedState.push([id, s]),
    sendDigest: async (text) => sent.push(text),
    updateSheet: async () => {},
    loadPendingDigest: async () => pending,
    savePendingDigest: async (p) => { pending = p; saved.push(p); },
    clearPendingDigest: async () => { pending = null; },
  });
  assert.equal(sent.length, 0, 'no broadcast in quiet hour');
  assert.equal(saved.length, 1, 'pending saved once');
  assert.ok(saved[0].items[T_X], 'tender buffered');
  assert.equal(savedState.length, 1, 'state still saved (dedup)');
});

test('runOnce: quiet hour without events → no buffer, no send', async () => {
  const deadline = '2026-05-22T17:00:00+03:00';
  const snap = baseSnap({ tenderPeriod: { endDate: deadline } });
  const sent = [], saved = [];
  await runOnce({
    runIso: '2026-05-22T01:00:00Z',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap, // identical → no events
    saveState: async () => {},
    sendDigest: async (text) => sent.push(text),
    updateSheet: async () => {},
    loadPendingDigest: async () => null,
    savePendingDigest: async (p) => saved.push(p),
    clearPendingDigest: async () => {},
  });
  assert.equal(sent.length, 0);
  assert.equal(saved.length, 0);
});

test('runOnce: 09:00 with non-empty buffer → flush broadcast + clear, no admin heartbeat', async () => {
  const snap = baseSnap({ tenderPeriod: { endDate: '2026-05-22T17:00:00+03:00' } });
  const stored = {
    items: {
      [T_X]: {
        tender_id: T_X, title: 'X', status: 'active.tendering',
        deadline: '2026-05-22T17:00:00+03:00',
        prozorro_url: `https://prozorro.gov.ua/tender/${T_X}`,
        events: [{ type: 'td_amended', title: 'Doc' }],
        first_fired_at: '2026-05-22T02:00:00Z',
        last_fired_at: '2026-05-22T02:00:00Z',
      },
    },
    archived: [],
    errors: [],
  };
  const sent = [], hbSent = [];
  let cleared = false;
  await runOnce({
    runIso: '2026-05-22T06:00:00Z', // 09:00 Kyiv (EEST)
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap, // identical → no current events
    saveState: async () => {},
    sendDigest: async (text) => sent.push(text),
    sendHeartbeat: async (text) => hbSent.push(text),
    updateSheet: async () => {},
    loadPendingDigest: async () => stored,
    savePendingDigest: async () => {},
    clearPendingDigest: async () => { cleared = true; },
    loadHeartbeatDate: async () => null,
    saveHeartbeatDate: async () => {},
  });
  assert.equal(sent.length, 1, 'night digest broadcast');
  assert.match(sent[0], /🌙 Нічний дайджест/);
  assert.equal(cleared, true, 'pending cleared');
  assert.equal(hbSent.length, 0, 'admin heartbeat suppressed');
});

test('runOnce: 09:00 with empty buffer and no events → admin heartbeat as before', async () => {
  const snap = baseSnap({ tenderPeriod: { endDate: '2026-05-22T17:00:00+03:00' } });
  const sent = [], hbSent = [];
  await runOnce({
    runIso: '2026-05-22T06:00:00Z',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap,
    saveState: async () => {},
    sendDigest: async (text) => sent.push(text),
    sendHeartbeat: async (text) => hbSent.push(text),
    updateSheet: async () => {},
    loadPendingDigest: async () => null,
    savePendingDigest: async () => {},
    clearPendingDigest: async () => {},
    loadHeartbeatDate: async () => null,
    saveHeartbeatDate: async () => {},
  });
  assert.equal(sent.length, 0);
  assert.equal(hbSent.length, 1, 'admin heartbeat fired');
});

test('runOnce: 09:00 with buffer AND new events → two sends (night digest + current digest)', async () => {
  const deadline = '2026-05-22T17:00:00+03:00';
  const prev = baseSnap({ tenderPeriod: { endDate: deadline } });
  const curr = { ...baseSnap({ tenderPeriod: { endDate: deadline } }), questions: [{ id: 'qN', title: 'New?' }] };
  const stored = {
    items: {
      'UA-OLD-XXXXX-X-x': {
        tender_id: 'UA-OLD-XXXXX-X-x', title: 'Buffered', status: 'active.tendering',
        prozorro_url: 'https://prozorro.gov.ua/tender/UA-OLD-XXXXX-X-x',
        events: [{ type: 'td_amended', title: 'Doc' }],
        first_fired_at: '2026-05-22T02:00:00Z',
        last_fired_at: '2026-05-22T02:00:00Z',
      },
    },
    archived: [],
    errors: [],
  };
  const sent = [];
  let cleared = false;
  await runOnce({
    runIso: '2026-05-22T06:00:00Z',
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: curr }),
    extractSnapshot: (r) => r.data,
    loadState: async () => prev,
    saveState: async () => {},
    sendDigest: async (text) => sent.push(text),
    sendHeartbeat: async () => {},
    updateSheet: async () => {},
    loadPendingDigest: async () => stored,
    savePendingDigest: async () => {},
    clearPendingDigest: async () => { cleared = true; },
    loadHeartbeatDate: async () => null,
    saveHeartbeatDate: async () => {},
  });
  assert.equal(sent.length, 2, 'two broadcasts: night then current');
  assert.match(sent[0], /🌙 Нічний дайджест/);
  assert.match(sent[0], /Buffered/);
  assert.match(sent[1], /Нове питання/); // current cycle
  assert.equal(cleared, true);
});

test('runOnce: 09:00 flush debounced by heartbeat date (same day → no re-flush)', async () => {
  const snap = baseSnap({ tenderPeriod: { endDate: '2026-05-22T17:00:00+03:00' } });
  const stored = {
    items: {
      [T_X]: {
        tender_id: T_X, title: 'X',
        prozorro_url: `https://prozorro.gov.ua/tender/${T_X}`,
        events: [{ type: 'td_amended', title: 'Doc' }],
        first_fired_at: '2026-05-22T02:00:00Z',
        last_fired_at: '2026-05-22T02:00:00Z',
      },
    },
    archived: [], errors: [],
  };
  const sent = [];
  let cleared = false;
  await runOnce({
    runIso: '2026-05-22T06:30:00Z', // 09:30 Kyiv, same date
    watchlist: [{ tender_id: T_X, enabled: true }],
    fetchTender: async () => ({ data: snap }),
    extractSnapshot: (r) => r.data,
    loadState: async () => snap,
    saveState: async () => {},
    sendDigest: async (text) => sent.push(text),
    sendHeartbeat: async () => {},
    updateSheet: async () => {},
    loadPendingDigest: async () => stored,
    savePendingDigest: async () => {},
    clearPendingDigest: async () => { cleared = true; },
    loadHeartbeatDate: async () => '2026-05-22', // already heartbeat'd today
    saveHeartbeatDate: async () => {},
  });
  assert.equal(sent.length, 0, 'flush debounced');
  assert.equal(cleared, false, 'buffer preserved');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/monitor.test.mjs 2>&1 | tail -15`
Expected: at minimum 6 failures from the new tests. Specifically, the "quiet hour with events → buffer NOT send" test should fail because current `runOnce` calls `sendDigest` regardless of hour.

- [ ] **Step 3: Implement `runOnce` changes**

In `monitor.mjs`, change the destructure at line 33–37 from:

```js
  const {
    runIso, watchlist, fetchTender, extractSnapshot,
    loadState, saveState, sendDigest, updateSheet,
    disableTender,
  } = deps;
```

to:

```js
  const {
    runIso, watchlist, fetchTender, extractSnapshot,
    loadState, saveState, sendDigest, updateSheet,
    disableTender,
    loadPendingDigest, savePendingDigest, clearPendingDigest,
  } = deps;
```

Replace the entire block from current line 157 down to the final `return { ... }` (currently around line 249) with this restructured version:

```js
  const inQuietWindow = isQuietHour(runIso);
  const inHeartbeatSlot = isHeartbeatHour(runIso);
  const today = kyivDate(runIso);
  const lastHeartbeatDate = inHeartbeatSlot && deps.loadHeartbeatDate
    ? await deps.loadHeartbeatDate()
    : null;
  const heartbeatDue = inHeartbeatSlot && lastHeartbeatDate !== today;

  // Phase A: flush pending night digest if heartbeat slot is due
  let nightFlushed = false;
  if (heartbeatDue && loadPendingDigest) {
    const pending = await loadPendingDigest();
    const pendingItems = pending ? Object.values(pending.items ?? {}) : [];
    const pendingHasContent = pending && (
      pendingItems.length > 0 ||
      (pending.archived ?? []).length > 0 ||
      (pending.errors ?? []).length > 0
    );
    if (pendingHasContent) {
      const morningText = formatNightDigest(runIso, pending);
      const nightButtons = pendingItems
        .filter(g => g.events?.some(e => e.type === 'new_tender_announced'))
        .map(g => g.tender_id);
      await sendDigest(
        morningText,
        nightButtons.length > 0 ? { addButtonsForTenders: nightButtons } : undefined,
      );
      if (clearPendingDigest) await clearPendingDigest();
      nightFlushed = true;
    }
  }

  // Phase B: process current-cycle events
  const isSilent = !hasContent;
  if (!isSilent || archivedNow.length > 0) {
    let text = '';
    if (!isSilent) {
      text = formatDigest(runIso, groups);
      if (errors.length > 0) {
        text += '\n\n⚠️ не вдалось перевірити:\n' +
          errors.map(e => {
            const line = e.is_invalid
              ? `  • ${e.tender_id} — не знайдено в Prozorro або невалідний формат, відключено від моніторингу`
              : `  • ${e.tender_id} — ${e.error}`;
            return line;
          }).join('\n');
      }
    }
    if (archivedNow.length > 0) {
      const block = '📦 Архівовано:\n' + archivedNow.map(a =>
        `  ${STATUS_ICONS[a.status] ?? '📦'} ${a.tender_id} — ${a.status}`
      ).join('\n');
      text = text ? `${text}\n\n${block}` : block;
    }
    const addButtonsForTenders = groups
      .filter(g => g.events?.some(e => e.type === 'new_tender_announced'))
      .map(g => g.tender_id);

    if (inQuietWindow) {
      // Buffer instead of broadcast.
      const prevPending = (loadPendingDigest ? await loadPendingDigest() : null) ?? emptyPending();
      const updated = mergePending(prevPending, {
        groups, archived: archivedNow, errors, runIso,
      });
      if (savePendingDigest) await savePendingDigest(updated);
    } else {
      await sendDigest(
        text,
        addButtonsForTenders.length > 0 ? { addButtonsForTenders } : undefined,
      );
    }

    // saveState runs in both branches — dedup must hold across buffered events too.
    const archivedIds = new Set(archivedNow.map(a => a.tender_id));
    await Promise.all(results.map(async r => {
      if (r.error || r.events.length === 0) return;
      if (archivedIds.has(r.row.tender_id)) return;
      await saveState(r.row.tender_id, r.curr);
    }));
  }

  // Phase C: admin heartbeat fallback (only if nothing else fired in the slot)
  let heartbeatSent = false;
  if (heartbeatDue && !nightFlushed && !hasContent && archivedNow.length === 0) {
    const heartbeat = formatHeartbeat(runIso, results
      .filter(r => !r.error && r.curr)
      .map(r => ({
        tender_id: r.row.tender_id,
        title: r.curr.title,
        status: r.curr.status,
        deadline: r.curr.tenderPeriod?.endDate ?? null,
      }))
    );
    if (deps.sendHeartbeat) {
      await deps.sendHeartbeat(heartbeat);
    } else {
      await sendDigest(heartbeat);
    }
    heartbeatSent = true;
  }

  // Phase D: persist heartbeat date if any 09:00-slot send actually happened
  if (heartbeatDue && (nightFlushed || heartbeatSent) && deps.saveHeartbeatDate) {
    await deps.saveHeartbeatDate(today);
  }

  // Phase E: always update sheet last_check
  await Promise.all(results.map(r =>
    updateSheet(r.row.tender_id, {
      last_check: runIso,
      last_status: r.curr?.status,
      last_dateModified: r.curr?.dateModified,
    }).catch(() => {})
  ));

  return {
    sent: nightFlushed || heartbeatSent || (!inQuietWindow && (!isSilent || archivedNow.length > 0)),
    groups: groups.length,
    errors: errors.length,
    heartbeat: heartbeatSent,
    nightFlushed,
    buffered: inQuietWindow && (!isSilent || archivedNow.length > 0),
  };
}
```

Note: this replaces both the old heartbeat early-return block (lines 157–196) and the old main send block (lines 200–234). Removing the early return is intentional — phases now compose linearly.

Also add `formatNightDigest` to the top-of-file import:

```js
import { formatDigest, formatHeartbeat, formatNightDigest } from './telegram.mjs';
```

- [ ] **Step 4: Run full test suite**

Run: `node --test test/*.mjs 2>&1 | tail -12`
Expected: `pass` count ≈ 461 + 6 + 6 + 3 + 5 = 481, `fail 0`.

If a pre-existing test about the old heartbeat early-return semantics fails (specifically: heartbeat-path tests around `test/monitor.test.mjs:328–365` already touched in earlier work), inspect the failure and either:
- (a) Update the expectation to match the new linear-phase return shape (`heartbeat`, `nightFlushed`, `buffered` keys are additive — no removed keys).
- (b) If a test relied on `groups: 0` being returned in heartbeat path, that field stays correct (`groups.length` is 0 in the no-content case).

No regressions in `compare.test.mjs` or `telegram.test.mjs` expected.

- [ ] **Step 5: Commit**

```bash
git add monitor.mjs test/monitor.test.mjs
git commit -m "monitor: quiet-hour buffering + 09:00 flush of pending digest"
```

---

### Task 6: End-to-end smoke + push

- [ ] **Step 1: Run the entire test suite one more time**

Run: `node --test test/*.mjs 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 2: Manual smoke — fake quiet-hour `ci.mjs` run with empty watchlist**

Create a tiny scratch test to verify the prod deps wire up correctly without sending Telegram. Run:

```bash
node -e "
const { runOnce } = await import('./monitor.mjs');
const { readFileSync, writeFileSync, existsSync, unlinkSync } = await import('node:fs');
const stateDir = './_state';
const pendingDigestPath = stateDir + '/_pending_digest.json';
if (existsSync(pendingDigestPath)) unlinkSync(pendingDigestPath);
const result = await runOnce({
  runIso: '2026-05-22T01:00:00Z',
  watchlist: [],
  fetchTender: async () => ({ data: {} }),
  extractSnapshot: (r) => r.data,
  loadState: async () => null,
  saveState: async () => {},
  sendDigest: async (t) => console.log('SEND:', t.slice(0,80)),
  updateSheet: async () => {},
  loadPendingDigest: async () => existsSync(pendingDigestPath) ? JSON.parse(readFileSync(pendingDigestPath,'utf-8')) : null,
  savePendingDigest: async (o) => writeFileSync(pendingDigestPath, JSON.stringify(o,null,2)),
  clearPendingDigest: async () => existsSync(pendingDigestPath) && unlinkSync(pendingDigestPath),
});
console.log(JSON.stringify(result));
if (existsSync(pendingDigestPath)) unlinkSync(pendingDigestPath);
"
```

Expected: no `SEND:` output, result printed with `sent: false, groups: 0`.

If the result is anything else, debug before pushing.

- [ ] **Step 3: Rebase on origin/main and push**

```bash
git fetch origin
git pull --rebase origin main
git push origin main
```

If rebase shows conflicts in `_state/*.json` (bot auto-updates), accept theirs for those files and keep our `monitor.mjs`/`telegram.mjs`/`ci.mjs`/`main.mjs`/test edits:

```bash
git checkout --theirs _state/UA-*.json _state/_watched_feed_cursor.json _state/_watched_seen.json
git add _state/
git rebase --continue
```

Then `git push origin main`.

- [ ] **Step 4: Verify deploy + next cron**

Watch `https://github.com/avp-terralab/tender-monitor/actions` for the next `tender-monitor` run to complete with our SHA. No code-change deploy via `deploy-worker` is needed (worker is untouched).

- [ ] **Step 5: Optional — first real night test**

In the next 00:00–06:00 Kyiv window with any incoming event, verify `_state/_pending_digest.json` appears in a bot state commit on the repo. At ≥ 09:00 Kyiv next day, verify the night digest message lands in Telegram.

No commit on this step — observation only.

---

## Self-Review Notes

- All spec sections covered: quiet-hour detector (Task 1), merge rules (Task 2), recipients (Task 5 — `sendDigest` is the broadcast path), morning format (Task 3), storage shape (Tasks 2 + 4), `runOnce` integration (Task 5), tests for every spec test case (Task 5).
- The merge spec says items keyed by `tender_id`; `mergePending` uses `next.items[g.tender_id]` accordingly.
- Spec test "graceful 09:00 with buffer + new events" → Task 5 test "two sends".
- Spec test "heartbeat-debounce flush exactly once" → Task 5 test "flush debounced".
- The `nightFlushed` flag bypasses both the admin heartbeat and the heartbeat-date save in the original code; new logic saves heartbeat date when either night flush or admin heartbeat fired. This intentionally widens the original behavior (which only saved on admin heartbeat).
- `archived` and `errors` shapes in `formatNightDigest` reuse the same patterns as `runOnce` digest block (icons, prefixes adapted to night context). No new patterns invented.
- Filename for the pending digest is `_pending_digest.json` (underscore prefix matches `_heartbeat.json`, `_watched_seen.json` convention).
