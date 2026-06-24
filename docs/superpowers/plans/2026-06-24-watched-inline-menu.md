# Моніторинг замовників — inline-меню (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Замінити плоский текст-список `👁 Моніторинг замовників` + toggle-режим на навіговане inline-меню: список-кнопки (6/стор) → картка замовника з діями (призупинити/відновити, прибрати).

**Architecture:** Чисті функції в `commands.mjs` (`buildWatchedMenu`, `buildWatchedEntityCard`, `handleWatchedNav`) повертають `{ text, keyboard }`. Нова мутація `set_enabled` у `applyEntityMutation`. Worker вантажить entities з GitHub, навігація редагує повідомлення на місці; toggle/rm роблять GitHub-save з retry. Префікс `wat:`.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Cloudflare Worker, Telegram Bot API.

**Спека:** `docs/superpowers/specs/2026-06-24-bot-inline-menus-design.md` (розділ 2).

**Це Фаза 2 із 3.** Залежності від Фази 1 немає — можна виконувати незалежно.

---

## File Structure

- `commands.mjs` — **Modify.** Додати `set_enabled` у `applyEntityMutation` (рядок ~610); додати `auditPhrase` кейси (рядок ~232); додати `buildWatchedMenu`/`buildWatchedEntityCard`/`handleWatchedNav` після `buildWatchedManageKeyboard` (рядок ~596).
- `worker/src/handler.mjs` — **Modify.** Гілка `cmd.cmd==='watched'` (рядки 454–462) → меню; додати callback-гілку `wat:` у `handleCallbackQuery` (поряд із `watched:manage`, рядок ~847); імпорти.
- `test/commands.test.mjs` — **Modify.** Тести на нові функції + `set_enabled`.
- `worker/test/handler.test.mjs` — **Modify.** Тести callback `wat:` (nav + toggle + rm).

**Команди:** `node --test test/commands.test.mjs` · `node --test worker/test/handler.test.mjs`

**Наявні символи:** entity = `{ edrpou, name, enabled }`. `abbreviateLegalForm`, `truncate`, `escapeHtml`, `handleUnwatch`, `applyEntityMutation`, `formatAuditMessage`. Worker: `_loadWatchedEntities`, `_saveWatchedEntities`, `ConflictError`, `isEditor`, `actorName`, `role`, `chatId`, `messageId`.

**Сумісність:** наявні `watched:manage`/`watched:done`/`unwatch:` гілки **лишаємо** (старі повідомлення). Нові повідомлення йдуть через `wat:`. `buildWatchedViewKeyboard`/`buildWatchedManageKeyboard`/`handleWatched` лишаються (їх ще кличуть renderWatched-хелпери).

---

## Task 1: Мутація `set_enabled`

**Files:** Modify `commands.mjs` (~610) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючий тест** (`applyEntityMutation` уже в імпорті тесту):

```javascript
test('applyEntityMutation: set_enabled flips one entity', () => {
  const out = applyEntityMutation(
    [{ edrpou: '11111111', name: 'A', enabled: true }, { edrpou: '22222222', name: 'B', enabled: true }],
    { type: 'set_enabled', edrpou: '22222222', enabled: false });
  assert.equal(out.find((e) => e.edrpou === '22222222').enabled, false);
  assert.equal(out.find((e) => e.edrpou === '11111111').enabled, true);
});
```

- [ ] **Step 2: Запустити — падає.** `node --test test/commands.test.mjs` → FAIL (повертає незмінений масив).

- [ ] **Step 3: Реалізувати** — у `applyEntityMutation` перед `return watchedEntities;`:

```javascript
  if (mutation.type === 'set_enabled') {
    return watchedEntities.map((e) =>
      e.edrpou === mutation.edrpou ? { ...e, enabled: mutation.enabled } : e);
  }
```

- [ ] **Step 4: Запустити — проходить.** `node --test test/commands.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(watched): set_enabled entity mutation"
```

---

## Task 2: Audit-фрази для паузи/відновлення

**Files:** Modify `commands.mjs` (`auditPhrase`, ~232) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючий тест** (`formatAuditLog` уже в імпорті):

