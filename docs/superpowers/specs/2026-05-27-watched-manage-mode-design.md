# `/watched` two-mode UX: compact list + opt-in delete mode

**Date:** 2026-05-27
**Status:** Approved (design)

## Goal

Remove the visual duplication in `/watched` (each watched entity currently appears twice — once in the text list, once on a 🗑 button). Make the default view compact, and move deletion into an opt-in "manage" mode reached by a single button.

## Motivation

The just-shipped unwatch-button feature renders, for editors, the text list **and** a 🗑 button per entity below it — the same ЄДРПОУ + name twice. For day-to-day viewing this is noisy and wastes space. The user wants the default `/watched` to be a clean list, with deletion controls shown only on demand.

## Current state (baseline = merged unwatch-button feature)

- `handleWatched({ watchedEntities })` (commands.mjs) → text list (numbered, `🟢/🔴 <edrpou> — <name>`, `Всього: N`). Unchanged here.
- `buildWatchedKeyboard(watchedEntities)` (commands.mjs) → `{ inline_keyboard: [[{ text: '🗑 <edrpou> — <name>', callback_data: 'unwatch:<edrpou>' }], …] }` or `null` if empty. Reused here.
- `/watched` dispatch (handler.mjs): for editor/admin, attaches `buildWatchedKeyboard(entities)` as `watchedReplyMarkup`. Viewers get text only.
- Callback `unwatch:<edrpou>` (handler.mjs): editor-guarded; load → `handleUnwatch` → `applyEntityMutation` → `saveWatchedEntities({message: auditMessage})` → refresh via `editMessageText(handleWatched text + buildWatchedKeyboard)`; double-tap → "Вже прибрано"; ConflictError retry.
- `editMessageText` primitive exists in telegram.mjs.

## Design (approved)

Two modes of the single `/watched` message, toggled in place via `editMessageText`. **Mode is not stored** — it is encoded in `callback_data`; every tap reloads fresh entities and re-renders the appropriate mode.

### VIEW mode (default `/watched`)
- Text: `handleWatched(entities)` (unchanged list).
- Keyboard (editor/admin only, non-empty list only): a single button `[🗑 Прибрати замовника]`, `callback_data: 'watched:manage'`. Viewers and empty lists get no inline keyboard (text only / persistent MAIN_KEYBOARD).

### MANAGE mode (after tapping «🗑 Прибрати замовника»)
- Text: a short prompt constant, e.g. `🗑 Кого прибрати? Тапни замовника. (тап = видалити)`.
- Keyboard: one 🗑 button per entity (`unwatch:<edrpou>`, reuse `buildWatchedKeyboard` rows) **plus** a final row `[← Готово]`, `callback_data: 'watched:done'`.
- In MANAGE mode the text list is replaced by the buttons, so the entity info appears once (no duplication even here).

### Callbacks
- `watched:manage` (editor-guard): `editMessageText` → manage prompt + manage keyboard. If the list is now empty (stale) → render the empty-state text, no keyboard.
- `unwatch:<edrpou>` (existing, editor-guard): remove the entity, then **re-render in MANAGE mode** (manage prompt + manage keyboard) so the user can remove several in a row. If the list becomes empty → empty-state text, no keyboard. Double-tap (no mutation) → "Вже прибрано" toast + manage re-render. ConflictError retry preserved. **This changes the existing callback's refresh target from view-style to manage-style.**
- `watched:done` (editor-guard): `editMessageText` → VIEW mode (list text + the single «Прибрати» button, or empty-state if empty).

Non-editors tapping any of these stale buttons → reject toast (`🚫 Це команда для редакторів`), no state change.

## Components & interfaces

### `commands.mjs` (pure)
- `handleWatched` — unchanged.
- `buildWatchedKeyboard(entities)` — unchanged; its rows are reused by the manage keyboard.
- NEW `buildWatchedViewKeyboard(entities)` → `{ inline_keyboard: [[{ text: '🗑 Прибрати замовника', callback_data: 'watched:manage' }]] }`, or `null` when the list is empty.
- NEW `buildWatchedManageKeyboard(entities)` → `null` when empty; otherwise `{ inline_keyboard: [ ...buildWatchedKeyboard(entities).inline_keyboard, [{ text: '← Готово', callback_data: 'watched:done' }] ] }`.
- NEW exported constant `WATCHED_MANAGE_PROMPT` (the manage-mode header text).

### `worker/src/handler.mjs`
- `/watched` dispatch: VIEW mode — text `handleWatched(entities)`; `watchedReplyMarkup = buildWatchedViewKeyboard(entities)` when `isEditor`. (Replaces the current `buildWatchedKeyboard` attachment.)
- Callback `watched:manage` — NEW branch: editor-guard; load entities; `editMessageText(WATCHED_MANAGE_PROMPT, buildWatchedManageKeyboard(entities) ?? undefined)`; empty → `editMessageText(handleWatched(empty) , undefined)`; ack().
- Callback `watched:done` — NEW branch: editor-guard; load entities; `editMessageText(handleWatched(entities), buildWatchedViewKeyboard(entities) ?? undefined)`; ack().
- Callback `unwatch:<edrpou>` — MODIFY existing refresh: after the mutation, re-render in MANAGE mode (`WATCHED_MANAGE_PROMPT` + `buildWatchedManageKeyboard(newEntities) ?? undefined`). All other logic (guard, audit, retry, double-tap, empty→empty-state) unchanged.

A small shared helper in handler.mjs to render a given mode (load + editMessageText) is fine but optional; keep it readable.

## callback_data

`watched:manage`, `watched:done`, `unwatch:<edrpou>` — all short, well under Telegram's 64-byte limit. `watched:` prefix is distinct from the existing `unwatch:`, `add:`, `notify:`, `noop`.

## Edge cases

- **Empty list (any mode):** VIEW with empty list shows the existing `📭 Не стежу за жодним замовником…` text and no inline keyboard. Manage/done callbacks on an emptied list fall back to the empty-state text, no keyboard.
- **Removing the last entity in manage mode:** message becomes the empty-state text, no keyboard.
- **Stale button after the list changed elsewhere:** every callback reloads fresh entities, so the re-render is always current; a tapped `unwatch:` for an already-gone entity → "Вже прибрано".
- **Non-editor taps a stale `watched:manage`/`watched:done`/`unwatch:` button:** rejected with a toast; no state change.
- **ConflictError on save (unwatch):** existing 2-attempt retry preserved.

## Out of scope

- Confirmation step before each delete (single tap deletes, as today).
- Pagination of very long lists.
- Changing `/watch` (add) or the text-list format itself.
- Number-based delete buttons (variant C) — not chosen.

## Testing

- **`test/commands.test.mjs`:** `buildWatchedViewKeyboard` (single manage button; empty → null); `buildWatchedManageKeyboard` (per-entity rows + trailing `← Готово` row with `watched:done`; empty → null); `WATCHED_MANAGE_PROMPT` exported and non-empty.
- **`worker/test/handler.test.mjs`:**
  - `/watched` (editor/admin) → VIEW: exactly one inline button `watched:manage`; (viewer) → no inline keyboard; (empty) → no inline keyboard.
  - `watched:manage` callback → editMessageText with manage prompt + per-entity 🗑 buttons + `watched:done` row; editor-guard rejects viewer.
  - `unwatch:<edrpou>` callback → after delete, message is in MANAGE mode (prompt + remaining entity buttons + Готово); audit message still `unwatch`; last entity → empty-state, no keyboard; double-tap → "Вже прибрано".
  - `watched:done` callback → editMessageText back to VIEW (list text + single «Прибрати» button); editor-guard rejects viewer.
