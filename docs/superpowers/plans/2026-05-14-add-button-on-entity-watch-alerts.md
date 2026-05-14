# Add-to-monitoring inline button on entity-watch alerts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline `➕ Додати в моніторинг` button under each entity-watch alert in the Telegram digest. Tapping it adds the tender to the watchlist and swaps the button to `✅ Додано HH:MM`.

**Architecture:** CI tick (`ci.mjs`) computes which `groups` are entity-watch alerts (event `new_tender_announced`) and passes their `tender_id`s to `sendDigest`, which attaches an inline_keyboard to chunks containing those IDs. Cloudflare Worker (`worker/src/handler.mjs`) gets a new `handleCallbackQuery` branch that parses `callback_data="add:UA-…"`, runs the existing `handleAdd` mutation, and edits the keyboard via `editMessageReplyMarkup`.

**Tech Stack:** Node.js (CI), Cloudflare Workers (bot), Telegram Bot API, GitHub REST (state), `node:test` for tests.

**Spec:** [docs/superpowers/specs/2026-05-14-add-button-on-entity-watch-alerts-design.md](../specs/2026-05-14-add-button-on-entity-watch-alerts-design.md)

---

## File map

| File | Responsibility | Change kind |
|---|---|---|
| `telegram.mjs` | Telegram I/O — formatting + send | extend `sendDigest`, add `editMessageReplyMarkup` + `answerCallbackQuery` exports, add DI fetch to `sendDigest`/`sendOne` |
| `monitor.mjs` | Tick orchestration | derive `addButtonsForTenders` from groups, pass to `sendDigest` |
| `ci.mjs` | CI entry — wires deps | thread 2nd arg through `sendDigest` adapter |
| `worker/src/handler.mjs` | Webhook update routing | new `handleCallbackQuery` branch in `runHandler` |
| `test/telegram.test.mjs` | Tests for telegram.mjs | new tests: button placement + new exports |
| `worker/test/handler.test.mjs` | Tests for handler | new tests: callback routing + edge cases |
| `worker/src/index.mjs` | Webhook entry | NO CHANGE (already passes raw `update`) |
| `entity_watch.mjs` | Builds entity-watch groups | NO CHANGE (already emits `new_tender_announced`) |

---

## Task 1: Add DI `fetch` param to `sendDigest` / `sendOne`

**Files:**
- Modify: `telegram.mjs` (lines 335-364)
- Test: `test/telegram.test.mjs` (append)

**Why first:** Existing `sendDigest` calls global `fetch` directly. Without injectable `fetch` we can't write a unit test for the new `addButtonsForTenders` behavior. Other senders (`sendReply`, `getUpdates`) already accept `fetch` — we're aligning `sendDigest` with the established pattern.

- [ ] **Step 1: Write the failing test**

Append to `test/telegram.test.mjs`:

