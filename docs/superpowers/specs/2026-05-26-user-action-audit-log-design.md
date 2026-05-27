# Аудит-лог дій користувачів (через коміти) + `/log`

**Date:** 2026-05-26
**Status:** Draft

## Problem

Власник хоче бачити, **хто** з користувачів виконав мутуючу дію — додав/видалив тендер, почав/припинив стежити за замовником — а також хто з адмінів керував доступом (invite/revoke/role). Переглядові команди (`/info`, `/status`, `/archive`, `/watched`, `/whoami`, `/help`) логувати **не** треба.

Поточний стан: кожна мутація вже створює коміт у репо (стан = файли в Git, зміни йдуть через GitHub Contents API). Тобто **ЩО** і **КОЛИ** змінилось — вже зафіксовано в git-історії та дифах. Бракує єдиного — **ХТО**: повідомлення комітів generic (`bot: update watchlist <iso>`), а автор коміту завжди один (бот через PAT).

## Рішення (обрано)

Дописати в **повідомлення коміту** актора й дію. Git-історія стає повноцінним незмінним аудит-логом, а команда `/log` читає останні коміти через GitHub commits API (вже підключений: `fetchLastCommit`, `fetchLatestDeployCommit`) і форматує їх у Telegram.

**Окремого файлу-сховища немає.** Аудит і зміна стану пишуться **одним комітом** — атомарно, без розсинхрону й без другого запису/конфлікту SHA.

### Чому не окремий `audit_log.json`

Розглядалось і відкинуто: окремий файл вимагає другого save-коміту на кожну дію (подвоєння write-трафіку + поверхня конфліктів load/save), а частковий збій (мутація записалась, лог — ні) дає брехливий аудит. Git-історія транзакційна за дизайном — таких проблем не має.

### Чому актор у тілі повідомлення, а не в git-`author`

GitHub Contents API дозволяє задати `author: {name, email}`, але ім'я приходить з недовіреного Telegram-вводу, і це засмічувало б contributor-статистику репо. Тримаємо актора **тільки в тілі повідомлення** (парситься), git-author лишається ботом.

## Обсяг

### Логуємо (мутуючі дії користувача)

| Команда | Дія | Ціль у логу |
|---|---|---|
| `/add UA-...` | `add` | tender_id |
| `/remove UA-...` | `remove` | tender_id |
| `/watch EDRPOU` | `watch` | edrpou |
| `/unwatch EDRPOU` | `unwatch` | edrpou |
| `/unarchive UA-...` | `unarchive` | tender_id |
| inline-кнопка `add:` | `add` | tender_id |
| `/invite role label` | `invite` | `role:label` |
| `/revoke chat_id` | `revoke` | chat_id |
| `/role role chat_id` | `role→<role>` | chat_id |

### НЕ логуємо

- Переглядові: `/list`, `/info`, `/status`, `/archive`, `/watched`, `/whoami`, `/help`, `/start`.
- `/notify on|off` — персональні налаштування сповіщень.
- `/start <token>` (redeem) — поза узгодженим обсягом (рішення власника).
- Системні записи: авто-архівація з `/info` (`applyLiveArchive`) і cron-коміти (`monitor: ...`). Формат префіксів це гарантує (див. нижче).

## Формат коміту

Парситься машиною, перший рядок:

```
audit: <action> <target> · <actor> [<chat_id>/<role>]
```

Приклади:
```
audit: add UA-2026-04-30-010542-a · Андрій Парасина [786078813/editor]
audit: unwatch 12345678 · Оксана Каніцька [7321709183/editor]
audit: revoke 1402480451 · admin [786078813/admin]
audit: role→editor 7321709183 · admin [786078813/admin]
audit: invite editor:Олег · admin [786078813/admin]
```

**Префікс `audit:`** (а не поточний `bot:`) — щоб `/log` чисто фільтрував дії людей від системних `bot: update ...` і `monitor: ...`. Наслідок: треба додати `audit:` у `BOT_RE` всередині `fetchLatestDeployCommit` (`worker/src/github.mjs:242`), щоб `/status` і далі ігнорував ці коміти як «не деплой».

**`<actor>`** — людинозрозуміле ім'я з `msg.from` Telegram-апдейту (`first_name` + `last_name`), бо воно присутнє завжди, включно з адміном (який не має запису в `allowed_users.json`). Якщо `msg.from` порожній — fallback на `label` із `userRecord`, далі на `chat_id`.

