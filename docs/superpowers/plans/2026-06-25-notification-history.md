# Notification History (Feature B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactive digests live 24h then move to a 📜 Історія view; deadline reminders go out as separate messages and are just deleted (never archived).

**Architecture:** The monitor (`ci.mjs`→`monitor.mjs`, GHA cron) splits deadline events into their own broadcast, logs each broadcast (recipients+text+summary) to `_state/notification_history.json`, and on each run deletes >24h-old messages via `deleteMessage` (digests stay in history, deadlines are dropped); cap 200 digests, newest-first. The worker (Cloudflare) adds a 📜 Історія button + `/history` command + a `hist:` paginated list→detail view.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Cloudflare Worker, GitHub Contents API, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-06-25-notification-history-design.md`

**Baselines:** commands 381, telegram 88, monitor 50, handler 185, github 39 (all 0 fail).

**Data model** (`_state/notification_history.json`): `{ items: [...] }`, newest-first. Each item:
`{ sent_at:ISO, type:'digest'|'deadline', summary:string, text:string, recipients:[{chat_id,message_id}], deleted:bool }`.

---

## Task 1: telegram.mjs — broadcastDigest returns recipients + formatDeadlineReminder + summarizeDigest

**Files:** Modify `telegram.mjs` · Test `test/telegram.test.mjs`

- [ ] **Step 1: Failing tests** — add the 3 names to the import, append:

```javascript
test('broadcastDigest: returns [{chat_id, message_id}] from each sent message', async () => {
  let n = 0;
  const sent = async ({ chatId }, text) => ({ ok: true, result: { message_id: 100 + (n++) } });
  // sendDigest is internal; broadcastDigest calls it. Use a fake fetch instead:
  let mid = 500;
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: mid++ } }) });
  const r = await broadcastDigest({ token: 'T', chatIds: ['11', { chatId: '22', role: 'viewer' }], fetch: fakeFetch }, 'hi');
  assert.deepEqual(r, [{ chat_id: '11', message_id: 500 }, { chat_id: '22', message_id: 501 }]);
});

test('broadcastDigest: a failing chat is skipped (not in result)', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) throw new Error('blocked');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  const r = await broadcastDigest({ token: 'T', chatIds: ['11', '22'], fetch: fakeFetch }, 'hi');
  assert.deepEqual(r, [{ chat_id: '22', message_id: 9 }]);
});

test('formatDeadlineReminder: header + a line per tender', () => {
  const t = formatDeadlineReminder([
    { tender_id: 'UA-2026-06-19-008800-a', entity: 'КНП МКЛ №1', deadline: '27.06 17:00' },
  ]);
  assert.match(t, /24 год/);
  assert.match(t, /UA-2026-06-19-008800-a/);
  assert.match(t, /КНП МКЛ №1/);
});

test('summarizeDigest: compact emoji·count per headline type', () => {
  const groups = [
    { events: [{ type: 'new_tender_announced' }] },
    { events: [{ type: 'new_tender_announced' }, { type: 'status_changed' }] },
  ];
  assert.equal(summarizeDigest(groups), '📥 2 · 🔄 1');
  assert.equal(summarizeDigest([]), '🔔 оновлення');
});
```

- [ ] **Step 2: Run — FAIL.** `node --test test/telegram.test.mjs` → `broadcastDigest`/`formatDeadlineReminder`/`summarizeDigest` mismatch (broadcastDigest returns undefined; the two fns missing).

- [ ] **Step 3: Implement in `telegram.mjs`**

3a. Replace the `broadcastDigest` body to collect + return recipients:
```javascript
export async function broadcastDigest({ token, chatIds, fetch: fetchImpl = fetch }, text, opts) {
  const recipients = [];
  for (const recipient of chatIds) {
    const isObj = typeof recipient === 'object' && recipient !== null;
    const chatId = isObj ? recipient.chatId : recipient;
    const role = isObj ? recipient.role : null;
    const effectiveOpts = role === 'viewer' && opts
      ? { ...opts, addButtonsForTenders: [] }
      : (opts ? { ...opts, role } : opts);
    try {
      const res = await sendDigest({ token, chatId, fetch: fetchImpl }, text, effectiveOpts);
      const mid = res?.result?.message_id;
      if (mid != null) recipients.push({ chat_id: String(chatId), message_id: mid });
    } catch (err) {
      console.error(`broadcastDigest to ${chatId} failed:`, err.message);
    }
  }
  return recipients;
}
```

3b. Add after `formatDigest` (near the other formatters):
```javascript
// Separate "24h to submission deadline" reminder — sent on its own (NOT in the
// digest) so it can be deleted after 24h without archiving it to history.
export function formatDeadlineReminder(tenders) {
  const lines = ['⏰ Залишилось 24 год до завершення приймання пропозицій:'];
  for (const t of tenders ?? []) {
    const ent = t.entity ? ` · ${escapeHtml(t.entity)}` : '';
    const dl = t.deadline ? ` · до ${escapeHtml(t.deadline)}` : '';
    lines.push(`🆔 ${escapeHtml(t.tender_id)}${ent}${dl}`);
  }
  return lines.join('\n');
}

