# `/archive` pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `/archive` (list) into multiple Telegram messages — one per legal entity (service provider) — and paginate a single provider's contracts (at tender boundaries, with a `Сторінка K/N` footer) when its block would exceed the message limit.

**Architecture:** A new pure `paginateArchiveGroup` in `commands.mjs` packs one provider group's pre-rendered entry strings into page strings. `handleArchive` is changed to return `string[]` (was a single concatenated string). The Worker dispatch already sends an array as one message per element (`pages = Array.isArray(reply) ? reply : [reply]`) and `sendReply` sub-chunks any page over 4096 — so **no handler source change is needed**.

**Tech Stack:** Node.js (ESM, built-ins only), `node:test`, Cloudflare Worker.

**Spec:** `docs/superpowers/specs/2026-05-27-archive-paging-design.md`

**Constraint:** all existing archive rendering (headers, `renderArchiveItem`, grouping, sorting, the `Всього в архіві: N` total text) stays unchanged — only message-splitting is added.

**Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Run tests:** `node --test test/*.test.mjs worker/test/*.test.mjs`.

---

## File Structure

- `commands.mjs` — ADD `ARCHIVE_PAGE_LIMIT` const + `paginateArchiveGroup` (pure); CHANGE `handleArchive` to return `string[]`. `renderArchiveItem`, `findServiceProvider`, `plural`, `abbreviateLegalForm`, `escapeHtml` reused unchanged.
- `worker/src/handler.mjs` — no source change expected (dispatch already pages arrays). Only its tests may need migration.
- Tests: `test/commands.test.mjs`, `worker/test/handler.test.mjs`.

---

## Task 1: `paginateArchiveGroup` helper (pure)

**Files:**
- Modify: `commands.mjs` (add immediately BEFORE `handleArchive`, around line 860)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `paginateArchiveGroup, ARCHIVE_PAGE_LIMIT` to the commands import block in `test/commands.test.mjs`. Then:

```js
test('paginateArchiveGroup: fits in one page → no footer', () => {
  const pages = paginateArchiveGroup({ header: 'H', entries: ['a', 'b', 'c'] });
  assert.equal(pages.length, 1);
  assert.equal(pages[0], 'H\n\na\n\nb\n\nc');
  assert.doesNotMatch(pages[0], /Сторінка/);
});

test('paginateArchiveGroup: overflow → multiple pages, footer, entries intact', () => {
  // 4 entries of ~1500 chars each, limit 3900 → 2 per page
  const big = (c) => c.repeat(1500);
  const entries = [big('1'), big('2'), big('3'), big('4')];
  const pages = paginateArchiveGroup({ header: 'HDR', entries, limit: 3900 });
  assert.ok(pages.length >= 2, 'splits into >= 2 pages');
  // every page repeats the header and carries a Сторінка k/n footer
  pages.forEach((p, i) => {
    assert.ok(p.startsWith('HDR\n\n'), 'header repeated');
    assert.match(p, new RegExp(`Сторінка ${i + 1}/${pages.length}$`));
  });
  // no entry split: each original entry appears whole in exactly one page
  for (const e of entries) {
    const hits = pages.filter(p => p.includes(e)).length;
    assert.equal(hits, 1, 'entry appears whole on exactly one page');
  }
});

test('paginateArchiveGroup: a single oversized entry gets its own page', () => {
  const huge = 'x'.repeat(5000);
  const pages = paginateArchiveGroup({ header: 'H', entries: [huge, 'small'], limit: 3900 });
  assert.equal(pages.length, 2);
  assert.ok(pages[0].includes(huge));
  assert.ok(pages[1].includes('small'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `paginateArchiveGroup`/`ARCHIVE_PAGE_LIMIT` not exported.

- [ ] **Step 3: Implement**

In `commands.mjs`, immediately BEFORE `handleArchive`, add:

```js
// Telegram messages cap at 4096 chars. /archive splits one provider group's
// entries into page strings under this limit (margin for the repeated header,
// the "Сторінка k/n" footer, and HTML entities). Splits only at entry
// boundaries — a single procurement's text is never cut across pages.
export const ARCHIVE_PAGE_LIMIT = 3900;

