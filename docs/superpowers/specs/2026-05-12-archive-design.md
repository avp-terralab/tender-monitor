# Archive completed tenders — design

**Date:** 2026-05-12
**Status:** Approved (brainstorming)
**Predecessor:** Watchlist + monitor cycle keep all tenders in `watchlist.json` regardless of terminal state; user must `/remove` manually to declutter.

## Problem

Tenders reach terminal status (`complete`, `cancelled`, `unsuccessful`) but stay in `watchlist.json` forever — `/list` clutter grows, monitor cycle keeps fetching dead tenders, user loses access to historical context (contract docs) after a `/remove`.

## Goals

- When monitor cycle observes a terminal status, the tender is auto-moved to an archive list.
- User can `/archive` to browse archived tenders, `/archive UA-...` to see details + contract docs, `/contract UA-...` for the contract-only shortcut.
- User can `/unarchive UA-...` to return a tender to active monitoring (mistakes / recurring contracts).
- Archive entry preserves `final_snapshot` so display works without re-fetching Prozorro (snapshot frozen at archive time).
- Contract documents are **fetched fresh** when requested via `/archive UA-...` or `/contract UA-...` (amendments can land after closing).
- Cross-checks: `/add UA-...` for an already-archived tender warns and offers `/unarchive`; `/info UA-...` for an archived tender redirects to `/archive UA-...`.

## Non-goals

- Manual archive (no `/archive UA-...` action verb to send a non-terminal tender to archive). Archive is only auto-driven by terminal status.
- Direct upload of contract files to the bot (download links from Prozorro only).
- Multi-tier statuses (e.g. "completed but pending payment"). One terminal bucket.

## User-facing commands

| Command | Who | Behavior |
|---|---|---|
| `/archive` | allowlist | Compact list: `1. ✅ UA-... — Замовник — 350 000 UAH (12.05.2026)`. Icons: ✅ `complete`, ❌ `unsuccessful`, ⊘ `cancelled`. Sort by `archived_at` desc. Footer: `Всього в архіві: N`. |
| `/archive UA-...` | allowlist | Details from `final_snapshot` (entity, ДК, value, contact, final status, archived date) **plus** `📄 Договір:` block with links pulled fresh via `fetchTender`. If no contract (cancelled / unsuccessful), the block is omitted. |
| `/contract UA-...` | allowlist | Shortcut: only the contract-documents block. If no contract, replies "❓ У цій закупівлі договір не укладено (status: ...)". |
| `/unarchive UA-...` | allowlist | Removes from `archived_tenders.json`, appends back to `watchlist.json` with `enabled: true`. Reply: `✅ UA-... повернуто в моніторинг.` |
| `/add UA-...` (archived) | allowlist | Reply: "⚠️ Ця закупівля архівована (status). Поверну? /unarchive UA-..." |
| `/info UA-...` (archived) | allowlist | Reply: "📦 Ця закупівля в архіві. /archive UA-..." |
| `/list`, `/info` (no arg) | allowlist | Unchanged — show only `watchlist.json` (active). |

`HELP_TEXT` gets a new section "Архів". BotFather `/setcommands` updated with `archive`, `contract`, `unarchive`.

## Storage

**New file:** `_state/archived_tenders.json` — top-level bare array, like `_state/invites.json` and `_state/allowed_users.json`. Path chosen because the bot/monitor own it (auto-managed, not user-edited).

Record schema:

```json
{
  "tender_id": "UA-2026-04-30-010542-a",
  "notes": "КНП ... — Реактиви",
  "archived_at": "2026-05-12T10:30:00Z",
  "final_status": "complete",
  "final_snapshot": {
    "title": "...",
    "status": "complete",
    "dateModified": "...",
    "procuringEntity": { ... },
    "value": { ... },
    "classification": { ... },
    "contact": { ... },
    "contracts": [ { "id": "...", "status": "signed", "documents": [ ... ] } ],
    "awards": [ ... ]
  }
}
```

`final_snapshot` re-uses the exact shape produced by `extractSnapshot()` — no transformation. `notes` carries over the watchlist row's `notes` (so labels survive).

## Trigger (monitor cycle)

`TERMINAL_STATUSES = new Set(['complete', 'cancelled', 'unsuccessful'])`.

Order inside one `runOnce()` tick:

1. Existing fetch + snapshot + diff path runs untouched. Final-status changes (`active.awarded → complete`, etc.) generate events as usual — that diff lands in the digest.
2. **After** digest text is assembled but **before** `sendDigest`, monitor walks `results` and calls `deps.archiveTender(tender_id, snapshot)` for each terminal-status row.
3. Each call: append to `archived_tenders.json` (idempotent — skip if tender_id already there), then delete from `watchlist.json`, then unlink `_state/UA-XXX.json`. Returns `true` if archived this tick, `false` if no-op (already archived).
4. If anything was archived, monitor appends a "📦 Архівовано:" block to the digest text before sending.

## Atomicity & failure modes

- Mutation order: **append to archive first**, then remove from watchlist. If A succeeds but B fails, the tender lives in both lists — next monitor tick fetches it (still in watchlist), observes terminal, attempts A → A is idempotent → skip → attempts B → eventually succeeds. Self-healing.
- If A fails: tender stays in watchlist as before. Next tick retries. No partial state.
- `_state/UA-XXX.json` deletion is best-effort (try/catch). A leftover snapshot has no behavioral effect (monitor won't load it because the tender_id no longer exists in `enabled` set).

## Race with bot commands

- User runs `/remove UA-...` while monitor archives the same UA: worker's `applyMutationWithRetry` either wins (UA gone from watchlist before monitor's B) — monitor's B becomes no-op — or loses (UA already removed by monitor's B). Both end states are correct.
- User runs `/add UA-...` for a UA the monitor just archived: handler sees no UA in watchlist, checks archive, finds it → returns warning + `/unarchive` suggestion. Cross-check below.
- User runs `/unarchive UA-...` while monitor archives the same UA: race possible but harmless. Worst case: unarchive succeeds first → monitor's run sees still-terminal status → re-archives. Spam-of-1. Acceptable.

## Cross-checks at the worker

- `handleAdd`: before attempting Prozorro fetch + watchlist insert, load `archived_tenders.json`. If `tender_id` present, return early with warning. Cost: one extra GitHub read per `/add`. Worth it for UX.
- `formatInfo` / `cmd: info` branch in handler: if `tender_id` is in archive but not in watchlist, reply with redirect instead of "не у watchlist".

## Test plan

Pure handlers (no I/O):
- `parseCommand`: `/archive`, `/archive UA-...`, `/contract UA-...`, `/unarchive UA-...` — happy path, missing/invalid ids, bot suffix, case normalization.
- `applyArchiveMutation`: `append_archive`, `remove_archive`.
- `handleArchive`: empty, multi-row, status-icon mapping, sort order, footer.
- `handleArchiveDetail`: with contract, without contract, archived but `tender_id` absent.
- `handleContract`: with contract, without contract, unknown tender.
- `handleUnarchive`: success path (mutation pair: remove from archive + append to watchlist), unknown tender, already in watchlist.
- `handleAdd` cross-check: archived tender → warning + no Prozorro fetch.

Monitor cycle:
- `archiveTender` injected; called once per terminal-status row.
- `archiveTender` is **not** called for `active.tendering`, `active.qualification`, `active.awarded`.
- Idempotency: if `archiveTender` returns `false` for all rows, no "Архівовано" block in digest.
- Order: digest text contains events first, then archive block.

Integration (worker handler):
- `/archive`, `/archive UA-...`, `/contract`, `/unarchive` route + sendReply.
- `/add` on archived UA → warning reply, no `saveWatchlist` call.
- `/info UA-...` on archived UA → redirect reply.

## Files touched

**Modified:**
- `commands.mjs` — parse + 6 handler functions + `applyArchiveMutation` + `HELP_TEXT`.
- `monitor.mjs` — terminal-status detection + `archiveTender` deps call + digest block.
- `ci.mjs` — implement `archiveTender` dep (filesystem I/O).
- `worker/src/github.mjs` — `loadArchivedTenders` / `saveArchivedTenders`.
- `worker/src/handler.mjs` — wire `/archive`, `/contract`, `/unarchive` + `applyArchiveMutationWithRetry` helper + cross-checks in `/add` and `/info`.
- `test/commands.test.mjs` — new tests (~30).
- `test/monitor.test.mjs` — 4-5 new tests.
- `worker/test/handler.test.mjs` — 4-6 new tests.
- `worker/test/github.test.mjs` — 2 new tests for I/O helpers.

**Created:**
- `_state/archived_tenders.json` — initial empty array `[]`.

**Not changed:** `prozorro.mjs`, `telegram.mjs`, `entity_watch.mjs`, `compare.mjs`, `main.mjs`.
