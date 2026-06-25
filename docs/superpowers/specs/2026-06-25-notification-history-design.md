# 📜 Історія сповіщень (Feature B)

Дата: 2026-06-25
Гілка: `feat/notification-history`

## Мета

Проактивні сповіщення живуть у чаті 24 год, потім **видаляються**, а їхній вміст
**переїжджає в історію**, доступну кнопкою **📜 Історія**. Виняток — нагадування
«24 год до завершення приймання»: шлються окремим повідомленням і просто видаляються
(в історію НЕ потрапляють).

Це **Фіча B** з трьох (A ✓ ефемерні перегляди → C ✓ guided-ввід → **B**).

## Затверджені рішення (brainstorm)

- **Дедлайни — окремим повідомленням** (не в дайджесті) → видаляються через 24 год, в історію не йдуть.
- **Решта (дайджести)** → видаляються через 24 год, але зберігаються в історію.
- **Ретенція історії: 200** найновіших дайджестів.
- **Перегляд історії:** список коротких рядків (дата + підсумок подій) → тап → повний текст.
- **Кнопка `📜 Історія`** у нижній клавіатурі (другий ряд) + команда `/history`.

## Архітектурний контекст

- **Сповіщення шле monitor-cron** (`ci.mjs` → `monitor.mjs`, GitHub Actions), **broadcast** усім
  підписаним (`broadcastDigest` → по одному повідомленню на чат). Worker їх НЕ шле.
- **Кнопка 📜 Історія — у worker** (Cloudflare). **Видалення через 24 год — у monitor** (він
  періодичний; worker подієвий).
- **Спільне сховище:** `_state/notification_history.json`. Monitor пише його як локальний файл
  (GHA комітить), worker читає через GitHub API.

## Дані: `_state/notification_history.json`
```json
{ "items": [
  {
    "sent_at": "2026-06-25T05:55:00.000Z",
    "type": "digest" | "deadline",
    "summary": "📥 2 нові, 🔄 1 зміна",          // один рядок для списку (рахує monitor)
    "text": "<повний текст повідомлення (HTML)>",
    "recipients": [ { "chat_id": "1744078008", "message_id": 1234 } ],  // по одному на підписника
    "deleted": false
  }
]}
```
- `items` у хронологічному порядку (новіші — в кінець або початок; фіксуємо: **новіші в початок**).
- `digest`-item-и лишаються після видалення (для історії, `deleted:true`); `deadline`-item-и після
  видалення **викидаються зовсім**.
- **Кап:** не більше **200** `digest`-item-ів (найновіші); старші відкидаються.

## Monitor (telegram.mjs + monitor.mjs + ci.mjs)

### `telegram.mjs`
- **`broadcastDigest(...)` → повертає `[{ chat_id, message_id }]`** — збирає `result.message_id` з
  кожного `sendDigest` (той уже повертає Telegram-JSON). Чати, що впали, просто не потрапляють у масив.
- **`formatDeadlineReminder(events)`** — текст окремого дедлайн-повідомлення
  (`⏰ Залишилось 24 год…` + рядок на кожен тендер).
- `deleteMessage(...)` — **вже є** (Фіча A), reuse.

### `monitor.mjs` (оркестрація, інʼєктовані deps: `loadNotificationHistory`, `saveNotificationHistory`,
`deleteMessage`, `now`, поряд із наявними `sendDigest` тощо)
1. **Expire (на старті циклу):** завантажити історію; для `item`-ів, де `!deleted && now - sent_at > 24h`:
   `deleteMessage` кожному recipient'у (best-effort, помилки ігнор) → `deleted:true`. Потім: `deadline`-item-и
   з `deleted:true` **прибрати**; обрізати `digest`-item-и до 200; зберегти.
2. **Розвести дедлайни:** події `deadline_approaching` **виключити з дайджесту** (`formatDigest` отримує
   групи без них), і якщо є хоч одна — окремий `broadcastDigest(formatDeadlineReminder(...))` →
   записати `item` type `deadline` (`summary` = «⏰ N дедлайнів», recipients з повернення).
3. **Логувати дайджест:** після `broadcastDigest(digestText)` → записати `item` type `digest`
   (`text` = надісланий текст, `summary` = рахунок подій за типами, recipients з повернення, `sent_at` = now).
   Нічний буфер (quiet window) логуємо при ранковому flush так само.