**Безпека формату:** `<actor>` ставимо **останнім** і санітизуємо (`sanitizeActor`): прибрати переноси рядків і символи `·`/`[`/`]`, схлопнути пробіли, обрізати до ~40 символів. Дія й ціль (контрольовані, валідовані `parseCommand`) ідуть першими, тож дивне ім'я не зламає парсинг. При рендері `/log` ім'я екрануємо для Telegram HTML (`escapeHtml`).

## `/log` (тільки адмін)

`/log [N]` — показати останні N зафіксованих дій, найновіші згори. Дефолт 20, максимум 50.

```
📋 Журнал дій (останні 20)

• 26.05 14:32 — Андрій Парасина додав UA-2026-04-30-010542-a
• 26.05 12:10 — Оксана Каніцька прибрала стеження за 12345678
• 25.05 09:05 — admin видав invite (editor: Олег)
• 24.05 18:40 — admin змінив роль 7321709183 → editor
```

**Дієслова (мапа `action → фраза`):**

| action | фраза |
|---|---|
| `add` | `додав {target}` |
| `remove` | `видалив {target}` |
| `watch` | `почав стеження за {target}` |
| `unwatch` | `прибрав стеження за {target}` |
| `unarchive` | `повернув з архіву {target}` |
| `invite` | `видав invite ({role}: {label})` |
| `revoke` | `прибрав доступ {target}` |
| `role→X` | `змінив роль {target} → X` |

**Обмеження (свідоме):** `/log` читає одну сторінку commits API (`per_page=100`) і фільтрує `audit:`. За поточного обсягу (кілька дій/день, кілька редакторів) це покриває багато днів. Якщо колись лог стане щільнішим — додамо пагінацію (поза цим обсягом).

## Точки зміни в коді

### 1. `commands.mjs`

**`parseCommand`** — нова гілка `/log` (поряд із простими `/help`, `/status`):
```js
const logMatch = trimmed.match(/^\/log(?:@\w+)?(?:\s+(\d+))?\s*$/i);
if (logMatch) {
  const n = logMatch[1] ? parseInt(logMatch[1], 10) : 20;
  return { cmd: 'log', limit: Math.min(Math.max(n, 1), 50) };
}
```

**`formatAuditMessage`** (новий експорт, чиста) — будує перший рядок коміту:
```js
export function sanitizeActor(name) {
  return String(name ?? '')
    .replace(/[\r\n·\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '?';
}

export function formatAuditMessage({ action, target, actor, chatId, role }) {
  const t = target ? ` ${target}` : '';
  return `audit: ${action}${t} · ${sanitizeActor(actor)} [${chatId}/${role}]`;
}
```

**`parseAuditCommit`** (новий експорт, чиста) — розбирає перший рядок назад у структуру; повертає `null`, якщо це не audit-коміт:
```js
export function parseAuditCommit(message) {
  const line = String(message ?? '').split('\n')[0];
  const m = line.match(/^audit:\s+(\S+)(?:\s+(.+?))?\s+·\s+(.+?)\s+\[([^\/\]]+)\/([^\]]+)\]\s*$/);
  if (!m) return null;
  return { action: m[1], target: m[2] ?? null, actor: m[3], chatId: m[4], role: m[5] };
}
```

**`formatAuditLog`** (новий експорт, чиста) — приймає масив `{ action, target, actor, date }` (вже розпарсених і відсортованих новіші→старіші) і будує текст відповіді:
```js
const KYIV_DT_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatAuditLog(entries, { limit }) {
  if (!entries || entries.length === 0) {
    return '📋 Журнал порожній — поки немає зафіксованих дій.';
  }
  const shown = entries.slice(0, limit);
  const lines = shown.map(e => {
    const when = e.date ? KYIV_DT_FMT.format(new Date(e.date)) : '??';
    return `• ${when} — ${escapeHtml(e.actor)} ${auditPhrase(e)}`;
  });
  return `📋 Журнал дій (останні ${shown.length})\n\n` + lines.join('\n');
}
```
(`auditPhrase(e)` — мапа `action → фраза` з таблиці вище; для `role→X` парсити суфікс.)

**`HELP_ADMIN`** — додати рядок: `/log [N] — журнал дій користувачів (хто що додав/видалив)`.

**`ADMIN_COMMANDS`** (для `setMyCommands`) — додати `{ command: 'log', description: 'Журнал дій користувачів' }`.

