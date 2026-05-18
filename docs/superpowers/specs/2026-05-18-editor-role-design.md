# Editor role + role-based command visibility

**Date:** 2026-05-18
**Status:** Draft

## Problem

Зараз авторизація бота двошарова:
- **Admin** (`ADMIN_CHAT_ID` env, = `1744078008`) — повний доступ + admin-команди.
- **Allowed users** (`_state/allowed_users.json`) — той самий доступ що й admin, окрім `/invite`/`/invites`/`/users`/`/revoke`.

Власник хоче, щоб **mutating-операції** (додати/змінити/видалити закупівлю чи замовника) могли виконувати лише виділені користувачі ("editors"). Решта запрошених — у режимі перегляду.

Додаткові вимоги:
- **Адмін керує ролями через бот** — присвоює роль при `/invite` та може змінювати її для існуючих юзерів через `/role`.
- **Користувач бачить лише ті команди, які він може використати** — у `/help` та в автокомпліті Telegram «/».

## Ролі

| Роль | Хто | Доступ |
|---|---|---|
| **Admin** | `chat_id == ADMIN_CHAT_ID` (1744078008) | Editor + `/invite`, `/invites`, `/users`, `/revoke`, `/role` |
| **Editor** | Запис в `allowed_users.json` з `role: "editor"` (або admin) | Viewer + `/add`, `/remove`, `/watch`, `/unwatch`, `/unarchive`, inline-кнопка `add:` |
| **Viewer** | Запис в `allowed_users.json` з `role: "viewer"` (або без `role` — back-compat) | `/start`, `/help`, `/menu`, `/status`, `/info`, `/watched`, `/archive` (список і деталі) |
| **Guest** | Не у `allowed_users.json` і не admin | `/start` (greeting із chat_id), `/start <token>` (redeem) |

Admin **імпліцитно** editor — на нього не поширюється allowed_users перевірка. Окремий запис у `allowed_users.json` для admin'а не потрібний.

## Storage schema

### `_state/allowed_users.json`

Було (bare array):
```json
[{ "chat_id": "...", "label": "...", "joined_at": "..." }]
```

Стає:
```json
[{ "chat_id": "...", "label": "...", "role": "viewer", "joined_at": "..." }]
```

Дозволені значення `role`: `"viewer"`, `"editor"`. Запис без поля `role` → читається як `"viewer"` (back-compat для існуючих записів — мігрування lazy, при першому write новий формат).

### `_state/invites.json`

Додається поле `role` до кожного запису. Значення приймаються при `/invite` і визначають роль майбутнього юзера після redeem.

```json
{ "token": "...", "label": "...", "role": "editor", "status": "pending", "expires_at": "...", "created_at": "..." }
```

Default `'viewer'` для записів без поля (legacy invites).

## Команди (нові й змінені)

### Існуючі команди — без змін у поведінці

`/start`, `/help`, `/menu`, `/status`, `/info`, `/watched`, `/archive`, `/users`-список (форматування виходу зміниться — див. нижче), `/invites`-список (форматування зміниться).

### Mutating, тепер editor-only

`/add`, `/remove`, `/watch`, `/unwatch`, `/unarchive`, inline-кнопка `add:` callback. Для viewer'а:
> 🚫 Це команда для редакторів. У тебе доступ лише для перегляду.

Для inline `add:` — callback ack з alert: `🚫 Лише для редакторів`.

### Admin-only — нові й розширені

**`/invite [editor|viewer] [name]`** — формат **role-first**. `role` обов'язковий перший аргумент, `name` — другий.
- `/invite editor Andrii` → invite токен з `role: "editor"`
- `/invite viewer Olha` → invite з `role: "viewer"`
- `/invite Olha` → error: `❌ Вкажи роль першим: /invite editor [імʼя] або /invite viewer [імʼя]`
- `/invite admin Test` → error: `❌ Невалідна роль. Тільки editor або viewer.`
- `/invite editor` → error: `❌ Вкажи імʼя: /invite editor [імʼя]`

**`/role [editor|viewer] [chat_id]`** — змінити роль існуючого юзера.
- `/role editor 7321709183` → user.role = "editor"; reply: `✅ Andrii (7321709183) → editor`
- `/role viewer 7321709183` → user.role = "viewer"; reply: `✅ Andrii (7321709183) → viewer`
- `/role editor <ADMIN_CHAT_ID>` → `❌ Не можна змінити роль адміна`
- `/role viewer <ADMIN_CHAT_ID>` → той самий refuse
- `/role editor 99999` → `❌ Користувача не знайдено. /users — список`
- `/role editor 7321709183` (вже editor) → `ℹ️ Andrii (7321709183) вже editor`
- `/role admin 12345` → `❌ Невалідна роль. Тільки editor або viewer.`
- `/role 12345 editor` (старий порядок) → error: `❌ Формат: /role [editor|viewer] [chat_id]`
- `/role` без аргументів → usage hint
- viewer/editor виконує `/role` → silent return (admin-only, як `/invite`)

