# Ефемерні перегляди на вимогу (Feature A)

Дата: 2026-06-25
Гілка: `feat/ephemeral-views`

## Мета

Тримати чат ботом чистим: коли користувач відкриває новий «перегляд на вимогу»
(📋 Моніторинг закупівель, 👁 Замовники, 📦 Архів, 🤖 Агент, ❓ Допомога, /status,
/whoami) — бот **видаляє попередній** такий перегляд (і запит користувача, і свою
відповідь), показуючи лише новий. Проактивні сповіщення (дайджест, нові тендери,
зміни, архівація) і підтвердження дій (➕ додав, ✅ notify…) **не чіпаються**.

Це **Фіча A** з трьох узгоджених (A → C → B). C (guided-ввід команд) і B (📜 Історія
сповіщень) — окремі специфікації.

## Затверджені рішення (brainstorm)

- **Модель:** замінювати попередній перегляд (у чаті максимум ОДИН актуальний
  перегляд + усі сповіщення).
- **Видаляти обидва боки:** і повідомлення-запит користувача, і відповідь бота
  (Telegram дозволяє боту видаляти вхідні в приватному чаті, у межах 48 год).
- **Обсяг VIEW:** `{ info, watched, archive, agent, help, status, whoami }`. Дії та
  проактивні сповіщення — поза набором.
- **Сховище:** **Cloudflare KV** (надійно, без git-комітів, швидко). Потребує разового
  налаштування namespace (дія користувача — див. нижче).

## Архітектура / компоненти

### 1. `telegram.mjs` — `deleteMessage`
Нова `deleteMessage({ token, chatId, messageId, fetch })` → `POST /deleteMessage`.
Повертає `true`/`false`; на 400 (повідомлення вже немає / старше 48 год) — **не кидає**,
повертає `false` (best-effort).

### 2. KV-binding (`worker/wrangler.toml`)
Додати:
```toml
[[kv_namespaces]]
binding = "EPHEMERAL_KV"
id = "<заповнює користувач після `wrangler kv namespace create`>"
```
Worker отримує доступ через `env.EPHEMERAL_KV` (`.get/.put/.delete`).

### 3. `worker/src/ephemeral.mjs` — тонкі хелпери над KV (інʼєктовний `kv`)
- `loadEphemeral(kv, chatId)` → `number[]` (масив message_id) або `[]`.
- `saveEphemeral(kv, chatId, ids)` → `kv.put('eph:'+chatId, JSON, { expirationTtl: 172800 })`
  (48 год — після цього id однаково невидаляються).
- Усе в try/catch на рівні виклику; KV-помилка ≠ збій команди.

### 4. `worker/src/handler.mjs` — підключення
Набір `EPHEMERAL_VIEW_CMDS = new Set(['info','watched','archive','agent','help','status','whoami'])`.
Для повідомлень-команд (не callback), коли `EPHEMERAL_VIEW_CMDS.has(cmd.cmd)`:
1. `prev = await loadEphemeral(kv, chatId)` → для кожного id `deleteMessage(...)` (ігнор помилок);
2. виконати команду як зараз, але **захопити `message_id`** відповіді(ей) бота
   (`sendReply` повертає `{ result: { message_id } }`);
3. `await saveEphemeral(kv, chatId, [msg.message_id, ...botReplyIds])`
   (`msg.message_id` — це запит користувача / тап reply-кнопки).
`kv = deps.ephemeralKV ?? env.EPHEMERAL_KV` (інʼєкція для тестів).

Inline-навігація меню (`mon:`/`wat:`/`arch:`/`agent:` callback) **редагує те саме
повідомлення**, тож його `message_id` незмінний — додаткового трекінгу не треба; ефемерний
запис, зроблений на команді, лишається валідним протягом навігації.

### Потік
```
тап «📋 Моніторинг закупівель» (VIEW)
  → load prev ids з KV
  → deleteMessage(кожен prev)            // старий перегляд + старий запит зникають
  → handle 'info' → sendReply(меню)      // новий перегляд
  → save [trigger_id, reply_id] у KV
```
Дії (add/remove/…) і сповіщення цей шлях НЕ зачіпають — їхні повідомлення лишаються,
і вони НЕ перезаписують ефемерний запис.

## Обробка помилок
- `deleteMessage` падає (старше 48 год / уже видалене / not found) → ловимо, ігноруємо.
- KV недоступне (load/save) → **не блокуємо команду**: показуємо новий перегляд без
  видалення старого (graceful degradation); лог у console.error.
- Захоплення `message_id` відповіді не вдалося → зберігаємо що є (хоч би trigger_id).

## Разове налаштування (дія користувача, поза кодом)
```
cd worker
npx wrangler kv namespace create EPHEMERAL_KV
# -> копіюємо виданий id у wrangler.toml (поле id)
```
Після цього звичайний деплой (push у main) підхопить binding. До налаштування KV код
**деградує безпечно** (KV відсутнє → cleanup пропускається, бот працює як раніше).

## Поза скоупом
- Фіча C (guided-ввід команд з аргументом) — окрема специфікація.
- Фіча B (📜 Історія сповіщень) — окрема специфікація.
- Прибирання повідомлень діалогу агента (ціна/підтвердження) — то транзакційні
  повідомлення дій, не перегляди; не чіпаємо.
- Видалення проактивних сповіщень — це Фіча B.

## Тестування
- **`telegram.test.mjs`:** `deleteMessage` будує правильний `POST /deleteMessage`
  (chatId/messageId), на не-ok відповіді повертає `false` без винятку.
- **`worker/test/ephemeral.test.mjs`** (новий, з fake-KV): `loadEphemeral` повертає `[]`
  для відсутнього ключа й масив для збереженого; `saveEphemeral` кладе JSON із TTL.
- **`worker/test/handler.test.mjs`:**
  - VIEW-команда (напр. `info`/«📋 Моніторинг закупівель») з раніше збереженими id →
    `deleteMessage` викликано для кожного prev id, і збережено нові `[trigger, reply]`.
  - ACTION-команда (напр. `add`) і callback-навігація **не** видаляють і **не** перезаписують
    ефемерний стан.
  - KV-помилка під час cleanup → команда все одно відповідає (новий перегляд показано).
- Наявні тести лишаються зеленими (захоплення `message_id` не ламає поточний send-флоу).

## Порядок реалізації (для плану)
1. `telegram.mjs`: `deleteMessage` (+тест).
2. `worker/src/ephemeral.mjs`: `loadEphemeral`/`saveEphemeral` над KV (+тести з fake-KV).
3. `worker/wrangler.toml`: KV-binding (placeholder id).
4. `worker/src/handler.mjs`: захоплення `message_id` відповіді + cleanup-логіка для
   VIEW-команд (+тести handler).
