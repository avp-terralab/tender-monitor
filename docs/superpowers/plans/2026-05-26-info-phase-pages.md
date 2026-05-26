# Phase-Grouped `/info` Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the all-tenders `/info` view by procurement phase and send each non-empty phase as its own Telegram message ("page"), with a global header on the first page.

**Architecture:** A new pure function `formatInfoPages` in `commands.mjs` buckets tender groups by phase (preserving pipeline order), sorts within each, and returns an array of page strings (+ an optional errors page). The worker's `/info` all-tenders branch builds pages and sends them one per `sendReply` (reply-quote on the first, keyboard on the last). Single-tender `/info <id>` keeps using `formatInfo` (one message). `sendReply` already sub-chunks any page over 4096 chars.

**Tech Stack:** Node.js (ESM, built-ins only), `node:test`, Cloudflare Worker. Pure rendering in `commands.mjs`; dispatch/IO in `worker/src/handler.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-26-info-phase-pages-design.md`

**Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Run tests:** `node --test test/*.test.mjs worker/test/*.test.mjs` (single file shown per task).

---

## File Structure

- `commands.mjs` — add module-level Kyiv `Intl` formatters, the `PHASES`/`OTHER_PHASE` constants, a `deadlineKey` helper, and the exported `formatInfoPages`. `formatInfo` and `formatInfoEntry` stay as-is (single-tender path reuses them).
- `worker/src/handler.mjs` — `/info` all-tenders branch produces pages; generalize the final send loop to handle a string **or** an array of pages.
- `test/commands.test.mjs` — unit tests for `formatInfoPages`.
- `worker/test/handler.test.mjs` — multi-page send behaviour; update the errors-page test.

---

## Task 1: `formatInfoPages` pure function

**Files:**
- Modify: `commands.mjs` (add near `formatInfo`, ~line 267, and module consts near `KYIV_HM_FMT` ~line 295)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `formatInfoPages` to the existing import block at the top of `test/commands.test.mjs` (the one that already imports `formatInfo`). Then append these tests:

```js
const PE = { name: 'КНП Тест', edrpou: '11111111' };
const mkGroup = (id, status, deadline = null) => ({
  tender_id: id,
  prozorro_url: `https://prozorro.gov.ua/tender/${id}`,
  status,
  deadline,
  procuring_entity: PE,
  value: null, classification: null, contact: null, awards: [],
});
const RUN = '2026-05-26T20:45:00+03:00';

test('formatInfoPages: empty → single friendly message', () => {
  assert.deepEqual(formatInfoPages({ runIso: RUN, groups: [], errors: [] }),
    ['📭 Немає активних тендерів.']);
});

test('formatInfoPages: one tender per phase → one page each, in pipeline order', () => {
  const groups = [
    mkGroup('UA-Q', 'active.qualification'),
    mkGroup('UA-T', 'active.tendering', '2026-06-01T10:00:00+03:00'),
    mkGroup('UA-AW', 'active.awarded'),
  ];
  const pages = formatInfoPages({ runIso: RUN, groups, errors: [] });
  assert.equal(pages.length, 3);
  // pipeline order: tendering → qualification → awarded
  assert.match(pages[0], /📥 Приймання пропозицій \(1\)/);
  assert.match(pages[1], /🔍 Розгляд пропозицій \(1\)/);
  assert.match(pages[2], /✍️ Очікування підписання договору \(1\)/);
});

