# Ephemeral On-Demand Views (Feature A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user opens a new on-demand VIEW (info/watched/archive/agent/help/status/whoami), the bot deletes the previous view (user request + bot reply) and shows only the new one; actions and proactive notifications are untouched.

**Architecture:** A new `telegram.deleteMessage` (best-effort), a tiny `worker/src/ephemeral.mjs` over a Cloudflare KV binding (`EPHEMERAL_KV`, keyed by chatId, 48h TTL), and cleanup logic wrapped around the command-reply send loop in `worker/src/handler.mjs`. Inline-nav callbacks edit one message in place, so no extra tracking is needed during navigation.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Cloudflare Worker + KV, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-06-25-ephemeral-views-design.md`

**Baseline:** `node --test test/telegram.test.mjs` = 85 pass; `node --test worker/test/handler.test.mjs` = 179 pass. All 0 fail.

---

## File Structure

- `telegram.mjs` — **Modify.** Add `deleteMessage` (after `editMessageReplyMarkup`, ~line 597). Pattern mirrors the existing send/edit helpers (POST to Bot API) but best-effort (non-ok → `false`, never throws).
- `worker/src/ephemeral.mjs` — **Create.** `loadEphemeral(kv, chatId)` / `saveEphemeral(kv, chatId, ids)` over a KV binding. Pure-ish; `kv` injected (fake in tests).
- `worker/wrangler.toml` — **Modify.** Add the `EPHEMERAL_KV` namespace binding (placeholder id the user fills).
- `worker/src/handler.mjs` — **Modify.** Import `deleteMessage` (line 23) + `loadEphemeral`/`saveEphemeral`; add `_deleteMessage`/`_ephemeralKV` dep aliases (~line 73); add module-scope `EPHEMERAL_VIEW_CMDS`; wrap the send loop (~lines 638-654) with cleanup-before + capture-reply-id + save-after.
- `test/telegram.test.mjs`, `worker/test/ephemeral.test.mjs`, `worker/test/handler.test.mjs` — **Create/Modify.** Tests.

**Commands:** `node --test test/telegram.test.mjs` · `node --test worker/test/ephemeral.test.mjs` · `node --test worker/test/handler.test.mjs`

**Test harness facts (handler):** `makeDeps(overrides)` returns `{ deps, ... }`; default `sendReply` returns `undefined` and `loadAllowedUsers` returns `{ users: [], sha: null }`; `ENV.ADMIN_CHAT_ID = '123'` so chat 123 is admin/allowed. The KV binding is read via `env.EPHEMERAL_KV`, so tests pass a fake KV in `env`.

---

## Task 1: `telegram.deleteMessage` (best-effort)

**Files:** Modify `telegram.mjs` (after `editMessageReplyMarkup`, ~line 597) · Test `test/telegram.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `deleteMessage` to the import in `test/telegram.test.mjs` (top `import { ... } from '../telegram.mjs'`), and append:

```javascript
test('deleteMessage: POST /deleteMessage with chat_id+message_id, true on ok', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  const ok = await deleteMessage({ token: 'TOK', chatId: 123, messageId: 55, fetch: fakeFetch });
  assert.equal(ok, true);
  assert.match(captured.url, /botTOK\/deleteMessage$/);
  assert.equal(captured.body.get('chat_id'), '123');
  assert.equal(captured.body.get('message_id'), '55');
});

test('deleteMessage: non-ok HTTP → false, no throw', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'message to delete not found' });
  assert.equal(await deleteMessage({ token: 'T', chatId: 1, messageId: 2, fetch: fakeFetch }), false);
});

test('deleteMessage: fetch throws → false, no throw', async () => {
  const fakeFetch = async () => { throw new Error('network'); };
  assert.equal(await deleteMessage({ token: 'T', chatId: 1, messageId: 2, fetch: fakeFetch }), false);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL — `deleteMessage is not a function`.

- [ ] **Step 3: Implement in `telegram.mjs`** (after the `editMessageReplyMarkup` function, ~line 597)

```javascript
// Best-effort delete: returns true on success, false on any failure (message
// already gone, older than 48h, network) — never throws, so cleanup of stale
// messages can't break a command.
export async function deleteMessage({ token, chatId, messageId, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/deleteMessage`;
  const params = new URLSearchParams({
    chat_id: String(chatId),
    message_id: String(messageId),
  });
  try {
    const res = await fetchImpl(url, { method: 'POST', body: params });
    if (!res.ok) return false;
    const json = await res.json();
    return json.ok === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test test/telegram.test.mjs`
Expected: PASS (85 + 3 = 88).

- [ ] **Step 5: Commit**

```bash
git add telegram.mjs test/telegram.test.mjs
git commit -m "feat(telegram): best-effort deleteMessage"
```

---

## Task 2: `worker/src/ephemeral.mjs` — KV helpers

**Files:** Create `worker/src/ephemeral.mjs` · Create `worker/test/ephemeral.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/ephemeral.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEphemeral, saveEphemeral } from '../src/ephemeral.mjs';

function fakeKV(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    delete: async (k) => { delete store[k]; },
  };
}

test('loadEphemeral: missing key → []', async () => {
  assert.deepEqual(await loadEphemeral(fakeKV(), '123'), []);
});

test('loadEphemeral: returns the stored array', async () => {
  const kv = fakeKV({ 'eph:123': JSON.stringify([10, 11]) });
  assert.deepEqual(await loadEphemeral(kv, '123'), [10, 11]);
});

test('loadEphemeral: null kv → []; bad JSON → []', async () => {
  assert.deepEqual(await loadEphemeral(null, '123'), []);
  assert.deepEqual(await loadEphemeral(fakeKV({ 'eph:1': 'not json' }), '1'), []);
});

test('saveEphemeral: stores JSON with a 48h TTL', async () => {
  const kv = fakeKV();
  let ttlOpts;
  kv.put = async (k, v, o) => { kv.store[k] = v; ttlOpts = o; };
  await saveEphemeral(kv, '123', [7, 555]);
  assert.equal(kv.store['eph:123'], JSON.stringify([7, 555]));
  assert.equal(ttlOpts.expirationTtl, 172800);
});

test('saveEphemeral: null kv → no-op (no throw)', async () => {
  await saveEphemeral(null, '123', [1]);   // must not throw
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test worker/test/ephemeral.test.mjs`
Expected: FAIL — cannot find module `../src/ephemeral.mjs`.

- [ ] **Step 3: Create `worker/src/ephemeral.mjs`**

```javascript
// Per-chat "last on-demand view" message ids, stored in Cloudflare KV so the
// next view command can delete the previous one. Keyed by chatId; 48h TTL (a
// message older than 48h can't be deleted anyway). `kv` is the EPHEMERAL_KV
// binding (or a fake in tests); a missing kv degrades to a no-op.
const key = (chatId) => `eph:${chatId}`;

export async function loadEphemeral(kv, chatId) {
  if (!kv) return [];
  const raw = await kv.get(key(chatId));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveEphemeral(kv, chatId, ids) {
  if (!kv) return;
  await kv.put(key(chatId), JSON.stringify(ids), { expirationTtl: 172800 });
}
```

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test worker/test/ephemeral.test.mjs`
Expected: PASS (5).

- [ ] **Step 5: Commit**

```bash
git add worker/src/ephemeral.mjs worker/test/ephemeral.test.mjs
git commit -m "feat(ephemeral): KV-backed per-chat view-message store"
```

---

## Task 3: Wire cleanup into the handler + KV binding

**Files:** Modify `worker/wrangler.toml`; Modify `worker/src/handler.mjs` (import line 23; aliases ~line 73; module-scope const; send loop ~638-654) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/handler.test.mjs`:

```javascript
test('runHandler: a VIEW command deletes the previous view + records the new one', async () => {
  const deleted = [];
  const kvStore = { 'eph:123': JSON.stringify([100, 101]) };
  const kv = {
    get: async (k) => (k in kvStore ? kvStore[k] : null),
    put: async (k, v) => { kvStore[k] = v; },
    delete: async (k) => { delete kvStore[k]; },
  };
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '/help', from: { id: 123 } } },
    env: { ...ENV, EPHEMERAL_KV: kv },
    deps: {
      ...makeDeps().deps,
      deleteMessage: async ({ messageId }) => { deleted.push(messageId); return true; },
      sendReply: async () => ({ ok: true, result: { message_id: 555 } }),
    },
  });
  assert.deepEqual(deleted.sort((a, b) => a - b), [100, 101], 'previous view messages deleted');
  assert.equal(kvStore['eph:123'], JSON.stringify([7, 555]), 'new ids = [trigger, reply]');
});

test('runHandler: a non-VIEW (action) command does NOT delete or record', async () => {
  const deleted = [];
  const kvStore = { 'eph:123': JSON.stringify([100]) };
  const kv = {
    get: async (k) => (k in kvStore ? kvStore[k] : null),
    put: async (k, v) => { kvStore[k] = v; },
    delete: async (k) => { delete kvStore[k]; },
  };
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 8, text: '/notify', from: { id: 123 } } },
    env: { ...ENV, EPHEMERAL_KV: kv },
    deps: {
      ...makeDeps().deps,
      deleteMessage: async ({ messageId }) => { deleted.push(messageId); return true; },
      sendReply: async () => ({ ok: true, result: { message_id: 999 } }),
    },
  });
  assert.equal(deleted.length, 0, 'no deletions for an action command');
  assert.equal(kvStore['eph:123'], JSON.stringify([100]), 'ephemeral state unchanged');
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — previous view not deleted / KV not updated (no cleanup logic yet).

- [ ] **Step 3: Implement**

3a. `worker/wrangler.toml` — append the KV binding:
```toml

[[kv_namespaces]]
binding = "EPHEMERAL_KV"
id = "REPLACE_WITH_KV_ID"   # `cd worker && npx wrangler kv namespace create EPHEMERAL_KV`
```

3b. `worker/src/handler.mjs` line 23 — add `deleteMessage` to the telegram import:
```javascript
import { sendReply, editMessageReplyMarkup, editMessageText, answerCallbackQuery, setMyCommands, deleteMessage } from '../../telegram.mjs';
```

3c. Add the ephemeral import just below the telegram import (after line 23):
```javascript
import { loadEphemeral, saveEphemeral } from './ephemeral.mjs';
```

3d. Add a module-scope constant near the top (e.g. just after the `BOT_USERNAME` const, ~line 39):
```javascript
// Commands whose reply is an on-demand "view": the bot keeps only the latest one
// in the chat (deletes the previous view + its trigger on the next view command).
const EPHEMERAL_VIEW_CMDS = new Set(['info', 'watched', 'archive', 'agent', 'help', 'status', 'whoami']);
```

3e. Add dep aliases right after `const _setMyCommands = deps.setMyCommands ?? setMyCommands;` (~line 73):
```javascript
  const _deleteMessage = deps.deleteMessage ?? deleteMessage;
  const _ephemeralKV = deps.ephemeralKV ?? env.EPHEMERAL_KV;
```

3f. Replace the send-loop block (currently ~lines 638-654):
```javascript
  const pages = Array.isArray(reply) ? reply : [reply];
  for (let i = 0; i < pages.length; i++) {
    const isLast = i === pages.length - 1;
    try {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: pages[i],
        replyToMessageId: i === 0 ? msg.message_id : undefined,
        replyMarkup: isLast
          ? (archiveReplyMarkup ?? agentReplyMarkup ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
          : undefined,
      });
    } catch (err) {
      console.error('worker: sendReply failed:', err.message);
    }
  }
```
with:
```javascript
  // Ephemeral views: before showing a new on-demand view, delete the previous
  // one (its bot reply + the user's trigger). Best-effort; never blocks the reply.
  const isView = EPHEMERAL_VIEW_CMDS.has(cmd.cmd);
  if (isView && _ephemeralKV) {
    try {
      const prevIds = await loadEphemeral(_ephemeralKV, chatId);
      for (const id of prevIds) {
        await _deleteMessage({ token: env.TELEGRAM_BOT_TOKEN, chatId, messageId: id });
      }
    } catch (err) {
      console.error('worker: ephemeral cleanup failed:', err.message);
    }
  }

  const pages = Array.isArray(reply) ? reply : [reply];
  const botReplyIds = [];
  for (let i = 0; i < pages.length; i++) {
    const isLast = i === pages.length - 1;
    try {
      const resp = await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: pages[i],
        replyToMessageId: i === 0 ? msg.message_id : undefined,
        replyMarkup: isLast
          ? (archiveReplyMarkup ?? agentReplyMarkup ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
          : undefined,
      });
      const mid = resp?.result?.message_id;
      if (mid != null) botReplyIds.push(mid);
    } catch (err) {
      console.error('worker: sendReply failed:', err.message);
    }
  }

  // Record this view (trigger + bot reply) so the NEXT view command can clear it.
  if (isView && _ephemeralKV) {
    try {
      const ids = [msg.message_id, ...botReplyIds].filter((x) => x != null);
      await saveEphemeral(_ephemeralKV, chatId, ids);
    } catch (err) {
      console.error('worker: ephemeral save failed:', err.message);
    }
  }
