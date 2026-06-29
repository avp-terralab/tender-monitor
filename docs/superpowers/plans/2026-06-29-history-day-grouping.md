# History Day Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group notification history entries under date headers in the Telegram inline keyboard, with pagination that never splits a day across pages.

**Architecture:** Two internal helpers (`histSlicePage`, `histPageStarts`) implement the "don't cut day" pagination logic; `buildHistoryList` inserts `hist:noop` date-header rows between day groups; `buildHistoryItem` uses `histPageStarts` to resolve which page to return to. `handler.mjs` already handles `hist:noop` — no changes there.

**Tech Stack:** Node ESM, `Intl.DateTimeFormat`, Node built-in test runner (`node --test`).

---

## File map

| File | Change |
|------|--------|
| `test/commands.test.mjs` | Update `histItems` fixture; update `buildHistoryList` assertions; add 4 new tests |
| `commands.mjs` | Replace `HIST_DT` with `HIST_DAY`+`HIST_TIME`; add `histSlicePage`/`histPageStarts`; rewrite `buildHistoryList`; update `buildHistoryItem` |

`handler.mjs`, `monitor.mjs`, `telegram.mjs`, `worker/src/github.mjs` — **no changes**.

---

### Task 1: Update test fixture and existing assertions

The current `histItems` fixture gives all entries the same day (`2026-06-25`), so the new "don't cut day" pagination would put all items on one page and break the nav/page assertions. Update the fixture to spread entries across multiple days (3 per day), then adjust the assertions in the existing `buildHistoryList` test.

**Files:**
- Modify: `test/commands.test.mjs` (around line 3669)

- [ ] **Step 1: Replace `histItems` fixture (line 3669)**

```js
const histItems = (n) => Array.from({ length: n }, (_, i) => ({
  type: 'digest',
  sent_at: new Date(Date.UTC(2026, 5, 29 - Math.floor(i / 3), 12 - (i % 3), 0, 0)).toISOString(),
  summary: `📥 ${i + 1}`,
  text: `<b>Дайджест ${i}</b>`,
  recipients: [],
  deleted: false,
}));
```

This gives 3 entries per day: i=0,1,2 → June 29 (15:00/14:00/13:00 Kyiv); i=3,4,5 → June 28; i=6,7,8 → June 27; etc.

- [ ] **Step 2: Update `buildHistoryList: digests only` test assertions (line 3679)**

Replace the three assertion lines inside that test:

```js
// OLD (remove these 3 lines):
assert.equal(rows[0][0].callback_data, 'hist:i:0');
assert.match(rows[0][0].text, /📥 1/);
const nav = rows.find((r) => r.some((b) => b.callback_data === 'hist:noop'));

// NEW (replace with):
assert.equal(rows[0][0].callback_data, 'hist:noop');    // date header row
assert.equal(rows[1][0].callback_data, 'hist:i:0');     // first entry
assert.match(rows[1][0].text, /📥 1/);
assert.ok(!rows[1][0].text.includes('29.06'));           // no date in entry row
const nav = rows.at(-1);
```

- [ ] **Step 3: Update comment in `buildHistoryItem: back button remembers page for idx on page 1` (line 3695)**

```js
// OLD:
// HIST_PER_PAGE=6, so idx=7 is on page 1
// NEW:
// page 0 = June29(0-2)+June28(3-5)=6 entries; page 1 starts at June27(6-8); idx=7 is on page 1
```

- [ ] **Step 4: Run history tests — confirm they FAIL**

```
node --test test/commands.test.mjs 2>&1 | grep -E "FAIL|pass|fail|Error" | head -30
```

Expected: `buildHistoryList: digests only` test fails with assertion error on `rows[0][0].callback_data`.

---

### Task 2: Add new grouped-display and pagination tests

Add 4 new tests after the existing history tests (after line 3712, before `mainKeyboard` test).

**Files:**
- Modify: `test/commands.test.mjs`

- [ ] **Step 1: Add test — grouped layout has date headers and time-only entries**

