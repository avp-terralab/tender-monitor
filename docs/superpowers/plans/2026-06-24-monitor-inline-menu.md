# Моніторинг закупівель — inline-меню (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Замінити «дамп» до 6 окремих повідомлень у `📋 Моніторинг закупівель` на одне навіговане inline-меню (меню фаз → пагінований список карток), у стилі Архіву.

**Architecture:** Чисті функції в `commands.mjs` (`monitorPhaseBuckets`, `buildMonitorMenu`, `renderMonitorPage`, `handleMonitorNav`) повертають `{ text, keyboard }`. Worker вантажить живі дані з Prozorro (stateless re-fetch на кожну навігацію), кличе чистий обробник, редагує повідомлення на місці (`editMessageText`). Стан повністю в `callback_data` під префіксом `mon:`.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, Cloudflare Worker (`worker/src/handler.mjs`), Telegram Bot API.

**Спека:** `docs/superpowers/specs/2026-06-24-bot-inline-menus-design.md` (розділ 1).

**Це Фаза 1 із 3.** Фази 2 (`wat:` — Замовники) і 3 (`agent:` — меню + «Останні задачі») — окремі плани. Кожна фаза самодостатня й окремо тестована.

---

## File Structure

- `commands.mjs` — **Modify.** Додати чисті функції меню/навігації після блоку `formatInfoPages`/`PHASES` (≈ рядок 442). Прибрати `formatInfoPages` (Task 6).
- `worker/src/handler.mjs` — **Modify.** Витягти хелпер `tenderGroups`; змінити гілку `cmd.cmd === 'info'` (без `tender_id`) на меню; додати гілку callback `mon:`; додати `monitorReplyMarkup` у ланцюжок reply-markup; оновити імпорти.
- `test/commands.test.mjs` — **Modify.** Тести на нові чисті функції; прибрати тести `formatInfoPages`.
- `worker/test/handler.test.mjs` — **Modify.** Тест на callback `mon:` + на `info`-вхід = одне меню-повідомлення.

**Команди тестів:**
- Чисті: `node --test test/commands.test.mjs`
- Worker: `node --test worker/test/handler.test.mjs`

Baseline зараз: `commands` — 353 pass / 0 fail.

**Наявні символи, на які спираємось (вже є у `commands.mjs`):**
`PHASES` (5 фаз, кожна `{ emoji, label, statuses }`), `OTHER_PHASE` (`{ emoji:'📦', label:'Інші статуси', statuses:[] }`), `formatInfoEntry(g, runIso)`, `deadlineKey(g)`, `INFO_TIME_FMT`, `INFO_DATE_FMT`. Група-об'єкт `g` має поля: `tender_id, prozorro_url, status, deadline, procuring_entity, value, classification, contact, awards`.

---

## Task 1: `monitorPhaseBuckets` + `buildMonitorMenu` (чисті)

**Files:**
- Modify: `commands.mjs` (додати після рядка ~442, одразу за `formatInfoPages`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Написати падаючі тести**

Додати в кінець `test/commands.test.mjs` (і додати `monitorPhaseBuckets, buildMonitorMenu` до імпорту з `../commands.mjs` угорі файлу):

```javascript
// --- Моніторинг закупівель: меню фаз ---
const monGroup = (status, id = 'UA-2026-06-01-000001-a', extra = {}) => ({
  tender_id: id,
  prozorro_url: `https://prozorro.gov.ua/tender/${id}`,
  status,
  deadline: null,
  procuring_entity: { name: 'КНП Лікарня', edrpou: '111' },
  ...extra,
});

test('monitorPhaseBuckets: only non-empty phases, lifecycle order, stable idx', () => {
  const buckets = monitorPhaseBuckets([
    monGroup('active.qualification', 'UA-2026-06-01-000001-a'),
    monGroup('active.tendering', 'UA-2026-06-01-000002-a'),
    monGroup('some.weird.status', 'UA-2026-06-01-000003-a'),
  ]);
  // tendering(idx0) before qualification(idx3) before OTHER(idx5)
  assert.deepEqual(buckets.map((b) => b.idx), [0, 3, 5]);
  assert.equal(buckets.find((b) => b.idx === 5).items.length, 1); // weird → OTHER
});

