# Нічний дайджест (quiet hours 00:00–06:00 Київ)

**Date:** 2026-05-21
**Status:** Draft

## Problem

Зараз будь-яка подія (новий статус, td_amended, deadline_approaching, скарга, питання тощо) шле миттєвий push у Telegram усім підписникам — незалежно від часу доби. Події, які прилітають вночі (Prozorro оновлює дані цілодобово), будять користувачів. Дія по них однаково можлива лише з ранку.

Хочемо **тиху ніч**: усе, що сталось у вікні `00:00–06:00` за Києвом, накопичується в буфер і вивалюється одним повідомленням у вже існуючий 09:00 слот.

## Scope

### У scope

- Виявляти, що `runIso` потрапляє у вікно `00:00–05:59` за `Europe/Kyiv`.
- У quiet-вікно: замість `broadcastDigest` — `appendToPendingDigest`.
- Зберігання `_state/_pending_digest.json` з мерджем по `tender_id`.
- У 09:00 слот: якщо буфер не порожній → `broadcastDigest(formatNightDigest(buffer))` всім + clear буфер. Якщо порожній і подій нема → старий heartbeat admin-only (як зараз).
- Тести quiet-хвилини детекції, append/merge, flush.

### Не в scope (YAGNI)

- Per-user налаштування quiet hours / opt-out.
- Конфігурований діапазон (00–06 захардкоджено).
- Винятки для критичних подій (deadline_24h, cancellation_initiated тощо) — користувач явно сказав «без винятків».
- Окремий 06:00 слот для випуску.
- `/digest` команда ручного перегляду буфера.

## Архітектура

### Подієвий шлях у `runOnce(runIso, ...)`

Псевдокод (новий код **жирним**):

```
fetch all → diff → groups, archivedNow, errors (як зараз)

hasContent = groups.length || errors.length

if hasContent || archivedNow.length:
  text = formatDigest(...)
  **if isQuietHour(runIso):**
    **await appendToPendingDigest({ groups, archived: archivedNow, errors, runIso })**
    // НЕ broadcast
  else:
    await broadcastDigest(text)  // як зараз

  await saveState per tender (як зараз — критично для dedup)

if isHeartbeatHour(runIso):  // debounced via loadHeartbeatDate, як зараз
  **pending = await loadPendingDigest()**
  **if pending && pending.items not empty:**
    **morning = formatNightDigest(runIso, pending)**
    **await broadcastDigest(morning)**     // ВСІМ
    **await clearPendingDigest()**
  elif !hasContent:
    await sendHeartbeat(formatHeartbeat(...))  // admin-only — як зараз
  await saveHeartbeatDate(today)
```

Усе, що поза 00–06, поводиться як раніше — миттєвий push.

### Quiet-window детектор

Pure function `isQuietHour(iso, tz = 'Europe/Kyiv')` повертає `true` якщо година у Києві ∈ {0,1,2,3,4,5}. Реалізація через `Intl.DateTimeFormat` (як уже використовується для `kyivDate`/`isHeartbeatHour`).

Розташування: `monitor.mjs` (поруч із вже там існуючими `kyivDate`/`isHeartbeatHour`). Якщо набір time-helpers зросте, винести в окремий `time.mjs` — поза скоупом цієї фічі.

## Storage

### Файл `_state/_pending_digest.json`

Формат:

```json
{
  "items": {
    "UA-2026-05-22-001234-a": {
      "tender_id": "UA-2026-05-22-001234-a",
      "title": "Реактиви для лабораторії",
      "status": "active.tendering",
      "deadline": "2026-05-23T17:00:00+03:00",
      "procuring_entity": {"name": "КНП ...", "edrpou": "12345678"},
      "value": {"amount": 100000, "currency": "UAH", "valueAddedTaxIncluded": true},
      "classification": {"id": "33696500-0", "description": "Реактиви"},
      "contact": {...},
      "procurement_method_type": "aboveThresholdUA",
      "prozorro_url": "https://prozorro.gov.ua/tender/UA-...",
      "events": [
        {"type": "td_amended", "title": "Доповнення №1", "datePublished": "..."},
        {"type": "new_question", "title": "Чи можлива..."}
      ],
      "first_fired_at": "2026-05-22T02:14:00Z",
      "last_fired_at": "2026-05-22T04:30:00Z"
    }
  },
  "archived": [
    {"tender_id": "UA-...", "status": "complete", "fired_at": "..."}
  ],
  "errors": [
    {"tender_id": "UA-...", "error": "...", "is_invalid": false, "fired_at": "..."}
  ]
}
```

Чому `items` — об'єкт по `tender_id`, а не масив: щоб **мерджити** події одного тендера за ніч у один блок (а не дві окремі секції в ранковому повідомленні).

### Merge-правила в `appendToPendingDigest({ groups, archived, errors, runIso })`