```javascript
test('auditPhrase: watch_pause / watch_resume render readable', () => {
  const out = formatAuditLog([
    { action: 'watch_pause', target: '12345678', actor: 'Адмін', date: '2026-06-24T10:00:00Z' },
    { action: 'watch_resume', target: '12345678', actor: 'Адмін', date: '2026-06-24T10:01:00Z' },
  ], { limit: 10 });
  assert.match(out, /призупинив стеження за 12345678/);
  assert.match(out, /відновив стеження за 12345678/);
});
```

- [ ] **Step 2: Запустити — падає.** FAIL (рендериться як `watch_pause 12345678`).

- [ ] **Step 3: Реалізувати** — у `auditPhrase`, після `case 'unwatch':`:

```javascript
    case 'watch_pause':  return `призупинив стеження за ${tgt}`;
    case 'watch_resume': return `відновив стеження за ${tgt}`;
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(watched): audit phrases for pause/resume"
```

---

## Task 3: `buildWatchedMenu` (список-кнопки, пагінація)

**Files:** Modify `commands.mjs` (після `buildWatchedManageKeyboard`, ~596) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючий тест** (додати `buildWatchedMenu` до імпорту):

```javascript
const watEnt = (edrpou, enabled = true, name = `Замовник ${edrpou}`) => ({ edrpou, name, enabled });

test('buildWatchedMenu: empty → keyboard null', () => {
  assert.equal(buildWatchedMenu({ entities: [], page: 0 }).keyboard, null);
});

test('buildWatchedMenu: one button per entity, callback wat:e:<edrpou>, icon by enabled', () => {
  const m = buildWatchedMenu({ entities: [watEnt('11111111', true), watEnt('22222222', false)], page: 0 });
  const rows = m.keyboard.inline_keyboard;
  assert.equal(rows[0][0].callback_data, 'wat:e:11111111');
  assert.match(rows[0][0].text, /^🟢/);
  assert.match(rows[1][0].text, /^🔴/);
  assert.match(m.text, /Моніторинг замовників/);
});

test('buildWatchedMenu: 6/page with nav arrows', () => {
  const entities = Array.from({ length: 8 }, (_, i) => watEnt(String(10000000 + i)));
  const r0 = buildWatchedMenu({ entities, page: 0 }).keyboard.inline_keyboard;
  const nav0 = r0.find((row) => row.some((b) => b.callback_data === 'wat:noop'));
  assert.ok(nav0.some((b) => b.text === 'Далі ▶'));
  assert.ok(nav0.some((b) => b.text === '1/2'));
  const r1 = buildWatchedMenu({ entities, page: 1 }).keyboard.inline_keyboard;
  const nav1 = r1.find((row) => row.some((b) => b.callback_data === 'wat:noop'));
  assert.ok(nav1.some((b) => b.text === '◀ Назад'));
  assert.equal(nav1.find((b) => b.callback_data?.startsWith('wat:menu')).callback_data, 'wat:menu:0');
});
```

- [ ] **Step 2: Запустити — падає.** `node --test test/commands.test.mjs` → FAIL.

- [ ] **Step 3: Реалізувати** — у `commands.mjs` після `buildWatchedManageKeyboard`:

```javascript
const WAT_PER_PAGE = 6;

export function buildWatchedMenu({ entities, page = 0 }) {
  if (!entities || entities.length === 0) {
    return { text: '📭 Не стежу за жодним замовником. Додай: /watch ЄДРПОУ', keyboard: null };
  }
  const pages = Math.max(1, Math.ceil(entities.length / WAT_PER_PAGE));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const start = p * WAT_PER_PAGE;
  const slice = entities.slice(start, start + WAT_PER_PAGE);
  const text = `👁 <b>Моніторинг замовників</b> — ${entities.length}\n🟢 активні · 🔴 призупинені`;
  const rows = slice.map((e) => {
    const icon = e.enabled ? '🟢' : '🔴';
    const name = e.name && e.name !== '(unknown)'
      ? truncate(abbreviateLegalForm(e.name), 48) : '';
    const label = name ? `${icon} ${name} · ${e.edrpou}` : `${icon} ${e.edrpou}`;
    return [{ text: label, callback_data: `wat:e:${e.edrpou}` }];
  });
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: '◀ Назад', callback_data: `wat:menu:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: 'wat:noop' });
    if (p < pages - 1) nav.push({ text: 'Далі ▶', callback_data: `wat:menu:${p + 1}` });
    rows.push(nav);
  }
  return { text, keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(watched): buildWatchedMenu (paginated entity list)"
```

---

## Task 4: `buildWatchedEntityCard` + `handleWatchedNav`

**Files:** Modify `commands.mjs` (після `buildWatchedMenu`) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючі тести** (додати `buildWatchedEntityCard, handleWatchedNav` до імпорту):

```javascript
test('buildWatchedEntityCard: shows state, manage buttons only when canManage', () => {
  const ent = [watEnt('11111111', true, 'КНП Лікарня')];
  const card = buildWatchedEntityCard({ entities: ent, edrpou: '11111111', canManage: true });
  assert.match(card.text, /КНП Лікарня/);
  assert.match(card.text, /🟢 стежу/);
  const cbs = JSON.stringify(card.keyboard.inline_keyboard);
  assert.match(cbs, /wat:toggle:11111111/);
  assert.match(cbs, /wat:rm:11111111/);
  assert.match(cbs, /wat:menu:0/);
  const viewer = buildWatchedEntityCard({ entities: ent, edrpou: '11111111', canManage: false });
  const vcbs = JSON.stringify(viewer.keyboard.inline_keyboard);
  assert.ok(!vcbs.includes('wat:toggle'));
  assert.ok(!vcbs.includes('wat:rm'));
  assert.match(vcbs, /wat:menu:0/);
});

test('buildWatchedEntityCard: paused entity shows Відновити; unknown edrpou → menu', () => {
  const ent = [watEnt('22222222', false)];
  const card = buildWatchedEntityCard({ entities: ent, edrpou: '22222222', canManage: true });
  assert.match(card.text, /🔴 призупинено/);
  assert.match(JSON.stringify(card.keyboard.inline_keyboard), /🟢 Відновити/);
  const miss = buildWatchedEntityCard({ entities: ent, edrpou: '99999999', canManage: true });
  assert.match(miss.text, /Моніторинг замовників/); // fell back to menu
});

test('handleWatchedNav: noop→null; menu/e routing', () => {
  const ent = [watEnt('11111111', true)];
  assert.equal(handleWatchedNav({ entities: ent, data: 'wat:noop', canManage: true }), null);
  assert.match(handleWatchedNav({ entities: ent, data: 'wat:menu:0', canManage: true }).text, /Моніторинг замовників/);
  assert.match(handleWatchedNav({ entities: ent, data: 'wat:e:11111111', canManage: true }).text, /Замовник 11111111|11111111/);
});
```

- [ ] **Step 2: Запустити — падає.** FAIL — функції не визначені.

- [ ] **Step 3: Реалізувати** — у `commands.mjs` після `buildWatchedMenu`:

```javascript
export function buildWatchedEntityCard({ entities, edrpou, canManage = false }) {
  const e = (entities ?? []).find((x) => x.edrpou === edrpou);
  if (!e) return buildWatchedMenu({ entities, page: 0 });
  const name = e.name && e.name !== '(unknown)' ? escapeHtml(abbreviateLegalForm(e.name)) : '(назва невідома)';
  const state = e.enabled ? '🟢 стежу' : '🔴 призупинено';
  const text = `👁 <b>${name}</b>\nЄДРПОУ ${e.edrpou}\nСтан: ${state}`;
  const rows = [];
  if (canManage) {
    rows.push([{
      text: e.enabled ? '🔴 Призупинити' : '🟢 Відновити',
      callback_data: `wat:toggle:${e.edrpou}`,
    }]);
    rows.push([{ text: '🗑 Прибрати', callback_data: `wat:rm:${e.edrpou}` }]);
  }
  rows.push([{ text: '⬅ До списку', callback_data: 'wat:menu:0' }]);
  return { text, keyboard: { inline_keyboard: rows } };
}

// Pure router for read-only `wat:` navigation (menu / entity card). Mutations
// (wat:toggle / wat:rm) are handled in the Worker (GitHub save).
export function handleWatchedNav({ entities, data, canManage = false }) {
  if (data === 'wat:noop') return null;
  const parts = data.split(':'); // wat:menu:<page> | wat:e:<edrpou>
  if (parts[1] === 'e') return buildWatchedEntityCard({ entities, edrpou: parts[2], canManage });
  if (parts[1] === 'menu') return buildWatchedMenu({ entities, page: Number(parts[2] ?? 0) });
  return buildWatchedMenu({ entities, page: 0 });
}
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(watched): entity card + handleWatchedNav router"
```

---

## Task 5: Worker — `/watched` відкриває меню

**Files:** Modify `worker/src/handler.mjs` (імпорт ~9; гілка `watched` 454–462) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Падаючий тест:**

```javascript
test('runHandler: /watched → menu message with wat:e button', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '👁 Моніторинг замовників', from: { id: 123 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }) }).deps,
      sendReply: async (a) => sent.push(a),
    },
  });
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].replyMarkup), /wat:e:11111111/);
});
```

- [ ] **Step 2: Запустити — падає.** `node --test worker/test/handler.test.mjs` → FAIL (markup ще `unwatch:`/немає).

- [ ] **Step 3: Реалізувати:**

3a. Імпорт (рядок ~4): додати `buildWatchedMenu, buildWatchedEntityCard, handleWatchedNav`:

```javascript
  buildWatchedViewKeyboard, buildWatchedManageKeyboard, WATCHED_MANAGE_PROMPT,
  buildWatchedMenu, buildWatchedEntityCard, handleWatchedNav,