test('buildMonitorMenu: empty groups → keyboard null', () => {
  assert.equal(buildMonitorMenu({ groups: [], runIso: '2026-06-24T13:00:00Z' }).keyboard, null);
});

test('buildMonitorMenu: one row per non-empty phase, callback mon:ph:<idx>:0, counts', () => {
  const m = buildMonitorMenu({
    groups: [monGroup('active.tendering', 'UA-2026-06-01-000002-a'), monGroup('active.tendering', 'UA-2026-06-01-000004-a')],
    runIso: '2026-06-24T13:00:00Z',
  });
  assert.equal(m.keyboard.inline_keyboard.length, 1);
  assert.equal(m.keyboard.inline_keyboard[0][0].callback_data, 'mon:ph:0:0');
  assert.match(m.keyboard.inline_keyboard[0][0].text, /\(2\)/);
  assert.match(m.text, /Моніторинг закупівель/);
});

test('buildMonitorMenu: errors footer line', () => {
  const m = buildMonitorMenu({
    groups: [monGroup('active.tendering')],
    runIso: '2026-06-24T13:00:00Z',
    errors: [{ tender_id: 'UA-2026-06-01-000009-a', error: '404' }],
  });
  assert.match(m.text, /Не вдалось перевірити: 1/);
});
```

- [ ] **Step 2: Запустити — переконатись, що падає**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `monitorPhaseBuckets is not a function` / `buildMonitorMenu is not a function`.

- [ ] **Step 3: Реалізувати в `commands.mjs`**

Вставити після `formatInfoPages` (після рядка ~442, перед `const KYIV_HM_FMT`):

```javascript
const MON_PER_PAGE = 6;
// Stable phase index = position here. OTHER_PHASE last (its statuses: []).
const MON_PHASES = [...PHASES, OTHER_PHASE];

// Non-empty lifecycle buckets, sorted within: active.tendering by deadline,
// others by tender_id. { idx, emoji, label, items }.
export function monitorPhaseBuckets(groups) {
  const known = new Set(PHASES.flatMap((p) => p.statuses));
  return MON_PHASES
    .map((p, idx) => {
      const items = p.statuses.length === 0
        ? (groups ?? []).filter((g) => !known.has(g.status))
        : (groups ?? []).filter((g) => p.statuses.includes(g.status));
      return { idx, emoji: p.emoji, label: p.label, items };
    })
    .filter((b) => b.items.length > 0)
    .map((b) => {
      const tendering = MON_PHASES[b.idx].statuses.includes('active.tendering');
      b.items = [...b.items].sort((a, c) =>
        tendering ? deadlineKey(a) - deadlineKey(c) : a.tender_id.localeCompare(c.tender_id));
      return b;
    });
}

