# Editor role + role-based command visibility

**Date:** 2026-05-18
**Status:** Draft

## Problem

Зараз авторизація бота двошарова:
- **Admin** (`ADMIN_CHAT_ID` env, = `1744078008`) — повний доступ + admin-команди.
- **Allowed users** (`_state/allowed_users.json`) — той самий доступ що й admin, окрім `/invite`/`/invites`/`/users`/`/revoke`.

Власник хоче, щоб **mutating-операції** (додати/змінити/видалити закупівлю чи замовника) могли виконувати лише **дві конкретні Telegram chat_id**: `1744078008` (поточний admin) та `7321709183`. Решта запрошених учасників мають бачити моніторинг тільки в режимі перегляду.

Додаткова вимога: **користувач бачить лише ті команди, які він може використати** — у `/help` та в автокомпліті Telegram «/».

## Ролі (нова модель)

| Роль | Хто | Доступ |
|---|---|---|
| **Admin** | `chat_id == ADMIN_CHAT_ID` (1744078008) | Editor + `/invite`, `/invites`, `/users`, `/revoke` |
| **Editor** | `chat_id in EDITOR_CHAT_IDS` АБО admin | Viewer + `/add`, `/remove`, `/watch`, `/unwatch`, `/unarchive`, inline-кнопка `add:` |
| **Viewer** | `chat_id ∈ allowed_users.json` і не editor | `/start`, `/help`, `/menu`, `/status`, `/info`, `/watched`, `/archive` (список і деталі) |
| **Не-allowed** | решта | `/start` (greeting із власним chat_id), `/start <token>` (redeem) |

Admin **імпліцитно** editor — не треба окремо додавати у `EDITOR_CHAT_IDS`.

## Конфігурація

Новий env var Worker'а:

```
EDITOR_CHAT_IDS = "7321709183"
```

Формат: comma-separated string, parsed at request time у `handler.mjs`. Пустий/відсутній → лише admin може мутирувати (back-compat-safe default).

Зберігання: Cloudflare Worker secret через `npx wrangler secret put EDITOR_CHAT_IDS`. Не в коді, не в `wrangler.toml` — щоб список можна було оновлювати без redeploy.

## Точки зміни

### 1. `worker/src/handler.mjs`

**Парсинг та обчислення ролі (на початку `runHandler`):**
```js
const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
const editorIds = String(env.EDITOR_CHAT_IDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = chatId !== '' && chatId === adminChatId;
// (далі — існуюча isInvited check через _loadAllowedUsers)
const isEditor = isAdmin || editorIds.includes(chatId);
// ВАЖЛИВО: isAllowed має включати editor, інакше editor НЕ у allowed_users.json буде заблокований
const isAllowed = isAdmin || isEditor || isInvited;
const role = isAdmin ? 'admin' : (isEditor ? 'editor' : (isInvited ? 'viewer' : 'guest'));
```

**Deps injection** — додати у destructuring на початку `runHandler`:
```js
const _setMyCommands = deps.setMyCommands ?? setMyCommands; // imported from telegram.mjs
```

Те саме для `handleCallbackQuery` — приймати editor list через env та обчислювати `isEditor` тим самим способом.

**Guard на mutating commands.** Перед існуючими гілками `cmd.cmd === 'add'`, `'remove'`, `'watch'`, `'unwatch'`, `'unarchive'`:
```js
if (MUTATING_COMMANDS.has(cmd.cmd) && !isEditor) {
  reply = '🚫 Це команда для редакторів. У тебе доступ лише для перегляду.';
  // (sendReply через існуючий шлях у кінці runHandler)
}
```
де `MUTATING_COMMANDS = new Set(['add', 'remove', 'watch', 'unwatch', 'unarchive'])`.

**Inline-кнопка `add:` callback** (`handleCallbackQuery`): додати editor check одразу після `isAllowed`:
```js
if (!isEditor) {
  await ack('🚫 Лише для редакторів', true);
  return;
}
```

**`/help` per-role:**
```js
} else if (cmd.cmd === 'help') {
  reply = buildHelpText(role);
}
```

**`/start` без аргументу — оновити Telegram chat-scope command menu:**
В блоці що обробляє `/start` без token (рядки 69–85), після `sendReply`, якщо `isAdmin || isInvited`:
```js
await syncBotCommands({ token, chatId, role });
```
де `syncBotCommands` — fire-and-forget (errors лише логуються, не блокують відповідь).

**При successful redeem** (`/start <token>` із створенням viewer-а) — теж викликати `syncBotCommands({ token, chatId, role: 'viewer' })` одразу після notify admin.

### 2. `commands.mjs`

**Видалити константу `HELP_TEXT`** (рядки 773–799), замінити функцією:

```js
const HELP_GENERAL = [
  'Загальні команди:',
  '/help — список команд',
  '/menu — показати швидкі кнопки',
  '/status — здоровʼя бота',
];

const HELP_VIEW_TENDERS = [
  'Моніторинг закупівель за ID:',
  '/info [UA-...] — список усіх або деталі одного тендера',
];

const HELP_VIEW_ENTITIES = [
  'Моніторинг замовників за EDRPOU:',
  '/watched — список замовників',
];

const HELP_VIEW_ARCHIVE = [
  'Архів завершених закупівель:',
  '/archive — список архіву (з посиланнями на договори)',
  '/archive [UA-...] — деталі + договір',
];

const HELP_EDIT_TENDERS = [
  '/add UA-YYYY-MM-DD-NNNNNN-x — додати тендер',
  '/remove UA-YYYY-MM-DD-NNNNNN-x — видалити тендер',
];

const HELP_EDIT_ENTITIES = [
  '/watch EDRPOU — стежити за замовником',
  '/unwatch EDRPOU — припинити стежити',
];

const HELP_EDIT_ARCHIVE = [
  '/unarchive [UA-...] — повернути в моніторинг',
];

const HELP_ADMIN = [
  'Адмін-команди:',
  '/invite [імʼя] — створити invite-посилання',
  '/invites — активні invite-посилання',
  '/users — список користувачів',
  '/revoke [chat_id] — видалити користувача',
];

export function buildHelpText(role) {
  const parts = [HELP_GENERAL.join('\n')];

  // Tenders block (view + optional edit lines)
  const tendersBlock = [...HELP_VIEW_TENDERS];
  if (role === 'editor' || role === 'admin') {
    // Insert edit lines BEFORE the view line for natural order (add, remove, info)
    tendersBlock.splice(1, 0, ...HELP_EDIT_TENDERS);
  }
  parts.push(tendersBlock.join('\n'));

  // Entities block
  const entitiesBlock = [...HELP_VIEW_ENTITIES];
  if (role === 'editor' || role === 'admin') {
    entitiesBlock.splice(1, 0, ...HELP_EDIT_ENTITIES);
  }
  parts.push(entitiesBlock.join('\n'));

  // Archive block
  const archiveBlock = [...HELP_VIEW_ARCHIVE];
  if (role === 'editor' || role === 'admin') {
    archiveBlock.push(...HELP_EDIT_ARCHIVE);
  }
  parts.push(archiveBlock.join('\n'));

  if (role === 'admin') {
    parts.push(HELP_ADMIN.join('\n'));
  }

  return parts.join('\n\n');
}

// Backward-compat: existing tests import HELP_TEXT and assert full content.
export const HELP_TEXT = buildHelpText('admin');
```

**Новий експорт `BOT_COMMANDS_BY_ROLE`** для Telegram `setMyCommands`:

```js
const VIEW_COMMANDS = [
  { command: 'help',    description: 'Список команд' },
  { command: 'menu',    description: 'Швидкі кнопки' },
  { command: 'status',  description: 'Здоровʼя бота' },
  { command: 'info',    description: 'Список або деталі тендерів' },
  { command: 'watched', description: 'Список замовників' },
  { command: 'archive', description: 'Архів завершених закупівель' },
];

const EDIT_COMMANDS = [
  { command: 'add',       description: 'Додати тендер у моніторинг' },
  { command: 'remove',    description: 'Видалити тендер' },
  { command: 'watch',     description: 'Стежити за замовником (EDRPOU)' },
  { command: 'unwatch',   description: 'Припинити стежити за замовником' },
  { command: 'unarchive', description: 'Повернути тендер з архіву' },
];

const ADMIN_COMMANDS = [
  { command: 'invite',  description: 'Створити invite-посилання' },
  { command: 'invites', description: 'Активні invite-посилання' },
  { command: 'users',   description: 'Список користувачів' },
  { command: 'revoke',  description: 'Видалити користувача' },
];

export const BOT_COMMANDS_BY_ROLE = {
  viewer: VIEW_COMMANDS,
  editor: [...VIEW_COMMANDS, ...EDIT_COMMANDS],
  admin:  [...VIEW_COMMANDS, ...EDIT_COMMANDS, ...ADMIN_COMMANDS],
};
```

### 3. `telegram.mjs`

Додати тонку обгортку над Bot API `setMyCommands`:

```js
export async function setMyCommands({ token, commands, chatId }) {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const body = {
    commands,
    scope: { type: 'chat', chat_id: Number(chatId) },
    language_code: '',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`setMyCommands ${res.status}: ${text}`);
  }
}
```

І `syncBotCommands` обгортка у `worker/src/handler.mjs` (або у `commands.mjs` як pure-helper, що дістає список):

```js
// In handler.mjs:
async function syncBotCommands({ token, chatId, role }) {
  const commands = BOT_COMMANDS_BY_ROLE[role] ?? BOT_COMMANDS_BY_ROLE.viewer;
  try {
    await _setMyCommands({ token, commands, chatId });
  } catch (err) {
    console.error('worker: setMyCommands failed:', err.message);
  }
}
```

### 4. Тести

**`worker/test/handler.test.mjs`** — нові test cases (mock-based, на стилі поточних handler-тестів):