```js
import { sendDigest } from '../telegram.mjs';

test('sendDigest: passes text + chat_id to fetch with parse_mode=HTML', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await sendDigest({ token: 'TOK', chatId: '12345', fetch: fakeFetch }, 'hello');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/sendMessage$/);
  assert.match(calls[0].body, /chat_id=12345/);
  assert.match(calls[0].body, /text=hello/);
  assert.match(calls[0].body, /parse_mode=HTML/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test test/telegram.test.mjs
```
Expected: this single test fails (sendDigest doesn't accept `fetch` param yet — falls back to global `fetch` and may throw or hit network).

- [ ] **Step 3: Implement DI fetch**

Replace `sendOne` and `sendDigest` in `telegram.mjs`:

```js
async function sendOne({ token, chatId, fetch: fetchImpl = fetch }, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const params = {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  };
  if (replyMarkup != null) params.reply_markup = JSON.stringify(replyMarkup);
  const body = new URLSearchParams(params);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', body });
      if (res.ok) return await res.json();
      lastErr = new Error(`Telegram ${res.status}: ${await res.text()}`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

export async function sendDigest({ token, chatId, fetch: fetchImpl = fetch }, text) {
  const chunks = chunkMessage(text, 4000);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const annotated = chunks.length > 1
      ? `${chunks[i]}\n\n— ${i + 1}/${chunks.length} —`
      : chunks[i];
    last = await sendOne({ token, chatId, fetch: fetchImpl }, annotated);
  }
  return last;
}
```

(Also added `replyMarkup` param to `sendOne` — needed by Task 2; harmless when omitted.)

- [ ] **Step 4: Run test to verify it passes**

```
node --test test/telegram.test.mjs
```
Expected: new test PASSES, all existing tests still pass.

- [ ] **Step 5: Commit**

```
git add telegram.mjs test/telegram.test.mjs
git commit -m "telegram: inject fetch into sendDigest (enables unit tests)"
```

---

## Task 2: Add `addButtonsForTenders` option to `sendDigest`

**Files:**
- Modify: `telegram.mjs` `sendDigest`
- Test: `test/telegram.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram.test.mjs`:

```js
test('sendDigest: addButtonsForTenders attaches inline_keyboard to chunk containing the id', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    'before\n\nUA-2026-05-14-008910-a in here\n\nafter',
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'] },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /reply_markup=/);
  const body = decodeURIComponent(calls[0]);
  assert.match(body, /"callback_data":"add:UA-2026-05-14-008910-a"/);
  assert.match(body, /Додати в моніторинг/);
});

test('sendDigest: addButtonsForTenders only attaches button to chunks containing the id', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  // Force chunking by exceeding 4000 chars; tender_id is in second chunk only.
  const filler = 'X'.repeat(3500);
  const text = `${filler}\n\nplain group\n\nUA-2026-05-14-008910-a here`;
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    text,
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'] },
  );
  assert.ok(calls.length >= 2, `expected at least 2 chunks, got ${calls.length}`);
  // First chunk has no tender_id → no reply_markup
  assert.doesNotMatch(calls[0], /reply_markup/);
  // Last chunk has tender_id → has reply_markup with the button
  const last = decodeURIComponent(calls[calls.length - 1]);
  assert.match(last, /"callback_data":"add:UA-2026-05-14-008910-a"/);
});

test('sendDigest: no options → no reply_markup (backward compat)', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest({ token: 'TOK', chatId: '1', fetch: fakeFetch }, 'plain text');
  assert.doesNotMatch(calls[0], /reply_markup/);
});

test('sendDigest: addButtonsForTenders entries that do NOT appear in any chunk are silently skipped', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    'no tender ids in this body at all',
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'] },
  );
  assert.doesNotMatch(calls[0], /reply_markup/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test test/telegram.test.mjs
```
Expected: 4 new tests fail.

- [ ] **Step 3: Implement option**

Replace `sendDigest` in `telegram.mjs`:

```js
export async function sendDigest({ token, chatId, fetch: fetchImpl = fetch }, text, { addButtonsForTenders = [] } = {}) {
  const chunks = chunkMessage(text, 4000);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const annotated = chunks.length > 1
      ? `${chunks[i]}\n\n— ${i + 1}/${chunks.length} —`
      : chunks[i];
    const buttonsHere = addButtonsForTenders.filter(id => annotated.includes(id));
    const replyMarkup = buttonsHere.length > 0
      ? {
          inline_keyboard: buttonsHere.map(id => [
            { text: `➕ Додати в моніторинг ${id}`, callback_data: `add:${id}` },
          ]),
        }
      : null;
    last = await sendOne({ token, chatId, fetch: fetchImpl }, annotated, replyMarkup);
  }
  return last;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test test/telegram.test.mjs
```
Expected: all 4 new tests PASS, all pre-existing PASS.

- [ ] **Step 5: Commit**

```
git add telegram.mjs test/telegram.test.mjs
git commit -m "telegram: sendDigest accepts addButtonsForTenders to inject inline keyboard"
```

---

## Task 3: Add `editMessageReplyMarkup` + `answerCallbackQuery` exports

**Files:**
- Modify: `telegram.mjs` (append)
- Test: `test/telegram.test.mjs` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram.test.mjs`:

```js
import { editMessageReplyMarkup, answerCallbackQuery } from '../telegram.mjs';

test('editMessageReplyMarkup: posts to editMessageReplyMarkup endpoint with chat_id, message_id, reply_markup', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const kb = { inline_keyboard: [[{ text: '✅ Додано', callback_data: 'noop' }]] };
  await editMessageReplyMarkup({
    token: 'TOK', chatId: '111', messageId: 222, replyMarkup: kb, fetch: fakeFetch,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/editMessageReplyMarkup$/);
  const body = decodeURIComponent(calls[0].body);
  assert.match(body, /chat_id=111/);
  assert.match(body, /message_id=222/);
  assert.match(body, /reply_markup=.*✅ Додано/);
  assert.match(body, /"callback_data":"noop"/);
});

test('editMessageReplyMarkup: throws on Telegram error response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  await assert.rejects(
    () => editMessageReplyMarkup({
      token: 'T', chatId: '1', messageId: 1,
      replyMarkup: { inline_keyboard: [] }, fetch: fakeFetch,
    }),
    /Telegram editMessageReplyMarkup 400/,
  );
});

