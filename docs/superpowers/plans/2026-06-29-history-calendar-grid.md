# Календарний грид для Історії сповіщень — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Замінити flat-список сповіщень на 3-стейтний calendar grid: грид місяця → список дня → повний текст.

**Architecture:** Нові `buildHistoryCalendar` і `buildHistoryDay` в `commands.mjs`; оновити `buildHistoryItem` (кнопка назад → `hist:day:`); оновити `handleHistoryNav` (роутинг нових callbacks); оновити `handler.mjs` (точка входу `/history`).

**Tech Stack:** Node ESM, Telegram inline keyboard, `Intl.DateTimeFormat` (`uk-UA`, `Europe/Kyiv`), `node --test`

---

## File Map

| File | Change |
|------|--------|
| `commands.mjs` (~2014–2054) | Add 7 private helpers, 2 new exports, update 2 existing exports |
| `test/commands.test.mjs` (line 30, ~3695–3718) | Add new tests, update 3 existing tests |
| `worker/src/handler.mjs` (lines 21, 598) | Update import + entry point |

---

## Task 1: Private helpers + `buildHistoryCalendar`

**Files:**
- Modify: `commands.mjs` after line 2012 (after `histPageStarts`)
- Modify: `test/commands.test.mjs` line 30 (import), and after the last `buildHistoryList` test

- [ ] **Step 1: Update the test import to include new exports**

In `test/commands.test.mjs` line 30, replace:

```js
  buildHistoryList, buildHistoryItem, handleHistoryNav,
```

with:

```js
  buildHistoryCalendar, buildHistoryDay, buildHistoryList, buildHistoryItem, handleHistoryNav,
```

- [ ] **Step 2: Write the failing tests for `buildHistoryCalendar`**

Add after the last `buildHistoryList` test block (after line ~3780) in `test/commands.test.mjs`:

```js
// ─── buildHistoryCalendar ─────────────────────────────────────────────────

test('buildHistoryCalendar: empty history → grid with all-noop days', () => {
  // June 1 2026 is Monday → offset 0, 30 days → 5 week-rows
  const v = buildHistoryCalendar({ items: [], month: '2026-06' });
  const rows = v.keyboard.inline_keyboard;
  assert.equal(rows[0].length, 3);                                     // nav: ◀ | month | ▶
  assert.equal(rows[0][0].callback_data, 'hist:noop');                 // no prev month
  assert.equal(rows[0][2].callback_data, 'hist:noop');                 // no next month
  assert.match(rows[0][1].text, /червень/i);                           // month label
  assert.equal(rows[1].length, 7);                                     // weekday headers
  assert.ok(rows[1].every((b) => b.callback_data === 'hist:noop'));
  assert.equal(rows.length, 7);                                        // nav + headers + 5 weeks
  assert.ok(rows.slice(2).flat().every((b) => b.callback_data === 'hist:noop'));
});

test('buildHistoryCalendar: days with events → hist:day callback + emoji', () => {
  const items = [
    { type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: '📥 2', text: 't', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-27T09:00:00.000Z', summary: '🔔 1', text: 't', recipients: [], deleted: false },
  ];
  const allCells = buildHistoryCalendar({ items, month: '2026-06' }).keyboard.inline_keyboard.slice(2).flat();
  const day29 = allCells.find((b) => b.callback_data === 'hist:day:2026-06-29');
  assert.ok(day29, 'day 29 should have hist:day callback');
  assert.match(day29.text, /^29/);
  assert.match(day29.text, /📥/);
  const day27 = allCells.find((b) => b.callback_data === 'hist:day:2026-06-27');
  assert.ok(day27);
  assert.match(day27.text, /🔔/);
  const day28 = allCells.find((b) => b.text === '28');
  assert.equal(day28?.callback_data, 'hist:noop');                     // no events → noop
});

test('buildHistoryCalendar: nav arrows point to prev/next months with events', () => {
  const items = [
    { type: 'digest', sent_at: '2026-05-15T10:00:00.000Z', summary: 'A', text: 't', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: 'B', text: 't', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-07-01T10:00:00.000Z', summary: 'C', text: 't', recipients: [], deleted: false },
  ];
  const nav = buildHistoryCalendar({ items, month: '2026-06' }).keyboard.inline_keyboard[0];
  assert.equal(nav[0].callback_data, 'hist:cal:2026-05');
  assert.equal(nav[2].callback_data, 'hist:cal:2026-07');
});

test('buildHistoryCalendar: first/last month → both nav arrows noop', () => {
  const items = [{ type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: 'A', text: 't', recipients: [], deleted: false }];
  const nav = buildHistoryCalendar({ items, month: '2026-06' }).keyboard.inline_keyboard[0];
  assert.equal(nav[0].callback_data, 'hist:noop');
  assert.equal(nav[2].callback_data, 'hist:noop');
});

test('buildHistoryCalendar: defaults to latest month with events when no month arg', () => {
  const items = [
    { type: 'digest', sent_at: '2026-04-10T10:00:00.000Z', summary: 'A', text: 't', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: 'B', text: 't', recipients: [], deleted: false },
  ];
  const v = buildHistoryCalendar({ items });
  assert.match(v.keyboard.inline_keyboard[0][1].text, /червень/i);
});

test('buildHistoryCalendar: Monday-start offset correct (June 2026: day 1 = Mon → col 0)', () => {
  const allCells = buildHistoryCalendar({ items: [], month: '2026-06' }).keyboard.inline_keyboard.slice(2).flat();
  assert.equal(allCells[0].text, '1');                                 // no leading empty cells
});

test('buildHistoryCalendar: May 2026 starts on Friday → 4 empty cells before day 1', () => {
  // May 1 2026 is Friday. getDay()=5. offset=(5+6)%7=4
  const allCells = buildHistoryCalendar({ items: [], month: '2026-05' }).keyboard.inline_keyboard.slice(2).flat();
  assert.equal(allCells[0].text, ' ');   // cell 0..3 empty
  assert.equal(allCells[1].text, ' ');
  assert.equal(allCells[2].text, ' ');
  assert.equal(allCells[3].text, ' ');
  assert.equal(allCells[4].text, '1');   // cell 4 = day 1 (Friday)
});
```