```

- [ ] **Step 4: Run — confirm PASS (both suites)**

Run: `node --test worker/test/handler.test.mjs` → 179 + 2 = 181, 0 fail.
Existing handler tests pass unchanged: they don't set `env.EPHEMERAL_KV`, so `_ephemeralKV` is undefined and the cleanup/save blocks are skipped; capturing `resp?.result?.message_id` is harmless when mocks return undefined.
Run: `node --test test/telegram.test.mjs` → 88, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(ephemeral): clear previous on-demand view on the next view command"
```

---

## Self-Review

**Spec coverage:**
- `deleteMessage` best-effort → Task 1 ✓
- KV store keyed by chatId, 48h TTL, graceful on missing kv/bad json → Task 2 ✓
- KV binding in wrangler.toml (placeholder id; user runs `wrangler kv namespace create`) → Task 3 step 3a ✓
- VIEW set `{info,watched,archive,agent,help,status,whoami}` → Task 3 step 3d ✓
- Cleanup before + capture reply id + save after, only for VIEW cmds → Task 3 step 3f ✓
- Actions/notifications/callbacks untouched → Task 3 (guarded by `isView`; callbacks return earlier via handleCallbackQuery, never reach this send loop) ✓
- Graceful degradation when KV missing/unavailable → `if (isView && _ephemeralKV)` guards + try/catch ✓

**Placeholder scan:** the wrangler `id = "REPLACE_WITH_KV_ID"` is an intentional user-filled config value (documented), not a plan gap. No code placeholders.

**Type consistency:** `deleteMessage({token,chatId,messageId,fetch})`, `loadEphemeral(kv,chatId)`/`saveEphemeral(kv,chatId,ids)` signatures identical across defs, tests, and handler call sites; key `eph:<chatId>` consistent (Task 2 def ↔ Task 3 tests); `EPHEMERAL_KV` binding name consistent (wrangler ↔ handler alias ↔ tests).

**One-time user action (outside this plan):** `cd worker && npx wrangler kv namespace create EPHEMERAL_KV` → paste the id into `wrangler.toml`. Until then the feature degrades to a no-op (bot works as before).