test('answerCallbackQuery: posts callback_query_id, text, show_alert', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await answerCallbackQuery({
    token: 'TOK', callbackQueryId: 'cbq1', text: '✅ Готово', showAlert: true, fetch: fakeFetch,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/answerCallbackQuery$/);
  const body = decodeURIComponent(calls[0].body);
  assert.match(body, /callback_query_id=cbq1/);
  assert.match(body, /text=✅ Готово/);
  assert.match(body, /show_alert=true/);
});

test('answerCallbackQuery: omits text and show_alert when not provided', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await answerCallbackQuery({ token: 'T', callbackQueryId: 'cbq1', fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /text=/);
  assert.doesNotMatch(calls[0], /show_alert=/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test test/telegram.test.mjs
```
Expected: 4 new tests fail (functions not exported).

- [ ] **Step 3: Implement exports**

Append to `telegram.mjs` (after `sendReply`):

```js
export async function editMessageReplyMarkup({ token, chatId, messageId, replyMarkup, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  const params = new URLSearchParams({
    chat_id: String(chatId),
    message_id: String(messageId),
    reply_markup: JSON.stringify(replyMarkup),
  });
  const res = await fetchImpl(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Telegram editMessageReplyMarkup ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram editMessageReplyMarkup: ${json.description ?? 'unknown'}`);
  return json;
}

export async function answerCallbackQuery({ token, callbackQueryId, text, showAlert, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const params = new URLSearchParams({ callback_query_id: String(callbackQueryId) });
  if (text != null) params.set('text', text);
  if (showAlert) params.set('show_alert', 'true');
  const res = await fetchImpl(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Telegram answerCallbackQuery ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram answerCallbackQuery: ${json.description ?? 'unknown'}`);
  return json;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test test/telegram.test.mjs
```
Expected: all 4 new tests PASS.

- [ ] **Step 5: Commit**

```
git add telegram.mjs test/telegram.test.mjs
git commit -m "telegram: export editMessageReplyMarkup + answerCallbackQuery"
```

---

## Task 4: monitor.mjs computes `addButtonsForTenders` and passes to sendDigest

**Files:**
- Modify: `monitor.mjs` (line 190 area: `await sendDigest(text)`)
- Modify: `ci.mjs` (line 61 area: `sendDigest` adapter signature)
- Test: `test/monitor.test.mjs` (append)

- [ ] **Step 1: Inspect existing monitor test setup**

Read `test/monitor.test.mjs` to confirm test pattern. Look for existing tests that capture `sendDigest` calls; reuse the same `sentText[]` capture approach.

```
Run: rg -n "sendDigest" test/monitor.test.mjs
```

- [ ] **Step 2: Write the failing test**

Append to `test/monitor.test.mjs`:

```js
test('runOnce: passes addButtonsForTenders for entity-watch alerts (new_tender_announced)', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-14T12:00:00Z',
    watchlist: [],
    fetchTender: async () => { throw new Error('not used'); },
    extractSnapshot: () => ({}),
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text, opts) => { sent.push({ text, opts }); },
    updateSheet: async () => {},
    watchedEntities: [{ edrpou: '01998644', enabled: true }],
    checkWatchedEntities: async () => ({
      alerts: [{
        tender_id: 'UA-2026-05-14-008910-a',
        title: 'X',
        events: [{ type: 'new_tender_announced' }],
        prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-05-14-008910-a',
      }],
      errors: [],
    }),
    loadCursor: async () => null,
    saveCursor: async () => {},
    loadSeen: async () => ({}),
    saveSeen: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { addButtonsForTenders: ['UA-2026-05-14-008910-a'] });
});

test('runOnce: heartbeat path passes no addButtonsForTenders', async () => {
  const sent = [];
  await runOnce({
    runIso: '2026-05-14T09:00:00+03:00', // matches isHeartbeatHour
    watchlist: [],
    fetchTender: async () => { throw new Error('skipped'); },
    extractSnapshot: () => ({}),
    loadState: async () => null,
    saveState: async () => {},
    sendDigest: async (text, opts) => { sent.push({ text, opts }); },
    updateSheet: async () => {},
  });
  assert.equal(sent.length, 1);
  // heartbeat path: opts undefined or omitted (no buttons attached)
  assert.ok(sent[0].opts === undefined || (sent[0].opts.addButtonsForTenders ?? []).length === 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```
node --test test/monitor.test.mjs
```
Expected: 2 new tests fail (sendDigest currently called without opts).

- [ ] **Step 4: Implement in monitor.mjs**

In `monitor.mjs` line 190 area, replace:

```js
    await sendDigest(text);
```

with:

```js
    const addButtonsForTenders = groups
      .filter(g => g.events?.some(e => e.type === 'new_tender_announced'))
      .map(g => g.tender_id);
    await sendDigest(text, addButtonsForTenders.length > 0 ? { addButtonsForTenders } : undefined);
```

The heartbeat path (line 156: `await sendDigest(heartbeat);`) stays unchanged.

- [ ] **Step 5: Update ci.mjs adapter to forward 2nd arg**

In `ci.mjs` line 61, replace:

```js
    sendDigest: async (text) => tgSend({ token, chatId }, text),
```

with:

```js
    sendDigest: async (text, opts) => tgSend({ token, chatId }, text, opts),
```

- [ ] **Step 6: Run tests to verify they pass**

```
node --test test/monitor.test.mjs
node --test
```
Expected: 2 new tests PASS, ALL 440+ tests PASS (no regressions).

- [ ] **Step 7: Commit**

```
git add monitor.mjs ci.mjs test/monitor.test.mjs
git commit -m "monitor: thread addButtonsForTenders for entity-watch alerts to sendDigest"
```

---

## Task 5: Worker callback_query routing — noop, invalid, unauthorized paths

**Files:**
- Modify: `worker/src/handler.mjs`
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/handler.test.mjs`:

```js
test('runHandler: callback_query from non-allowed user → answers "Доступ заборонено", no edit, no add', async () => {
  const sent = [];
  const acks = [];
  const edits = [];
  const adds = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1',
        data: 'add:UA-2026-05-14-008910-a',
        message: { chat: { id: 999 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      sendReply: async (a) => sent.push(a),
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
      saveWatchlist: async () => adds.push('called'),
      loadAllowedUsers: async () => ({ users: [], sha: null }),
    },
  });
  assert.equal(sent.length, 0);
  assert.equal(edits.length, 0);
  assert.equal(adds.length, 0);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Доступ заборонено/);
});

test('runHandler: callback_query data="noop" → empty answer, nothing else', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: 'noop',
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 0);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].text, undefined);
});