```js
test('buildHistoryList: inserts noop date headers, entries show time only', () => {
  const items = [
    { type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: 'A', text: 'ta', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-29T10:00:00.000Z', summary: 'B', text: 'tb', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-28T12:00:00.000Z', summary: 'C', text: 'tc', recipients: [], deleted: false },
  ];
  const rows = buildHistoryList({ items, page: 0 }).keyboard.inline_keyboard;
  // row 0: date header June 29
  assert.equal(rows[0][0].callback_data, 'hist:noop');
  assert.match(rows[0][0].text, /29 червня/);
  // row 1: entry A — time 15:00 Kyiv, no "29.06" date prefix
  assert.equal(rows[1][0].callback_data, 'hist:i:0');
  assert.match(rows[1][0].text, /15:00/);
  assert.ok(!rows[1][0].text.includes('29.06'));
  // row 2: entry B
  assert.equal(rows[2][0].callback_data, 'hist:i:1');
  // row 3: date header June 28
  assert.equal(rows[3][0].callback_data, 'hist:noop');
  assert.match(rows[3][0].text, /28 червня/);
  // row 4: entry C — no nav (single page)
  assert.equal(rows[4][0].callback_data, 'hist:i:2');
  assert.equal(rows.length, 5);
});
```

- [ ] **Step 2: Add test — day with < 6 entries does not trigger page break**

```js
test('buildHistoryList: 5+3 entries across 2 days fit on one page', () => {
  const mk = (d, n) => Array.from({ length: n }, (_, i) => ({
    type: 'digest', sent_at: `${d}T${10 + i}:00:00.000Z`, summary: `s${i}`, text: 't', recipients: [], deleted: false,
  }));
  // 5 June29 + 3 June28: when June28 starts, entries.length=5 < 6 → continue
  const items = [...mk('2026-06-29', 5), ...mk('2026-06-28', 3)];
  const rows = buildHistoryList({ items, page: 0 }).keyboard.inline_keyboard;
  assert.equal(rows.filter((r) => r[0].callback_data === 'hist:noop').length, 2);     // 2 date headers
  assert.equal(rows.filter((r) => r[0].callback_data.startsWith('hist:i:')).length, 8); // all 8 entries
  assert.ok(!rows.at(-1).some((b) => b.text === 'Далі ▶'));                             // no next page
});
```

- [ ] **Step 3: Add test — 6+ entries triggers page break at day boundary**

```js
test('buildHistoryList: 6+2 entries split across 2 pages at day boundary', () => {
  const mk = (d, n) => Array.from({ length: n }, (_, i) => ({
    type: 'digest', sent_at: `${d}T${10 + i}:00:00.000Z`, summary: `s${i}`, text: 't', recipients: [], deleted: false,
  }));
  // 6 June29 + 2 June28: when June28 starts, entries.length=6 >= 6 → break
  const items = [...mk('2026-06-29', 6), ...mk('2026-06-28', 2)];
  const v0 = buildHistoryList({ items, page: 0 });
  const rows0 = v0.keyboard.inline_keyboard;
  assert.equal(rows0.filter((r) => r[0].callback_data.startsWith('hist:i:')).length, 6); // 6 on page 0
  assert.ok(rows0.at(-1).some((b) => b.text === 'Далі ▶'));                               // nav → next page

  const rows1 = buildHistoryList({ items, page: 1 }).keyboard.inline_keyboard;
  assert.equal(rows1.filter((r) => r[0].callback_data.startsWith('hist:i:')).length, 2); // 2 on page 1
  assert.ok(rows1.at(-1).some((b) => b.text === '◀ Назад'));                              // nav → prev page
});
```

- [ ] **Step 4: Add test — single day with 8 entries stays on one page**

```js
test('buildHistoryList: single day with 8 entries fits on one page (no split)', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    type: 'digest', sent_at: `2026-06-29T${10 + i}:00:00.000Z`, summary: `s${i}`, text: 't', recipients: [], deleted: false,
  }));
  const rows = buildHistoryList({ items, page: 0 }).keyboard.inline_keyboard;
  assert.equal(rows.filter((r) => r[0].callback_data === 'hist:noop').length, 1);        // 1 date header
  assert.equal(rows.filter((r) => r[0].callback_data.startsWith('hist:i:')).length, 8);  // all 8 entries
  assert.ok(!rows.at(-1).some((b) => b.text === 'Далі ▶'));                               // no next page
});
```