// `entries` are already-rendered entry strings. One bucket that fits → a single
// page with NO footer. Otherwise pack entries into buckets (never splitting an
// entry) and render each as `${header}\n\n${body}\n\nСторінка k/n`. An entry
// that alone exceeds the limit still gets its own bucket (sendReply sub-chunks
// it at send time).
export function paginateArchiveGroup({ header, entries, limit = ARCHIVE_PAGE_LIMIT }) {
  const pageLen = (bucket) => header.length + 2 + bucket.join('\n\n').length;
  const buckets = [];
  let current = [];
  for (const e of entries) {
    if (current.length > 0 && pageLen([...current, e]) > limit) {
      buckets.push(current);
      current = [];
    }
    current.push(e);
  }
  if (current.length > 0) buckets.push(current);

  if (buckets.length <= 1) {
    return [`${header}\n\n${entries.join('\n\n')}`];
  }
  const n = buckets.length;
  return buckets.map((b, i) => `${header}\n\n${b.join('\n\n')}\n\nСторінка ${i + 1}/${n}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: add paginateArchiveGroup + ARCHIVE_PAGE_LIMIT"
```

---

## Task 2: `handleArchive` returns paged array

**Files:**
- Modify: `commands.mjs` — `handleArchive` (the empty-return + the `sections`/return block, ~lines 860-906)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

These need realistic archive entries. Reuse whatever archive-entry fixture/shape the EXISTING `handleArchive` tests in this file use (search for `handleArchive(` in `test/commands.test.mjs` and copy their entry shape — they already build archive objects with `awards`/`contracts`/`archived_at`). Add:

```js
test('handleArchive: empty → one-element array', () => {
  assert.deepEqual(handleArchive({ archive: [] }), ['📭 Архів порожній.']);
});

test('handleArchive: returns an array, total only on the last page', () => {
  // Build an archive with TWO distinct providers (reuse the existing test fixture
  // shape). Each small → one page per provider.
  const archive = [ /* entry for provider A */, /* entry for provider B */ ];
  const pages = handleArchive({ archive });
  assert.ok(Array.isArray(pages));
  assert.ok(pages.length >= 2, 'one page per provider group');
  // total appears once, on the last page only
  const withTotal = pages.filter(p => /Всього в архіві:/.test(p));
  assert.equal(withTotal.length, 1);
  assert.ok(/Всього в архіві:/.test(pages[pages.length - 1]));
  // no Сторінка footers when each group fits one page
  assert.ok(pages.every(p => !/Сторінка/.test(p)));
});

test('handleArchive: a provider with many contracts splits into footered pages', () => {
  // One provider, enough entries to exceed ARCHIVE_PAGE_LIMIT. Tune the count so
  // the single group spans >= 2 pages (start ~60; increase if needed).
  const archive = Array.from({ length: 60 }, (_, i) => /* entry for the SAME provider, i */);
  const pages = handleArchive({ archive });
  assert.ok(pages.length >= 2);
  // the split pages carry Сторінка k/n; the final page also has the global total
  const paged = pages.filter(p => /Сторінка \d+\/\d+/.test(p));
  assert.ok(paged.length >= 2, 'split group produced footered pages');
  assert.ok(/Всього в архіві: 60/.test(pages[pages.length - 1]));
});
```

> Adapt the `/* entry */` placeholders to the real archive-entry shape used by the existing `handleArchive` tests (provider identity comes from `findServiceProvider`, which reads `awards[].suppliers[0]` with `status === 'active'` — match how the existing tests construct a provider so grouping works). For the many-contracts test, all entries must resolve to the SAME provider so they land in one group; give each a distinct `tender_id`/`archived_at`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `handleArchive` currently returns a string, so `Array.isArray` is false / `deepEqual` to an array fails.

- [ ] **Step 3: Implement**

In `handleArchive`:

(a) Empty case — change:
```js
  if (!archive || archive.length === 0) {
    return '📭 Архів порожній.';
  }
```
to:
```js
  if (!archive || archive.length === 0) {
    return ['📭 Архів порожній.'];
  }
```

(b) Replace the `sections` building + return (the block that starts `const sections = [];` and ends `return sections.join('\n\n') + \`\n\nВсього в архіві: ${archive.length}\`;`) with:
```js
  const pages = [];
  for (const g of groupList) {
    const count = g.entries.length;
    const noun = plural(count, ['контракт', 'контракти', 'контрактів']);
    let header;
    if (g.provider) {
      const name = escapeHtml(abbreviateLegalForm(g.provider.name));
      const edrpou = g.provider.edrpou ? ` (ЄДРПОУ ${g.provider.edrpou})` : '';
      header = `👤 ${name}${edrpou} — ${count} ${noun}`;
    } else {
      header = `📦 Без укладеного договору — ${count} ${noun}`;
    }
    const entries = g.entries.map((a, i) => renderArchiveItem(a, i));
    pages.push(...paginateArchiveGroup({ header, entries }));
  }
  pages[pages.length - 1] += `\n\nВсього в архіві: ${archive.length}`;
  return pages;
```
(The header construction is copied verbatim from the existing code — unchanged. Only the per-group `section` is replaced by `paginateArchiveGroup(...)` pages, and the join+total becomes an append-to-last-page.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS. Update any PRE-EXISTING `handleArchive` test that asserted a single string return (e.g. `assert.match(handleArchive(...), /…/)` on the whole reply) — change it to index into the returned array (e.g. join the array, or assert on `pages[0]`). List which you changed.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleArchive returns paged array (split per provider)"
```

---

## Task 3: handler test migration + full suite + finish

**Files:**
- Test: `worker/test/handler.test.mjs` (migration only — no handler source change expected)

- [ ] **Step 1: Check the `/archive` handler tests**

Search `worker/test/handler.test.mjs` for `/archive` list tests (not `/archive UA-…` detail). Because `handleArchive` now returns an array, the dispatch sends one message per page. Any test that asserted a single concatenated `/archive` reply (e.g. `sent.length === 1` with all groups in `sent[0].text`, or matched the full string) must be updated:
- Empty archive → still ONE message (`['📭 Архів порожній.']`), so `sent.length === 1`, `sent[0].text` matches `📭 Архів порожній` — likely still passes.
- Multi-group archive → assert `sent.length === <number of pages>` and that group headers are distributed across messages.

Add (or adapt an existing test to) a multi-provider `/archive` case:
```js
test('runHandler: /archive with two providers sends one message per group', async () => {
  const archive = [ /* provider A entry */, /* provider B entry */ ]; // reuse handler test fixture shape
  const { deps, sent } = makeDeps({ loadArchivedTenders: async () => ({ archive, sha: 's' }) });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/archive', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 2);
});
```
(Use the archive-entry shape already used by existing `/archive` handler tests. If `makeDeps` already defaults `loadArchivedTenders`, only override it here.)

- [ ] **Step 2: Run the affected file**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS (after migrating any string-assuming `/archive` tests).

- [ ] **Step 3: Full suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: all pass. Investigate/fix any regression — especially any other place that consumed `handleArchive`'s return as a string (grep `handleArchive` across the repo to confirm the only caller is the `/archive` dispatch, which already handles arrays).

- [ ] **Step 4: Commit (if test changes were made)**

```bash
git add worker/test/handler.test.mjs
git commit -m "test: /archive sends one message per provider group"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. Deployment note: merging to `main` triggers `worker-deploy.yml` (paths include `commands.mjs`) → tests, then Worker deploy.

---

## Self-Review Notes

- **Spec coverage:** per-legal-entity split (Task 2 — one+ pages per group, no cross-provider packing), intra-provider split at entry boundaries (Task 1 `paginateArchiveGroup`), `Сторінка k/n` only when split (Task 1 — single bucket → no footer), header repeated on split pages (Task 1), global total once on last page (Task 2), rendering otherwise unchanged (Task 2 copies header/`renderArchiveItem` verbatim), oversized-single-entry fallback (Task 1 own-bucket + `sendReply` chunking), no handler source change (Task 3 verifies). All spec items map to a task.
- **Type/name consistency:** `handleArchive` now returns `string[]` (was `string`); `paginateArchiveGroup({ header, entries, limit }) → string[]`; `ARCHIVE_PAGE_LIMIT` constant. Callers: only the `/archive` dispatch (already array-aware) — verified in Task 3.
- **No placeholders in logic:** the only `/* … */` are test fixtures the implementer fills from the existing test shape (explicitly instructed) — the production code blocks are complete.
- **Reuse:** header construction + `renderArchiveItem` + grouping/sorting copied unchanged; only splitting is new.
