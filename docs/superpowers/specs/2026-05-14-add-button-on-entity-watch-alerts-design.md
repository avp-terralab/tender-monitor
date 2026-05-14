# Add-to-monitoring button on entity-watch alerts — design

**Date:** 2026-05-14
**Status:** Approved (pending spec review)

## Problem

Коли monitor-тік знаходить новий тендер від юрособи з watched_entities, digest у Telegram містить лише текст + посилання на Prozorro. Щоб поставити цей тендер на детальний моніторинг (`/add UA-…`), користувач має скопіювати tender_id і ввести команду вручну. Хочемо одноклацний шлях: інлайн-кнопка під digest-блоком.

## Scope

Кнопка `➕ Додати в моніторинг` тільки для груп digest'у, які мають event `new_tender_announced` (тобто алерти з `entity_watch.mjs:147`). Для інших груп — кнопки нема (тендер уже в watchlist).

## User flow

1. Monitor tick → entity_watch будує `groups` з `events: [{type: 'new_tender_announced'}]` → monitor.mjs формує digest і шле через `sendDigest`.
2. Telegram доставляє повідомлення з кнопкою `➕ Додати в моніторинг` під кожним entity-watch блоком.
3. Користувач (адмін) натискає кнопку.
4. Worker отримує `callback_query`, виконує `handleAdd`, редагує inline-keyboard повідомлення → кнопка стає `✅ Додано HH:MM` (disabled, callback_data=`noop`). Telegram показує toast "✅ Додано у watchlist".

## Architecture

```
┌─────────────────┐
│  CI (ci.mjs)    │  GitHub Actions, hourly
│  runOnce        │
└────────┬────────┘
         │ groups (with new_tender_announced)
         ▼
┌─────────────────┐
│  telegram.mjs   │
│  sendDigest     │  extended: attaches inline_keyboard per chunk
│                 │  for tender_ids in addButtonsForTenders
└────────┬────────┘
         │ HTTP POST sendMessage(reply_markup)
         ▼
   [Telegram]
         │
         │ user tap
         ▼
┌─────────────────┐
│  Cloudflare     │
│  Worker         │  POST /webhook → runHandler(update)
└────────┬────────┘
         │ update.callback_query
         ▼
┌─────────────────┐
│  handler.mjs    │  NEW: callback_query routing
│  parses "add:UA-…" → handleAdd
│  edit keyboard → answer callback
└─────────────────┘
```

## Components

### 1. `telegram.mjs` — extend `sendDigest`

**New signature:**
```js
sendDigest(creds, text, { addButtonsForTenders?: string[] } = {})
```

**Behavior:** for each chunk (after `chunkMessage`), build `reply_markup.inline_keyboard` containing one row per tender_id in `addButtonsForTenders` that **also appears in this chunk's text**. Button:
```json
{ "text": "➕ Додати в моніторинг UA-…", "callback_data": "add:UA-…" }
```

If a chunk has zero matching tender_ids, no `reply_markup` is sent (current behavior preserved).

**New exports:**
- `editMessageReplyMarkup(creds, { chatId, messageId, replyMarkup })` — wraps Telegram `editMessageReplyMarkup`.
- `answerCallbackQuery(creds, { callbackQueryId, text?, showAlert? })` — wraps `answerCallbackQuery`.

### 2. `monitor.mjs` — compute button list

Before invoking `sendDigest`, build:
```js
const addButtonsForTenders = groups
  .filter(g => g.events?.some(e => e.type === 'new_tender_announced'))
  .map(g => g.tender_id);
```
Pass to `sendDigest` as the new option.

CI's `sendDigest` adapter in `ci.mjs` already forwards args through; just pipe the third arg.

### 3. `worker/src/handler.mjs` — callback_query routing

Add at the top of `runHandler` (before existing `update.message` logic):
```js
const cq = update.callback_query;
if (cq) {
  return handleCallbackQuery({ cq, env, deps, _sendReply, … });
}
```

**`handleCallbackQuery` flow:**
1. Resolve `chatId = String(cq.message?.chat?.id ?? '')`, then compute `isAllowed` (admin or allowlist) — same predicate as message path.
2. If not allowed → `answerCallbackQuery(text: "Доступ заборонено", showAlert: true)` + return.
3. Parse `cq.data`:
   - `"noop"` → just `answerCallbackQuery({})` (empty), return.
   - `"add:<tender_id>"` → continue.
   - else → `answerCallbackQuery(text: "❓ Невідома кнопка")` + return.
