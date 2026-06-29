# Календарний грид для історії сповіщень

Дата: 2026-06-29

## Мета

Замінити точку входу "📜 Історія" з плоского списку на місячний календарний грид,
де дні з подіями підсвічені. Тап на день — список подій цього дня. Звідти —
існуючий екран деталей запису.

## Три стани навігації

```
📜 Історія → [Грид місяця] → тап на день → [Список дня] → тап на запис → [Повний текст]
                   ↑                              ↓
             ◀ ▶ місяці               ⬅ Назад до календаря
```

---

## Стан 1 — Грид місяця (`buildHistoryCalendar`)

**Текст повідомлення:**
```
📜 <b>Історія сповіщень</b> — N
```
де N — загальна кількість записів у всій історії.

**Inline keyboard (знизу-вгору по логіці, зверху-вниз по відображенню):**

1. Рядок навігації місяців:
   ```
   [◀]  [Червень 2026]  [▶]
   ```
   - `◀` → `hist:cal:<prev-YYYY-MM>` якщо є попередній місяць з подіями, інакше `hist:noop`
   - центр → `hist:noop` (назва місяця — заголовок)
   - `▶` → `hist:cal:<next-YYYY-MM>` якщо є наступний місяць з подіями, інакше `hist:noop`

2. Рядок заголовків днів тижня (один рядок, 7 кнопок):
   ```
   [Пн] [Вт] [Ср] [Чт] [Пт] [Сб] [Нд]
   ```
   Всі → `hist:noop`.

3. Рядки з днями місяця (кожен рядок — 7 кнопок):
   - Порожні комірки (до першого числа та після останнього) → `{ text: ' ', callback_data: 'hist:noop' }`
   - Дні без подій → `{ text: '<DD>', callback_data: 'hist:noop' }`
   - Дні з подіями → `{ text: '<DD>🔔', callback_data: 'hist:day:<YYYY-MM-DD>' }`
     де `🔔` — перший emoji з `summary` першої події дня (або просто `🔔` якщо summary відсутній)

**Порожній місяць:** якщо в місяці взагалі немає записів, відображати грид однаково,
але ◀/▶ вже вказуватимуть на ближчі місяці з подіями.

**Кнопки "⬅ Меню" немає** — грид є top-level екраном для Історії, зворотньої навігації
до inline-меню не існує. Вихід — через reply keyboard команди.

---

## Стан 2 — Список дня (`buildHistoryDay`)

**Текст повідомлення:**
```
📅 <b>29 червня</b> — N сповіщень
```

**Inline keyboard:**
- Рядки записів: такий самий формат, як в `buildHistoryList` (`🔔 HH:mm · summary`),
  callback → `hist:i:<idx>`.
- Якщо записів > 8 — пагінація (`hist:day:<YYYY-MM-DD>:p:<page>`), не різати список
  (відступаємо від "не різати день" — день вже визначений, тому проста пагінація по 8).
- Останній рядок: `[⬅ Назад до календаря]` → `hist:cal:<YYYY-MM>` місяця цього дня.

---

## Стан 3 — Повний текст (`buildHistoryItem`)

**Зміна:** кнопка "назад" оновлюється з `hist:p:<page>` на `hist:day:<YYYY-MM-DD>`,
де дата береться з `list[idx].sent_at`.

Текст кнопки: `⬅ Назад до 29 червня` (день + місяць, `HIST_DAY` формат).

---

## Схема callback_data

| Callback | Призначення |
|----------|-------------|
| `hist:cal:<YYYY-MM>` | Відкрити грид місяця |
| `hist:day:<YYYY-MM-DD>` | Відкрити список дня |
| `hist:day:<YYYY-MM-DD>:p:<page>` | Сторінка N списку дня |
| `hist:i:<idx>` | Повний текст запису (існуючий) |
| `hist:noop` | Неінтерактивна кнопка (існуючий) |

Старі `hist:p:<N>` callbacks більше не генеруються, але handler залишає підтримку
(рядки з `hist:p:` у `handleHistoryNav`) для backward compat з вже відправленими
повідомленнями.

