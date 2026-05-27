# Remove watched entity via inline button (retire `/unwatch` command)

**Date:** 2026-05-27
**Status:** Approved (design)

## Goal

Let editors/admins stop watching a procuring entity (замовник) by tapping a 🗑 button on the `/watched` list, instead of typing `/unwatch <ЄДРПОУ>`. Remove the `/unwatch` command entirely.

## Motivation

`/unwatch` requires copy-pasting an 8-digit ЄДРПОУ, which the user already sees in `/watched`. A per-row delete button removes that friction. This mirrors the existing inline-button pattern (`add:` on entity-watch alerts, `notify:` toggle).

## Current state

- `handleWatched({ watchedEntities })` (commands.mjs) returns a **plain text** numbered list (`N. 🟢/🔴 <ЄДРПОУ> — <name>`, `Всього: N`). No keyboard.
- `/unwatch <ЄДРПОУ>` → `parseCommand` → `{ cmd: 'unwatch', edrpou }` → handler runs `handleUnwatch` through `applyEntityMutationWithRetry` → `saveWatchedEntities`, with an audit commit message (action `unwatch`). Editor-only mutation.
- `handleUnwatch({ watchedEntities }, { edrpou })` returns `{ reply, mutation }` (`mutation: { type: 'delete_entity', edrpou }` or `null` if not found).
- Callbacks handled in `handleCallbackQuery` (worker/src/handler.mjs); existing prefixes `add:`, `notify:`. Uses `editMessageReplyMarkup` + `answerCallbackQuery` from telegram.mjs. Viewer button-hiding pattern already established.
- `editMessageText` does **not** exist in telegram.mjs yet (only `editMessageReplyMarkup`).

## Design decisions (approved)

1. **Layout — single message + buttons (variant A).** `/watched` keeps its text list; for editor/admin an inline keyboard is attached below, one 🗑 button per entity. Tapping refreshes the same message in place.
2. **Single tap = delete.** No confirmation step (removal is reversible via `/watch <ЄДРПОУ>`). Tap → toast `✅ Прибрано <ЄДРПОУ>` → message (text + keyboard) re-rendered.
3. **`/unwatch` command removed.** Dropped from parser dispatch, HELP text, and `BOT_COMMANDS_BY_ROLE`. Typing `/unwatch` returns a gentle hint pointing to `/watched`.
4. **Permissions.** Buttons attached only for editor/admin; viewers see the text list with no buttons (existing viewer-button-hiding). The callback defensively rejects non-editors (stale-button safety).
5. **Audit unchanged.** The button-driven removal still records an audit commit with action `unwatch` (actor sourced from the callback's `cq.from`, as the audit feature already wires). `/log` is unaffected.

## Components & interfaces

### `commands.mjs` (pure)
- **`buildWatchedKeyboard(watchedEntities)` — NEW.** Returns `{ inline_keyboard: [[btn], …] }` with one row per entity, or `null` when the list is empty. Each button: `{ text: "🗑 <ЄДРПОУ> — <скороч. назва>" (truncated), callback_data: "unwatch:<edrpou>" }`. Reuses `abbreviateLegalForm` + `truncate` + `escapeHtml`-free plain text (button labels are not HTML-parsed).
- **`handleWatched`** — unchanged (returns text). The handler composes text + keyboard.
- **`handleUnwatch`** — unchanged; reused by the callback path.
- **`parseCommand`** — `/unwatch` (optionally with args) → `{ cmd: 'unwatch_removed' }`. Remove the old `{ cmd: 'unwatch', edrpou }` branch. Remove `/unwatch` from HELP and `BOT_COMMANDS_BY_ROLE`.

### `telegram.mjs`
- **`editMessageText({ token, chatId, messageId, text, replyMarkup, fetch })` — NEW.** Wraps Telegram `editMessageText` (accepts `text` + optional `reply_markup` in one call). Mirrors the shape/options of the existing `editMessageReplyMarkup`. Used to refresh the `/watched` message after a removal.

### `worker/src/handler.mjs`
- **`/watched` dispatch** — build reply text via `handleWatched`; if role is editor/admin, attach `buildWatchedKeyboard(entities)` as `reply_markup`. Viewers get text only.
- **Callback `unwatch:<edrpou>` — NEW branch in `handleCallbackQuery`.**
  - Guard: editor/admin only; otherwise `answerCallbackQuery` with a reject toast (e.g. `Лише для editor/admin`), no mutation.
  - Run `handleUnwatch` through the existing `applyEntityMutationWithRetry`, threading `auditMessage = formatAuditMessage({ action: 'unwatch', target: edrpou, actor: actorName, chatId, role })`.
  - On success: derive the updated list (the entities loaded inside the mutation minus the removed `edrpou` — do NOT issue a second GitHub read just to refresh), rebuild text via `handleWatched` + keyboard via `buildWatchedKeyboard`, call `editMessageText` to refresh the message; `answerCallbackQuery` toast `✅ Прибрано <ЄДРПОУ>`. If the list is now empty: `editMessageText` with the empty-state text (`📭 Не стежу за жодним замовником…`) and no `reply_markup`. (Note: `applyEntityMutationWithRetry` currently returns only `result.reply`; the plan must expose the post-mutation entity list to the callback — e.g. return it, or have the callback recompute via the existing `applyEntityMutation(entities, mutation)`.)
  - On `mutation: null` (already gone — double-tap / stale button): toast `Вже прибрано` and still refresh the keyboard so the stale button disappears.
- **`/unwatch` (deprecated) dispatch** — reply with the hint: `ℹ️ Команду /unwatch прибрано. Відкрий /watched і тисни 🗑 біля замовника.`

## Callback data

`unwatch:<edrpou>` — ЄДРПОУ is 8 digits, well within Telegram's 64-byte `callback_data` limit. Parsed by splitting on the first `:` (same convention as `add:`).

## Edge cases

- **Double-tap / stale message:** second tap → `handleUnwatch` returns `mutation: null` → toast `Вже прибрано` + keyboard refreshed (button already absent after refresh).
- **Last entity removed:** message edited to empty-state text, keyboard removed.
- **Non-editor taps a stale button:** rejected with a toast; no state change.
- **SHA conflict on save:** preserved by the existing retry loop in `applyEntityMutationWithRetry`.
- **Long entity names:** button label truncated; ЄДРПОУ always visible (leading token).

## Out of scope

- Pagination of very long watched lists (Telegram caps inline keyboards generously; revisit only if a user hits the limit).
- Bulk "remove all" button.
- Changing `/watch` (add) UX.
- The broader README prose staleness (handled separately).

## Testing

- **`test/commands.test.mjs`:** `buildWatchedKeyboard` (rows, callback_data, truncation, empty → null); `parseCommand('/unwatch …')` → `{ cmd: 'unwatch_removed' }`; HELP and `BOT_COMMANDS_BY_ROLE` no longer contain `unwatch`.
- **`worker/test/handler.test.mjs`:** `/watched` attaches keyboard for editor/admin but NOT viewer; `unwatch:<edrpou>` callback removes entity + refreshes via `editMessageText` + audit message action `unwatch`; double-tap → `Вже прибрано`; removing the last entity → empty-state text, no keyboard; non-editor callback → reject toast, no save; `/unwatch` command → hint reply.
- **`test/telegram.test.mjs`:** `editMessageText` posts the correct method/body (text + reply_markup).
