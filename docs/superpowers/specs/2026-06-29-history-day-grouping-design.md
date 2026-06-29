# Групування історії сповіщень по днях

Дата: 2026-06-29

## Мета

Замість плоского списку записів `DD.MM HH:mm · summary` — показувати записи
згруповано під заголовками дат у межах одного екрана Telegram.

## Затверджені рішення

- **Варіант відображення:** заголовок дня + розгорнутий список записів (не згорнуті групи).
- **Заголовки дат** — не-інтерактивні рядки в inline keyboard (`callback_data: 'noop'`).
- **Пагінація:** "не різати день" — до 6 записів на сторінці, але якщо черговий запис
  є першим записом нового дня, він починає наступну сторінку. День з 8+ записів
  розміщується цілком на одній сторінці (переповнення ліміту допустиме).

## Формат відображення

```
── 29 червня ──          ← noop-кнопка (заголовок дня)
  16:25 · 📖 1           ← entry-кнопка (лише час, без дати)
  14:55 · 🏆 1
── 28 червня ──
  09:25 · 📌 2
── 27 червня ──
  17:25 · 📌 2
  09:25 · 📌 1
[◀ Назад]  [▶ Далі]
```

Запис більше не містить дати — вона винесена в заголовок.

## Форматери дат

Замість одного `HIST_DT` (`DD.MM HH:mm`) — два:

| Константа  | Формат         | Приклад      | Використання          |
|------------|----------------|--------------|-----------------------|
| `HIST_DAY` | `day + month long` | `29 червня` | заголовок дня (noop) |
| `HIST_TIME`| `HH:mm`        | `16:25`      | рядок запису          |

Обидва — `uk-UA`, `timeZone: 'Europe/Kyiv'`.

## Алгоритм пагінації

```
startIdx = page_start   // стартовий індекс у масиві history
entries = []
lastDay = null

for i = startIdx to history.length - 1:
  entry = history[i]
  day = formatDay(entry.sent_at)          // HIST_DAY

  if day !== lastDay and entries.length > 0:
    // новий день, і вже є записи на сторінці
    if entries.length >= 6:
      break                               // стоп: сторінка заповнена, не різати день
    // інакше — продовжуємо (менше 6, новий день починається на цій же сторінці)

  entries.push(entry)
  lastDay = day

nextPageStart = i   // перший індекс наступної сторінки
hasNext = i < history.length
```

**Особливий випадок:** якщо один день має > 6 записів, всі вони потрапляють на одну
сторінку (перевищення ліміту). Це рідкісний сценарій, overflow прийнятний.

## Формування inline keyboard

```javascript
for (const entry of entries) {
  const day = formatDay(entry.sent_at);
  if (day !== prevDay) {
    keyboard.push([{ text: `── ${day} ──`, callback_data: 'noop' }]);
    prevDay = day;
  }
  keyboard.push([{ text: `${formatTime(entry.sent_at)} · ${entry.summary}`,
                   callback_data: `hist:${entry.idx}` }]);
}
```

## Обробка noop

У `handler.mjs`, у switch по `callback_data`:

```javascript
case 'noop':
  await answerCallbackQuery(callbackId);
  return;
```

Нічого не роблять, не навігують, не показують повідомлень.

## Файли, що змінюються

| Файл | Зміна |
|------|-------|
| `commands.mjs` | Замінити `HIST_DT` на `HIST_DAY` + `HIST_TIME`; переписати пагінацію `buildHistoryList()`; вставляти noop-рядки між групами |
| `worker/src/handler.mjs` | Додати `case 'noop'` |

**Без змін:** `monitor.mjs`, `telegram.mjs`, `worker/src/github.mjs`, структура `_state/notification_history.json`.

## Тести

- `buildHistoryList()` з вхідними даними: 2 записи 29.06 + 1 запис 28.06 → 1 noop + 2 entries + 1 noop + 1 entry.
- Пагінація: 5 записів 29.06 + 3 записи 28.06 → сторінка 1 = 5 (29.06), сторінка 2 = 3 (28.06).
- Пагінація: 8 записів одного дня → всі 8 на одній сторінці.
- `noop` callback → відповідь без дії.