export function buildMonitorMenu({ groups, runIso, errors = [] }) {
  if (!groups || groups.length === 0) {
    return { text: '📭 Немає активних тендерів.', keyboard: null };
  }
  const time = INFO_TIME_FMT.format(new Date(runIso));
  const date = INFO_DATE_FMT.format(new Date(runIso));
  let text = `📋 <b>Моніторинг закупівель</b> — ${groups.length} активних\nоновлено ${time}, ${date}`;
  if (errors.length > 0) text += `\n⚠️ Не вдалось перевірити: ${errors.length}`;
  const rows = monitorPhaseBuckets(groups).map((b) => [{
    text: `${b.emoji} ${b.label} (${b.items.length})`,
    callback_data: `mon:ph:${b.idx}:0`,
  }]);
  return { text, keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 4: Запустити — переконатись, що проходить**

Run: `node --test test/commands.test.mjs`
Expected: PASS (353 + 4 нові).

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(monitor): phase-menu builder (monitorPhaseBuckets, buildMonitorMenu)"
```

---

## Task 2: `renderMonitorPage` (чиста, пагінація + картки)

**Files:**
- Modify: `commands.mjs` (після `buildMonitorMenu`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Написати падаючі тести**

Додати `renderMonitorPage` до імпорту, і тести:

```javascript
test('renderMonitorPage: 6/page nav arrows, header, card content', () => {
  const groups = Array.from({ length: 8 }, (_, i) =>
    monGroup('active.qualification', `UA-2026-06-01-00000${i}-a`));
  const pg0 = renderMonitorPage({ groups, phaseIdx: 3, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  const nav0 = pg0.keyboard.inline_keyboard.find((r) => r.some((b) => b.callback_data === 'mon:noop'));
  assert.ok(nav0.some((b) => b.text === 'Далі ▶'));
  assert.ok(nav0.some((b) => b.text === '1/2'));
  assert.ok(!nav0.some((b) => b.text === '◀ Назад'));
  assert.match(pg0.text, /Розгляд пропозицій/);
  assert.match(pg0.text, /prozorro\.gov\.ua\/tender\//);
  const back = pg0.keyboard.inline_keyboard.at(-1)[0];
  assert.equal(back.callback_data, 'mon:menu');
  const pg1 = renderMonitorPage({ groups, phaseIdx: 3, page: 1, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  const nav1 = pg1.keyboard.inline_keyboard.find((r) => r.some((b) => b.callback_data === 'mon:noop'));
  assert.ok(nav1.some((b) => b.text === '◀ Назад'));
  assert.ok(!nav1.some((b) => b.text === 'Далі ▶'));
});

test('renderMonitorPage: admin gets 🤖 buttons only on tendering phase', () => {
  const groups = [monGroup('active.tendering', 'UA-2026-06-01-000002-a')];
  const asAdmin = renderMonitorPage({ groups, phaseIdx: 0, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'admin' });
  assert.match(JSON.stringify(asAdmin.keyboard.inline_keyboard), /agent:start:UA-2026-06-01-000002-a/);
  const asViewer = renderMonitorPage({ groups, phaseIdx: 0, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  assert.ok(!JSON.stringify(asViewer.keyboard.inline_keyboard).includes('agent:start'));
});

test('renderMonitorPage: unknown phaseIdx → falls back to menu', () => {
  const pg = renderMonitorPage({ groups: [monGroup('active.tendering')], phaseIdx: 99, page: 0, runIso: '2026-06-24T13:00:00Z', role: 'viewer' });
  assert.match(pg.text, /Моніторинг закупівель/);
});
```

- [ ] **Step 2: Запустити — переконатись, що падає**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `renderMonitorPage is not a function`.

- [ ] **Step 3: Реалізувати в `commands.mjs`** (після `buildMonitorMenu`)

```javascript
export function renderMonitorPage({ groups, phaseIdx, page = 0, runIso, role }) {
  const bucket = monitorPhaseBuckets(groups).find((b) => b.idx === phaseIdx);
  if (!bucket) return buildMonitorMenu({ groups, runIso });
  const { items } = bucket;
  const pages = Math.max(1, Math.ceil(items.length / MON_PER_PAGE));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const start = p * MON_PER_PAGE;
  const slice = items.slice(start, start + MON_PER_PAGE);
  const header = `${bucket.emoji} <b>${bucket.label}</b> (${items.length})`;
  const body = slice
    .map((g, i) => `━━━━━━ ${start + i + 1} ━━━━━━\n${formatInfoEntry(g, runIso)}`)
    .join('\n\n');
  const rows = [];
  if (role === 'admin' && MON_PHASES[phaseIdx].statuses.includes('active.tendering')) {
    rows.push(slice.map((g, i) => ({
      text: `🤖 ${start + i + 1}`, callback_data: `agent:start:${g.tender_id}`,
    })));
  }
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: '◀ Назад', callback_data: `mon:ph:${phaseIdx}:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: 'mon:noop' });
    if (p < pages - 1) nav.push({ text: 'Далі ▶', callback_data: `mon:ph:${phaseIdx}:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '⬅ Меню', callback_data: 'mon:menu' }]);
  return { text: `${header}\n\n${body}`, keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 4: Запустити — переконатись, що проходить**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(monitor): renderMonitorPage (6/page cards + admin agent buttons)"
```

---

## Task 3: `handleMonitorNav` (чистий dispatcher)

**Files:**
- Modify: `commands.mjs` (після `renderMonitorPage`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Написати падаючі тести**

Додати `handleMonitorNav` до імпорту, і тест:

```javascript
test('handleMonitorNav: noop→null; menu/ph routing', () => {
  const groups = [monGroup('active.tendering', 'UA-2026-06-01-000002-a')];
  const args = { groups, runIso: '2026-06-24T13:00:00Z', role: 'viewer' };
  assert.equal(handleMonitorNav({ ...args, data: 'mon:noop' }), null);
  assert.match(handleMonitorNav({ ...args, data: 'mon:menu' }).text, /Моніторинг закупівель/);
  assert.match(handleMonitorNav({ ...args, data: 'mon:ph:0:0' }).text, /Приймання пропозицій/);
  // unknown → menu
  assert.match(handleMonitorNav({ ...args, data: 'mon:garbage' }).text, /Моніторинг закупівель/);
});
```

- [ ] **Step 2: Запустити — переконатись, що падає**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `handleMonitorNav is not a function`.

- [ ] **Step 3: Реалізувати в `commands.mjs`** (після `renderMonitorPage`)

```javascript
// Single entry point for any `mon:` callback. Pure: { text, keyboard } or
// null for `mon:noop` (caller just acks).
export function handleMonitorNav({ groups, data, runIso, role }) {
  if (data === 'mon:noop') return null;
  if (data === 'mon:menu' || data === 'mon') return buildMonitorMenu({ groups, runIso });
  const parts = data.split(':'); // mon:ph:<idx>:<page>
  if (parts[1] === 'ph') {
    return renderMonitorPage({
      groups, phaseIdx: Number(parts[2]), page: Number(parts[3] ?? 0), runIso, role,
    });
  }
  return buildMonitorMenu({ groups, runIso });
}
```

- [ ] **Step 4: Запустити — переконатись, що проходить**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(monitor): handleMonitorNav dispatcher for mon: callbacks"
```

---

## Task 4: Worker — `info`-вхід дає меню + хелпер `tenderGroups`

**Files:**
- Modify: `worker/src/handler.mjs` (імпорти ~9; гілка `cmd.cmd==='info'` рядки 336–391; reply-markup змінні 145–149; send-ланцюжок рядок 685)
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Написати падаючий тест**

Додати в `worker/test/handler.test.mjs`:

```javascript
test('runHandler: /info (no id) → single menu message with mon:ph button', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '📋 Моніторинг закупівель', from: { id: 123 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true }], sha: 's' }),
        fetchTender: async () => ({ data: { status: 'active.tendering', tenderPeriod: { endDate: '2026-07-01T00:00:00Z' }, procuringEntity: { name: 'КНП' } } }),
      }).deps,
      sendReply: async (a) => sent.push(a),
    },
  });
  assert.equal(sent.length, 1, 'one message, not a multi-page dump');
  assert.match(JSON.stringify(sent[0].replyMarkup), /mon:ph:0:0/);
});
```

> `ENV.ADMIN_CHAT_ID` має дорівнювати `'123'` (chat 123 = allowed). Перевір у наявному `const ENV` (рядок 50); якщо інший — підстав chat id, що проходить allowlist у решті тестів цього файлу.

- [ ] **Step 2: Запустити — переконатись, що падає**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `replyMarkup` не містить `mon:ph:0:0` (зараз шле `formatInfoPages`).

- [ ] **Step 3: Реалізувати**

3a. Імпорт (рядок ~9): додати `buildMonitorMenu, handleMonitorNav`, прибрати `formatInfoPages`:

```javascript
  formatInfo, buildMonitorMenu, handleMonitorNav, buildHelpText, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD, mainKeyboard,
```

3b. Reply-markup змінні (після рядка 149 `let agentReplyMarkup = null;`):

```javascript
  let monitorReplyMarkup = null;
```

3c. Витягти хелпер `tenderGroups` — додати на рівні модуля (напр. одразу перед `async function handleCallbackQuery`, рядок ~731):

```javascript
// Fetch live Prozorro snapshots for the given watchlist rows → grouped result.
// Shared by the /info menu and the mon: callback (stateless re-fetch).
async function tenderGroups(rows, { fetchTender, extractSnapshot }) {
  const results = await Promise.all((rows ?? []).map(async (r) => {
    try {
      const snap = extractSnapshot(await fetchTender(r.tender_id));
      return {
        tender_id: r.tender_id,
        prozorro_url: `https://prozorro.gov.ua/tender/${r.tender_id}`,
        status: snap.status,
        deadline: snap.tenderPeriod?.endDate ?? null,
        procuring_entity: snap.procuringEntity,
        value: snap.value,
        classification: snap.classification,
        contact: snap.contact,
        awards: snap.awards,
        _snapshot: snap,
        _row: r,
      };
    } catch (err) {
      return { tender_id: r.tender_id, error: err.message };
    }
  }));
  return { groups: results.filter((r) => !r.error), errors: results.filter((r) => r.error) };
}
```

3d. У гілці `cmd.cmd === 'info'` замінити інлайн-`Promise.all` (рядки 366–386) на виклик хелпера. Знайти:

```javascript
      } else if (targets) {
        const results = await Promise.all(targets.map(async r => {
          // ... ~20 рядків ...
        }));
        const groups = results.filter(r => !r.error);
        const errors = results.filter(r => r.error);
        reply = cmd.tender_id
          ? formatInfo({ runIso: new Date().toISOString(), groups, errors })
          : formatInfoPages({ runIso: new Date().toISOString(), groups, errors });
```

Замінити на:

```javascript
      } else if (targets) {
        const { groups, errors } = await tenderGroups(targets, {
          fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
        });
        if (cmd.tender_id) {
          reply = formatInfo({ runIso: new Date().toISOString(), groups, errors });
        } else {
          const menu = buildMonitorMenu({ groups, runIso: new Date().toISOString(), errors });
          reply = menu.text;
          monitorReplyMarkup = menu.keyboard ?? undefined;
        }
```

> Решта блоку (агент-кнопка для одиночного `/info UA-...` і live-archive, рядки 392+) лишається без змін — він під `if (cmd.tender_id ...)`.

3e. Send-ланцюжок (рядок 685): додати `monitorReplyMarkup` у `??`-каскад:

```javascript
          ? (archiveReplyMarkup ?? agentReplyMarkup ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
```

- [ ] **Step 4: Запустити — переконатись, що проходить**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS (новий тест зелений; наявні `/info`-тести можуть впасти через `formatInfoPages` — лагодимо в Task 6).

> Якщо наявні тести шукають мульти-сторінковий вивід `/info` — вони стосуються старої поведінки й оновлюються/видаляються в Task 6.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(monitor): /info opens phase menu; extract tenderGroups helper"
```

---

## Task 5: Worker — callback-гілка `mon:`

**Files:**
- Modify: `worker/src/handler.mjs` (у `handleCallbackQuery`, поряд із гілкою `arch:` ~789)
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Написати падаючий тест**

```javascript
test('runHandler: callback mon:ph:0:0 → edits message in place with cards', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbq-mon', data: 'mon:ph:0:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true }], sha: 's' }),
        fetchTender: async () => ({ data: { status: 'active.tendering', tenderPeriod: { endDate: '2026-07-01T00:00:00Z' }, procuringEntity: { name: 'КНП' } } }),
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1, 'callback edits the message in place');
  assert.match(edits[0].text, /Приймання пропозицій/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /mon:menu/);
  assert.equal(acks.length, 1);
});
```

- [ ] **Step 2: Запустити — переконатись, що падає**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `edits.length` === 0 (гілки `mon:` ще немає; падає на unknown-button).

- [ ] **Step 3: Реалізувати**

Додати в `handleCallbackQuery` одразу **перед** гілкою `if (data.startsWith('arch:')) {` (рядок ~789):

```javascript
  if (data.startsWith('mon:')) {
    if (data === 'mon:noop') { await ack(); return; }
    let groups = [];
    try {
      const { watchlist } = await _loadWatchlist(env);
      const enabled = watchlist.filter((r) => r.enabled);
      ({ groups } = await tenderGroups(enabled, {
        fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
      }));
    } catch (err) {
      console.error('worker: monitor nav load failed:', err.message);
      await ack('⚠️ Prozorro/GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleMonitorNav({ groups, data, runIso: new Date().toISOString(), role });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: monitor nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }
```

> `handleMonitorNav` уже в імпорті (Task 4, 3a). `_loadWatchlist, _fetchTender, _extractSnapshot, role` уже деструктуровані в `handleCallbackQuery` (рядки 732–743) — нічого додавати не треба.

- [ ] **Step 4: Запустити — переконатись, що проходить**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(monitor): wire mon: callback (edit-in-place navigation)"
```

---

## Task 6: Прибрати мертвий `formatInfoPages`

**Files:**
- Modify: `commands.mjs` (видалити `export function formatInfoPages` ~403–442)
- Modify: `test/commands.test.mjs` (видалити тести `formatInfoPages` + прибрати з імпорту)
- Modify: `worker/test/handler.test.mjs` (оновити/видалити тести, що чекали мульти-сторінковий `/info`)

- [ ] **Step 1: Знайти всі згадки**

Run: `grep -rn "formatInfoPages" commands.mjs test/ worker/`
Expected: визначення в `commands.mjs`, його тести в `test/commands.test.mjs`, можливі очікування у `worker/test/handler.test.mjs`. (У `worker/src/handler.mjs` згадок уже нема — прибрано в Task 4.)

- [ ] **Step 2: Видалити визначення** у `commands.mjs` — увесь блок `export function formatInfoPages({ runIso, groups, errors = [] }) { ... }` (рядки ~403–442). `PHASES`, `OTHER_PHASE`, `deadlineKey`, `formatInfoEntry` — **залишити** (їх використовують нові функції).

- [ ] **Step 3: Прибрати з тестів** — у `test/commands.test.mjs` видалити `formatInfoPages` з рядка імпорту і всі `test('formatInfoPages: ...')`. У `worker/test/handler.test.mjs` — будь-який тест, що ассертить кілька сторінок `/info` без id, замінити на перевірку одного меню-повідомлення (як у Task 4 Step 1) або видалити, якщо дублює.

- [ ] **Step 4: Запустити обидва набори — зелено**

Run: `node --test test/commands.test.mjs`
Run: `node --test worker/test/handler.test.mjs`
Expected: PASS обидва, 0 fail, жодного `formatInfoPages is not defined`.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs worker/test/handler.test.mjs
git commit -m "refactor(monitor): remove dead formatInfoPages (replaced by mon: menu)"
```

---

## Self-Review (виконано автором плану)

**Spec coverage (розділ 1 спеки):**
- Меню фаз непорожніх із лічильниками, `mon:ph:<idx>:0` → Task 1 ✓
- Сторінка фази, 6/стор, картки `formatInfoEntry`, сортування → Task 2 ✓
- Admin 🤖-кнопки на «Приймання» → Task 2 ✓
- `handleMonitorNav` dispatcher → Task 3 ✓
- Worker: `info` без id → меню; stateless re-fetch; `monitorReplyMarkup` → Task 4 ✓
- Worker: callback `mon:` edit-in-place, помилки → `ack` → Task 5 ✓
- `/info UA-...` одиночний без змін → Task 4 (else-гілка) ✓
- Прибрати `formatInfoPages` → Task 6 ✓

**Placeholder scan:** немає TBD/«handle errors abstractly» — увесь код наведено.

**Type consistency:** `monitorPhaseBuckets`/`buildMonitorMenu`/`renderMonitorPage`/`handleMonitorNav` мають однакові імена в усіх задачах; група-об'єкт `g` однаковий між `tenderGroups` (Task 4) і чистими функціями (Task 1–2); `MON_PHASES[idx]` індексація консистентна між Task 1 і Task 2.

**Не покрито спекою свідомо:** `wat:` і `agent:` — окремі плани (Фази 2–3).