- [ ] **Step 5: Run all history tests — confirm all new tests FAIL**

```
node --test test/commands.test.mjs 2>&1 | grep -E "✗|✓|FAIL|pass" | grep -A1 "hist\|Hist\|group\|day\|split"
```

Expected: new 4 tests fail, existing back-button tests pass (they don't depend on formatting).

---

### Task 3: Implement changes in commands.mjs

Replace the formatter constant, add two internal helpers, rewrite `buildHistoryList`, update `buildHistoryItem`.

**Files:**
- Modify: `commands.mjs` (lines 1970–2010)

- [ ] **Step 1: Replace `HIST_DT` with `HIST_DAY` + `HIST_TIME` (line 1970)**

```js
// Remove:
const HIST_DT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

// Add in its place:
const HIST_DAY = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long',
});
const HIST_TIME = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});
```

- [ ] **Step 2: Add `histSlicePage` helper after `historyDigests` (after line 1978)**

```js
// Returns one page of entries starting at startIdx.
// Stops before adding an entry from a new day if entries.length >= 6.
function histSlicePage(list, startIdx) {
  const entries = [];
  let lastDay = null;
  let i = startIdx;
  for (; i < list.length; i++) {
    const day = HIST_DAY.format(new Date(list[i].sent_at));
    if (day !== lastDay && entries.length >= 6) break;
    entries.push(list[i]);
    lastDay = day;
  }
  return { entries, nextStart: i, hasNext: i < list.length };
}

function histPageStarts(list) {
  const starts = [];
  let s = 0;
  while (s < list.length) {
    starts.push(s);
    s = histSlicePage(list, s).nextStart;
  }
  return starts;
}
```

- [ ] **Step 3: Rewrite `buildHistoryList` (lines 1980–1994)**

```js
export function buildHistoryList({ items, page = 0 }) {
  const list = historyDigests(items);
  if (list.length === 0) return { text: '📭 Історія сповіщень порожня.', keyboard: null };
  const starts = histPageStarts(list);
  const pages = starts.length;
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const { entries } = histSlicePage(list, starts[p]);
  const rows = [];
  let prevDay = null;
  entries.forEach((it, i) => {
    const day = HIST_DAY.format(new Date(it.sent_at));
    if (day !== prevDay) {
      rows.push([{ text: `── ${day} ──`, callback_data: 'hist:noop' }]);
      prevDay = day;
    }
    const when = it.sent_at ? HIST_TIME.format(new Date(it.sent_at)) : '—';
    rows.push([{ text: `🔔 ${when} · ${it.summary ?? ''}`.trim(), callback_data: `hist:i:${starts[p] + i}` }]);
  });
  const nav = buildPageNavRow(p, pages, (x) => `hist:p:${x}`, 'hist:noop');
  if (nav) rows.push(nav);
  return { text: `📜 <b>Історія сповіщень</b> — ${list.length}`, keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 4: Update `buildHistoryItem` to use `histPageStarts` (lines 1996–2002)**

```js
export function buildHistoryItem({ items, idx }) {
  const list = historyDigests(items);
  const it = list[idx];
  if (!it) return buildHistoryList({ items, page: 0 });
  const starts = histPageStarts(list);
  const page = Math.max(0, starts.findLastIndex((s) => s <= idx));
  return { text: it.text ?? '(порожньо)', keyboard: { inline_keyboard: [[{ text: '⬅ Назад до історії', callback_data: `hist:p:${page}` }]] } };
}
```

- [ ] **Step 5: Run all tests — confirm they pass**

```
node --test test/commands.test.mjs worker/test/handler.test.mjs 2>&1 | tail -20
```

Expected: all tests pass, zero failures. If `findLastIndex` is unavailable, replace with:
```js
let page = 0;
for (let j = starts.length - 1; j >= 0; j--) { if (starts[j] <= idx) { page = j; break; } }
```

- [ ] **Step 6: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat: group history entries by day with date headers"
```
