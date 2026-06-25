# Guided-ввід команд з аргументом (Feature C)

Дата: 2026-06-25
Гілка: `feat/guided-command-args`

## Мета

Прибрати «глуху помилку» при випадковому/навмисному тапі команд, що потребують
аргументу. Замість `❌ Не вказано tender_id` бот шле повідомлення з **`force_reply`**:
відкриває користувачу поле «відповісти» з підказкою-плейсхолдером, той вводить лише
значення (id/ЄДРПОУ), і бот виконує дію. Невалідне значення → перепитує знову.

Стосується **4 команд, що зараз дають помилку на голому виклику**: `/add`, `/remove`,
`/watch`, `/unarchive`. (`/info`, `/archive` без аргументу вже показують список/меню —
їх НЕ чіпаємо; одиночний пошук там — через `/`-автодоповнення клієнта.)

Це **Фіча C** з трьох узгоджених (A зроблено → **C** → B).

## Затверджені рішення (brainstorm)

- **Обсяг:** `{ add, remove, watch, unarchive }` (= наявний `MUTATING` set).
- **Невалідна відповідь:** перепитати (`force_reply` знову) з префіксом «❌ Невірний формат».
- **Механізм:** `force_reply` + `reply_to_message` (стейтлес; контекст несе сама відповідь),
  а не «наступне повідомлення = аргумент» (той перехопив би випадкове повідомлення).

## Архітектура / компоненти

### `commands.mjs`
- **`ARG_REPLY_SPECS`** — мапа cmd → `{ core, prompt, placeholder }` для 4 команд:
  | cmd | core (стабільна фраза для розпізнавання) | prompt | placeholder |
  |---|---|---|---|
  | `add` | `додати в моніторинг` | `➕ Надішли tender_id, який додати в моніторинг (UA-…):` | `UA-2026-06-19-008800-a` |
  | `remove` | `прибрати з моніторингу` | `🗑 Надішли tender_id, який прибрати з моніторингу (UA-…):` | `UA-2026-06-19-008800-a` |
  | `watch` | `ЄДРПОУ замовника` | `👁 Надішли ЄДРПОУ замовника (8 цифр):` | `12345678` |
  | `unarchive` | `повернути з архіву` | `↩️ Надішли tender_id, який повернути з архіву (UA-…):` | `UA-2026-06-19-008800-a` |
- **`buildArgPrompt(cmd, { retry = false } = {})`** → `{ text, replyMarkup }`:
  - `text` = `(retry ? '❌ Невірний формат. ' : '') + ARG_REPLY_SPECS[cmd].prompt`
  - `replyMarkup` = `{ force_reply: true, input_field_placeholder: ARG_REPLY_SPECS[cmd].placeholder }`
- **`commandFromReplyPrompt(replyText)`** → cmd, чиє `core` міститься в `replyText`
  (працює і для retry-варіанту, бо префікс додано перед `core`), або `null`. `null` для
  не-рядка / чужого тексту.

### `worker/src/handler.mjs`
1. **Перепис відповіді на промпт (на вході, перед `parseCommand`):**
   ```
   const replyCmd = (typeof msg.text === 'string' && msg.reply_to_message)
     ? commandFromReplyPrompt(msg.reply_to_message.text)
     : null;
   const textToParse = replyCmd ? `/${replyCmd} ${msg.text}` : msg.text;
   const cmd = parseCommand(textToParse);
   ```
   Так відповідь користувача стає `/<cmd> <значення>` і йде звичайним шляхом. Не конфліктує
   з агентним price-перехопленням (той гейтиться pending-станом `await_price`, не reply).
2. **Промпт замість помилки:** у гілках `add`/`remove`/`watch`/`unarchive`, коли
   `cmd.error` ∈ `{ missing_id, invalid_id, missing_edrpou, invalid_edrpou }` — замість сухого
   `❌ …` тексту:
   ```
   const p = buildArgPrompt(cmd.cmd, { retry: cmd.error.startsWith('invalid') });
   reply = p.text;
   forceReplyMarkup = p.replyMarkup;
   ```
   Новий акумулятор `let forceReplyMarkup = null;` (поряд з іншими `*ReplyMarkup`), доданий у
   `??`-ланцюжок send-розмітки (на початку, щоб мати пріоритет для цих команд).
3. **Права не змінюються:** перевірка `MUTATING.has(cmd.cmd) && !isEditor` стоїть ПЕРЕД
   гілками команд, тож не-редактор і далі отримує `🚫 Це команда для редакторів` (без промпта).

## Потік
```
тап /add (editor)            → бот: «➕ Надішли tender_id … (UA-…):» [force_reply, placeholder]
ти (reply): UA-2026-…        → перепис → /add UA-2026-… → handleAdd → ✅ Додано
ти (reply): «абищо»          → /add абищо → invalid_id → buildArgPrompt(retry) → «❌ Невірний формат. ➕ …» [force_reply]
не-editor тапнув /add        → 🚫 Це команда для редакторів (без промпта)
```

## Обробка помилок / межі
- Відповідь без тексту (стікер/фото у reply) → `msg.text` не рядок → перепис не спрацьовує,
  іде звичайний шлях.
- Reply на чуже повідомлення бота (не промпт) → `commandFromReplyPrompt` → `null` → звичайний шлях.
- Промпт + відповідь + підтвердження дії лишаються в чаті (це дії, не «перегляди» — Фіча A їх
  не чистить). Прибирання їх — поза скоупом C.
- Валідний `/add UA-…`, введений напряму (не через промпт) — працює як раніше (промпт лише на
  missing/invalid).

## Поза скоупом
- `/info`, `/archive`, `/watched` — без змін (голі дають список/меню).
- Прибирання промпт-діалогу з чату (то Фіча A-подібне, але для дій — не робимо).
- Фіча B (📜 Історія сповіщень) — окрема специфікація.

## Тестування
- **`test/commands.test.mjs`:**
  - `buildArgPrompt('add')` → текст містить `core` «додати в моніторинг» і `force_reply:true`,
    `input_field_placeholder` = UA-приклад; `buildArgPrompt('watch')` → ЄДРПОУ-плейсхолдер;
    `{retry:true}` → текст починається з «❌ Невірний формат.» і все ще містить `core`.
  - `commandFromReplyPrompt(buildArgPrompt('add').text)` === `'add'`; для retry-тексту теж `'add'`;
    `commandFromReplyPrompt('щось стороннє')` === `null`; `commandFromReplyPrompt(123)` === `null`.
- **`worker/test/handler.test.mjs`:**
  - Голий `/add` від editor → `reply` = промпт (містить «додати в моніторинг»), розмітка має
    `force_reply`, мутації немає.
  - Reply на add-промпт із валідним `UA-…` (update з `message.reply_to_message.text` = промпт,
    `message.text` = UA-…) → `handleAdd` виконано (saveWatchlist викликано).
  - Reply на add-промпт із невалідним текстом → відповідь-промпт із «❌ Невірний формат» + force_reply,
    мутації немає.
  - Не-editor голий `/add` → `🚫 Це команда для редакторів`, без force_reply.
  - Наявні тести (валідний `/add UA-…` напряму, тощо) лишаються зеленими.

## Порядок реалізації (для плану)
1. `commands.mjs`: `ARG_REPLY_SPECS`, `buildArgPrompt`, `commandFromReplyPrompt` (+тести).
2. `worker/src/handler.mjs`: перепис reply-промпта (textToParse) + промпт-замість-помилки для 4
   команд + `forceReplyMarkup` (+тести handler).