**`/users` — змінене форматування виходу**

Поточний формат (`commands.mjs:704–712`):
```
👥 Користувачі бота:

1. 1744078008 — admin
2. 7321709183 — Andrii (від: запрошення)
```

Стає (роль перед `invited_via`):
```
👥 Користувачі бота:

1. 1744078008 — admin
2. 7321709183 — Andrii — editor (від: запрошення)
```

Запис без поля `role` → показується `viewer`.

**`/invites` — змінене форматування виходу**

Кожен pending invite показує plan-role:
```
🎟 Активні invite-посилання (1):
• editor — Andrii — закінчиться 2026-05-25 14:00, токен abc...
```

## Точки зміни в коді

### 1. `commands.mjs`

**`parseCommand`** — оновити парсери:
- `/invite` regex/parser: match `^/invite(?:@\w+)?\s+(editor|viewer)\s+(\S.*?)\s*$` → `{ cmd: 'invite', role, label }`. Помилки: `missing_role`, `invalid_role`, `missing_label`.
- `/role` (новий): match `^/role(?:@\w+)?(?:\s+(\S+)(?:\s+(\S+))?)?\s*$` → `{ cmd: 'role', role, chat_id }`. Валідація: role ∈ {editor, viewer}, chat_id — лише цифри. Помилки: `missing_args`, `missing_chat_id`, `invalid_role`, `invalid_chat_id`.

**`handleInvite`** — приймає `cmd.role`, кладе у новий invite record.

**`handleRedeem`** — читає `invite.role`, кладе `role` у новий запис `allowed_users.json`. Якщо `invite.role` відсутній (legacy) → default `'viewer'`.

**`handleRole`** (новий pure-handler) — приймає `{ allowedUsers, adminChatId }, { role, chat_id }`. Повертає `{ reply, mutation? }`. Mutation — `{ kind: 'set_role', chat_id, role }`.

**`applyAllowedUsersMutation`** — додати case для `set_role`: знайти запис по chat_id, оновити `role`.

**`handleUsersList`** — додати `(role)` у вивід для кожного non-admin. Admin рендериться як `(admin)`.

**`handleInvitesList`** — додати рядок role у вивід.

**`HELP_TEXT` → `buildHelpText(role)`** — як у попередній версії спеку. Структура:

```js
const HELP_GENERAL = [/* /help, /menu, /status */];
const HELP_VIEW_TENDERS = ['Моніторинг закупівель за ID:', '/info [UA-...] — список або деталі'];
const HELP_VIEW_ENTITIES = ['Моніторинг замовників за EDRPOU:', '/watched — список замовників'];
const HELP_VIEW_ARCHIVE = ['Архів завершених закупівель:', '/archive — список архіву', '/archive [UA-...] — деталі + договір'];
const HELP_EDIT_TENDERS = ['/add UA-... — додати тендер', '/remove UA-... — видалити'];
const HELP_EDIT_ENTITIES = ['/watch EDRPOU — стежити', '/unwatch EDRPOU — припинити'];
const HELP_EDIT_ARCHIVE = ['/unarchive [UA-...] — повернути в моніторинг'];
const HELP_ADMIN = [
  'Адмін-команди:',
  '/invite [editor|viewer] [імʼя] — створити invite-посилання',
  '/role [editor|viewer] [chat_id] — змінити роль користувача',
  '/invites — активні invite-посилання',
  '/users — список користувачів',
  '/revoke [chat_id] — видалити користувача',
];

export function buildHelpText(role) {
  const parts = [HELP_GENERAL.join('\n')];
  const tenders = [...HELP_VIEW_TENDERS];
  if (role === 'editor' || role === 'admin') tenders.splice(1, 0, ...HELP_EDIT_TENDERS);
  parts.push(tenders.join('\n'));
  const entities = [...HELP_VIEW_ENTITIES];
  if (role === 'editor' || role === 'admin') entities.splice(1, 0, ...HELP_EDIT_ENTITIES);
  parts.push(entities.join('\n'));
  const archive = [...HELP_VIEW_ARCHIVE];
  if (role === 'editor' || role === 'admin') archive.push(...HELP_EDIT_ARCHIVE);
  parts.push(archive.join('\n'));
  if (role === 'admin') parts.push(HELP_ADMIN.join('\n'));
  return parts.join('\n\n');
}

export const HELP_TEXT = buildHelpText('admin'); // back-compat for existing tests
```

