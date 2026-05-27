# `/archive` pagination by legal entity

**Date:** 2026-05-27
**Status:** Approved (design)

## Goal

`/archive` (list mode) currently returns one concatenated message that grows with every completed tender and will eventually exceed Telegram's 4096-char limit. Split it into multiple messages — **one per legal entity (service provider)** — and, when a single entity's contracts exceed the limit, split that entity across pages at tender boundaries with a `Сторінка K/N` footer.

## Constraints (from the user)

- Split **by legal entity** (the provider with whom contracts are concluded). Each provider group → its own message(s). Do NOT pack multiple providers into one message.
- If one provider's block exceeds the char limit, split it so that **a single procurement's info is never cut mid-way** (split only at tender/entry boundaries).
- When (and only when) a split happens for one provider, add a `Сторінка K/N` footer to each of that provider's pages.
- **Everything else about the archive rendering stays exactly as it is now** — headers (`👤 Name (ЄДРПОУ …) — N контрактів`, `📦 Без укладеного договору`), per-entry rendering (`renderArchiveItem`), grouping, sorting, and the global `Всього в архіві: N` total. Only the message-splitting is new.

## Current state

`handleArchive({ archive })` (commands.mjs):
- Empty → returns the string `'📭 Архів порожній.'`.
- Else: groups entries by service provider (`findServiceProvider`), sorts entries within a group by `archived_at` desc and groups by max `archived_at` desc (the synthetic `📦 Без укладеного договору` group last), builds one `section` string per group (`${header}\n\n${body}`, body = entries joined by `\n\n`), and **returns `sections.join('\n\n') + '\n\nВсього в архіві: N'`** — a single string.

Dispatch (`worker/src/handler.mjs`, `cmd.cmd === 'archive'`, list branch): `reply = handleArchive({ archive })`. The shared send loop already does `pages = Array.isArray(reply) ? reply : [reply]` → one `sendReply` per element (reply-quote on the first, `MAIN_KEYBOARD` on the last), and `sendReply` sub-chunks any single page over 4096. `/info` already exploits this via `formatInfoPages` (array return). `handleArchiveDetail` (`/archive UA-…`) is a separate single-tender path — unchanged.

## Design

Make `handleArchive` return **`string[]`** (an array of page strings). No handler change is needed — the dispatch already pages arrays and chunks oversized pages.

- **Empty archive:** `['📭 Архів порожній.']` (one-element array).
- **Per group** (same grouping/sorting as now): render the header (unchanged) and the per-entry strings (unchanged `renderArchiveItem`), then paginate that group's entries:
  - If `header + all entries` fits within `ARCHIVE_PAGE_LIMIT` → **one page, no footer**.
  - Else → split the entries into consecutive buckets, each bucket sized so that `header + bucket entries (+ footer)` stays within the limit, **never splitting an entry across buckets**. Render each bucket as `${header}\n\n${bucketBody}\n\nСторінка ${k}/${n}` (header repeated on every page; `n` = that group's page count).
  - Pathological case: a single entry that alone exceeds the limit gets its own page anyway (cannot split further); `sendReply` will sub-chunk it at send time. Accepted fallback.
- **Concatenate** all groups' pages into one array, in the existing group order.
- **Global total:** append `\n\nВсього в архіві: N` to the **last page** of the whole array (only once, at the very end).

### New pure helper

`paginateArchiveGroup({ header, entries, limit })` → `string[]`
- `entries` = array of already-rendered entry strings (from `renderArchiveItem`).
- Greedy pack: accumulate entries into the current bucket while `headerLen + currentLen + entryLen + separators ≤ limit`; overflow → start a new bucket. An entry that alone overflows an empty bucket still occupies its own bucket.
- 1 bucket → `[ `${header}\n\n${body}` ]` (no footer). >1 bucket → each rendered with the `Сторінка k/n` footer.

`ARCHIVE_PAGE_LIMIT` — module constant, conservatively `3900` (margin under 4096 for the repeated header, the footer, and HTML entities).

## Edge cases

- One small group → single page, no footer, global total appended (since it's the last page).
- Many small groups → one page each; no footers; global total on the last group's page.
- One large group spanning pages, among other small groups → that group emits N footered pages (`Сторінка 1/N` … `N/N`); other groups stay single-page; global total on the very last page emitted.
- Single oversized entry → own page; `sendReply` sub-chunks at send (only place an entry can be cut, unavoidable).
- Empty archive → `['📭 Архів порожній.']`.

## Out of scope

- `/archive UA-…` detail (`handleArchiveDetail`) — unchanged.
- Any change to entry/header rendering, grouping, sorting, or the total line text.
- Bin-packing multiple providers into one message (explicitly rejected — split is per legal entity).

## Testing

- **`test/commands.test.mjs`:**
  - `handleArchive` returns an array (not a string); empty → `['📭 Архів порожній.']`.
  - One small group → length 1, no `Сторінка`, contains the header and `Всього в архіві:`.
  - Multiple small groups → one page per group; no `Сторінка` footers; `Всього в архіві: N` only on the last element; each element contains exactly one group header.
  - One group with enough large entries to exceed `ARCHIVE_PAGE_LIMIT` → that group yields >1 page; every such page repeats the group header and ends with `Сторінка k/n`; no entry text is split across pages (assert a representative entry appears wholly on one page); other groups stay single-page.
  - Global `Всього в архіві: N` appears once, on the final page only.
  - Each produced page ≤ `ARCHIVE_PAGE_LIMIT` (except the synthetic single-oversized-entry case, which may exceed and rely on `sendReply`).
  - `paginateArchiveGroup` unit tests: fits → 1 page no footer; overflow → multiple pages with footers, entries intact, correct `k/n`.
- **`worker/test/handler.test.mjs`:**
  - `/archive` with a multi-group archive → multiple `sendReply` calls (one per page). Update/replace any existing `/archive` list test that asserted a single concatenated reply string. Empty archive still sends one message. `/archive UA-…` detail unchanged.