// One-line summary of a digest's events for the history list row.
const SUMMARY_TYPES = [
  ['new_tender_announced', '📥'],
  ['status_changed', '🔄'],
  ['award_qualified', '🏆'],
  ['contract_signed', '✍️'],
];
export function summarizeDigest(groups) {
  const counts = new Map();
  for (const g of groups ?? []) for (const e of (g.events ?? [])) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts = SUMMARY_TYPES.filter(([t]) => counts.get(t)).map(([t, emoji]) => `${emoji} ${counts.get(t)}`);
  if (parts.length) return parts.join(' · ');
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return total ? `📌 ${total}` : '🔔 оновлення';
}
```
(`escapeHtml` is already exported from telegram.mjs — used by formatDigest.)

- [ ] **Step 4: Run — PASS.** `node --test test/telegram.test.mjs` → 92, 0 fail. (Existing broadcastDigest tests that ignored the return value still pass.)

- [ ] **Step 5: Commit**
```bash
git add telegram.mjs test/telegram.test.mjs
git commit -m "feat(notif): broadcastDigest returns recipients; formatDeadlineReminder + summarizeDigest"
```

---

## Task 2: commands.mjs — 📜 history view builders + button + /history

**Files:** Modify `commands.mjs` · Test `test/commands.test.mjs`

- [ ] **Step 1: Failing tests** — add `buildHistoryList, buildHistoryItem, handleHistoryNav, mainKeyboard, parseCommand` (some already imported) and append:

```javascript
const histItems = (n) => Array.from({ length: n }, (_, i) => ({
  sent_at: `2026-06-25T0${i % 6}:55:00.000Z`, type: 'digest',
  summary: `📥 ${i + 1}`, text: `<b>Дайджест ${i}</b>`, recipients: [], deleted: false,
}));

test('buildHistoryList: empty → 📭', () => {
  assert.equal(buildHistoryList({ items: [], page: 0 }).keyboard, null);
  assert.match(buildHistoryList({ items: [], page: 0 }).text, /порожня/);
});

test('buildHistoryList: digests only, 6/page, hist:i rows + nav', () => {
  const items = [...histItems(8), { type: 'deadline', summary: 'x', text: 'y', sent_at: 't', recipients: [], deleted: false }];
  const v = buildHistoryList({ items, page: 0 });
  const rows = v.keyboard.inline_keyboard;
  assert.equal(rows[0][0].callback_data, 'hist:i:0');
  assert.match(rows[0][0].text, /📥 1/);
  const nav = rows.find((r) => r.some((b) => b.callback_data === 'hist:noop'));
  assert.ok(nav.some((b) => b.text === 'Далі ▶'));   // 8 digests → 2 pages
});

test('buildHistoryItem: full text + back', () => {
  const v = buildHistoryItem({ items: histItems(3), idx: 1 });
  assert.match(v.text, /Дайджест 1/);
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'hist:p:0');
});