Для кожного `g` у `groups`:
- Якщо `pending.items[g.tender_id]` нема — створити запис, скопіювати всі поля з `g`, додати `first_fired_at = runIso`, `last_fired_at = runIso`.
- Якщо є — додати `g.events` у `events` (без додаткової дедупкації — `compare.mjs` уже не emit'ить дублі), оновити `last_fired_at = runIso`, оновити змінні поля (`status`, `deadline`, `title`) з найновішого snapshot.

`archived` і `errors` — просто `concat` (з `fired_at = runIso`). Не очікуємо архівації того ж тендера двічі за ніч.

### Storage shape — як інтегрується у `deps`

Аналогічно `loadHeartbeatDate`/`saveHeartbeatDate`:

```js
deps = {
  ...
  loadPendingDigest: async () => obj|null,
  savePendingDigest: async (obj) => void,
  clearPendingDigest: async () => void,
}
```

У `ci.mjs` і `main.mjs` — імплементації через `readFileSync`/`writeFileSync` у `_state/_pending_digest.json`. У worker — не потрібно (worker не запускає `runOnce`).

## Формат ранкового повідомлення

`formatNightDigest(runIso, pending)`:

```
🌙 Нічний дайджест за <kyivDate(runIso) – 1 день>

<стандартний formatDigest для items.values()>
```

Тонка обгортка: рендерить шапку + викликає існуючий `formatDigest(runIso, [...Object.values(items)])`. Сторінкування і кнопки «🔔 додати в моніторинг» для `new_tender_announced` — без змін.

`archived` і `errors` — рендеряться окремими блоками після основного digest (за тими ж патернами, що використовуються в `runOnce` сьогодні).

## Recipients

| Випадок | Кому |
|---|---|
| Подія в `06:00–23:59` (миттєво) | broadcast (admin+editor+viewer), як зараз |
| Quiet-hour запис у буфер | нікому, тихо |
| 09:00 flush буфера | broadcast (admin+editor+viewer) |
| 09:00 heartbeat (буфер порожній і подій нема) | admin-only, як зараз |

## Тести

Нові:

1. `isQuietHour`: true для `02:00 Kyiv`, false для `06:00 Kyiv` / `23:59 Kyiv` / `15:00 Kyiv`. Перевірити перехід літо/зима (EEST=+03 / EET=+02).
2. `appendToPendingDigest`: новий tender_id → створює запис; повторний → мерджить events, оновлює `last_fired_at`.
3. `runOnce` у quiet-hour з подіями → `savePendingDigest` викликано, `broadcastDigest` НЕ викликано, `saveState` викликано (dedup тримається).
4. `runOnce` у quiet-hour без подій → нічого не зберігається в буфер, нічого не шлеться.
5. `runOnce` у 09:00 з непорожнім буфером → `broadcastDigest(morning)` викликано, `clearPendingDigest` викликано, heartbeat НЕ викликаний.
6. `runOnce` у 09:00 з порожнім буфером і без подій → heartbeat admin-only як раніше.
7. `runOnce` у 09:00 з непорожнім буфером **І** новими подіями (граничний випадок: 09:00 cron знаходить події) → broadcast нового digest **та** flush буфера. Можна послідовно двома повідомленнями (простіше) або об'єднати — обираю **послідовно**, бо це рідкісно і відокремлено читабельніше.
8. Heartbeat-debounce: два cron виклики о 09:01 і 09:29 → flush буфера виконано рівно раз.
9. `formatNightDigest`: шапка + контент.

Існуючі тести `monitor.test.mjs` — переконатись, що нічого не зламано: 06:00–23:59 шлях не змінено.

## Migration / rollout

- Новий файл `_state/_pending_digest.json` створюється lazy: `loadPendingDigest` повертає `null` якщо файл відсутній, `appendToPendingDigest` зберігає тоді новий шейп.
- Не потрібно мігрувати існуючі state-файли тендерів.
- Не потребує деплою worker'а (це лише monitor-side).

## Ризики й гачки

| Ризик | Mitigation |
|---|---|
| Race: два cron триггери в одну quiet-хвилину → дубль events у буфері | `compare.mjs` уже dedupить через `_notifiedDeadlines` тощо. Інші events базуються на `prev vs curr` snapshot — після `saveState` curr вже стає prev, тож re-emit не виникне. Тому append'у одного типу двічі майже неможливий у нормі. |
| Buffer не flush'нувся (cron провалився саме о 09:00–09:30) | `isHeartbeatHour` спрацює наступного дня о 09:00 — буфер вивалиться через ~24h, дозволено. Альтернатива (broadcast при першому ж cron'і після 09:30) — складніше, не варто. |
| Великий буфер (за добу 50+ тендерів × кілька подій) — Telegram message > 4096 chars | `broadcastDigest` уже має chunking. Перевірити, що chunking чіпляє кнопки правильно (це вже відтестовано для broadcastDigest). |
| 24h-deadline emit о 02:00 → flush лише о 09:00 → fakly «за 17 годин ми лишили на 7 годин до дедлайну» | Прийнятно — користувач явно вибрав «без винятків». Якщо біль виявиться — окрема task: вернути deadline_24h до winning exception list. |

## Розширення на майбутнє (не в scope)

- Per-user `quiet_hours` у `allowed_users.json` (виглядає overkill для двох-трьох користувачів).
- Команда `/digest` для ручного «зараз дай мені нічний буфер».
- Кастомізований hour-range через `_state/config.json`.