- [ ] **Step 3: Run to verify all new tests fail**

```
node --test test/commands.test.mjs
```

Expected: ~7 new tests fail with `buildHistoryCalendar is not a function` or `ReferenceError`.

- [ ] **Step 4: Add private helpers and `buildHistoryCalendar` to `commands.mjs`**

In `commands.mjs`, after line 2012 (after the `histPageStarts` function body, before `buildHistoryList`), insert:

```js
// Returns 'YYYY-MM-DD' for a timestamp in Europe/Kyiv, or null if invalid.
function histIsoDay(sent_at) {
  const d = new Date(sent_at);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d);
}

// Sorted unique 'YYYY-MM' strings (Kyiv time) for all entries in the list.
function activeMths(list) {
  const set = new Set();
  for (const it of list) { const day = histIsoDay(it.sent_at); if (day) set.add(day.slice(0, 7)); }
  return [...set].sort();
}

function prevMonth(mths, current) {
  const before = mths.filter((m) => m < current);
  return before.length ? before[before.length - 1] : null;
}

function nextMonth(mths, current) {
  const after = mths.filter((m) => m > current);
  return after.length ? after[0] : null;
}

// First emoji_presentation character from a string, or undefined.
function firstEmoji(summary) {
  if (!summary) return undefined;
  return summary.match(/\p{Emoji_Presentation}/u)?.[0];
}

export function buildHistoryCalendar({ items, month }) {
  const list = historyDigests(items);
  const mths = activeMths(list);
  let cur = month ?? (mths.length ? mths[mths.length - 1] : null);
  if (!cur) { cur = histIsoDay(new Date().toISOString())?.slice(0, 7) ?? '1970-01'; }
  const [yearStr, monthStr] = cur.split('-');
  const year = Number(yearStr);
  const month0 = Number(monthStr) - 1;
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const offset = (new Date(year, month0, 1).getDay() + 6) % 7;
  const monthLabel = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(year, month0, 1)));
  const label = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  const prev = prevMonth(mths, cur);
  const next = nextMonth(mths, cur);
  const rows = [];
  rows.push([
    { text: '◀', callback_data: prev ? `hist:cal:${prev}` : 'hist:noop' },
    { text: label, callback_data: 'hist:noop' },
    { text: '▶', callback_data: next ? `hist:cal:${next}` : 'hist:noop' },
  ]);
  rows.push(['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].map((d) => ({ text: d, callback_data: 'hist:noop' })));
  const cells = [...Array(offset).fill(null)];
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7).map((d) => {
      if (d === null) return { text: ' ', callback_data: 'hist:noop' };
      const dd = String(d).padStart(2, '0');
      const isoDate = `${year}-${monthStr}-${dd}`;
      const evts = list.filter((it) => histIsoDay(it.sent_at) === isoDate);
      if (evts.length > 0) {
        const emoji = firstEmoji(evts[0].summary) ?? '🔔';
        return { text: `${d}${emoji}`, callback_data: `hist:day:${isoDate}` };
      }
      return { text: String(d), callback_data: 'hist:noop' };
    }));
  }
  return { text: `📜 <b>Історія сповіщень</b> — ${list.length}`, keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 5: Run tests — all new `buildHistoryCalendar` tests should pass**

```
node --test test/commands.test.mjs
```

Expected: previously-failing `buildHistoryCalendar` tests now pass; all prior tests still pass.

- [ ] **Step 6: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "feat: buildHistoryCalendar — monthly grid with day navigation"
```