test('runHandler: callback_query data="add:bad-format" → answers with error toast, no add, no edit', async () => {
  const acks = [];
  const edits = [];
  const adds = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: 'add:not-a-tender',
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
      saveWatchlist: async () => adds.push('x'),
    },
  });
  assert.equal(adds.length, 0);
  assert.equal(edits.length, 0);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Невалідний tender_id/);
});

test('runHandler: callback_query data="something-unknown" → answers with unknown-button toast', async () => {
  const acks = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: 'frobnicate',
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps().deps,
      answerCallbackQuery: async (a) => acks.push(a),
    },
  });
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Невідома кнопка/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test worker/test/handler.test.mjs
```
Expected: 4 new tests fail (callback_query branch not implemented; deps not wired).

- [ ] **Step 3: Wire `answerCallbackQuery` + `editMessageReplyMarkup` deps**

In `worker/src/handler.mjs` add imports at top:

```js
import { sendReply, editMessageReplyMarkup, answerCallbackQuery } from '../../telegram.mjs';
```

Inside `runHandler`, near the existing `_sendReply = …` line, add:

```js
  const _editMessageReplyMarkup = deps.editMessageReplyMarkup ?? editMessageReplyMarkup;
  const _answerCallbackQuery = deps.answerCallbackQuery ?? answerCallbackQuery;