**`BOT_COMMANDS_BY_ROLE`** (новий експорт) — для Telegram `setMyCommands`:

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
  { command: 'role',    description: 'Змінити роль користувача' },
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

### 2. `worker/src/handler.mjs`

**Парсинг ролі юзера (на початку `runHandler`, після завантаження allowed users):**
```js
const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
const isAdmin = chatId !== '' && chatId === adminChatId;

let userRecord = null;
try {
  const { users } = await _loadAllowedUsers(env);
  userRecord = users.find(u => u.chat_id === chatId) ?? null;
} catch (err) {
  console.error('worker: loadAllowedUsers failed:', err.message);
  // Fail closed — non-admin sees nothing if we can't verify.
}
const isInvited = userRecord !== null;
const isAllowed = isAdmin || isInvited;
const userRole = userRecord?.role ?? 'viewer'; // legacy entries without role → viewer
const isEditor = isAdmin || userRole === 'editor';
const role = isAdmin ? 'admin' : (isEditor ? 'editor' : (isInvited ? 'viewer' : 'guest'));
```

**Guard для mutating-команд** — перед існуючими гілками `cmd.cmd === 'add' | 'remove' | 'watch' | 'unwatch' | 'unarchive'`:
```js
const MUTATING = new Set(['add', 'remove', 'watch', 'unwatch', 'unarchive']);
if (MUTATING.has(cmd.cmd) && !isEditor) {
  reply = '🚫 Це команда для редакторів. У тебе доступ лише для перегляду.';
  // falls through to existing sendReply at end
} else if (cmd.cmd === 'add') { /* ... existing ... */ }
```

(Реалізаційно — додати один if-блок перед існуючими if/else if; код повертає `reply` й продовжує до sendReply.)

**Inline `add:` callback (`handleCallbackQuery`)** — після `isAllowed` гейту:
```js
if (!isEditor) {
  await ack('🚫 Лише для редакторів', true);
  return;
}
```
(Перевикористовує той самий загруз `allowed_users.json` що `runHandler` робить для авторизації.)

**`/help`** — `reply = buildHelpText(role);` замість константи.

**`/invite`** — передати `cmd.role` у handler:
```js
} else if (cmd.cmd === 'invite') {
  if (!isAdmin) return;
  if (cmd.error === 'missing_role') {
    reply = '❌ Вкажи роль першим: /invite editor [імʼя] або /invite viewer [імʼя]';
  } else if (cmd.error === 'invalid_role') {
    reply = '❌ Невалідна роль. Тільки editor або viewer.';
  } else if (cmd.error === 'missing_label') {
    reply = '❌ Вкажи імʼя: /invite editor [імʼя]';
  } else {
    // pass cmd.role through computeMutation
  }
}
```

**`/role`** — нова гілка:
```js
} else if (cmd.cmd === 'role') {
  if (!isAdmin) return;
  if (cmd.error === 'missing_args' || cmd.error === 'missing_chat_id') {
    reply = '❌ Формат: /role [editor|viewer] [chat_id]';
  } else if (cmd.error === 'invalid_role') {
    reply = '❌ Невалідна роль. Тільки editor або viewer.';
  } else if (cmd.error === 'invalid_chat_id') {
    reply = '❌ chat_id має бути числом';
  } else {
    reply = await applyAllowedUsersMutationWithRetry({
      env, loadAllowedUsers: _loadAllowedUsers, saveAllowedUsers: _saveAllowedUsers,
      computeMutation: ({ users }) => handleRole({ allowedUsers: users, adminChatId }, cmd),
    });
  }
}
```

**`/start` (no token), при `isAllowed`** — після `sendReply` викликати fire-and-forget оновлення Telegram chat-scope command list:
```js
if (isAllowed) {
  syncBotCommands({ token: env.TELEGRAM_BOT_TOKEN, chatId, role })
    .catch(err => console.error('syncBotCommands failed:', err.message));
}
```

**Redeem success** (`handleRedeem` після успіху both mutations) — теж `syncBotCommands` для нового viewer'а.