---

## Task 2: `buildHistoryDay`

**Files:**
- Modify: `commands.mjs` — add after `buildHistoryCalendar`
- Modify: `test/commands.test.mjs` — add after `buildHistoryCalendar` tests

- [ ] **Step 1: Write failing tests for `buildHistoryDay`**

Add after the `buildHistoryCalendar` test block in `test/commands.test.mjs`:

```js
// ─── buildHistoryDay ──────────────────────────────────────────────────────

test('buildHistoryDay: shows only entries for that day with back button', () => {
  const items = [
    { type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: '📥 1', text: 'text1', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-29T10:00:00.000Z', summary: '📥 2', text: 'text2', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-28T10:00:00.000Z', summary: '📥 3', text: 'text3', recipients: [], deleted: false },
  ];
  const v = buildHistoryDay({ items, date: '2026-06-29' });
  assert.match(v.text, /📅/);
  assert.match(v.text, /29 червня/);
  assert.match(v.text, /2 сповіщень/);
  const rows = v.keyboard.inline_keyboard;
  const entries = rows.filter((r) => r[0].callback_data.startsWith('hist:i:'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0][0].callback_data, 'hist:i:0');  // global idx 0
  assert.equal(entries[1][0].callback_data, 'hist:i:1');  // global idx 1
  const back = rows.at(-1)[0];
  assert.equal(back.callback_data, 'hist:cal:2026-06');
  assert.match(back.text, /Назад до календаря/);
});

test('buildHistoryDay: global idx survives when earlier entries are from other days', () => {
  // items[0] = June28, items[1] = June29 — idx for June29 entry is 1
  const items = [
    { type: 'digest', sent_at: '2026-06-28T10:00:00.000Z', summary: 'A', text: 'tA', recipients: [], deleted: false },
    { type: 'digest', sent_at: '2026-06-29T12:00:00.000Z', summary: 'B', text: 'tB', recipients: [], deleted: false },
  ];
  const v = buildHistoryDay({ items, date: '2026-06-29' });
  const entries = v.keyboard.inline_keyboard.filter((r) => r[0].callback_data.startsWith('hist:i:'));
  assert.equal(entries[0][0].callback_data, 'hist:i:1');  // global idx 1, not 0
});

test('buildHistoryDay: pagination when > 8 entries on the same day', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    type: 'digest',
    sent_at: `2026-06-29T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
    summary: `s${i}`, text: 't', recipients: [], deleted: false,
  }));
  const v0 = buildHistoryDay({ items, date: '2026-06-29', page: 0 });
  const entries0 = v0.keyboard.inline_keyboard.filter((r) => r[0].callback_data.startsWith('hist:i:'));
  assert.equal(entries0.length, 8);
  const navRow = v0.keyboard.inline_keyboard.find((r) => r.some((b) => b.text === 'Далі ▶'));
  assert.ok(navRow, 'page 0 should have Далі ▶');
  const nextBtn = navRow.find((b) => b.text === 'Далі ▶');
  assert.equal(nextBtn.callback_data, 'hist:day:2026-06-29:p:1');

  const v1 = buildHistoryDay({ items, date: '2026-06-29', page: 1 });
  const entries1 = v1.keyboard.inline_keyboard.filter((r) => r[0].callback_data.startsWith('hist:i:'));
  assert.equal(entries1.length, 2);
  const prevBtn = v1.keyboard.inline_keyboard.flat().find((b) => b.text === '◀ Назад');
  assert.equal(prevBtn?.callback_data, 'hist:day:2026-06-29:p:0');
});