---

## Алгоритм побудови гриду

```
year, month = parse(YYYY-MM)            // month 0-based
daysInMonth = new Date(year, month+1, 0).getDate()
firstDayOfWeek = new Date(year, month, 1).getDay()
offset = (firstDayOfWeek + 6) % 7      // Monday-start: 0=Пн, 6=Нд

cells = Array(offset).fill(null)        // порожні комірки-відступи
for d = 1 to daysInMonth:
  cells.push(d)
// вирівнювання до кратного 7
while cells.length % 7 !== 0:
  cells.push(null)

rows = []
for i = 0 to cells.length/7 - 1:
  row = cells[i*7 .. i*7+6].map(d => {
    if d is null: return { text: ' ', callback_data: 'hist:noop' }
    isoDate = `${year}-${padMonth}-${padDay}`
    events = entriesOnDay(isoDate)
    if events.length > 0:
      emoji = firstEmoji(events[0].summary) ?? '🔔'
      return { text: `${d}${emoji}`, callback_data: `hist:day:${isoDate}` }
    else:
      return { text: `${d}`, callback_data: 'hist:noop' }
  })
  rows.push(row)
```

`entriesOnDay(isoDate)` — фільтрує `historyDigests(items)` по дню Kyiv-time.

---

## Алгоритм навігації по місяцях

```
activeMths = unique set of YYYY-MM з усіх записів у Kyiv-time

prevMonth(current):
  sorted = activeMths.filter(m < current).sort().desc()
  return sorted[0] ?? null            // null → ◀ стає noop

nextMonth(current):
  sorted = activeMths.filter(m > current).sort().asc()
  return sorted[0] ?? null            // null → ▶ стає noop
```

---

## Точка входу

`buildHistoryList({ items, page })` більше не є точкою входу з кнопки 📜 Історія.
Натомість — `buildHistoryCalendar({ items, month })`, де `month` — найсвіжіший місяць
з активними записами. `buildHistoryList` залишається для можливого internal use
в `buildHistoryDay`.

Команда `/history` і кнопка `📜 Історія` у головному меню тепер передають до
`handleHistoryNav` з `data = 'hist:cal:<latest-month>'`.

---

## Файли, що змінюються

| Файл | Зміна |
|------|-------|
| `commands.mjs` | Нові функції `buildHistoryCalendar`, `buildHistoryDay`; оновити `buildHistoryItem` (кнопка назад); оновити `handleHistoryNav` (роутинг нових callbacks) |
| `worker/src/handler.mjs` | Точка входу "📜 Історія" → `hist:cal:<latest>` замість `hist:p:0`; роутинг `hist:cal:` і `hist:day:` |

**Без змін:** `monitor.mjs`, `telegram.mjs`, `worker/src/github.mjs`,
структура `_state/notification_history.json`, логіка `historyDigests`.

---

## Тести

### `buildHistoryCalendar`

- Правильна кількість рядків (рядок nav + рядок заголовків + тижні місяця + кнопка меню).
- Перший день місяця у правильній колонці (Monday-start offset).
- Дні без подій → `hist:noop`; дні з подіями → `hist:day:<YYYY-MM-DD>`.
- Emoji першої події відображається у кнопці дня.
- `◀` → noop якщо немає попереднього місяця з подіями.
- `▶` → `hist:cal:<next>` якщо є наступний місяць.
- Місяць із 0 записів — грид відображається, обидва ◀▶ вказують на ближчі місяці.

### `buildHistoryDay`

- Текст повідомлення: правильна дата (Kyiv-locale) та кількість.
- Записи лише цього дня.
- Кнопка назад → `hist:cal:<YYYY-MM>` цього дня.
- Пагінація при > 8 записів.

### `buildHistoryItem` (оновлений)

- Кнопка назад → `hist:day:<YYYY-MM-DD>` (а не `hist:p:<N>`).
- Текст кнопки містить HIST_DAY-форматовану дату.

### Навігація місяців

- `prevMonth` / `nextMonth` — повертають коректні значення при наявності та відсутності
  сусідніх місяців.