### 2. `worker/src/github.mjs`

**Опційне повідомлення коміту в save-функціях.** Зараз `saveWatchlist` хардкодить message; `saveFile` — теж. Додаємо опційний `message`:
```js
export async function saveWatchlist(env, watchlist, sha, { fetch: fetchImpl = fetch, message } = {}) {
  // ...
  const body = {
    message: message ?? `bot: update watchlist ${new Date().toISOString()}`,
    content: base64, sha, branch: 'main',
  };
  // ...
}

async function saveFile(env, filePath, text, sha, { fetch: fetchImpl = fetch, message } = {}) {
  // ...
  const body = {
    message: message ?? `bot: update ${filePath} ${new Date().toISOString()}`,
    content: base64, branch: 'main',
  };
  if (sha != null) body.sha = sha;
  // ...
}
```
Обгортки прокидають `opts` далі (вже приймають `opts = {}`): `saveWatchedEntities`, `saveWatchedSeen`, `saveInvites`, `saveAllowedUsers`, `saveArchivedTenders`. Жодних змін у їхніх сигнатурах — `opts.message` просто доходить до `saveFile`. **back-compat:** усі наявні виклики без `message` дають той самий `bot: update ...`, що й зараз.

**`fetchAuditLog`** (нова) — читає коміти й віддає сирі `{ message, date }`:
```js
export async function fetchAuditLog(env, { fetch: fetchImpl = fetch, perPage = 100 } = {}) {
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/commits?per_page=${perPage}`,
    { headers: { Authorization: `Bearer ${env.GITHUB_PAT}`,
      'User-Agent': 'tender-monitor-worker', Accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) throw new Error(`GitHub commits API ${res.status}`);
  const commits = await res.json();
  return commits.map(c => ({
    message: (c.commit?.message ?? '').split('\n')[0],
    date: c.commit?.committer?.date ?? null,
  }));
}
```

**`fetchLatestDeployCommit`** — розширити `BOT_RE` (рядок 242):
```js
const BOT_RE = /^(monitor: state update|monitor: cursor sync|bot:|audit:)/;
```

### 3. `worker/src/handler.mjs`

**Дескриптор актора.** На початку `runHandler`, поряд із `chatId`/`role`, зібрати:
```js
const from = msg.from ?? {};
const actorName = [from.first_name, from.last_name].filter(Boolean).join(' ')
  || userRecord?.label || chatId;