**`/role` success** — після успішного `applyAllowedUsersMutation`, якщо роль змінилась, викликати `syncBotCommands` для target chat_id (щоб у нього одразу оновився autocomplete без потреби `/start`). Краще — повернути target chat_id у result.mutation і викликати після save. Fire-and-forget.

### 3. `telegram.mjs`

Нова функція:
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
  if (!res.ok) throw new Error(`setMyCommands ${res.status}`);
}
```

Helper у `handler.mjs`:
```js
async function syncBotCommands({ token, chatId, role }) {
  const commands = BOT_COMMANDS_BY_ROLE[role] ?? BOT_COMMANDS_BY_ROLE.viewer;
  try {
    await _setMyCommands({ token, commands, chatId });
  } catch (err) {
    console.error('worker: setMyCommands failed:', err.message);
  }
}
```

**Deps injection** у `runHandler` (для testability):
```js
const _setMyCommands = deps.setMyCommands ?? setMyCommands; // import from telegram.mjs
```

### 4. Тести

**`test/commands.test.mjs`:**

- `parseCommand('/invite editor Andrii')` → `{ cmd:'invite', role:'editor', label:'Andrii' }`
- `parseCommand('/invite viewer Olha')` → `{ cmd:'invite', role:'viewer', label:'Olha' }`
- `parseCommand('/invite Andrii')` → `{ cmd:'invite', error:'missing_role' }`
- `parseCommand('/invite admin X')` → `{ cmd:'invite', error:'invalid_role' }`
- `parseCommand('/invite editor')` → `{ cmd:'invite', error:'missing_label' }`
- `parseCommand('/invite')` → `{ cmd:'invite', error:'missing_role' }` (single error code; UX буде "вкажи роль першим")
- `parseCommand('/role editor 12345')` → `{ cmd:'role', role:'editor', chat_id:'12345' }`
- `parseCommand('/role viewer 12345')` → `{ cmd:'role', role:'viewer', chat_id:'12345' }`
- `parseCommand('/role')` → `{ cmd:'role', error:'missing_args' }`
- `parseCommand('/role editor')` → `{ cmd:'role', error:'missing_chat_id' }`
- `parseCommand('/role admin 12345')` → `{ error:'invalid_role' }`
- `parseCommand('/role editor abc')` → `{ error:'invalid_chat_id' }`
- `parseCommand('/role 12345 editor')` → `{ error:'invalid_role' }` (старий порядок, лівий "12345" не валід. роль)
- `handleInvite({ ..., cmd:{ role:'editor', label:'A' }})` — створений invite має `role:'editor'`
- `handleRedeem(...)` — новий user має той `role` що був у invite
- `handleRedeem(...)` — legacy invite без role → user.role === 'viewer'
- `handleRole({...}, { role:'editor', chat_id:'12345' })` — mutation `{ kind:'set_role', chat_id:'12345', role:'editor' }`
- `handleRole({...adminChatId:'AA'}, { role:'editor', chat_id:'AA' })` → reply contains "адмін"
- `handleRole({users:[X with role:editor]}, { role:'editor', chat_id:X.chat_id })` → reply "вже editor", no mutation
- `handleRole({users:[]}, { role:'editor', chat_id:'99999' })` → reply "не знайдено", no mutation
- `applyAllowedUsersMutation([{X, role:'viewer'}], {kind:'set_role', chat_id:X.chat_id, role:'editor'})` → user updated
- `handleUsersList({...})` — вивід містить `(editor)` / `(viewer)` / `(admin)`
- `handleUsersList` — legacy user без role показується як `(viewer)`
- `handleInvitesList` — вивід містить роль per-token
- `buildHelpText('viewer')` — не містить `/add`, `/remove`, `/watch`, `/unwatch`, `/unarchive`, `/invite`, `/role`
- `buildHelpText('viewer')` — містить `/info`, `/watched`, `/archive`
- `buildHelpText('editor')` — містить mutating + view; не містить `/invite`, `/role`, `/users`, `/revoke`
- `buildHelpText('admin')` — містить усе, включно з `/role`
- `buildHelpText('admin') === HELP_TEXT` (back-compat)
- Існуючі асерти `HELP_TEXT mentions admin commands` (`/invite`, `/users`, `/revoke`) лишаються; додати `/role` в той же блок
- `BOT_COMMANDS_BY_ROLE.viewer` не містить `add`, `invite`, `role`
- `BOT_COMMANDS_BY_ROLE.editor` містить `add` але не `invite`/`role`
- `BOT_COMMANDS_BY_ROLE.admin` містить `role`
- Всі command names ≤32 символи (Telegram limit)

**`worker/test/handler.test.mjs`:**

- viewer chat: `/info` → success
- viewer chat: `/add UA-...` → refusal `🚫 Це команда для редакторів`; `saveWatchlist` не викликається
- viewer chat: `/remove UA-...` → refusal; `saveWatchlist` не викликається
- viewer chat: `/watch 12345678` → refusal; `saveWatchedEntities` не викликається
- viewer chat: `/unwatch 12345678` → refusal
- viewer chat: `/unarchive UA-...` → refusal
- viewer chat: `/role editor 99999` → silent return (admin-only)
- viewer chat: `/invite editor X` → silent return
- editor chat: `/add UA-...` → success (`saveWatchlist` called)
- editor chat: `/role editor 99999` → silent return
- editor chat: `/invite editor X` → silent return
- admin chat: `/invite editor Andrii` → invite created with role='editor'
- admin chat: `/invite viewer Olha` → invite created with role='viewer'
- admin chat: `/invite Andrii` → reply `❌ Вкажи роль першим`
- admin chat: `/role editor 7321709183` (user exists, was viewer) → role flipped; reply `✅`
- admin chat: `/role viewer 1744078008` (self) → refusal "не можна змінити роль адміна"
- admin chat: `/role editor 99999` → "не знайдено"
- admin chat: `/role editor 7321709183` (already editor) → "вже editor", no save
- inline `add:` callback, viewer → `ack('🚫 Лише для редакторів', true)`; no watchlist write
- inline `add:` callback, editor → success
- `/start` (no token), viewer → `setMyCommands` called with VIEW_COMMANDS
- `/start` (no token), editor → `setMyCommands` called with VIEW+EDIT
- `/start` (no token), admin → `setMyCommands` called with all
- `/start <token>` successful redeem → `setMyCommands` called with VIEW (or EDIT, depends on invite.role)
- `/role` success → `setMyCommands` called for target chat_id with new role's command set
- legacy `allowed_users.json` (entry without `role`) → user treated as viewer (refusal on /add)
- legacy `invites.json` (record without `role`) → redeem → user.role === 'viewer'

## Deployment

1. Merge у `main` → CI задеплоїть Worker.
2. **Onboard 7321709183 як editor:**
   - Адмін у боті: `/invite editor Andrii`
   - Бот віддасть посилання `t.me/terralab_tenders_bot?start=<token>`
   - Адмін пересилає лінку 7321709183 → юзер тапає → редеплой/secret не потрібний → у allowed_users.json з'являється `{chat_id:"7321709183", label:"Andrii", role:"editor", joined_at:"..."}`
3. **Глобальний BotFather command list** — лишити viewer-set (мінімум). За потреби — оновити (через @BotFather → `/setcommands`):
   ```
   help - Список команд
   menu - Швидкі кнопки
   status - Здоровʼя бота
   info - Список або деталі тендерів
   watched - Список замовників
   archive - Архів завершених закупівель
   ```
4. Для існуючих editor/admin чатів autocomplete оновиться при наступному `/start`. Або разово запустити setMyCommands вручну (поза скоупом MVP).

## Edge cases

- **Existing `allowed_users.json` без поля `role`:** читається як viewer; коли admin зробить `/role editor X`, запис оновиться і отримає поле.
- **Existing `invites.json` без поля `role`:** redeem → новий user отримує `role: 'viewer'`. Інші pending invites — без зміни поки не використані.
- **Race: admin зробив `/role editor X`, X одночасно натиснув `/add`:** залежить від порядку завантаження. Якщо X завантажив `allowed_users.json` до save — побачить старий `role`. У наступному повідомленні буде вже OK. Acceptable; no extra coordination needed.
- **`setMyCommands` failure:** залогувати, не блокувати відповідь. Telegram кешує — наступний `/start` спробує знову.
- **`/role` для admin chat_id:** refuse explicitly, бо admin не має запису в `allowed_users.json`, і навіть якщо мав би — змінювати власну роль через бот небажано.
- **`/revoke` для editor'а:** просто видаляє запис із `allowed_users.json` — наступний `isInvited` = false, юзер стає guest. Без додаткової логіки.
- **`/role` після `/revoke`:** "не знайдено" — як очікуємо.

## Out of scope

- Локалізація refusal-повідомлень (UA only).
- Per-user invite TTL override.
- Audit log змін ролі.
- Реплі-клавіатура для адмін-команд.
- Передача `role` редаговано-кому через окремий env (як `EDITOR_CHAT_IDS`) — розглядалось, відкинуто на користь storage-based підходу.