```

- [ ] **Step 4: Add `handleCallbackQuery` branch**

Insert into `runHandler`, immediately after the `const msg = update.message; if (!msg) return;` block, replace:

```js
  const msg = update.message;
  if (!msg) return;
```

with:

```js
  const cq = update.callback_query;
  if (cq) {
    return handleCallbackQuery({
      cq, env, _sendReply, _editMessageReplyMarkup, _answerCallbackQuery,
      _loadAllowedUsers, _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
      _fetchTender, _extractSnapshot,
    });
  }

  const msg = update.message;
  if (!msg) return;
```

Then add the `handleCallbackQuery` function at the bottom of the file (before the helper `applyMutationWithRetry`):

```js
const TENDER_ID_RE = /^UA-\d{4}-\d{2}-\d{2}-\d{6}-[a-zA-Z]$/;

async function handleCallbackQuery({
  cq, env, _sendReply, _editMessageReplyMarkup, _answerCallbackQuery,
  _loadAllowedUsers, _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
  _fetchTender, _extractSnapshot,
}) {
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const chatId = String(cq.message?.chat?.id ?? '');
  const messageId = cq.message?.message_id;
  const isAdmin = chatId !== '' && chatId === adminChatId;

  let isInvited = false;
  if (!isAdmin) {
    try {
      const { users } = await _loadAllowedUsers(env);
      isInvited = users.some(u => u.chat_id === chatId);
    } catch (err) {
      console.error('worker: callback loadAllowedUsers failed:', err.message);
    }
  }
  const isAllowed = isAdmin || isInvited;

  const ack = (text, showAlert = false) => _answerCallbackQuery({
    token: env.TELEGRAM_BOT_TOKEN, callbackQueryId: cq.id, text, showAlert,
  });

  if (!isAllowed) {
    await ack('🚫 Доступ заборонено', true);
    return;
  }

  const data = String(cq.data ?? '');
  if (data === 'noop') { await ack(); return; }

  if (data.startsWith('add:')) {
    const tenderId = data.slice(4);
    if (!TENDER_ID_RE.test(tenderId)) {
      await ack('❌ Невалідний tender_id');
      return;
    }
    // Add path implemented in next task — for now stub to avoid compile errors.
    await ack('TODO');
    return;
  }

  await ack('❓ Невідома кнопка');
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
node --test worker/test/handler.test.mjs
```
Expected: All 4 new tests PASS (unauthorized, noop, unknown, invalid tender_id — the regex catches `add:not-a-tender` before reaching the stub).

If any pre-existing handler test fails, fix the `runHandler` early-return shape — `update.message` path must continue to work as before.

- [ ] **Step 6: Commit**

```
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: callback_query routing — unauthorized, noop, invalid-data paths"
```

---

## Task 6: Worker callback_query — successful add path

**Files:**
- Modify: `worker/src/handler.mjs` (replace TODO stub in `handleCallbackQuery`)
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `worker/test/handler.test.mjs`:

```js
test('runHandler: callback_query "add:UA-…" success → handleAdd, edit keyboard to ✅, toast', async () => {
  const acks = [];
  const edits = [];
  const saved = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
        saveWatchlist: async (env, wl) => { saved.push(wl); },
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  // Add happened
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].tender_id, ID);
  // Keyboard swapped
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 42);
  assert.equal(edits[0].chatId, '123');
  assert.match(JSON.stringify(edits[0].replyMarkup), /✅ Додано/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /"callback_data":"noop"/);
  // Toast
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /додано/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test worker/test/handler.test.mjs
```
Expected: new test fails (currently TODO stub).

- [ ] **Step 3: Implement add success path**

Replace in `handleCallbackQuery`:

```js
    // Add path implemented in next task — for now stub to avoid compile errors.
    await ack('TODO');
    return;