test('handleHistoryNav: noop→null; p/i routing', () => {
  const items = histItems(3);
  assert.equal(handleHistoryNav({ items, data: 'hist:noop' }), null);
  assert.match(handleHistoryNav({ items, data: 'hist:p:0' }).text, /Історія сповіщень/);
  assert.match(handleHistoryNav({ items, data: 'hist:i:0' }).text, /Дайджест 0/);
});

test('mainKeyboard: has 📜 Історія; parseCommand /history', () => {
  assert.match(JSON.stringify(mainKeyboard('admin')), /📜 Історія/);
  assert.deepEqual(parseCommand('/history'), { cmd: 'history' });
  assert.deepEqual(parseCommand('📜 Історія'), { cmd: 'history' });
});
```

- [ ] **Step 2: Run — FAIL.** `node --test test/commands.test.mjs` → builders missing / no 📜 button / `/history` unknown.

- [ ] **Step 3: Implement in `commands.mjs`**

3a. Add `'📜 Історія': 'history'` to `BUTTON_ALIASES`.

3b. In `MAIN_KEYBOARD` and `mainKeyboard(role)` add `{ text: '📜 Історія' }` to the SECOND row (both the non-admin keyboard's bottom row and the admin variant — put it before the help button). Use the existing keyboard structure; the second row becomes e.g. `[{ text: '📜 Історія' }, { text: '❓ Допомога (список команд)' }]` for non-admin, and `[{ text: '🤖 Агент' }, { text: '📜 Історія' }, { text: '❓ Допомога (список команд)' }]` for admin.

3c. In `parseCommand`, add next to the other no-arg patterns:
```javascript
  if (/^\/history(?:@\w+)?$/i.test(trimmed)) return { cmd: 'history' };
```

3d. Add the pure view functions (place near the archive builders):
```javascript
const HIST_PER_PAGE = 6;
const HIST_DT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

// Only digests are kept in history; newest-first is the storage order.
function historyDigests(items) {
  return (items ?? []).filter((it) => it.type === 'digest');
}

export function buildHistoryList({ items, page = 0 }) {
  const list = historyDigests(items);
  if (list.length === 0) return { text: '📭 Історія сповіщень порожня.', keyboard: null };
  const pages = Math.max(1, Math.ceil(list.length / HIST_PER_PAGE));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const start = p * HIST_PER_PAGE;
  const slice = list.slice(start, start + HIST_PER_PAGE);
  const rows = slice.map((it, i) => {
    const when = it.sent_at ? HIST_DT.format(new Date(it.sent_at)) : '—';
    return [{ text: `🔔 ${when} · ${it.summary ?? ''}`.trim(), callback_data: `hist:i:${start + i}` }];
  });
  const nav = buildPageNavRow(p, pages, (x) => `hist:p:${x}`, 'hist:noop');
  if (nav) rows.push(nav);
  return { text: `📜 <b>Історія сповіщень</b> — ${list.length}`, keyboard: { inline_keyboard: rows } };
}

export function buildHistoryItem({ items, idx }) {
  const list = historyDigests(items);
  const it = list[idx];
  if (!it) return buildHistoryList({ items, page: 0 });
  return { text: it.text ?? '(порожньо)', keyboard: { inline_keyboard: [[{ text: '⬅ Назад до історії', callback_data: 'hist:p:0' }]] } };
}

export function handleHistoryNav({ items, data }) {
  if (data === 'hist:noop') return null;
  const parts = data.split(':'); // hist:p:<page> | hist:i:<idx>
  if (parts[1] === 'i') return buildHistoryItem({ items, idx: Number(parts[2]) });
  if (parts[1] === 'p') return buildHistoryList({ items, page: Number(parts[2] ?? 0) });
  return buildHistoryList({ items, page: 0 });
}
```
(`buildPageNavRow` already exists in commands.mjs — the shared pagination helper. `idx` in the list row is the GLOBAL index into `historyDigests`, so `buildHistoryItem` uses the same `historyDigests(items)[idx]`.)

- [ ] **Step 4: Run — PASS.** `node --test test/commands.test.mjs` → 386, 0 fail. (Existing `mainKeyboard` tests may assert the old rows — if any break because of the new 📜 button, update them to include it.)

- [ ] **Step 5: Commit**
```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(notif): 📜 Історія button + history list/detail view builders"
```

---

## Task 3: worker/src/github.mjs — loadNotificationHistory

**Files:** Modify `worker/src/github.mjs` · Test `worker/test/github.test.mjs`

- [ ] **Step 1: Failing tests** — add `loadNotificationHistory` to the import, append:

```javascript
test('loadNotificationHistory: parses items', async () => {
  const json = JSON.stringify({ items: [{ type: 'digest', text: 'x' }] });
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ content: Buffer.from(json).toString('base64'), sha: 's' }) });
  const r = await loadNotificationHistory(ENV, { fetch: fakeFetch });
  assert.deepEqual(r, { items: [{ type: 'digest', text: 'x' }] });
});