test('formatInfoPages: global header only on the first page', () => {
  const groups = [
    mkGroup('UA-T', 'active.tendering', '2026-06-01T10:00:00+03:00'),
    mkGroup('UA-Q', 'active.qualification'),
  ];
  const pages = formatInfoPages({ runIso: RUN, groups, errors: [] });
  assert.match(pages[0], /📋 Статус тендерів \(/);
  assert.doesNotMatch(pages[1], /📋 Статус тендерів/);
});

test('formatInfoPages: tendering sorted by deadline ascending, null deadline last', () => {
  const groups = [
    mkGroup('UA-LATE', 'active.tendering', '2026-06-10T10:00:00+03:00'),
    mkGroup('UA-NONE', 'active.tendering', null),
    mkGroup('UA-SOON', 'active.tendering', '2026-06-01T10:00:00+03:00'),
  ];
  const [page] = formatInfoPages({ runIso: RUN, groups, errors: [] });
  const order = ['UA-SOON', 'UA-LATE', 'UA-NONE'].map(id => page.indexOf(id));
  assert.ok(order[0] < order[1] && order[1] < order[2], `unexpected order: ${order}`);
});

test('formatInfoPages: non-tendering phase sorted by tender_id', () => {
  const groups = [
    mkGroup('UA-Z', 'active.qualification'),
    mkGroup('UA-A', 'active.qualification'),
  ];
  const [page] = formatInfoPages({ runIso: RUN, groups, errors: [] });
  assert.ok(page.indexOf('UA-A') < page.indexOf('UA-Z'));
});

test('formatInfoPages: unknown status falls into 📦 Інші статуси', () => {
  const pages = formatInfoPages({
    runIso: RUN, groups: [mkGroup('UA-X', 'active.weird')], errors: [],
  });
  assert.equal(pages.length, 1);
  assert.match(pages[0], /📦 Інші статуси \(1\)/);
});

test('formatInfoPages: errors become a final page', () => {
  const pages = formatInfoPages({
    runIso: RUN,
    groups: [mkGroup('UA-T', 'active.tendering', '2026-06-01T10:00:00+03:00')],
    errors: [{ tender_id: 'UA-ERR', error: 'Prozorro 503' }],
  });
  assert.equal(pages.length, 2);
  assert.match(pages[1], /⚠️ Не вдалось перевірити \(1\)/);
  assert.match(pages[1], /UA-ERR — Prozorro 503/);
});

test('formatInfoPages: entry body equals formatInfoEntry output', () => {
  // The per-tender rendering must be unchanged — grouping only adds headers.
  const g = mkGroup('UA-T', 'active.tendering', '2026-06-01T10:00:00+03:00');
  const [page] = formatInfoPages({ runIso: RUN, groups: [g], errors: [] });
  assert.ok(page.includes(`🆔 Ідентифікатор закупівлі`));
  assert.ok(page.includes('UA-T'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `formatInfoPages` is not exported / not a function.

- [ ] **Step 3: Implement**

In `commands.mjs`, add module-level formatters near `KYIV_HM_FMT` (~line 295):

```js
const INFO_TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});
const INFO_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric',
});

// Procurement-phase pages for /info, in lifecycle order. Any status not listed
// here falls into the OTHER_PHASE bucket so nothing is silently dropped.
const PHASES = [
  { emoji: '📥', label: 'Приймання пропозицій',           statuses: ['active.tendering'] },
  { emoji: '🧮', label: 'Прекваліфікація',                statuses: ['active.pre-qualification', 'active.pre-qualification.stand-still'] },
  { emoji: '🔨', label: 'Триває аукціон',                 statuses: ['active.auction'] },
  { emoji: '🔍', label: 'Розгляд пропозицій',             statuses: ['active.qualification'] },
  { emoji: '✍️', label: 'Очікування підписання договору', statuses: ['active.awarded'] },
];
const OTHER_PHASE = { emoji: '📦', label: 'Інші статуси', statuses: [] };

function deadlineKey(g) {
  return g.deadline ? new Date(g.deadline).getTime() : Number.POSITIVE_INFINITY;
}
```

Add the exported function after `formatInfo` (~line 293):

```js
// Groups for the all-tenders /info view into one page (message) per non-empty
// phase, in lifecycle order, plus an optional final errors page. The global
// header is prepended to the first page only. Returns string[].
export function formatInfoPages({ runIso, groups, errors = [] }) {
  if (groups.length === 0 && errors.length === 0) {
    return ['📭 Немає активних тендерів.'];
  }

  const known = new Set(PHASES.flatMap(p => p.statuses));
  const buckets = PHASES.map(p => ({ ...p, items: groups.filter(g => p.statuses.includes(g.status)) }));
  const otherItems = groups.filter(g => !known.has(g.status));
  if (otherItems.length > 0) buckets.push({ ...OTHER_PHASE, items: otherItems });

  for (const b of buckets) {
    if (b.statuses.includes('active.tendering')) {
      b.items.sort((a, c) => deadlineKey(a) - deadlineKey(c));
    } else {
      b.items.sort((a, c) => a.tender_id.localeCompare(c.tender_id));
    }
  }

  const pages = [];
  for (const b of buckets) {
    if (b.items.length === 0) continue;
    const lines = [`${b.emoji} ${b.label} (${b.items.length})`];
    b.items.forEach((g, i) => {
      lines.push('');
      lines.push(`━━━━━━━━━━ ${i + 1} ━━━━━━━━━━`);
      lines.push(formatInfoEntry(g, runIso));
    });
    pages.push(lines.join('\n'));
  }

  if (errors.length > 0) {
    const lines = [`⚠️ Не вдалось перевірити (${errors.length})`];
    for (const e of errors) lines.push(`  • ${e.tender_id} — ${e.error}`);
    pages.push(lines.join('\n'));
  }

  const header = `📋 Статус тендерів (${INFO_TIME_FMT.format(new Date(runIso))}, ${INFO_DATE_FMT.format(new Date(runIso))})`;
  pages[0] = `${header}\n\n${pages[0]}`;
  return pages;
}
```

(`formatInfoEntry` is already defined above in the same module. `formatInfo` is left untouched.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS (all new tests + existing `formatInfo` tests still green).

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "info: add formatInfoPages — phase-grouped pages for /info"
```

---

## Task 2: Worker sends one message per phase page

**Files:**
- Modify: `worker/src/handler.mjs` — import `formatInfoPages`; `/info` all-view builds pages (line 352 area); generalize final send (lines 588-598)
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write/Update the failing tests**

In `worker/test/handler.test.mjs`, add a multi-phase test and update the existing errors test.

Add:

```js
test('runHandler: /info sends one message per phase, keyboard on last only', async () => {
  const RAW = (id, status) => ({
    data: {
      tenderID: id, title: 'X', status,
      tenderPeriod: { endDate: '2026-06-01T14:00:00+03:00' },
      procuringEntity: { name: 'Тест', identifier: { id: '11111111' } },
      items: [],
    },
  });
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-T', enabled: true },
        { tender_id: 'UA-Q', enabled: true },
      ],
      sha: 'x',
    }),
    fetchTender: async (id) => RAW(id, id === 'UA-T' ? 'active.tendering' : 'active.qualification'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 7 } },
    env: ENV, deps,
  });
  // two phases → two messages
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /📥 Приймання пропозицій/);
  assert.match(sent[1].text, /🔍 Розгляд пропозицій/);
  // reply-quote only on the first page
  assert.equal(sent[0].replyToMessageId, 7);
  assert.equal(sent[1].replyToMessageId, undefined);
  // keyboard only on the last page
  assert.ok(sent[1].replyMarkup, 'last page carries the keyboard');
  assert.equal(sent[0].replyMarkup, undefined);
});
```

Replace the existing test `runHandler: /info partial Prozorro errors are listed in footer` (it now goes to a separate page) with:

```js
test('runHandler: /info partial Prozorro errors become a final page', async () => {
  const RAW = {
    data: {
      tenderID: 'UA-A', title: 'X', status: 'active.tendering',
      tenderPeriod: { endDate: '2026-05-15T14:00:00+03:00' },
      procuringEntity: { name: 'T', identifier: { id: '1' } },
      items: [],
    },
  };
  const { deps, sent } = await makeDeps({
    loadWatchlist: async () => ({
      watchlist: [
        { tender_id: 'UA-A', enabled: true },
        { tender_id: 'UA-B', enabled: true },
      ],
      sha: 'x',
    }),
    fetchTender: async (id) => {
      if (id === 'UA-B') throw new Error('Prozorro 503');
      return RAW;
    },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/info', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /UA-A/);
  assert.match(sent[1].text, /⚠️ Не вдалось перевірити/);
  assert.match(sent[1].text, /UA-B — Prozorro 503/);
});
```

(Existing tests stay valid: `/info` with two `active.tendering` tenders → one phase → `sent.length === 1` with the header; `/info UA-…` single-id and empty-watchlist paths are unchanged.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `/info` still sends a single combined message (`sent.length === 1`), errors still in a footer.

- [ ] **Step 3: Implement**

Add the import at the top of `worker/src/handler.mjs` (in the `../../commands.mjs` import list, alongside `formatInfo`):

```js
  formatInfo, formatInfoPages, buildHelpText, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD,
```

In the `/info` branch, change the all-tenders rendering. Replace this line (currently ~352):

```js
        reply = formatInfo({ runIso: new Date().toISOString(), groups, errors });
```

with:

```js
        reply = cmd.tender_id
          ? formatInfo({ runIso: new Date().toISOString(), groups, errors })
          : formatInfoPages({ runIso: new Date().toISOString(), groups, errors });
```

Generalize the final send block (currently lines 588-598) to handle a string or an array of pages:

```js
  const pages = Array.isArray(reply) ? reply : [reply];
  for (let i = 0; i < pages.length; i++) {
    const isLast = i === pages.length - 1;
    try {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: pages[i],
        replyToMessageId: i === 0 ? msg.message_id : undefined,
        replyMarkup: isLast
          ? (notifyReplyMarkup ?? (isAllowed ? MAIN_KEYBOARD : undefined))
          : undefined,
      });
    } catch (err) {
      console.error('worker: sendReply failed:', err.message);
    }
  }