### `ci.mjs`
- Завести `loadNotificationHistory` / `saveNotificationHistory` (локальний файл `_state/notification_history.json`,
  як `loadState`/`saveState`), `deleteMessage` (telegram) і `now`; передати в `monitor.mjs`.

## Worker (github.mjs + commands.mjs + handler.mjs)

### `worker/src/github.mjs`
- `loadNotificationHistory(env)` → `{ items }` (читає `_state/notification_history.json`; 404 → `{items:[]}`).

### `commands.mjs` (чисті функції + кнопка)
- Кнопка **`📜 Історія`** у `mainKeyboard` (2-й ряд) + `BUTTON_ALIASES['📜 Історія'] = 'history'`;
  `parseCommand('/history')` → `{ cmd: 'history' }`.
- `buildHistoryList({ items, page })` — лише `type==='digest'`, 6/стор, рядок-кнопка
  `🔔 <дата час> · <summary>` → `hist:i:<idx>`; навігація `hist:p:<page>`; порожньо → «📭 Історія порожня».
- `buildHistoryItem({ items, idx })` — повний `text` того item + `[⬅ Назад до історії] hist:p:0`.
- `handleHistoryNav({ items, data })` — dispatcher (`hist:noop`→null, `hist:p:<page>`→список,
  `hist:i:<idx>`→деталь, інакше→список).

### `worker/src/handler.mjs`
- `cmd.cmd === 'history'` → `buildHistoryList({ items, page:0 })` (load history), `historyReplyMarkup`.
- Гілка callback `data.startsWith('hist:')` → load history → `handleHistoryNav` → `editMessageText`.
- Додати **`'history'` у `EPHEMERAL_VIEW_CMDS`** (Фіча A) — перегляд історії теж ефемерний.

## Обробка помилок
- `deleteMessage` старшого за 48 год / уже видаленого → `false`, ігнор (item все одно `deleted:true`).
- GitHub/файл історії недоступний у monitor (load/save) → лог, **не блокує розсилку** (історія
  best-effort; на наступному циклі допишеться).
- Worker `hist:` при недоступному GitHub → `ack('⚠️ GitHub тимчасово недоступний', true)`.
- `broadcastDigest`: чат, що впав, не потрапляє в recipients → його повідомлення просто не
  відстежується (не видалятиметься, але це лише той чат).

## Поза скоупом
- Зміна формату самого дайджесту (`formatDigest`) поза винесенням дедлайнів.
- Історія дій/команд (то Фіча A — ефемерність, уже є).
- Пошук/фільтри в історії (YAGNI; лише хронологічний список + деталь).

## Тестування
- **`test/telegram.test.mjs`:** `broadcastDigest` повертає `[{chat_id,message_id}]` (мок sendDigest з
  різними id; чат, що кинув помилку, відсутній у масиві); `formatDeadlineReminder(events)` містить
  «24 год» і tender_id-и.
- **`test/monitor.test.mjs`:** дедлайни виключені з дайджесту і йдуть окремим broadcast;
  логування item-ів (digest+deadline, recipients, summary); expire видаляє >24год (виклики
  `deleteMessage`), викидає дедлайни, лишає дайджести, кап 200; quiet-flush логує.
- **`test/commands.test.mjs`:** `buildHistoryList` (6/стор, рядки `hist:i:`, лише digest, порожньо),
  `buildHistoryItem` (повний текст + назад), `handleHistoryNav` (noop/p/i routing); кнопка 📜 у
  `mainKeyboard`; `parseCommand('/history')`.
- **`worker/test/github.test.mjs`:** `loadNotificationHistory` (масив / 404→`{items:[]}`).
- **`worker/test/handler.test.mjs`:** `/history` → список; `hist:i:0` → деталь edit-in-place;
  ефемерність (history у VIEW-наборі).

## Порядок реалізації (для плану)
1. `telegram.mjs`: `broadcastDigest` повертає recipients + `formatDeadlineReminder` (+тести).
2. `commands.mjs`: `buildHistoryList`/`buildHistoryItem`/`handleHistoryNav` + кнопка/команда `/history` (+тести).
3. `worker/src/github.mjs`: `loadNotificationHistory` (+тест).
4. `worker/src/handler.mjs`: `/history` + `hist:` callback + ефемерність (+тести).
5. `monitor.mjs`: розвести дедлайни + логування + expire/кап (+тести monitor).
6. `ci.mjs`: проводка `loadNotificationHistory`/`saveNotificationHistory`/`deleteMessage`/`now`.