test('loadNotificationHistory: 404 → empty', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  assert.deepEqual(await loadNotificationHistory(ENV, { fetch: fakeFetch }), { items: [] });
});
```

- [ ] **Step 2: Run — FAIL.** `node --test worker/test/github.test.mjs` → `loadNotificationHistory is not a function`.

- [ ] **Step 3: Implement in `worker/src/github.mjs`** (after `loadArchivedTenders`):
```javascript
const NOTIFICATION_HISTORY_FILE = '_state/notification_history.json';

// History of proactive digests (written by the monitor) — for the worker's
// 📜 Історія view. Missing file → { items: [] }.
export async function loadNotificationHistory(env, opts = {}) {
  const { content } = await loadFile(env, NOTIFICATION_HISTORY_FILE, opts);
  if (content === null) return { items: [] };
  try {
    const parsed = JSON.parse(content);
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}
```

- [ ] **Step 4: Run — PASS.** `node --test worker/test/github.test.mjs` → 41, 0 fail.

- [ ] **Step 5: Commit**
```bash
git add worker/src/github.mjs worker/test/github.test.mjs
git commit -m "feat(notif): loadNotificationHistory (worker reads the history file)"
```

---

## Task 4: worker/src/handler.mjs — /history command + hist: callback + ephemeral

**Files:** Modify `worker/src/handler.mjs` · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Failing tests** — add:

```javascript
test('runHandler: /history → list with hist:i button', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '/history', from: { id: 123 } } },
    env: ENV,
    deps: { ...makeDeps({ loadNotificationHistory: async () => ({ items: [{ type: 'digest', summary: '📥 1', text: 'D', sent_at: '2026-06-25T05:55:00Z', recipients: [], deleted: false }] }) }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].replyMarkup), /hist:i:0/);
});

