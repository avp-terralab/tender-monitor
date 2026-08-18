# Entity-watch admin error message clarity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the admin "не вдалось перевірити" alert in `monitor.mjs` into two clearly-worded sections depending on whether the failure came from a manually-tracked watchlist tender or from an entity-watch candidate (a tender the bot discovered from a watched customer but couldn't yet fetch to check its ДК code).

**Architecture:** Tag entity-watch-sourced error records with `source: 'entity_watch'` where they're pushed into the shared `errors[]` array in `runOnce` (`monitor.mjs`). At admin-alert build time, partition `adminErrors` on that tag and render each partition under its own header/emoji, joined by a blank line when both are present.

**Tech Stack:** Node ESM, `node --test`.

Spec: `docs/superpowers/specs/2026-07-09-entity-watch-error-message-clarity-design.md`

---

### Task 1: Tag entity-watch errors and split the admin alert text

**Files:**
- Modify: `monitor.mjs:207-214` (entity-watch error push), `monitor.mjs:382-390` (admin alert text build)
- Test: `test/monitor.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add these three tests to `test/monitor.test.mjs`, right after the existing
`'runOnce: entity-watch errors go to admin only, not the public digest'` test
(around line 488):

```javascript
test('runOnce: entity-watch admin alert uses the ДК-not-checked-yet wording', async () => {
  const adminSent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [],
    fetchTender: async () => ({ data: {} }),
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async () => {},
    sendAdminAlert: async (text) => { adminSent.push(text); },
    updateSheet: async () => {},
    checkWatchedEntities: async () => ({
      alerts: [],
      errors: [{ tender_id: 'UA-2026-07-09-007845-a', error: 'Prozorro summary 404: UA-2026-07-09-007845-a' }],
    }),
  });
  assert.equal(adminSent.length, 1);
  assert.match(adminSent[0], /код ДК ще не перевірено/);
  assert.doesNotMatch(adminSent[0], /списку стеження/);
});

test('runOnce: watchlist admin alert does NOT use the entity-watch wording', async () => {
  const adminSent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [
      { tender_id: T_OK, enabled: true },
      { tender_id: T_BAD, enabled: true },
    ],
    fetchTender: async (id) => {
      if (id === T_BAD) throw new Error('500');
      return { data: baseSnap({ tender_id: T_OK, status: 'active.qualification' }) };
    },
    extractSnapshot: (r) => r.data,
    loadState: async (id) => id === T_OK ? baseSnap({ tender_id: T_OK, status: 'active.tendering' }) : null,
    saveState: async () => {},
    sendDigest: async () => {},
    sendAdminAlert: async (text) => { adminSent.push(text); },
    updateSheet: async () => {},
  });
  assert.equal(adminSent.length, 1);
  assert.match(adminSent[0], /списку стеження/);
  assert.doesNotMatch(adminSent[0], /код ДК ще не перевірено/);
});

