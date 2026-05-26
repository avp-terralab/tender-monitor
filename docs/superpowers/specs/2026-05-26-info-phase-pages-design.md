# `/info` згруповано за фазами — окреме повідомлення на кожну фазу

**Date:** 2026-05-26
**Status:** Draft

## Problem

Команда `/info` (і кнопка «📋 Моніторинг закупівель») виводить усі активні тендери одним списком. Користувач хоче бачити їх **згрупованими за фазою закупівлі**, де кожна фаза — окреме повідомлення («сторінка»): Приймання пропозицій, Розгляд пропозицій, Очікування підписання договору тощо.

Сьогодні `formatInfo` повертає один рядок; воркер шле його одним `sendReply` (який від попереднього фіксу ріже надто довге за довжиною на межах абзаців — це лишається запобіжником, але не дає смислового групування).

## Рішення

Нова чиста функція `formatInfoPages` групує тендери за фазою й повертає **масив рядків** — по сторінці на непорожню фазу (+ опційна сторінка помилок). Воркер у режимі «всі тендери» шле кожну сторінку окремим `sendReply`. Режим одного тендера (`/info <UA-…>`) не змінюється.

## Фази та порядок

Порядок сторінок — за життєвим циклом закупівлі. Кожна фаза має емодзі, заголовок і набір Prozorro-статусів:

| # | Емодзі | Заголовок | Статуси |
|---|---|---|---|
| 1 | 📥 | Приймання пропозицій | `active.tendering` |
| 2 | 🧮 | Прекваліфікація | `active.pre-qualification`, `active.pre-qualification.stand-still` |
| 3 | 🔨 | Триває аукціон | `active.auction` |
| 4 | 🔍 | Розгляд пропозицій | `active.qualification` |
| 5 | ✍️ | Очікування підписання договору | `active.awarded` |
| 6 | 📦 | Інші статуси | будь-який статус поза переліком вище (запобіжник) |

Порожні фази пропускаються (повідомлення не шлеться).

## Сортування всередині фази

- **Приймання пропозицій** — за дедлайном подачі (`deadline`) за зростанням (найближчі зверху). Тендери без `deadline` — у кінці.
- **Решта фаз** — за `tender_id` (стабільний порядок; дедлайн там у минулому й несе мало сенсу).

## Формат сторінки

**Перша сторінка** має глобальний рядок-шапку, далі — заголовок фази:
```
📋 Статус тендерів (HH:MM, DD.MM.YYYY)

📥 Приймання пропозицій (3)

━━━━━━━━━━ 1 ━━━━━━━━━━
<formatInfoEntry>

━━━━━━━━━━ 2 ━━━━━━━━━━
<formatInfoEntry>
```

**Наступні сторінки** — лише заголовок фази:
```
🔍 Розгляд пропозицій (2)

━━━━━━━━━━ 1 ━━━━━━━━━━
<formatInfoEntry>
```

- Час/дата — у форматі Києва (як у поточному `formatInfo`: `HH:MM` + `DD.MM.YYYY`).
- Лічильник у заголовку фази — кількість тендерів у цій фазі.
- Нумерація `━━ N ━━` — у межах фази, з 1.
- Вміст кожного тендера — поточний `formatInfoEntry(g, runIso)` **без змін**.

## Краї

- **Помилки fetch** (тендер не вдалось перевірити) → окрема **остання** сторінка:
  ```
  ⚠️ Не вдалось перевірити (N)
    • UA-… — <error>
  ```
- **Жодного тендера і жодної помилки** → один рядок `📭 Немає активних тендерів.` (як зараз).
- **Лише одна непорожня фаза** → одна сторінка (з глобальною шапкою).

## Точки зміни в коді

### 1. `commands.mjs`

**`PHASES`** (нова приватна константа) — впорядкований масив фаз:
```js
const PHASES = [
  { emoji: '📥', label: 'Приймання пропозицій',            statuses: ['active.tendering'] },
  { emoji: '🧮', label: 'Прекваліфікація',                 statuses: ['active.pre-qualification', 'active.pre-qualification.stand-still'] },
  { emoji: '🔨', label: 'Триває аукціон',                  statuses: ['active.auction'] },
  { emoji: '🔍', label: 'Розгляд пропозицій',              statuses: ['active.qualification'] },
  { emoji: '✍️', label: 'Очікування підписання договору',  statuses: ['active.awarded'] },
];
// Будь-який статус поза PHASES потрапляє у фолбек «📦 Інші статуси».
const OTHER_PHASE = { emoji: '📦', label: 'Інші статуси' };
```