test('buildHistoryDay: unknown date falls back to calendar', () => {
  const v = buildHistoryDay({ items: histItems(3), date: '2026-05-01' });
  assert.match(v.text, /Історія сповіщень/);
});
```

- [ ] **Step 2: Run to verify tests fail**

```
node --test test/commands.test.mjs
```

Expected: 4 new tests fail with `buildHistoryDay is not a function`.

- [ ] **Step 3: Implement `buildHistoryDay` in `commands.mjs`**

Add immediately after `buildHistoryCalendar` (before `buildHistoryList`):

```js
export function buildHistoryDay({ items, date, page = 0 }) {
  const list = historyDigests(items);
  const indexed = list.map((it, idx) => ({ it, idx }))
    .filter(({ it }) => histIsoDay(it.sent_at) === date);
  if (indexed.length === 0) return buildHistoryCalendar({ items, month: date.slice(0, 7) });
  const PAGE_SIZE = 8;
  const pages = Math.max(1, Math.ceil(indexed.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.trunc(page ?? 0)), pages - 1);
  const slice = indexed.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const rows = [];
  for (const { it, idx } of slice) {
    const d = new Date(it.sent_at);
    const when = it.sent_at && !isNaN(d) ? HIST_TIME.format(d) : '—';
    rows.push([{ text: `🔔 ${when} · ${it.summary ?? ''}`.trim(), callback_data: `hist:i:${idx}` }]);
  }
  if (pages > 1) {
    rows.push([
      p > 0 ? { text: '◀ Назад', callback_data: `hist:day:${date}:p:${p - 1}` } : { text: ' ', callback_data: 'hist:noop' },
      { text: `${p + 1}/${pages}`, callback_data: 'hist:noop' },
      p < pages - 1 ? { text: 'Далі ▶', callback_data: `hist:day:${date}:p:${p + 1}` } : { text: ' ', callback_data: 'hist:noop' },
    ]);
  }
  rows.push([{ text: '⬅ Назад до календаря', callback_data: `hist:cal:${date.slice(0, 7)}` }]);
  const [yr, mo, dy] = date.split('-').map(Number);
  const dateLabel = HIST_DAY.format(new Date(Date.UTC(yr, mo - 1, dy)));
  return {
    text: `📅 <b>${dateLabel}</b> — ${indexed.length} сповіщень`,
    keyboard: { inline_keyboard: rows },
  };
}
```

- [ ] **Step 4: Run tests — all `buildHistoryDay` tests should pass**

```
node --test test/commands.test.mjs
```

Expected: 4 new tests pass; all prior tests still pass.

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "feat: buildHistoryDay — day entry list with back-to-calendar"
```

---

## Task 3: Update `buildHistoryItem` — back button → `hist:day:`

**Files:**
- Modify: `commands.mjs` `buildHistoryItem` (~line 2038)
- Modify: `test/commands.test.mjs` — update 3 existing tests

- [ ] **Step 1: Update the 3 existing `buildHistoryItem` tests to expect `hist:day:` callbacks**

In `test/commands.test.mjs`, replace the three test blocks starting at ~line 3695:

```js
// REPLACE this:
test('buildHistoryItem: full text + back to page 0', () => {
  const v = buildHistoryItem({ items: histItems(3), idx: 1 });
  assert.match(v.text, /Дайджест 1/);
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'hist:p:0');
});

test('buildHistoryItem: back button remembers page for idx on page 1', () => {
  // page 0 = June29(0-2)+June28(3-5)=6 entries; page 1 starts at June27(6-8); idx=7 is on page 1
  const v = buildHistoryItem({ items: histItems(14), idx: 7 });
  assert.match(v.text, /Дайджест 7/);
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'hist:p:1');
});

test('buildHistoryItem: back button remembers page for idx on page 2', () => {
  const v = buildHistoryItem({ items: histItems(20), idx: 13 });
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'hist:p:2');
});
```