```

with:

```js
    const result = await applyMutationWithRetry({
      env,
      loadWatchlist: _loadWatchlist,
      saveWatchlist: _saveWatchlist,
      computeMutation: async ({ watchlist }) => {
        let archive = [];
        try { ({ archive } = await _loadArchivedTenders(env)); } catch {}
        return handleAdd({
          watchlist, archive,
          fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
        }, { tender_id: tenderId, notes: null });
      },
    });
    await onAddResult({ result, tenderId, chatId, messageId, env, _editMessageReplyMarkup, ack });
    return;
```

Add helper function at bottom of `worker/src/handler.mjs`:

```js
async function onAddResult({ result, tenderId, chatId, messageId, env, _editMessageReplyMarkup, ack }) {
  // result is the reply string from applyMutationWithRetry. Parse intent from prefix.
  const time = formatKyivTime(new Date());
  if (typeof result === 'string' && /^✅/.test(result)) {
    await safeEditKeyboard(_editMessageReplyMarkup, env, chatId, messageId, `✅ Додано ${time}`);
    await ack(`✅ ${tenderId} додано у watchlist`);
    return;
  }
  if (typeof result === 'string' && /Вже моніторю/.test(result)) {
    await safeEditKeyboard(_editMessageReplyMarkup, env, chatId, messageId, `ℹ️ Вже додано`);
    await ack('ℹ️ Вже моніторю');
    return;
  }
  if (typeof result === 'string' && /архівована/i.test(result)) {
    await safeEditKeyboard(_editMessageReplyMarkup, env, chatId, messageId, `📦 В архіві`);
    await ack('📦 Тендер в архіві');
    return;
  }
  // GitHub conflict / network / generic error → keep keyboard, surface error in toast.
  await ack(typeof result === 'string' ? result : '⚠️ Помилка', true);
}

async function safeEditKeyboard(_edit, env, chatId, messageId, label) {
  try {
    await _edit({
      token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      replyMarkup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] },
    });
  } catch (err) {
    console.error('worker: editMessageReplyMarkup failed:', err.message);
  }
}

function formatKyivTime(d) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test worker/test/handler.test.mjs
```
Expected: new test PASSES, all pre-existing PASS.

- [ ] **Step 5: Commit**

```
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: callback add path — handleAdd + swap keyboard to ✅ Додано"
```

---

## Task 7: Worker callback_query — already-in-watchlist + archive + GH-error edge cases

**Files:**
- Modify: nothing (logic from Task 6 already covers branches; we just verify with tests)
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Write the tests**

Append to `worker/test/handler.test.mjs`:

```js
test('runHandler: callback add when tender already in watchlist → keyboard ℹ️ Вже додано, toast', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 'sha1' }),
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].replyMarkup), /Вже додано/);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /Вже моніторю/);
});