- `viewer chat: /info → success, /add → "🚫 Це команда для редакторів"`
- `viewer chat: /remove → refusal; watchlist не змінюється (saveWatchlist not called)`
- `viewer chat: /watch → refusal; entities не змінюється`
- `viewer chat: /unarchive UA-... → refusal; archive не змінюється`
- `editor chat (not admin, in EDITOR_CHAT_IDS): /add → success`
- `editor chat: /invite → silent return (admin-only)` — поведінка існуюча, але перевірити що залишилась
- `admin chat: /invite → success` — sanity
- `inline button add: callback → viewer ack with "🚫 Лише для редакторів"; editor → success`
- `/start (no token), viewer → setMyCommands called with VIEW_COMMANDS`
- `/start (no token), editor → setMyCommands called with VIEW + EDIT commands`
- `/start (no token), admin → setMyCommands called with all commands`
- `/start <token> redeem success → setMyCommands called with VIEW_COMMANDS for new viewer`
- `/start non-allowed → setMyCommands NOT called`
- `EDITOR_CHAT_IDS empty/unset → admin still has full access; allowed users are viewers`
- `EDITOR_CHAT_IDS with spaces "7321709183, 999" → both parsed`

**`test/commands.test.mjs`** — нові test cases:

- `buildHelpText('viewer') не містить /add, /remove, /watch, /unwatch, /unarchive, /invite`
- `buildHelpText('viewer') містить /info, /watched, /archive`
- `buildHelpText('editor') містить mutating + view; не містить /invite, /users, /revoke`
- `buildHelpText('admin') == HELP_TEXT (existing constant)`
- Існуючі асерти `HELP_TEXT mentions admin commands` — лишаються незмінні (HELP_TEXT тепер = `buildHelpText('admin')`)
- `BOT_COMMANDS_BY_ROLE.viewer | editor | admin` — перевірити масиви: viewer не містить `add`, editor містить `add` але не `invite`, admin містить усе. Перевірити що всі command names ASCII-only й коротші за 32 символи (Telegram limit).

## Deployment

1. Merge у `main` → CI задеплоїть Worker (`worker-deploy.yml`).
2. Виставити secret: `cd worker && npx wrangler secret put EDITOR_CHAT_IDS` → ввести `7321709183`.
3. Для існуючих чатів editor'ів: `setMyCommands` оновиться при наступному `/start`. Якщо хочеш одразу — попроси їх натиснути `/start`. Альтернатива: разовий маніал-виклик Bot API (не обов'язково для MVP).
4. У BotFather залишити глобальний `/setcommands` як viewer-set (мінімум) — fallback для нових чатів до першого `/start`.

## Що не змінюємо

- **Reply keyboard (`MAIN_KEYBOARD`)** — 4 кнопки усі view, доступні всім allowed. Без змін.
- **`/start` greeting** — той самий текст для admin/editor/viewer/guest, бо мета — показати chat_id.
- **`/status`** — без обмежень (просто пингує health).
- **Notification до admin при redeem** — без змін.
- **`/help` для не-allowed** — не показуємо (як зараз: handler does `return` для не-allowed до `cmd === 'help'`).

## Edge cases

- **Editor що теж є у `allowed_users.json`:** OK, він editor (`isEditor` має priority).
- **Editor НЕ у `allowed_users.json`:** також OK — `isAdmin || editorIds.includes(chatId)` проходить before allowlist check. Уточнення: у handler логіці `isAllowed = isAdmin || isInvited`. Треба змінити на `isAllowed = isAdmin || isEditor || isInvited` — інакше editor якого видалили з `allowed_users.json` буде заблокований.
- **`EDITOR_CHAT_IDS` має admin id:** harmless duplication — `isEditor = isAdmin || editorIds.includes(chatId)` — спрацьовує однаково.
- **`EDITOR_CHAT_IDS` має id неіснуючого юзера:** harmless — він просто не зможе нічого зробити, бо не пише боту. При першому повідомленні від нього — отримає editor-доступ.
- **`setMyCommands` failure:** залогувати й продовжити; не блокує відповідь. Telegram має кеш — наступний `/start` спробує знову.
- **Admin зробив `/revoke` для editor'а:** editor залишиться editor'ом, бо `EDITOR_CHAT_IDS` — env, не `allowed_users.json`. Це фіча: editor'ів керує адмін через CF dashboard / wrangler, не через бот-команду. (Майбутній enhancement — `/promote <chat_id>` / `/demote <chat_id>` — поза скоупом цього спеку.)

## Out of scope

- Команди `/promote`, `/demote` для керування editor'ами через бот (потребувало б додаткового storage; зараз обходимось env var).
- Per-user role у `allowed_users.json` (`role: viewer|editor`). Зберігаємо схему bare-array як зараз, editor list — окремо в env.
- Reply keyboard з editor-кнопками для швидких mutating дій (вони все одно потребують аргументів — tender_id, EDRPOU).
- Локалізація refusal-повідомлень (зараз тільки UA).