4. Validate tender_id format (reuse TENDER_ID_RE check via `parseCommand` or direct regex).
5. Run mutation via `applyMutationWithRetry` (existing) with `handleAdd`.
6. Based on result (HH:MM is Europe/Kyiv via existing `KYIV_TIME_FMT`):
   - **Successful add:** swap keyboard to `[{text: "✅ Додано HH:MM", callback_data: "noop"}]`, toast `✅ UA-… додано у watchlist`.
   - **Already in watchlist** (handleAdd returns `mutation=null` with appropriate reply): swap keyboard to `[{text: "ℹ️ Вже додано", callback_data: "noop"}]`, toast `Вже у watchlist`.
   - **In archive:** swap to `[{text: "📦 В архіві", callback_data: "noop"}]`, toast `Тендер в архіві`.
   - **GH/network error:** keep keyboard unchanged, toast `⚠️ GitHub тимчасово недоступний, спробуй ще раз`.

### 4. `worker/src/index.mjs` — no changes

Already forwards every `update` to `runHandler` regardless of type.

## Data contracts

**callback_data format:**
- `add:UA-2026-05-14-008910-a` (28 bytes, max 64 per Telegram spec)
- `noop` (for disabled / completed buttons)

**`reply_markup` shape:**
```json
{
  "inline_keyboard": [
    [{"text": "➕ Додати в моніторинг UA-2026-…", "callback_data": "add:UA-2026-…"}]
  ]
}
```

One button per row (vertical stack), one row per tender_id in the chunk.

## Edge cases

| Case | Behavior |
|---|---|
| User taps button twice quickly (race) | Second `handleAdd` returns "вже у watchlist", swap is idempotent — same `✅ Додано` state |
| Digest chunk split mid-block, tender_id appears in chunk N but button is for chunk N-1 | Solved by matching button to chunk where `chunkText.includes(tender_id)` — substring match against the rendered tender_id link |
| Tender meanwhile cancelled or 404'd | `handleAdd` returns Prozorro error → toast `❌ Помилка fetch`, keyboard unchanged |
| Worker called by non-allowed user | Block before `handleAdd`, only toast (no state mutation, no edit) |
| `addButtonsForTenders` empty (no entity-watch alerts) | `sendDigest` sends without `reply_markup` (current behavior) |
| Heartbeat path | `sendDigest(creds, text)` called without options → no keyboards, unchanged |

## Testing

### Unit tests

**`test/telegram.test.mjs`:**
- `sendDigest` без options → не передає `reply_markup` (regression: heartbeat path).
- `sendDigest` з `addButtonsForTenders=['UA-X']`, text що містить `UA-X` → перший виклик до Telegram має `reply_markup` з очікуваною кнопкою.
- `sendDigest` з `addButtonsForTenders=['UA-X']`, text що НЕ містить `UA-X` → жодних кнопок.
- `sendDigest` з 2 chunks, де tender_id в обох → кнопка лише в правильному chunk'у (substring match).
- `editMessageReplyMarkup`, `answerCallbackQuery` — happy path: правильний URL і body.

**`worker/test/handler.test.mjs`** (новий або extend існуючого, якщо є):
- `callback_query` від адміна з `data="add:UA-…"` → `handleAdd` mocked → `editMessageReplyMarkup` з ✅-кнопкою, `answerCallbackQuery` з success toast.
- `callback_query` від не-allowed user → лише `answerCallbackQuery` "Доступ заборонено", БЕЗ `handleAdd`, БЕЗ edit.
- `callback_query` з `data="noop"` → лише `answerCallbackQuery({})`, нічого більше.
- `callback_query` з невалідним `data="add:bad-id"` → toast `❓ Невалідний tender_id`, БЕЗ edit.
- `callback_query` коли тендер уже в watchlist → keyboard стає `ℹ️ Вже додано`, toast відповідний.

## Out of scope (YAGNI)

- Bulk "➕ Додати всі" кнопка.
- Кастомні нотатки через callback (поки що завжди `notes: null`; користувач може зробити `/add UA-… note` текстом).
- Auto-expire кнопки.
- Кнопки для regular monitor digest (ті тендери вже в watchlist).
- Локалізація toast'ів (зараз UA-only).

## Files touched

| File | Change |
|---|---|
| `telegram.mjs` | extend `sendDigest`, add `editMessageReplyMarkup` + `answerCallbackQuery` exports |
| `monitor.mjs` | compute `addButtonsForTenders` and pass to `sendDigest` |
| `ci.mjs` | thread new option through `sendDigest` adapter |
| `worker/src/handler.mjs` | new `handleCallbackQuery` block in `runHandler` |
| `test/telegram.test.mjs` | new tests for button placement and new exports |
| `worker/test/handler.test.mjs` | new tests for callback_query routing |

No changes to: `entity_watch.mjs` (groups already carry `events: [new_tender_announced]`), `worker/src/index.mjs` (already forwards updates), `worker/src/github.mjs` (no new storage), `commands.mjs` (handleAdd reused as-is), `compare.mjs` (irrelevant).