test('runHandler: callback add when tender in archive → keyboard 📦 В архіві, toast', async () => {
  const acks = [];
  const edits = [];
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
        loadArchivedTenders: async () => ({ archive: [{ tender_id: ID }], sha: null }),
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(edits[0].replyMarkup), /В архіві/);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /архів/i);
});

test('runHandler: callback add when GitHub conflict → keyboard NOT edited, error toast', async () => {
  const acks = [];
  const edits = [];
  // Simulate persistent ConflictError to exhaust retries
  const { ConflictError } = await import('../src/github.mjs');
  await runHandler({
    update: {
      callback_query: {
        id: 'cbq1', data: `add:${ID}`,
        message: { chat: { id: 123 }, message_id: 42 },
      },
    },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [], sha: 'sha1' }),
        saveWatchlist: async () => { throw new ConflictError('409'); },
      }).deps,
      answerCallbackQuery: async (a) => acks.push(a),
      editMessageReplyMarkup: async (a) => edits.push(a),
    },
  });
  assert.equal(edits.length, 0, 'keyboard should NOT be edited on error');
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /спробуй за хвилину/i);
});
```

- [ ] **Step 2: Run tests**

```
node --test worker/test/handler.test.mjs
```
Expected: All 3 PASS (logic from Task 6 already routes these). If any fails, refine the regex matching in `onAddResult` to align with actual `handleAdd` reply strings — re-read `commands.mjs` `handleAdd` to confirm its exact reply text and update the regex.

- [ ] **Step 3: Run full suite**

```
node --test
```
Expected: ALL tests pass.

- [ ] **Step 4: Commit**

```
git add worker/test/handler.test.mjs
git commit -m "worker: tests — callback edge cases (already-watched, archived, GH error)"
```

---

## Task 8: Manual smoke test + deploy

**Files:** none (deploy + verify)

- [ ] **Step 1: Verify worker can be deployed locally**

```
cd worker
npx wrangler deploy --dry-run
```
Expected: dry-run succeeds; no syntax errors.

- [ ] **Step 2: Push to main, let GitHub Actions deploy**

```
git push origin main
```

Watch the `worker-deploy` workflow run. Expected: success in ~30 sec.

```
curl -s "https://api.github.com/repos/avp-terralab/tender-monitor/actions/workflows/worker-deploy.yml/runs?per_page=1" | grep -E '"status":|"conclusion":'
```

- [ ] **Step 3: Trigger monitor workflow_dispatch with a fresh entity-watch alert in the pipe**

Either:
- Wait for next hourly tick to surface a new tender from a watched entity, or
- Add a new EDRPOU via `/watch <code>` for an entity that you know has a freshly active tender, then trigger workflow_dispatch.

In Telegram, verify:
- Digest message arrives with `➕ Додати в моніторинг UA-…` button below the entity-watch block.
- Tap the button → spinner → toast `✅ … додано у watchlist` → button text changes to `✅ Додано HH:MM`.
- Re-tap (now disabled `noop`) → no visible action, no spinner.

- [ ] **Step 4: Verify state**

```
curl -s https://raw.githubusercontent.com/avp-terralab/tender-monitor/main/watchlist.json | jq '.[] | select(.tender_id=="UA-…")'
```
Expected: tender appears in watchlist.

- [ ] **Step 5: Final commit (no code change — just close out)**

If smoke test reveals issues, fix them inline before this step. If clean, no further commit needed.

---

## Self-review notes

- **Spec coverage:** ✅ Every section (architecture, components, edge cases, testing) is implemented across Tasks 1–8.
- **Type/name consistency:** `addButtonsForTenders` (option key), `add:UA-…` (callback_data), `noop` (disabled-button data), `handleCallbackQuery` (function name) — used consistently.
- **No placeholders:** All steps contain runnable code/commands. The "TODO" stub in Task 5 is intentional — replaced by real impl in Task 6.
- **Bite-sized:** Each step is one action; tasks deliver a single coherent change with passing tests + commit.
