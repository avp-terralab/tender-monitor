# Inline-меню для Моніторингу закупівель, Замовників та Агента

Дата: 2026-06-24
Гілка-зразок: `fix/archive-link-preview` (Архів закупівель, PR #9)

## Мета

Переробити три розділи бота — **📋 Моніторинг закупівель** (`info`), **👁 Моніторинг
замовників** (`watched`), **🤖 Агент** (`agent`) — на одне навіговане inline-меню
кожен, у тому ж стилі, що й **📦 Архів закупівель**: одне повідомлення, навігація
редагує його на місці (`editMessageText`), листки з пагінацією 6/сторінку, єдині
рядки `⬅ Назад` / `⬅ Меню`. Прибрати «дамп» кількох повідомлень у `info`.

Обраний напрямок (узгоджено з користувачем):
- **Варіант A — «Дзеркало Архіву»**: нижня persistent-клавіатура лишається точками
  входу; кожна кнопка відкриває власне inline-меню.
- **Моніторинг закупівель — stateless re-fetch**: кожна навігація перезапитує
  watchlist у Prozorro (та сама вартість, що один `/info` сьогодні). KV не заводимо.
- **Агент — додаємо екран «📊 Останні задачі»** (статуси agent-job + лінки на Drive).

## Зразок (наявний Архів) — патерн, який повторюємо

- Чисті функції в `commands.mjs`: `buildArchiveMenu`, `renderArchivePage`,
  `handleArchiveNav({ archive, data })` → `{ text, keyboard }` або `null` (для `:noop`).
- Worker (`handler.mjs`): на callback з префіксом `arch:` вантажить дані, кличе
  `handleArchiveNav`, робить `editMessageText` (з `disable_web_page_preview`), `ack()`.
- Стан повністю в `callback_data` (≤64 байти, ASCII): `arch:co:2:1`.
- Пагінація: рядок `[◀ Назад][p/total][Далі ▶]`, індикатор сторінки — `arch:noop`.
- Усе покрите юніт-тестами (13 нових у PR #9).

## Спільні домовленості

- Нові префікси callback: `mon:` (закупівлі), `wat:` (замовники). Агент лишається в
  наявному просторі `agent:` (додаються `agent:menu`, `agent:pick:<page>`,
  `agent:jobs:<page>`; наявні `agent:start/co/confirm/cancel` без змін).
- Усі навігаційні обробники — **чисті функції** в `commands.mjs`, повертають
  `{ text, keyboard }` (keyboard — об'єкт `{ inline_keyboard }` або `null`), як
  `handleArchiveNav`. Worker лише вантажить дані → кличе обробник → `editMessageText`.
- `editMessageText` для всіх нових view — з `disable_web_page_preview: true`
  (як у фіксі `3da3449`) і `parse_mode: HTML`.
- Пагінація: константа `PER_PAGE = 6` (як `ARCH_PER_PAGE`). Рядок-навігація і
  `*:noop` для індикатора — без edit.
- Persistent reply-клавіатура (`mainKeyboard`) **не змінюється** — лишається точками
  входу. `BUTTON_ALIASES` без змін.
- Невалідний/застарілий callback → обробник повертає корінь-меню (graceful), як в
  Архіві (`return buildArchiveMenu(...)` в кінці `handleArchiveNav`).

## 1. Моніторинг закупівель — префікс `mon:`

**Проблема зараз:** `info` без `tender_id` віддає `formatInfoPages` → масив сторінок →
worker шле **до 6 окремих повідомлень** (одне на фазу життєвого циклу).

**Стає:** одне повідомлення — меню фаз; тап фази → пагінований список повних карток.

### Ієрархія / view

1. **Меню фаз** (`mon:menu`): заголовок `📋 Моніторинг закупівель — N активних,
   оновлено HH:MM, DD.MM` + по кнопці на **непорожню** фазу з лічильником.
   Фази й порядок — наявний `PHASES` (+`OTHER_PHASE`). Кнопка кодує **індекс** фази
   (не назву — кирилиця/емодзі завеликі для callback): `mon:ph:<idx>:0`.
2. **Сторінка фази** (`mon:ph:<idx>:<page>`): до 6 повних карток
   (наявний `formatInfoEntry`) з тим самим сортуванням, що у `formatInfoPages`
   (`active.tendering` — за дедлайном, інші — за `tender_id`). Рядок навігації
   `[◀ Назад][p/total][Далі ▶]` + `[⬅ Меню] mon:menu`.
   Для адміна на фазі «📥 Приймання пропозицій» — додатково пронумеровані кнопки
   `🤖 N` (запуск агента; reuse `agentTriggerButtonRow`/`agent:start:<tid>`).

### Нові чисті функції (`commands.mjs`)

- `buildMonitorMenu({ groups, runIso })` → `{ text, keyboard }`. Лічить непорожні фази.
  Порожньо → `{ text: '📭 Немає активних тендерів.', keyboard: null }`.
- `monitorPhaseBuckets(groups)` → масив `{ idx, emoji, label, items }` непорожніх фаз
  у порядку життєвого циклу (виноситься зі спільної логіки `formatInfoPages`).
- `renderMonitorPage({ groups, phaseIdx, page, runIso, role })` → `{ text, keyboard }`.
- `handleMonitorNav({ groups, data, runIso, role })` → дispatcher (`mon:noop`→null,
  `mon:menu`→меню, `mon:ph:*`→сторінка, інакше→меню).

### Worker

- Гілка callback `data.startsWith('mon:')` у `handleCallbackQuery`: re-fetch watchlist
  (та сама логіка fetch-all, що в гілці `cmd === 'info'`) → `groups` → `handleMonitorNav`
  → `editMessageText`. Помилка Prozorro/GitHub → `ack('⚠️ …недоступний', true)`.
- Гілка `cmd.cmd === 'info'` **без** `tender_id`: замість `formatInfoPages(...)`
  будувати `buildMonitorMenu(...)` і ставити його keyboard у `replyMarkup`
  (новий `monitorReplyMarkup`, у тому ж ланцюжку, що `archiveReplyMarkup`).
  `/info UA-...` (одиночний) — **без змін** (картка + кнопка агента + live-archive).

### Прибирання

- `formatInfoPages` стає мертвим у проді → видалити разом із його тестами; спільну
  логіку фаз винести в `monitorPhaseBuckets`. `formatInfo` і `formatInfoEntry`
  лишаються (reused).

## 2. Моніторинг замовників — префікс `wat:`

**Зараз:** `watched` → одне текстове повідомлення-список + кнопка «🗑 Прибрати
замовника», що перемикає у manage-режим (`watched:manage`/`watched:done`,
`unwatch:<edrpou>`).

**Стає:** меню-список кнопок (6/стор) → картка замовника з діями (drill-down).

### Ієрархія / view

1. **Меню** (`wat:menu:<page>`): заголовок `👁 Моніторинг замовників — N
   (🟢 активні · 🔴 призупинені)` + по кнопці на замовника
   `[🟢|🔴 <скорочена назва> · <edrpou>] wat:e:<edrpou>`, пагінація 6/стор.
   Порожньо → `📭 Не стежу за жодним замовником. Додай: /watch ЄДРПОУ`.
2. **Картка замовника** (`wat:e:<edrpou>`): назва, ЄДРПОУ, стан. Кнопки:
   `[🔴 Призупинити | 🟢 Відновити] wat:toggle:<edrpou>`,
   `[🗑 Прибрати] wat:rm:<edrpou>`, `[⬅ До списку] wat:menu:0`.

### Нові чисті функції (`commands.mjs`)

- `buildWatchedMenu({ entities, page })` → `{ text, keyboard }` (пагінація).
- `buildWatchedEntityCard({ entities, edrpou })` → `{ text, keyboard }`; невідомий
  edrpou → меню (graceful).
- `handleWatchedNav({ entities, data })` → dispatcher для `wat:menu`/`wat:e`/`wat:noop`.
- Мутації `wat:toggle`/`wat:rm` лишаються в worker (потрібен GitHub-save з retry).

### Мутації / Worker

- **Нова мутація** `set_enabled` для entity (`applyEntityMutation`) — перемикає
  `enabled`. (Видалення reuse наявний `handleUnwatch` + delete-мутацію.)
- Гілка `data.startsWith('wat:')`: вантажить entities, для `menu`/`e` → `handleWatchedNav`
  → edit; для `toggle`/`rm` → load→mutate→save (retry на `ConflictError`, як `unwatch`)
  → re-render картку (toggle) або меню (rm).
- `cmd.cmd === 'watched'` → `buildWatchedMenu({ entities, page: 0 })` замість
  тексту+`buildWatchedViewKeyboard`.
- **Сумісність:** наявні `watched:manage`/`watched:done`/`unwatch:` обробники лишити
  (старі повідомлення в історії), або видалити після узгодження. За замовчуванням —
  лишаємо, нові повідомлення йдуть через `wat:`.

## 3. Агент — простір `agent:`

**Зараз:** `agent` → одразу список тендерів (`active.tendering`) → компанія →
підтвердження (`agent:start/co/confirm/cancel`).

**Стає:** меню дій; вибір тендера з пагінацією + «назад»; новий екран задач.

### Ієрархія / view

1. **Меню** (`agent:menu`): `🤖 Агент` + `[🚀 Надіслати тендер агенту] agent:pick:0`,
   `[📊 Останні задачі] agent:jobs:0`.
2. **Вибір тендера** (`agent:pick:<page>`): наявний `buildAgentTenderListKeyboard`,
   обгорнутий у view із заголовком + пагінацією + `[⬅ Назад] agent:menu`.
   Далі — наявний флоу (`agent:co`/`agent:confirm`/`agent:cancel`) без змін.
3. **Останні задачі** (`agent:jobs:<page>`): по рядку на задачу — статус-емодзі +
   `tender_id` + компанія + (лінк на Drive якщо `done`), 6/стор + `[⬅ Назад] agent:menu`.
   Статуси: `📋 pending · ⏳ running · ✅ done · ❌ error`.

### Нові функції

- `commands.mjs`: `buildAgentMenu()`, `buildAgentPickView({ tenders, page })`,
  `buildAgentJobsPage({ jobs, page })`, `handleAgentMenuNav({ tenders, jobs, data })`
  (тільки для `menu`/`pick`/`jobs`/`noop`; `start/co/confirm/cancel` лишаються в worker).
- `worker/src/github.mjs`: **нова** `listAgentJobs(env)` — лістинг директорії
  `_state/agent_jobs/` (GitHub contents API) + читання кожного `<tid>.json`. Сортувати
  за `created_at` desc, обрізати до останніх **20** перед пагінацією (6/стор).
- Job-shape (наявний): `{ tender_id, company, price, status, created_at, result?.drive_link }`.

### Worker

- `cmd.cmd === 'agent'` (admin) → `buildAgentMenu()` замість одразу списку тендерів.
- Гілка `data.startsWith('agent:')`: для `menu`/`pick`/`jobs` — вантажити потрібні дані
  (watchlist для `pick`, `listAgentJobs` для `jobs`) → `handleAgentMenuNav` → edit;
  `start/co/confirm/cancel` — наявні гілки.
- Усе під `if (!isAdmin) { ack('🚫 …', true); return; }`.

## Обробка помилок

- Prozorro/GitHub недоступні під час навігації → `ack('⚠️ …тимчасово недоступний', true)`,
  повідомлення не чіпаємо (як `arch:` гілка).
- Застарілий стан (тендер зник із watchlist, замовник видалений іншим адміном): чисті
  обробники працюють на свіжо-завантажених даних, тож меню просто не покаже зниклий
  елемент; невідомий id у картці → повернення в корінь-меню.
- `editMessageText` «message is not modified» — ловити й ігнорувати (як наявні edit-и).

## Тестування

- `test/commands.test.mjs`: юніт-тести на кожен новий builder/nav — лічильники фаз,
  межі пагінації (перша/остання сторінка, рівно `PER_PAGE`), порожні стани, наявність
  back-рядків, ASCII-довжина `callback_data` ≤64. Дзеркалити 13 архівних тестів.
- `worker/test/handler.test.mjs`: маршрутизація callback `mon:`/`wat:`/`agent:`;
  що `info`/`watched`/`agent` (вхід) дають **одне** меню-повідомлення; toggle/rm
  замовника зберігають мутацію; `listAgentJobs` мокнутий.
- Усі наявні тести лишаються зеленими.

## Поза скоупом

- Зміна layout persistent reply-клавіатури.
- KV/кеш для live-даних (свідомо stateless re-fetch).
- Інтеграція запуску агента, live-archive логіка, формат карток `formatInfoEntry`.
- Міграція старих `watched:`/`unwatch:` callback (лишаємо для сумісності).

## Порядок реалізації (для плану)

1. `mon:` — Моніторинг закупівель (найбільший виграш: прибирає дамп).
2. `wat:` — Моніторинг замовників (drill-down + toggle).
3. `agent:` — меню + пагінований вибір + екран «Останні задачі» (+`listAgentJobs`).

Кожен крок: чисті функції + тести → worker-гілка + тести → зелено.