```

3b. Гілка `cmd.cmd === 'watched'` (рядки 454–462) → :

```javascript
  } else if (cmd.cmd === 'watched') {
    try {
      const { entities } = await _loadWatchedEntities(env);
      const menu = buildWatchedMenu({ entities, page: 0 });
      reply = menu.text;
      watchedReplyMarkup = menu.keyboard ?? undefined;
    } catch (err) {
      console.error('worker: /watched failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  }
```

> `watchedReplyMarkup` уже існує (рядок 147). Меню показуємо всім (навігація — лише перегляд); дії в картці гейтяться `canManage` у Task 6.

- [ ] **Step 4: Запустити — проходить.** PASS. (Наявні `/watched`-тести, що чекали старий текст-список/`buildWatchedViewKeyboard`, оновити під нове меню або видалити, якщо дублюють.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(watched): /watched opens paginated menu"
```

---

## Task 6: Worker — callback-гілка `wat:` (nav + toggle + rm)

**Files:** Modify `worker/src/handler.mjs` (`handleCallbackQuery`, перед `watched:manage`, ~847) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Падаючі тести:**

```javascript
test('runHandler: wat:e:<edrpou> → edits to entity card', async () => {
  const acks = []; const edits = [];
  await runHandler({
    update: { callback_query: { id: 'cbw1', data: 'wat:e:11111111', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({ loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }) }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].replyMarkup), /wat:toggle:11111111/); // chat 123 = admin → canManage
  assert.equal(acks.length, 1);
});

test('runHandler: wat:toggle:<edrpou> → saves set_enabled, re-renders card', async () => {
  const acks = []; const edits = []; let saved = null;
  await runHandler({
    update: { callback_query: { id: 'cbw2', data: 'wat:toggle:11111111', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
        saveWatchedEntities: async (_e, entities) => { saved = entities; },
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(saved.find((e) => e.edrpou === '11111111').enabled, false, 'toggled off');
  assert.match(JSON.stringify(edits[0].replyMarkup), /🟢 Відновити/);
});

test('runHandler: wat:rm:<edrpou> → deletes, re-renders menu', async () => {
  const edits = []; let saved = null;
  await runHandler({
    update: { callback_query: { id: 'cbw3', data: 'wat:rm:11111111', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchedEntities: async () => ({ entities: [{ edrpou: '11111111', name: 'КНП', enabled: true }], sha: 's' }),
        saveWatchedEntities: async (_e, entities) => { saved = entities; },
      }).deps,
      answerCallbackQuery: async () => {},
      editMessageText: async (a) => edits.push(a),
    },
  });
  assert.equal(saved.length, 0, 'entity removed');
  assert.match(edits[0].text, /Не стежу за жодним|Моніторинг замовників/);
});
```

> `signature saveWatchedEntities(env, entities, sha, opts)` — у тесті беремо 2-й арг.

- [ ] **Step 2: Запустити — падає.** FAIL (немає `wat:` гілки → «Невідома кнопка»).

- [ ] **Step 3: Реалізувати** — у `handleCallbackQuery`, додати **перед** `if (data === 'watched:manage' || data === 'watched:done') {` (рядок ~847):

```javascript
  if (data.startsWith('wat:')) {
    if (data === 'wat:noop') { await ack(); return; }
    const parts = data.split(':'); // wat:menu:<p> | wat:e:<edrpou> | wat:toggle:<edrpou> | wat:rm:<edrpou>

    if (parts[1] === 'toggle' || parts[1] === 'rm') {
      if (!isEditor) { await ack('🚫 Це команда для редакторів', true); return; }
      const edrpou = parts[2];
      if (!/^\d{8}$/.test(edrpou)) { await ack('❌ Невалідний ЄДРПОУ'); return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { entities, sha } = await _loadWatchedEntities(env);
          let mutation; let action;
          if (parts[1] === 'toggle') {
            const cur = entities.find((e) => e.edrpou === edrpou);
            const next = !(cur?.enabled);
            mutation = { type: 'set_enabled', edrpou, enabled: next };
            action = next ? 'watch_resume' : 'watch_pause';
          } else {
            mutation = { type: 'delete_entity', edrpou };
            action = 'unwatch';
          }
          const newEntities = applyEntityMutation(entities, mutation);
          await _saveWatchedEntities(env, newEntities, sha, {
            message: formatAuditMessage({ action, target: edrpou, actor: actorName, chatId, role }),
          });
          const view = parts[1] === 'toggle'
            ? buildWatchedEntityCard({ entities: newEntities, edrpou, canManage: true })
            : buildWatchedMenu({ entities: newEntities, page: 0 });
          await _editMessageText({
            token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
            text: view.text, replyMarkup: view.keyboard ?? undefined,
          });
          await ack(parts[1] === 'toggle' ? '✅ Оновлено' : '✅ Прибрано');
          return;
        } catch (err) {
          if (err instanceof ConflictError && attempt === 0) continue;
          console.error('worker: wat mutation failed:', err.message);
          await ack('⚠️ Помилка, спробуй ще раз', true);
          return;
        }
      }
      return;
    }

    // read-only nav: menu / entity card
    let entities = [];
    try {
      ({ entities } = await _loadWatchedEntities(env));
    } catch (err) {
      console.error('worker: wat nav load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleWatchedNav({ entities, data, canManage: isEditor });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: wat nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }
```

> `applyEntityMutation`, `formatAuditMessage` уже імпортовані в `handler.mjs`. `buildWatchedMenu`/`buildWatchedEntityCard`/`handleWatchedNav` додані в Task 5 (3a). `isEditor`, `actorName`, `role`, `chatId`, `messageId`, `_loadWatchedEntities`, `_saveWatchedEntities`, `ConflictError` уже доступні в `handleCallbackQuery`.

- [ ] **Step 4: Запустити — проходить.** `node --test worker/test/handler.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(watched): wire wat: callback (nav + pause/resume + remove)"
```

---

## Self-Review

**Spec coverage (розділ 2):**
- Меню-список 6/стор, `wat:e:<edrpou>` → Task 3 ✓
- Картка з паузою/відновленням/видаленням → Task 4 + Task 6 ✓
- Мутація enable/disable → Task 1 ✓
- Worker `watched`→меню; `wat:` nav + toggle/rm з retry → Task 5–6 ✓
- Сумісність старих callback → лишені (зазначено) ✓
- Audit для паузи/відновлення → Task 2 ✓

**Placeholder scan:** увесь код наведено; жодних TBD.

**Type consistency:** `buildWatchedMenu({entities,page})`, `buildWatchedEntityCard({entities,edrpou,canManage})`, `handleWatchedNav({entities,data,canManage})` — однакові скрізь; мутації `set_enabled`/`delete_entity` узгоджені між Task 1, Task 6 і наявним `applyEntityMutation`; callback-схема `wat:menu:<p>` / `wat:e:<edrpou>` / `wat:toggle:<edrpou>` / `wat:rm:<edrpou>` / `wat:noop` консистентна.