const actor = { actorName, chatId, role };
```
(У `handleCallbackQuery` — аналогічно з `cq.from`.)

**Прокидання `message` крізь `...WithRetry`-хелпери.** Кожен хелпер отримує опційний `auditMessage` і передає його в save:
```js
async function applyMutationWithRetry({ env, loadWatchlist, saveWatchlist, computeMutation, auditMessage }) {
  // ...
  await saveWatchlist(env, newWatchlist, sha, { message: auditMessage });
  // ...
}
```
Те саме для `applyEntityMutationWithRetry` (→ `saveWatchedEntities`), `applyInviteMutationWithRetry` (→ `saveInvites`), `applyAllowedUsersMutationWithRetry` (→ `saveAllowedUsers`), `applyUnarchive` (→ `saveArchivedTenders`), і `/notify`-блок **не** чіпаємо (його не логуємо — лишається без message).

**Будування `auditMessage` на місці диспетчу.** Для кожної логованої гілки перед викликом WithRetry:
```js
// /add
auditMessage: formatAuditMessage({ action: 'add', target: cmd.tender_id, actor: actorName, chatId, role }),
// /remove
... action: 'remove', target: cmd.tender_id ...
// /watch
... action: 'watch', target: cmd.edrpou ...
// /unwatch
... action: 'unwatch', target: cmd.edrpou ...
// /unarchive
... action: 'unarchive', target: cmd.tender_id ...
// /invite (label — вільний текст, тож санітизуємо: target = `${cmd.role}:${sanitizeActor(cmd.label)}`)
... action: 'invite', target: `${cmd.role}:${sanitizeActor(cmd.label)}` ...
// /revoke
... action: 'revoke', target: cmd.chat_id ...
// /role
... action: `role→${cmd.role}`, target: cmd.chat_id ...
```
**Важливо:** `auditMessage` будуємо лише на успішному шляху (коли `computeMutation` поверне `mutation`). Якщо мутації немає (no-op, напр. `/remove` неіснуючого) — save не викликається, коміту немає, логу немає. Це коректно: лог фіксує реальні зміни стану, а не спроби. (Будувати message заздалегідь безпечно — він просто не використається, якщо `result.mutation` порожній.)

**Inline `add:` callback** (`handleCallbackQuery`) — той самий `auditMessage` для `action: 'add'`, актор із `cq.from`.

**Нова гілка `/log`:**
```js
} else if (cmd.cmd === 'log') {
  if (!isAdmin) return;
  try {
    const raw = await _fetchAuditLog(env);
    const entries = raw
      .map(c => { const p = parseAuditCommit(c.message); return p ? { ...p, date: c.date } : null; })
      .filter(Boolean);
    reply = formatAuditLog(entries, { limit: cmd.limit });
  } catch (err) {
    console.error('worker: /log failed:', err.message);
    reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
  }
}
```
Інжекція deps: `const _fetchAuditLog = deps.fetchAuditLog ?? fetchAuditLog;` (+ імпорт із `./github.mjs`, + імпорт `formatAuditMessage`, `parseAuditCommit`, `formatAuditLog` з `../../commands.mjs`).

## Тести

### `test/commands.test.mjs`

- `parseCommand('/log')` → `{ cmd:'log', limit:20 }`
- `parseCommand('/log 5')` → `{ cmd:'log', limit:5 }`
- `parseCommand('/log 999')` → `limit:50` (cap)
- `parseCommand('/log 0')` → `limit:1` (floor)
- `parseCommand('/log abc')` → `{ cmd:'unknown' }` (не матчить `\d+`)
- `formatAuditMessage({action:'add', target:'UA-..a', actor:'Андрій', chatId:'1', role:'editor'})` === `'audit: add UA-..a · Андрій [1/editor]'`
- `formatAuditMessage` з `target:null` (теоретичний) → без зайвого пробілу
- `sanitizeActor('Ан\nдрій · [x]')` → `'Ан дрій x'` (без `\n·[]`)
- `sanitizeActor('')` → `'?'`
- `sanitizeActor('a'.repeat(100))` → довжина ≤ 40
- **round-trip:** `parseAuditCommit(formatAuditMessage(x))` повертає `action/target/actor/chatId/role`, що збігаються з `x` (для звичайних і кириличних імен)
- `parseAuditCommit('bot: update watchlist 2026-...')` → `null`
- `parseAuditCommit('monitor: state update')` → `null`
- `parseAuditCommit('audit: role→editor 123 · admin [9/admin]')` → `{ action:'role→editor', target:'123', actor:'admin', chatId:'9', role:'admin' }`
- `parseAuditCommit` коректно парсить ім'я з пробілами (`Андрій Парасина`)
- `formatAuditLog([], {limit:20})` → містить «порожній»
- `formatAuditLog([entry], {limit:20})` → містить дату (Київ), ім'я, фразу для кожного action
- `formatAuditLog` — кожен `action` дає правильну фразу (`add`→додав, `unwatch`→прибрав стеження, `role→editor`→«змінив роль … → editor», `invite`→«видав invite (editor: Олег)»)
- `formatAuditLog` екранує HTML у `actor` (ім'я з `<` не ламає розмітку)
- `formatAuditLog` обмежує до `limit`
- `buildHelpText('admin')` містить `/log`
- `buildHelpText('viewer')` / `('editor')` **не** містять `/log`
- `BOT_COMMANDS_BY_ROLE.admin` містить `log`; `.editor`/`.viewer` — ні
- усі `command` ≤ 32 символи (наявний асерт лишається валідним)

### `worker/test/github.test.mjs`

- `saveWatchlist(env, wl, sha, { message:'audit: ...' })` → у тілі PUT `message === 'audit: ...'`
- `saveWatchlist(env, wl, sha)` (без message) → дефолт `bot: update watchlist ...` (back-compat)
- `saveAllowedUsers(env, u, sha, { message:'audit: ...' })` → message прокинуто в `saveFile` PUT
- `fetchAuditLog(env)` з мок-fetch (масив комітів) → повертає `[{message, date}]` з першими рядками
- `fetchLatestDeployCommit` пропускає коміт із префіксом `audit:` (повертає перший «не-bot/monitor/audit»)

### `worker/test/handler.test.mjs`

- editor `/add UA-...` (успіх) → `saveWatchlist` викликано з `opts.message` що матчить `^audit: add UA-`, і містить ім'я з `msg.from` + `[<chatId>/editor]`
- editor `/remove UA-...` (успіх) → message `^audit: remove UA-`
- editor `/watch 12345678` → `saveWatchedEntities` з message `^audit: watch 12345678`
- editor `/unwatch 12345678` → message `^audit: unwatch 12345678`
- editor `/unarchive UA-...` → `saveArchivedTenders` з message `^audit: unarchive UA-`
- admin `/invite editor Олег` → `saveInvites` з message `^audit: invite editor:Олег`
- admin `/invite editor Ан · Бор` (label з роздільником) → message парситься назад через `parseAuditCommit` без втрати actor/role (label санітизовано)
- admin `/revoke 123` → `saveAllowedUsers` з message `^audit: revoke 123`
- admin `/role editor 7321709183` → `saveAllowedUsers` з message `^audit: role→editor 7321709183`
- **no-op не логується:** editor `/remove` неіснуючого тендера → save **не** викликається (немає mutation), коміту немає
- actor fallback: апдейт без `msg.from` → message містить `label` юзера (або `chatId`)
- actor санітизація: `msg.from.first_name` з `·`/`\n` → у message немає сирих `·`/переносів (парсер не ламається)
- inline `add:` callback (editor) → `saveWatchlist` з message `^audit: add UA-`, актор із `cq.from`
- `/log` admin → `fetchAuditLog` викликано; reply містить розпарсені дії
- `/log` non-admin (editor/viewer) → silent return (як інші admin-only)
- `/log` коли `fetchAuditLog` кидає → reply «GitHub тимчасово недоступний»
- `/log` фільтрує не-audit коміти (мок повертає мікс `audit:`/`bot:`/`monitor:`) → у відповіді лише audit-дії
- `/notify on` (editor) → `saveAllowedUsers` викликано **без** `message` (не логуємо; дефолтний `bot: update`)

## Edge cases

- **No-op мутації** (`/remove` неіснуючого, `/unwatch` невідстежуваного, `/role` для вже-такої-ролі): `computeMutation` повертає `mutation: null` → save не викликається → коміту й запису в логу немає. Лог фіксує лише реальні зміни.
- **`auditMessage` для гілок, що не зберігають** (помилки парсингу `cmd.error`): ці гілки взагалі не доходять до WithRetry — message не будується.
- **Старі коміти до релізу** не мають `audit:`-префіксу → `parseAuditCommit` дає `null` → у `/log` їх не видно. Лог починається з моменту деплою. Прийнятно.
- **`msg.from` відсутній** (рідко — канали/служб. апдейти): fallback `label`→`chatId`; дія все одно атрибутується стабільним chat_id.
- **Ім'я з символами розмітки/роздільниками:** `sanitizeActor` чистить роздільники для парсингу, `escapeHtml` — для рендеру. Парсер стійкий, бо `action`/`target` (контрольовані) стоять перед вільним `actor`.
- **Вільний текст у `target` (тільки `/invite` label):** проганяємо через `sanitizeActor`, щоб `·`/`[`/`]`/переноси в імені запрошеного не зламали роздільник у `/log`. Решта цілей (tender_id, edrpou, chat_id) — валідовані `parseCommand`, без роздільників.
- **Два коміти на одну дію** (немає серед логованих): redeem (invites+users) не логуємо; live-archive (archive+watchlist) системний — обидва поза обсягом. Кожна логована дія = рівно один save = один audit-коміт.
- **GitHub недоступний при `/log`:** ловимо, віддаємо стандартний «тимчасово недоступний», не падаємо.
- **Дебаунс cron-комітів (~6h) та state-update коміти** інтерлівляться з audit-комітами, але `/log` фільтрує за префіксом — їх не видно. За `per_page=100` audit-дії не «тонуть» на горизонті кількох днів.

## Out of scope

- Пагінація `/log` за межі 100 останніх комітів (додамо, якщо обсяг зросте).
- Логування переглядових команд і `/notify`.
- Логування redeem (`/start <token>`) — свідомо виключено власником.
- Фільтри `/log` за користувачем/типом дії/тендером.
- Експорт логу (CSV/окремий файл).
- Атрибуція git-`author` за актором (свідомо відкинуто).
- Сповіщення адміна в реальному часі про кожну дію (розглядалось у брейнштормі, відкинуто на користь `/log`-on-demand).