```js
// WITH this:
test('buildHistoryItem: full text + back button → hist:day:<date>', () => {
  // histItems(3): all 3 entries are on 2026-06-29
  const v = buildHistoryItem({ items: histItems(3), idx: 1 });
  assert.match(v.text, /Дайджест 1/);
  const back = v.keyboard.inline_keyboard.at(-1)[0];
  assert.equal(back.callback_data, 'hist:day:2026-06-29');
  assert.match(back.text, /29 червня/);
});

test('buildHistoryItem: back button shows day for idx on different day (idx=7 → June27)', () => {
  // histItems: i=7 → Date.UTC(2026,5,29-floor(7/3),12-(7%3)) = Date.UTC(2026,5,27,11) = 2026-06-27T11Z → Kyiv 14:00 → 2026-06-27
  const v = buildHistoryItem({ items: histItems(14), idx: 7 });
  assert.match(v.text, /Дайджест 7/);
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'hist:day:2026-06-27');
});

test('buildHistoryItem: back button for idx=13 → June25', () => {
  // i=13 → Date.UTC(2026,5,29-floor(13/3),12-(13%3)) = Date.UTC(2026,5,25,11) = 2026-06-25T11Z → Kyiv → 2026-06-25
  const v = buildHistoryItem({ items: histItems(20), idx: 13 });
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'hist:day:2026-06-25');
});
```

- [ ] **Step 2: Run to verify the 3 updated tests now fail**

```
node --test test/commands.test.mjs
```

Expected: exactly 3 tests fail — the ones just updated (still returning `hist:p:` instead of `hist:day:`).

- [ ] **Step 3: Update `buildHistoryItem` in `commands.mjs`**

Replace the existing `buildHistoryItem` function (~line 2038):

```js
// BEFORE:
export function buildHistoryItem({ items, idx }) {
  const list = historyDigests(items);
  const it = list[idx];
  if (!it) return buildHistoryList({ items, page: 0 });
  const starts = histPageStarts(list);
  let page = 0;
  for (let j = starts.length - 1; j >= 0; j--) { if (starts[j] <= idx) { page = j; break; } }
  return { text: it.text ?? '(порожньо)', keyboard: { inline_keyboard: [[{ text: '⬅ Назад до історії', callback_data: `hist:p:${page}` }]] } };
}
```

```js
// AFTER:
export function buildHistoryItem({ items, idx }) {
  const list = historyDigests(items);
  const it = list[idx];
  if (!it) return buildHistoryCalendar({ items });
  const isoDate = histIsoDay(it.sent_at) ?? '';
  const dateLabel = isoDate ? HIST_DAY.format(new Date(it.sent_at)) : '—';
  return {
    text: it.text ?? '(порожньо)',
    keyboard: { inline_keyboard: [[{
      text: `⬅ Назад до ${dateLabel}`,
      callback_data: isoDate ? `hist:day:${isoDate}` : 'hist:noop',
    }]] },
  };
}
```

- [ ] **Step 4: Run tests — all 3 updated tests should now pass**

```
node --test test/commands.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "feat: buildHistoryItem back button → hist:day:<YYYY-MM-DD>"
```

---

## Task 4: Update `handleHistoryNav` routing

**Files:**
- Modify: `commands.mjs` `handleHistoryNav` (~line 2048)
- Modify: `test/commands.test.mjs` — update 1 existing test

- [ ] **Step 1: Update the existing `handleHistoryNav` test**

In `test/commands.test.mjs`, replace:

```js
test('handleHistoryNav: noop→null; p/i routing', () => {
  const items = histItems(3);
  assert.equal(handleHistoryNav({ items, data: 'hist:noop' }), null);
  assert.match(handleHistoryNav({ items, data: 'hist:p:0' }).text, /Історія сповіщень/);
  assert.match(handleHistoryNav({ items, data: 'hist:i:0' }).text, /Дайджест 0/);
});
```

with:

```js
test('handleHistoryNav: noop→null; i/cal/day/p routing', () => {
  const items = histItems(3);
  assert.equal(handleHistoryNav({ items, data: 'hist:noop' }), null);
  // hist:i → full text
  assert.match(handleHistoryNav({ items, data: 'hist:i:0' }).text, /Дайджест 0/);
  // hist:cal → calendar grid
  assert.match(handleHistoryNav({ items, data: 'hist:cal:2026-06' }).text, /Історія сповіщень/);
  // hist:day → day list (histItems(3): all 3 on 2026-06-29)
  assert.match(handleHistoryNav({ items, data: 'hist:day:2026-06-29' }).text, /29 червня/);
  // hist:day with page → day list page 0 (no pagination for 3 entries)
  assert.match(handleHistoryNav({ items, data: 'hist:day:2026-06-29:p:0' }).text, /29 червня/);
  // hist:p backward compat → flat list
  assert.match(handleHistoryNav({ items, data: 'hist:p:0' }).text, /Історія сповіщень/);
});
```

- [ ] **Step 2: Run to verify the updated test fails**

```
node --test test/commands.test.mjs
```

Expected: the `handleHistoryNav` test fails (can't route `hist:cal:` or `hist:day:`).

- [ ] **Step 3: Replace `handleHistoryNav` in `commands.mjs`**

Replace (~line 2048):

```js
// BEFORE:
export function handleHistoryNav({ items, data }) {
  if (data === 'hist:noop') return null;
  const parts = data.split(':'); // hist:p:<page> | hist:i:<idx>
  if (parts[1] === 'i') return buildHistoryItem({ items, idx: Number(parts[2]) });
  if (parts[1] === 'p') return buildHistoryList({ items, page: Number(parts[2] ?? 0) });
  return buildHistoryList({ items, page: 0 });
}
```

```js
// AFTER:
export function handleHistoryNav({ items, data }) {
  if (data === 'hist:noop') return null;
  const parts = data.split(':');
  if (parts[1] === 'i') return buildHistoryItem({ items, idx: Number(parts[2]) });
  if (parts[1] === 'cal') return buildHistoryCalendar({ items, month: parts[2] });
  if (parts[1] === 'day') {
    // hist:day:YYYY-MM-DD  or  hist:day:YYYY-MM-DD:p:N
    const date = parts[2];
    const page = parts[3] === 'p' ? Number(parts[4] ?? 0) : 0;
    return buildHistoryDay({ items, date, page });
  }
  if (parts[1] === 'p') return buildHistoryList({ items, page: Number(parts[2] ?? 0) });
  return buildHistoryCalendar({ items });
}
```

- [ ] **Step 4: Run full test suite**

```
node --test test/commands.test.mjs worker/test/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "feat: handleHistoryNav routes hist:cal and hist:day callbacks"
```

---

## Task 5: Update `handler.mjs` entry point

**Files:**
- Modify: `worker/src/handler.mjs` lines 21 and 598

- [ ] **Step 1: Update the import in `handler.mjs`**

On line 21, replace:

```js
  buildHistoryList, handleHistoryNav,
```

with:

```js
  buildHistoryCalendar, handleHistoryNav,
```

(Note: `buildHistoryList` is no longer called directly in handler.mjs; it remains exported from commands.mjs for backward compat.)

- [ ] **Step 2: Update the `/history` command handler in `handler.mjs`**

On line 598, replace:

```js
      const view = buildHistoryList({ items, page: 0 });
```

with:

```js
      const view = buildHistoryCalendar({ items });
```

- [ ] **Step 3: Run full test suite**

```
node --test test/commands.test.mjs worker/test/*.test.mjs
```

Expected: all tests pass (the handler tests mock dependencies; handler.mjs change is covered by integration).

- [ ] **Step 4: Commit**

```
git add worker/src/handler.mjs
git commit -m "feat: /history entry point → buildHistoryCalendar"
```

---

## Verification

After all 5 tasks:

```
node --test test/commands.test.mjs worker/test/*.test.mjs
```

Expected output: all tests pass (was 582 before; now higher by the count of new tests added).

Key things to manually verify if deployed:
- `/history` command opens monthly calendar grid (not flat list)
- Tapping an active day opens day list with correct entries
- Tapping an entry shows full text with `⬅ Назад до <date>` back button
- ◀/▶ navigate to prev/next months that have events
- Empty cells and inactive day cells do nothing when tapped