**`formatInfoPages`** (новий експорт, чиста) — повертає `string[]`:
```js
export function formatInfoPages({ runIso, groups, errors = [] }) {
  if (groups.length === 0 && errors.length === 0) {
    return ['📭 Немає активних тендерів.'];
  }

  // Bucket groups by phase, preserving PHASES order; unknown statuses → OTHER.
  const known = new Set(PHASES.flatMap(p => p.statuses));
  const buckets = PHASES.map(p => ({
    ...p,
    items: groups.filter(g => p.statuses.includes(g.status)),
  }));
  const otherItems = groups.filter(g => !known.has(g.status));
  if (otherItems.length > 0) buckets.push({ ...OTHER_PHASE, items: otherItems });

  // Sort within phase: tendering by deadline asc (nulls last); others by tender_id.
  for (const b of buckets) {
    if (b.statuses?.includes('active.tendering')) {
      b.items.sort((a, c) => deadlineKey(a) - deadlineKey(c));
    } else {
      b.items.sort((a, c) => a.tender_id.localeCompare(c.tender_id));
    }
  }

  const header = `📋 Статус тендерів (${kyivTime(runIso)}, ${kyivDate(runIso)})`;
  const pages = [];
  for (const b of buckets) {
    if (b.items.length === 0) continue;
    const lines = [`${b.emoji} ${b.label} (${b.items.length})`];
    b.items.forEach((g, i) => {
      lines.push('');
      lines.push(`━━━━━━━━━━ ${i + 1} ━━━━━━━━━━`);
      lines.push(formatInfoEntry(g, runIso));
    });
    pages.push(lines.join('\n'));
  }

  if (errors.length > 0) {
    const lines = [`⚠️ Не вдалось перевірити (${errors.length})`];
    for (const e of errors) lines.push(`  • ${e.tender_id} — ${e.error}`);
    pages.push(lines.join('\n'));
  }

  // Prepend the global header to the first page only.
  if (pages.length > 0) pages[0] = `${header}\n\n${pages[0]}`;
  return pages;
}
```
Helpers:
```js
function deadlineKey(g) {
  return g.deadline ? new Date(g.deadline).getTime() : Number.POSITIVE_INFINITY;
}
```
`kyivTime`/`kyivDate` — винести з тіла поточного `formatInfo` у спільні приватні хелпери (DRY), або повторно використати наявні `Intl.DateTimeFormat` константи. `formatInfo` лишається для single-id шляху.

### 2. `worker/src/handler.mjs`

У гілці `cmd.cmd === 'info'`: коли запит **без** `cmd.tender_id` (перегляд усіх) — будувати сторінки:
```js
} else {
  targets = watchlist.filter(r => r.enabled);
}
...
// all-tenders view → pages; single-id view → one message
if (!cmd.tender_id) {
  reply = formatInfoPages({ runIso: new Date().toISOString(), groups, errors });
} else {
  reply = formatInfo({ runIso: new Date().toISOString(), groups, errors });
}
```
(`formatInfoPages` додати в імпорт з `../../commands.mjs`.)

`reply` тепер може бути рядком **або масивом рядків**. Узагальнити фінальну відправку (рядки ~588):
```js
const pages = Array.isArray(reply) ? reply : [reply];
for (let i = 0; i < pages.length; i++) {
  try {
    await _sendReply({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: msg.chat.id,
      text: pages[i],
      replyToMessageId: i === 0 ? msg.message_id : undefined,
      replyMarkup: i === pages.length - 1
        ? (notifyReplyMarkup ?? (isAllowed ? MAIN_KEYBOARD : undefined))
        : undefined,
    });
  } catch (err) {
    console.error('worker: sendReply failed:', err.message);
  }
}
```
Цитата-відповідь — лише на першій сторінці; клавіатура — лише на останній. `sendReply` сам ріже занадто довгу сторінку на під-частини (попередній фікс), тож фаза з багатьма тендерами не впаде в ліміт 4096.

Live-archive у `/info <id>` (термінальний статус) — не зачіпається: це лише single-id шлях.

### 3. Тести

**`test/commands.test.mjs`** (`formatInfoPages`):
- порожньо → `['📭 Немає активних тендерів.']`
- по одному тендеру в трьох різних фазах → 3 сторінки, у порядку PHASES; заголовки містять емодзі+назву+`(1)`
- 1-ша сторінка містить `📋 Статус тендерів (`; наступні — ні
- фаза «Приймання» з кількома тендерами сортується за дедлайном (найближчий — `━━ 1 ━━`); тендер без дедлайну — останній
- не-приймальна фаза сортується за `tender_id`
- порожні фази пропускаються (немає сторінки)
- невідомий статус (напр. `active.something`) → потрапляє у «📦 Інші статуси»
- наявність `errors` → остання сторінка `⚠️ Не вдалось перевірити (N)` з рядками помилок
- лише помилки, без груп → одна сторінка помилок (без шапки тендерів? — шапка додається до `pages[0]`, тобто до сторінки помилок; прийнятно)
- вміст тендера дослівно дорівнює `formatInfoEntry(g, runIso)` (групування не змінює рендер запису)

**`worker/test/handler.test.mjs`:**
- `/info` (без id), watchlist із тендерами у 2 фазах → `sendReply` викликано 2 рази; `reply_to_message_id` лише на першому виклику; `replyMarkup` (MAIN_KEYBOARD) лише на останньому
- `/info` з порожнім watchlist → один `sendReply` з «Немає активних тендерів»
- `/info UA-…` (один тендер) → один `sendReply` (single-id шлях, без фаз-сторінок)
- кнопка «📋 Моніторинг закупівель» → той самий багатосторінковий шлях, що й `/info`
- одна з фаз із багатьма тендерами, що перевищує 4096 → кількість викликів `sendReply` ≥ кількості фаз (внутрішній чанкінг не ламає логіку; перевірити, що всі тексти ≤4096)

## Out of scope

- Пагінація з кнопками «далі/назад» (inline) — поки просто кілька повідомлень.
- Зміна рендеру окремого тендера (`formatInfoEntry`) — лишається як є.
- Групування у крон-дайджесті (`formatDigest`) — інший потік, поза цією зміною.
- Згортання/розгортання фаз, фільтри за фазою.
- Зміна `/info <id>` (single-tender) — лишається одним повідомленням.