test('runHandler: hist:i:0 → edits to the full digest text', async () => {
  const edits = []; const acks = [];
  await runHandler({
    update: { callback_query: { id: 'ch1', data: 'hist:i:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: { ...makeDeps({ loadNotificationHistory: async () => ({ items: [{ type: 'digest', summary: 's', text: 'ПОВНИЙ ТЕКСТ', sent_at: 't', recipients: [], deleted: false }] }) }).deps,
      editMessageText: async (a) => edits.push(a), answerCallbackQuery: async (a) => acks.push(a) },
  });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /ПОВНИЙ ТЕКСТ/);
  assert.equal(acks.length, 1);
});
```

- [ ] **Step 2: Run — FAIL.** `/history` is unknown (`❓ Не розумію`); `hist:` callback → `❓ Невідома кнопка`.

- [ ] **Step 3: Implement**

3a. Commands import: add `buildHistoryList, handleHistoryNav`. Github import: add `loadNotificationHistory`. Dep alias (with the others): `const _loadNotificationHistory = deps.loadNotificationHistory ?? loadNotificationHistory;`.

3b. Add `'history'` to `EPHEMERAL_VIEW_CMDS` (line 48): `new Set(['info', 'watched', 'archive', 'agent', 'help', 'status', 'whoami', 'history'])`.

3c. Add the accumulator near the others: `let histReplyMarkup = null;` and slot it into the send-markup `??` chain (after `forceReplyMarkup`):
```javascript
          ? (forceReplyMarkup ?? histReplyMarkup ?? archiveReplyMarkup ?? agentReplyMarkup ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
```

3d. Add the command branch (near `cmd.cmd === 'help'`):
```javascript
  } else if (cmd.cmd === 'history') {
    try {
      const { items } = await _loadNotificationHistory(env);
      const view = buildHistoryList({ items, page: 0 });
      reply = view.text;
      histReplyMarkup = view.keyboard ?? undefined;
    } catch (err) {
      console.error('worker: /history failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  }
```

3e. Add the callback branch in `handleCallbackQuery` (immediately before the `arch:` branch):
```javascript
  if (data.startsWith('hist:')) {
    if (data === 'hist:noop') { await ack(); return; }
    let items = [];
    try {
      ({ items } = await _loadNotificationHistory(env));
    } catch (err) {
      console.error('worker: hist nav load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleHistoryNav({ items, data });
    if (view) {
      try {
        await _editMessageText({ token: env.TELEGRAM_BOT_TOKEN, chatId, messageId, text: view.text, replyMarkup: view.keyboard ?? undefined });
      } catch (err) {
        console.error('worker: hist nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }
```
(`_loadNotificationHistory` must be passed into `handleCallbackQuery` — add it to that function's destructured params and to the call site, mirroring how `_loadArchivedTenders` is threaded.)

- [ ] **Step 4: Run — PASS.** `node --test worker/test/handler.test.mjs` → 187, 0 fail. `node --test test/commands.test.mjs` → 386.

- [ ] **Step 5: Commit**
```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(notif): /history command + hist: callback (ephemeral history view)"
```

---

## Task 5: monitor.mjs — split deadlines, log broadcasts, expire >24h, cap 200

**Files:** Modify `monitor.mjs` · Test `test/monitor.test.mjs`

Injected deps used here (added to `runOnce` via `deps.*`, like the existing optional deps): `deps.loadNotificationHistory` → `{ items }`, `deps.saveNotificationHistory(obj)`, `deps.deleteMessage({ token?, chatId, messageId })` (the monitor already has the token via its send deps; pass a bound `deleteMessage(chatId, messageId)` from ci.mjs), and `deps.now` (a `Date`, defaulting to `new Date(runIso)`). Import `formatDeadlineReminder`, `summarizeDigest` from `./telegram.mjs`.

- [ ] **Step 1: Failing tests** — add to `test/monitor.test.mjs` (mirror the existing dep-stub style):

```javascript
test('runOnce: deadline events go out as a separate broadcast and are logged type=deadline', async () => {
  const broadcasts = [];   // [{text, recipients}]
  const saved = [];
  const deps = baseDeps({
    // a watchlist tender that produced a deadline_approaching event this cycle
    sendDigest: async (text) => { broadcasts.push(text); return [{ chat_id: '1', message_id: broadcasts.length }]; },
    loadNotificationHistory: async () => ({ items: [] }),
    saveNotificationHistory: async (obj) => { saved.push(obj); },
    deleteMessage: async () => true,
    now: new Date('2026-06-25T06:00:00Z'),
  });
  // ... arrange a tender whose diff yields a deadline_approaching event ...
  await runOnce(deps);
  // a deadline reminder broadcast happened, and a digest WITHOUT the deadline line
  assert.ok(broadcasts.some((t) => /24 год/.test(t)), broadcasts);
  const items = saved.at(-1).items;
  assert.ok(items.some((i) => i.type === 'deadline'));
});

test('expire: items older than 24h are deleted (deleteMessage called), deadlines dropped, digests kept', async () => {
  const deletedIds = [];
  const old = { sent_at: '2026-06-24T00:00:00Z', type: 'digest', summary: 's', text: 'd', recipients: [{ chat_id: '1', message_id: 7 }], deleted: false };
  const oldDeadline = { sent_at: '2026-06-24T00:00:00Z', type: 'deadline', summary: 's', text: 'r', recipients: [{ chat_id: '1', message_id: 8 }], deleted: false };
  const saved = [];
  const deps = baseDeps({
    loadNotificationHistory: async () => ({ items: [old, oldDeadline] }),
    saveNotificationHistory: async (obj) => { saved.push(obj); },
    deleteMessage: async (chatId, messageId) => { deletedIds.push(messageId); return true; },
    now: new Date('2026-06-25T12:00:00Z'),
    sendDigest: async () => [],
  });
  await runOnce(deps);
  assert.deepEqual(deletedIds.sort(), [7, 8], 'both >24h messages deleted');
  const items = saved.at(-1).items;
  assert.ok(items.find((i) => i.type === 'digest')?.deleted === true, 'digest kept, marked deleted');
  assert.ok(!items.some((i) => i.type === 'deadline'), 'deadline dropped');
});
```
NOTE: the implementer adapts `baseDeps(...)` to the file's existing stub factory (the test file already builds a deps object; extend it with the new keys). Arranging a real `deadline_approaching` event requires a watchlist row whose previous vs current snapshot crosses the 24h threshold — reuse the file's existing fixtures for that diff; if too involved, split into (a) a focused unit test of a new pure `expireHistory(items, now, deleteMessage)` helper and (b) a smaller integration check. Prefer extracting `expireHistory` + `logBroadcast` as pure-ish helpers so they're unit-testable without the full diff machinery.

- [ ] **Step 2: Run — FAIL.** `node --test test/monitor.test.mjs`.

- [ ] **Step 3: Implement in `monitor.mjs`**

3a. Near the top, import + a cap/TTL const:
```javascript
import { formatDigest, formatHeartbeat, formatNightDigest, formatDeadlineReminder, summarizeDigest } from './telegram.mjs';
const HISTORY_CAP = 200;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
```

3b. Add two pure-ish helpers (exported for tests):
```javascript
// Delete messages older than ttl; drop expired deadline items, keep digests
// (marked deleted), and cap digests to `cap` (newest-first). deleteMessage is
// best-effort (errors ignored).
export async function expireHistory(items, now, deleteMessage, { ttlMs = HISTORY_TTL_MS, cap = HISTORY_CAP } = {}) {
  const out = [];
  for (const it of items ?? []) {
    const age = now - new Date(it.sent_at).getTime();
    if (!it.deleted && age > ttlMs) {
      for (const r of it.recipients ?? []) {
        try { await deleteMessage(r.chat_id, r.message_id); } catch { /* best-effort */ }
      }
      it.deleted = true;
    }
    if (it.type === 'deadline' && it.deleted) continue;   // drop expired deadlines
    out.push(it);
  }
  const digests = out.filter((i) => i.type === 'digest').slice(0, cap);
  const keepDigest = new Set(digests);
  return out.filter((i) => i.type !== 'digest' || keepDigest.has(i));
}

// Prepend a new item (newest-first).
export function logBroadcast(items, item) {
  return [item, ...(items ?? [])];
}
```

3c. In `runOnce`, near the start (after loading state), expire:
```javascript
  const now = deps.now ?? new Date(runIso);
  let history = (deps.loadNotificationHistory ? (await deps.loadNotificationHistory()).items : []) ?? [];
  if (deps.deleteMessage) {
    history = await expireHistory(history, now.getTime?.() ?? now, deps.deleteMessage);
  }
```

3d. Where the digest is built/sent (~line 263-299): BEFORE `formatDigest`, split deadline events:
- Compute `deadlineTenders` = groups that have a `deadline_approaching` event → `{ tender_id, entity: g.procuring_entity?.name, deadline: <formatted endDate> }`.
- Remove `deadline_approaching` events from each group's `events` (so they don't render in the digest); drop groups that become empty.
- If `deadlineTenders.length`: `const dRec = await sendDigest(formatDeadlineReminder(deadlineTenders));` then `history = logBroadcast(history, { sent_at: now.toISOString(), type: 'deadline', summary: `⏰ ${deadlineTenders.length}`, text: formatDeadlineReminder(deadlineTenders), recipients: dRec ?? [], deleted: false });`
- After the existing digest `sendDigest(text, ...)` for the remaining groups: capture its return `const rec = await sendDigest(text, ...);` and `history = logBroadcast(history, { sent_at: now.toISOString(), type: 'digest', summary: summarizeDigest(groups), text, recipients: rec ?? [], deleted: false });`
(Apply the same logging to the night-buffer morning flush path at ~line 254.)

3e. At the end of `runOnce`, persist history: `if (deps.saveNotificationHistory) await deps.saveNotificationHistory({ items: history });`

- [ ] **Step 4: Run — PASS.** `node --test test/monitor.test.mjs` → 52, 0 fail (existing 50 + 2). Existing tests pass because the new deps (loadNotificationHistory/saveNotificationHistory/deleteMessage) are optional — when absent, expire/log are skipped.

- [ ] **Step 5: Commit**
```bash
git add monitor.mjs test/monitor.test.mjs
git commit -m "feat(notif): monitor splits deadlines, logs digests, expires >24h (cap 200)"
```

---

## Task 6: ci.mjs — wire the monitor deps (no new test; config glue)

**Files:** Modify `ci.mjs`

- [ ] **Step 1: Implement** — in `ci.mjs`, alongside `loadState`/`saveState` (~lines 68-112), add local-file helpers + bind deleteMessage, and pass them to `runOnce`:
```javascript
import { ..., broadcastDigest, deleteMessage } from './telegram.mjs';   // add deleteMessage
const NOTIF_HISTORY_PATH = join(stateDir, 'notification_history.json');  // mirror the other _state paths
// ... within the deps object passed to runOnce:
  loadNotificationHistory: async () => {
    try { return JSON.parse(readFileSync(NOTIF_HISTORY_PATH, 'utf8')); }
    catch { return { items: [] }; }
  },
  saveNotificationHistory: async (obj) => {
    writeFileSync(NOTIF_HISTORY_PATH, JSON.stringify(obj, null, 2) + '\n');
  },
  deleteMessage: async (chatId, messageId) => deleteMessage({ token, chatId, messageId }),
  now: new Date(runIso),
```
(Use the same `readFileSync`/`writeFileSync`/`join`/`stateDir` imports/vars the existing loadState/saveState use — match the file's actual helpers. `token` is the bot token already in scope for broadcastDigest.)

- [ ] **Step 2: Verify** — `node --test test/*.test.mjs worker/test/*.test.mjs` → all green. (ci.mjs has no unit tests; the monitor logic is covered in Task 5. Smoke: `node -e "import('./ci.mjs')"` must not throw on import — but ci.mjs runs on import, so instead just confirm the repo's full test suite passes.)

- [ ] **Step 3: Commit**
```bash
git add ci.mjs
git commit -m "feat(notif): ci wires notification-history load/save + deleteMessage + now"
```

---

## Self-Review

**Spec coverage:** store schema (Task 5/6 write, Task 3 read) ✓; broadcastDigest returns recipients (T1) ✓; formatDeadlineReminder + separate broadcast (T1, T5) ✓; summarizeDigest stored as item.summary (T1, T5) ✓; expire >24h + drop deadlines + keep digests + cap 200 (T5) ✓; 📜 button + /history + hist: list→detail (T2, T4) ✓; ephemeral history view (T4 adds 'history' to EPHEMERAL_VIEW_CMDS) ✓; newest-first (T5 logBroadcast prepends; T2 list shows in order) ✓; error handling (best-effort delete, GitHub-fail guards) ✓.

**Placeholder scan:** Task 5 Step 1 explicitly flags that arranging a real deadline_approaching diff may be hard and recommends extracting `expireHistory`/`logBroadcast` as unit-testable helpers (which Step 3 does) — the expire test is fully concrete against `expireHistory`. No `TBD`. The ci.mjs glue references "the file's actual helpers" — the implementer must read ci.mjs's existing fs imports; this is config glue, not new logic.

**Type consistency:** item shape `{sent_at,type,summary,text,recipients:[{chat_id,message_id}],deleted}` identical across T1/T2/T3/T5; `loadNotificationHistory` → `{items}` consistent (T3 def ↔ T4/T5 callers); `hist:p:<page>`/`hist:i:<idx>`/`hist:noop` consistent (T2 builders ↔ T4 callback); `deleteMessage(chatId, messageId)` arg order consistent (T5 helper ↔ T6 binding); `summarizeDigest(groups)`/`formatDeadlineReminder(tenders)` signatures consistent (T1 ↔ T5).
