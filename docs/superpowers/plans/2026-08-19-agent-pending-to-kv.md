# agent_pending.json → Cloudflare KV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop committing `_state/agent_pending.json` to git on every step of the `/agent` dialog (company pick, price prompt, confirm, cancel). Move it to Cloudflare KV, the same store `worker/src/ephemeral.mjs` already uses for per-chat view state.

**Why now, why only this file:** audited every `_state/*.json` file against both `worker/src/github.mjs` and `ci.mjs` (the GitHub Actions cron). `agent_pending.json` is the ONLY one touched exclusively by the Worker — everything else (`_watched_seen.json`, `notification_history.json`, `_pending_digest.json`, `watchlist.json`, `watched_entities.json`, `agent_jobs/*`) is also read/written by `ci.mjs` and/or the Python poller, so it must stay in git (the only store all sides can reach without new cross-environment plumbing). The three cron-only files (`_heartbeat.json`, `_agent_health_alerted.json`, `_watched_feed_cursor.json`) are a separate, lower-priority candidate — moving THOSE to KV would require `ci.mjs` (which runs in GitHub Actions, no native KV binding) to call Cloudflare's KV REST API over HTTP, a real new piece of infrastructure for comparatively little benefit (the cron already commits at most once an hour, not per click). Not in scope here.

**Architecture:** Add a new KV namespace binding (or reuse `EPHEMERAL_KV` with a distinct key prefix, e.g. `pending:${chatId}`) and swap `loadAgentPending`/`saveAgentPending` in `worker/src/github.mjs` from GitHub Contents API calls to `env.<KV_BINDING>.get`/`.put`. No change to the calling code in `handler.mjs` — same function signatures, same return shape.

**Tech Stack:** Cloudflare Workers, `wrangler.toml`, `node --test`.

---

### Task 1: Add the KV binding

**Files:**
- Modify: `worker/wrangler.toml`

- [ ] Check whether the existing `EPHEMERAL_KV` namespace is fine to reuse (just a different key prefix) or a second namespace is cleaner — reuse is simpler and there is no cross-talk risk since `agent_pending` keys and `eph:`/`eph:start:` keys never collide.
- [ ] If reusing: no `wrangler.toml` change needed. If adding a new namespace: add the binding, create it via `wrangler kv:namespace create`, record the id.

### Task 2: Rewrite `loadAgentPending` / `saveAgentPending`

**Files:**
- Modify: `worker/src/github.mjs` (or move these two functions into `ephemeral.mjs` if that reads better — they are conceptually the same kind of state now)
- Test: `worker/test/github.test.mjs` (or `ephemeral.test.mjs` if moved)

- [ ] **Step 1: Write the failing tests first.** Mock a fake KV binding (`{get, put}` in-memory map, same pattern the existing ephemeral tests already use for the fake KV) and assert:
  - `loadAgentPending(env, chatId)` returns `null` when nothing is stored
  - `saveAgentPending(env, chatId, obj)` then `loadAgentPending` round-trips the same object
  - saving `null`/deleting clears the key (matches today's "cancel clears pending" behavior)
- [ ] **Step 2: Run tests, confirm they fail** against the current GitHub-API-based implementation (or don't compile yet if the function signature changes — either way, confirm red before writing the real implementation).
- [ ] **Step 3: Implement** using `env.EPHEMERAL_KV.get(\`pending:${chatId}\`, 'json')` / `.put(..., JSON.stringify(obj))` / `.delete(...)`. Keep the same exported function names and call sites in `handler.mjs` untouched.
- [ ] **Step 4: Run tests, confirm green.**
- [ ] **Step 5: Run the full test suite** (`node --test test/*.test.mjs worker/test/*.test.mjs`) — confirm no other test references `agent_pending.json` as a GitHub-committed file (grep for `agent_pending` across `worker/test/` and `test/` first, in case some test's fixture/mocked-github asserts a commit happened).

### Task 3: Remove the now-dead GitHub Contents API path for this file

**Files:**
- Modify: `worker/src/github.mjs` — delete the old `AGENT_PENDING_FILE` constant and the old load/save implementation once Task 2's replacement is in and tested
- Check: `CLAUDE.md` in this repo doesn't document `agent_pending.json` as part of the job-queue contract with the agent (it shouldn't — only `agent_jobs/<tender_id>.json` is the contract file) — confirm no doc update needed there.

- [ ] Remove dead code, re-run full suite once more.

### Task 4: Live verification (owner does this, not the agent)

- [ ] Deploy, then run through one full `/agent` dialog in Telegram (company pick → price → confirm) and confirm: (a) it still works exactly the same from the chat's point of view, (b) no new commit appears in GitHub for `_state/agent_pending.json` during the dialog.

---

## Self-review notes

- **Scope discipline:** this plan deliberately does NOT touch `_heartbeat.json`/`_agent_health_alerted.json`/`_watched_feed_cursor.json` (cron-only, different execution environment, would need a new HTTP-based Cloudflare KV REST integration from GitHub Actions — a separate, lower-value piece of work) or any of the genuinely cross-environment files (`agent_jobs/*`, `watchlist.json`, `watched_entities.json`, `_watched_seen.json`, `notification_history.json`, `_pending_digest.json`) — those must stay in git since more than one execution context needs to read/write them and git/GitHub API is the only thing all of them can already reach.
- **Placeholder scan:** none — every step names a real file and a real function.
- **Type consistency:** `loadAgentPending`/`saveAgentPending` keep their existing signatures; only the storage backend changes.