test('runOnce: mixed watchlist + entity-watch admin errors render both sections', async () => {
  const adminSent = [];
  await runOnce({
    runIso: '2026-05-08T13:00:00+03:00',
    watchlist: [{ tender_id: T_BAD, enabled: true }],
    fetchTender: async () => { throw new Error('500'); },
    extractSnapshot: (r) => r.data,
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async () => {},
    sendAdminAlert: async (text) => { adminSent.push(text); },
    updateSheet: async () => {},
    checkWatchedEntities: async () => ({
      alerts: [],
      errors: [{ tender_id: 'UA-2026-07-09-007845-a', error: 'Prozorro summary 404: UA-2026-07-09-007845-a' }],
    }),
  });
  assert.equal(adminSent.length, 1);
  assert.match(adminSent[0], /списку стеження/);
  assert.match(adminSent[0], /код ДК ще не перевірено/);
  // Two sections separated by a blank line.
  assert.match(adminSent[0], /\n\n/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/monitor.test.mjs`
Expected: the three new tests FAIL — the current single-header text contains
neither `код ДК ще не перевірено` nor a doesNotMatch-safe split (the watchlist
test fails because current text never contains `списку стеження`; the
ДК-wording test fails because current text never contains `код ДК ще не
перевірено`).

- [ ] **Step 3: Tag entity-watch errors at the push site**

In `monitor.mjs`, find this block (around line 207-214):

```javascript
      if (watchResult.errors?.length) {
        for (const e of watchResult.errors) {
          errors.push({
            tender_id: e.tender_id ?? `[entity-watch ${e.source}]`,
            error: e.error,
            is_invalid: false,
          });
        }
      }
```

Replace it with:

```javascript
      if (watchResult.errors?.length) {
        for (const e of watchResult.errors) {
          errors.push({
            tender_id: e.tender_id ?? `[entity-watch ${e.source}]`,
            error: e.error,
            is_invalid: false,
            source: 'entity_watch',
          });
        }
      }
```

(Watchlist errors, pushed earlier around line 159-163, are left untouched —
they get no `source` field, which is how the two are told apart downstream.)

- [ ] **Step 4: Split the admin alert text by source**

In `monitor.mjs`, find this block (around line 382-390):

```javascript
  if (adminErrors.length > 0 && !inQuietWindow && deps.sendAdminAlert) {
    const adminText = '⚠️ Тимчасово не вдалось перевірити (мережа/Prozorro, повтор наступного запуску):\n' +
      adminErrors.map(e => `  • ${e.tender_id} — ${e.error}`).join('\n');
    try {
      await deps.sendAdminAlert(adminText);
    } catch (err) {
      console.error('sendAdminAlert failed:', err.message);
    }
  }
```

Replace it with:

```javascript
  if (adminErrors.length > 0 && !inQuietWindow && deps.sendAdminAlert) {
    const watchlistAdminErrors = adminErrors.filter(e => e.source !== 'entity_watch');
    const entityWatchAdminErrors = adminErrors.filter(e => e.source === 'entity_watch');
    const sections = [];
    if (watchlistAdminErrors.length > 0) {
      sections.push(
        '⚠️ Тимчасово не вдалось перевірити тендери з твого списку стеження\n' +
        '(мережа/Prozorro, повтор наступного запуску):\n' +
        watchlistAdminErrors.map(e => `  • ${e.tender_id} — ${e.error}`).join('\n')
      );
    }
    if (entityWatchAdminErrors.length > 0) {
      sections.push(
        'ℹ️ Не вдалось завантажити деталі тендера від відстежуваного замовника —\n' +
        'код ДК ще не перевірено, спробуємо ще раз наступного запуску:\n' +
        entityWatchAdminErrors.map(e => `  • ${e.tender_id} — ${e.error}`).join('\n')
      );
    }
    const adminText = sections.join('\n\n');
    try {
      await deps.sendAdminAlert(adminText);
    } catch (err) {
      console.error('sendAdminAlert failed:', err.message);
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/monitor.test.mjs`
Expected: PASS — all tests in the file, including the 3 new ones and the
pre-existing `'runOnce: continues on per-tender error and reports it'` (still
matches `/Тимчасово не вдалось перевірити/`, now inside the watchlist section)
and `'runOnce: entity-watch errors go to admin only, not the public digest'`
(still matches `/Prozorro 503/`, now inside the entity-watch section).

- [ ] **Step 6: Run the full test suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: PASS, no regressions elsewhere (no other file reads
`monitor.mjs`'s admin alert text format).

- [ ] **Step 7: Commit**

```bash
git add monitor.mjs test/monitor.test.mjs
git commit -m "fix: split admin alert text by watchlist vs entity-watch source

Entity-watch candidates fail fetch before their ДК code can be checked,
which read as a generic bot failure. Give that case its own wording."
```

---

## Self-review notes

- **Spec coverage:** source tag (Step 3) ✓, two-section text with exact wording
  from spec (Step 4) ✓, feed/backfill entity-watch errors (no `tender_id`) fall
  into the same entity-watch section automatically since they go through the
  same push site ✓. Alert frequency/dedup explicitly out of scope per spec —
  no task touches it ✓.
- **Placeholder scan:** none — all steps contain literal code/commands.
- **Type consistency:** `source` field name and `'entity_watch'` value used
  identically in the push site (Step 3) and the filter (Step 4).