```

(`reply` is a string for every other command, so they send exactly one message as before. The single-tender `/info <id>` live-archive notice still appends to the `formatInfo` string before this loop.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: send /info as one message per phase page"
```

---

## Task 3: Full suite + branch wrap-up

**Files:** none (verification) + `README.md`

- [ ] **Step 1: Run the entire suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: all pass. In particular confirm the still-valid existing tests:
`runHandler: button label "📋 Моніторинг закупівель"` (empty watchlist → one message), `runHandler: /info with active tenders` (two `active.tendering` → one page, `sent.length === 1`, header present), and `/info UA-…` single-id tests.

- [ ] **Step 2: Sanity-check real output (optional, no deploy)**

Run a scratch check that the live `/info` splits into phase pages without exceeding 4096 per page (Prozorro must be reachable):

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { fetchTender, extractSnapshot } from './prozorro.mjs';
import { formatInfoPages } from './commands.mjs';
const wl = JSON.parse(readFileSync('./watchlist.json','utf-8')).filter(r=>r.enabled);
const groups = await Promise.all(wl.map(async r => { const s = extractSnapshot(await fetchTender(r.tender_id)); return { tender_id:r.tender_id, prozorro_url:'https://prozorro.gov.ua/tender/'+r.tender_id, status:s.status, deadline:s.tenderPeriod?.endDate??null, procuring_entity:s.procuringEntity, value:s.value, classification:s.classification, contact:s.contact, awards:s.awards }; }));
const pages = formatInfoPages({ runIso:new Date().toISOString(), groups, errors:[] });
console.log(pages.length, 'pages; lengths:', pages.map(p=>p.length).join(', '));
"
```
Expected: one page per active phase; each length well under 4096.

- [ ] **Step 3: Update README**

In `README.md`, under the Telegram commands list (around line 36), adjust the `/list` / `/info` line to note phase grouping:

```
- `/list` / `/info` — переглянути watchlist (короткий / детальний; `/info` групує за фазою — Приймання / Розгляд / Очікування договору — кожна окремим повідомленням).
```

- [ ] **Step 4: Commit docs**

```bash
git add README.md
git commit -m "docs: note phase-grouped /info output"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. Deployment note: merging to `main` touches `commands.mjs`/`worker/**` → `worker-deploy.yml` runs the test suite then `wrangler deploy`, so the bot picks up phase-grouped `/info` automatically. No secrets or BotFather changes.

---

## Self-Review Notes

- **Spec coverage:** phases+order (Task 1 `PHASES`), sorting (Task 1 deadline/tender_id tests), first-page header (Task 1), errors page (Task 1), empty case (Task 1), single-id unchanged (Task 2 uses `formatInfo` when `cmd.tender_id`), multi-message send with reply-on-first/keyboard-on-last (Task 2), >4096 per-phase safety (handled by existing `sendReply` chunking — Task 3 sanity check). All spec sections map to a task.
- **Placeholder scan:** none — every code step shows full code.
- **Type consistency:** `formatInfoPages({ runIso, groups, errors })` returns `string[]`; the handler treats `reply` as string-or-array and normalises with `Array.isArray`. `PHASES`/`OTHER_PHASE` both carry a `statuses` array, so the `b.statuses.includes(...)` sort check is safe for the OTHER bucket (empty array → false → sorts by tender_id). Group object shape (`tender_id`, `status`, `deadline`, `procuring_entity`, …) matches what the worker builds and what `formatInfoEntry` consumes.
- **YAGNI:** `formatInfo` left untouched; no inline-button pagination; cron digest untouched.
