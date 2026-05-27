# Unwatch-via-button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let editors/admins stop watching a procuring entity by tapping a 🗑 button on the `/watched` list, and remove the `/unwatch` command.

**Architecture:** `/watched` keeps its text list; for editor/admin the handler attaches an inline keyboard (one 🗑 button per entity, `callback_data: "unwatch:<edrpou>"`). A new `unwatch:` callback branch in `handleCallbackQuery` runs a self-contained load→mutate→save→refresh loop (mirroring the existing `notify:` callback), threading the same `unwatch` audit message, and refreshes the message in place via a new `editMessageText` Telegram primitive. The `/unwatch` command is retired to a hint.

**Tech Stack:** Node.js (ESM, built-ins only), `node:test`, Cloudflare Worker, Telegram Bot API. Pure logic in `commands.mjs`, Telegram I/O in `telegram.mjs`, dispatch in `worker/src/handler.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-27-unwatch-button-design.md`

**Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Run tests:** `node --test test/*.test.mjs worker/test/*.test.mjs` (or a single file as shown per task).

---

## File Structure

- `telegram.mjs` — add `editMessageText` (mirrors existing `editMessageReplyMarkup`).
- `commands.mjs` — add `buildWatchedKeyboard` (pure); retire `/unwatch` in `parseCommand`, `HELP_EDIT_ENTITIES`, `EDIT_COMMANDS`. `handleWatched`/`handleUnwatch` unchanged (reused).
- `worker/src/handler.mjs` — `/watched` attaches keyboard for editor/admin; `unwatch:` callback branch + thread `_loadWatchedEntities`/`_saveWatchedEntities`/`_editMessageText` into `handleCallbackQuery`; `/unwatch` → hint.
- Tests: `test/telegram.test.mjs`, `test/commands.test.mjs`, `worker/test/handler.test.mjs`.

---

## Task 1: `editMessageText` primitive in telegram.mjs

**Files:**
- Modify: `telegram.mjs` (add after `editMessageReplyMarkup`)
- Test: `test/telegram.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `test/telegram.test.mjs` (import `editMessageText` alongside the existing telegram imports at the top of the file — check the existing import block and add it there):

```js
test('editMessageText: posts text + reply_markup to editMessageText endpoint', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  await editMessageText({
    token: 'T', chatId: 42, messageId: 7,
    text: 'hello', replyMarkup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] },
    fetch: fakeFetch,
  });
  assert.match(captured.url, /\/botT\/editMessageText$/);
  const params = captured.body; // URLSearchParams
  assert.equal(params.get('chat_id'), '42');
  assert.equal(params.get('message_id'), '7');
  assert.equal(params.get('text'), 'hello');
  assert.match(params.get('reply_markup'), /inline_keyboard/);
});

test('editMessageText: omits reply_markup when not provided', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = opts.body;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await editMessageText({ token: 'T', chatId: 1, messageId: 2, text: 'hi', fetch: fakeFetch });
  assert.equal(captured.get('reply_markup'), null);
});

test('editMessageText: throws on non-ok HTTP', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  await assert.rejects(
    () => editMessageText({ token: 'T', chatId: 1, messageId: 2, text: 'x', fetch: fakeFetch }),
    /400/,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL — `editMessageText` is not exported / not a function.

- [ ] **Step 3: Implement**

In `telegram.mjs`, immediately AFTER the existing `editMessageReplyMarkup` function, add (mirror its structure exactly — same error-handling shape):

```js
export async function editMessageText({ token, chatId, messageId, text, replyMarkup, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const params = new URLSearchParams({
    chat_id: String(chatId),
    message_id: String(messageId),
    text: String(text),
    parse_mode: 'HTML',
  });
  if (replyMarkup != null) params.set('reply_markup', JSON.stringify(replyMarkup));
  const res = await fetchImpl(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Telegram editMessageText ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram editMessageText: ${json.description ?? 'unknown'}`);
  return json;
}
```

> Note: `parse_mode: 'HTML'` matches how `sendReply` renders the `/watched` text (which uses `escapeHtml` on entity names). Confirm `sendReply` in this file uses `parse_mode: 'HTML'`; if it uses a different mode, match that instead so the refreshed text renders identically to the original.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/telegram.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add telegram.mjs test/telegram.test.mjs
git commit -m "telegram: add editMessageText primitive"
```

---

## Task 2: `buildWatchedKeyboard` (pure) in commands.mjs

**Files:**
- Modify: `commands.mjs` (add right after `handleWatched`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `buildWatchedKeyboard` to the commands import block at the top of `test/commands.test.mjs`, then:

```js
test('buildWatchedKeyboard: one 🗑 row per entity with unwatch: callback_data', () => {
  const kb = buildWatchedKeyboard([
    { edrpou: '12345678', name: 'КОМУНАЛЬНЕ НЕКОМЕРЦІЙНЕ ПІДПРИЄМСТВО "ЛІКАРНЯ №1"', enabled: true },
    { edrpou: '01999106', name: '(unknown)', enabled: true },
  ]);
  assert.equal(kb.inline_keyboard.length, 2);
  const [row1, row2] = kb.inline_keyboard;
  assert.equal(row1[0].callback_data, 'unwatch:12345678');
  assert.match(row1[0].text, /^🗑 12345678 — /);
  assert.equal(row2[0].callback_data, 'unwatch:01999106');
  // name === '(unknown)' → no " — name" suffix, just the ЄДРПОУ
  assert.equal(row2[0].text, '🗑 01999106');
});

test('buildWatchedKeyboard: empty list → null', () => {
  assert.equal(buildWatchedKeyboard([]), null);
  assert.equal(buildWatchedKeyboard(null), null);
});

test('buildWatchedKeyboard: long name truncated in button label', () => {
  const longName = 'А'.repeat(200);
  const kb = buildWatchedKeyboard([{ edrpou: '12345678', name: longName, enabled: true }]);
  assert.ok(kb.inline_keyboard[0][0].text.length < 80);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `buildWatchedKeyboard` not a function.

- [ ] **Step 3: Implement**

In `commands.mjs`, immediately AFTER `handleWatched` (which ends around the `return rows.join('\n\n') + ...` line), add. `abbreviateLegalForm` and `truncate` are already defined/in-scope in this module (used by `handleWatched`):

```js
// Inline keyboard for /watched — one 🗑 delete button per watched entity.
// Rendered only for editor/admin (handler decides). Button text is plain
// (Telegram does not HTML-parse button labels), so no escapeHtml here.
export function buildWatchedKeyboard(watchedEntities) {
  if (!watchedEntities || watchedEntities.length === 0) return null;
  return {
    inline_keyboard: watchedEntities.map(e => {
      const name = e.name && e.name !== '(unknown)'
        ? ` — ${truncate(abbreviateLegalForm(e.name), 40)}`
        : '';
      return [{ text: `🗑 ${e.edrpou}${name}`, callback_data: `unwatch:${e.edrpou}` }];
    }),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: add buildWatchedKeyboard for /watched delete buttons"
```

---

## Task 3: Retire `/unwatch` command (parser + help + command list)

**Files:**
- Modify: `commands.mjs` — `parseCommand` (the `/unwatch` block), `HELP_EDIT_ENTITIES`, `EDIT_COMMANDS`
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('parseCommand: /unwatch (any args) → unwatch_removed', () => {
  assert.deepEqual(parseCommand('/unwatch'), { cmd: 'unwatch_removed' });
  assert.deepEqual(parseCommand('/unwatch 12345678'), { cmd: 'unwatch_removed' });
  assert.deepEqual(parseCommand('/unwatch@terralab_tenders_bot 12345678'), { cmd: 'unwatch_removed' });
});

test('buildHelpText: editor help no longer mentions /unwatch', () => {
  assert.doesNotMatch(buildHelpText('editor'), /\/unwatch/);
  assert.doesNotMatch(buildHelpText('admin'), /\/unwatch/);
});

test('BOT_COMMANDS_BY_ROLE: no role lists unwatch', () => {
  for (const set of Object.values(BOT_COMMANDS_BY_ROLE)) {
    assert.ok(!set.some(c => c.command === 'unwatch'));
  }
});
```

(Ensure `buildHelpText` and `BOT_COMMANDS_BY_ROLE` are imported in the test file — they are used by existing tests, so the imports already exist.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `/unwatch` still parses to `{ cmd: 'unwatch', edrpou }`; help/commands still contain unwatch.

- [ ] **Step 3: Implement**

(a) In `parseCommand`, REPLACE the entire `/unwatch` block:

```js
  const unwatchMatch = trimmed.match(/^\/unwatch(?:@\w+)?(?:\s+(.*))?$/i);
  if (unwatchMatch) {
    const args = (unwatchMatch[1] || '').trim();
    if (!args) return { cmd: 'unwatch', error: 'missing_edrpou' };
    if (!EDRPOU_RE.test(args)) return { cmd: 'unwatch', error: 'invalid_edrpou' };
    return { cmd: 'unwatch', edrpou: args };
  }
```

with:

```js
  if (/^\/unwatch(?:@\w+)?(?:\s+.*)?$/i.test(trimmed)) {
    return { cmd: 'unwatch_removed' };
  }
```

(b) In `HELP_EDIT_ENTITIES`, remove the `/unwatch` line so it reads:

```js
const HELP_EDIT_ENTITIES = [
  '/watch ЄДРПОУ — стежити за замовником',
];
```

(c) In `EDIT_COMMANDS`, remove the `unwatch` entry so it reads:

```js
const EDIT_COMMANDS = [
  { command: 'add',       description: 'Додати тендер у моніторинг' },
  { command: 'remove',    description: 'Видалити тендер' },
  { command: 'watch',     description: 'Стежити за замовником (ЄДРПОУ)' },
  { command: 'unarchive', description: 'Видалити тендер з архіву' },
];
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS. (If any pre-existing test asserted the old `/unwatch` parse result, update it to expect `unwatch_removed` — search the test file for `cmd: 'unwatch'` and fix those that test the command parse; do NOT touch `handleUnwatch` tests, which still exercise the reused mutation function directly.)

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: retire /unwatch command (parser, help, command list)"
```

---

## Task 4: `/watched` attaches keyboard for editor/admin; `/unwatch` hint

**Files:**
- Modify: `worker/src/handler.mjs` — import `buildWatchedKeyboard`; add a `watchedReplyMarkup` slot; `/watched` branch; replace `/unwatch` branch with `unwatch_removed` hint
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `worker/test/handler.test.mjs` (reuse existing `makeDeps`, `runHandler`, `ENV`; admin chat is `123`). Add:

```js
const WATCHED_TWO = [
  { edrpou: '12345678', name: 'КНП «Лікарня №1»', enabled: true },
  { edrpou: '01999106', name: 'ТОВ «TERRALAB IT»', enabled: true },
];

test('runHandler: /watched attaches inline unwatch keyboard for admin/editor', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  const kb = sent[0].replyMarkup;
  assert.ok(kb && kb.inline_keyboard, 'has inline_keyboard');
  assert.equal(kb.inline_keyboard.length, 2);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'unwatch:12345678');
});

test('runHandler: /watched for viewer has NO inline unwatch keyboard', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  const kb = sent[0].replyMarkup;
  // viewer gets the persistent MAIN_KEYBOARD (or undefined) — never an inline_keyboard
  assert.ok(!kb || !kb.inline_keyboard, 'no inline_keyboard for viewer');
});

test('runHandler: /watched empty list → no inline keyboard even for admin', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  const kb = sent[0].replyMarkup;
  assert.ok(!kb || !kb.inline_keyboard);
});

test('runHandler: /unwatch command → hint pointing to /watched', async () => {
  const { deps, sent } = makeDeps({});
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/unwatch 12345678', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/watched/);
  assert.match(sent[0].text, /🗑/);
});
```

> Before running, confirm the test helper's captured `sent[i]` object exposes `replyMarkup` (the existing `add:`/digest tests assert on reply markup — mirror however they read it; if the field is named differently, adjust the assertions). Confirm `makeDeps` default `loadWatchedEntities` exists (the `/watch` tests use it).

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `/watched` currently sends no inline keyboard; `/unwatch` still runs the mutation path (no hint).

- [ ] **Step 3: Implement**

(a) Add `buildWatchedKeyboard` to the `../../commands.mjs` import block in `handler.mjs` (the block that already imports `handleWatch, handleUnwatch, handleWatched`).

(b) Near the existing `let notifyReplyMarkup = null;` declaration in `runHandler`, add:

```js
  let watchedReplyMarkup = null;
```

(c) Replace the `/watched` branch body so it attaches the keyboard for editor/admin:

```js
  } else if (cmd.cmd === 'watched') {
    try {
      const { entities } = await _loadWatchedEntities(env);
      reply = handleWatched({ watchedEntities: entities });
      if (isEditor) watchedReplyMarkup = buildWatchedKeyboard(entities);
    } catch (err) {
      console.error('worker: /watched failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  }
```

(`isEditor` is already in scope in `runHandler`; for admin it is true. `buildWatchedKeyboard` returns `null` for an empty list, leaving `watchedReplyMarkup` null.)

(d) Replace the entire `/unwatch` dispatch branch (`} else if (cmd.cmd === 'unwatch') { ... }`) with:

```js
  } else if (cmd.cmd === 'unwatch_removed') {
    reply = 'ℹ️ Команду /unwatch прибрано. Відкрий /watched і тисни 🗑 біля замовника, щоб припинити стеження.';
  }
```

(e) In the send block at the bottom of `runHandler`, update the `replyMarkup` expression so the watched inline keyboard wins when set. Change:

```js
        replyMarkup: isLast
          ? (notifyReplyMarkup ?? (isAllowed ? MAIN_KEYBOARD : undefined))
          : undefined,
```

to:

```js
        replyMarkup: isLast
          ? (watchedReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? MAIN_KEYBOARD : undefined))
          : undefined,
```

(The inline keyboard replaces MAIN_KEYBOARD on this one message; MAIN_KEYBOARD is `is_persistent`, so the bottom keyboard stays from prior messages.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS. Then full suite `node --test test/*.test.mjs worker/test/*.test.mjs` — fix any pre-existing `/watched`/`/unwatch` handler test that assumed the old behavior.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "handler: /watched delete buttons for editors; /unwatch hint"
```

---

## Task 5: `unwatch:<edrpou>` callback branch

**Files:**
- Modify: `worker/src/handler.mjs` — import `editMessageText`, `buildWatchedKeyboard`, `applyEntityMutation`; add `_editMessageText` dep + thread `_loadWatchedEntities`/`_saveWatchedEntities`/`_editMessageText` into `handleCallbackQuery`; new `unwatch:` branch
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
const CB = (data, fromChatId = 123, from = { first_name: 'Андрій' }) => ({
  callback_query: { id: 'cq1', data, from, message: { chat: { id: fromChatId }, message_id: 9 } },
});

test('callback unwatch: removes entity, refreshes via editMessageText, audits, toast', async () => {
  let savedOpts, edited, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
    editMessageText: async (args) => { edited = args; },
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  // audit message
  assert.match(savedOpts.message, /^audit: unwatch 12345678 · Андрій \[123\/admin\]$/);
  // message refreshed with remaining entity + its keyboard
  assert.match(edited.text, /01999106/);
  assert.doesNotMatch(edited.text, /12345678/);
  assert.equal(edited.replyMarkup.inline_keyboard.length, 1);
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'unwatch:01999106');
  assert.match(acked.text, /Прибрано/);
});

test('callback unwatch: last entity → empty-state text, no keyboard', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [{ edrpou: '12345678', name: 'КНП', enabled: true }], sha: 's' }),
    saveWatchedEntities: async () => {},
    editMessageText: async (args) => { edited = args; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.match(edited.text, /Не стежу за жодним замовником/);
  assert.ok(edited.replyMarkup == null, 'no keyboard when list empty');
});

test('callback unwatch: double-tap (already gone) → "вже прибрано", no save', async () => {
  let saved = false, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [{ edrpou: '01999106', name: 'X', enabled: true }], sha: 's' }),
    saveWatchedEntities: async () => { saved = true; },
    editMessageText: async () => {},
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.equal(saved, false);
  assert.match(acked.text, /[Вв]же прибрано/);
});

test('callback unwatch: viewer rejected, no save', async () => {
  let saved = false, acked;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    saveWatchedEntities: async () => { saved = true; },
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:12345678', 456, { first_name: 'V' }), env: ENV, deps });
  assert.equal(saved, false);
  assert.match(acked.text, /редактор|🚫/);
});

test('callback unwatch: invalid edrpou → toast, no save', async () => {
  let saved = false, acked;
  const { deps } = makeDeps({
    saveWatchedEntities: async () => { saved = true; },
    answerCallbackQuery: async (args) => { acked = args; },
  });
  await runHandler({ update: CB('unwatch:abc'), env: ENV, deps });
  assert.equal(saved, false);
  assert.match(acked.text, /Невалідн/);
});
```

Also add `editMessageText: async () => {}` to the `makeDeps` DEFAULT deps (so callback tests that don't override it, and any unrelated test, don't crash).

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — no `unwatch:` callback branch (falls through to `❓ Невідома кнопка`); `savedOpts`/`edited` undefined.

- [ ] **Step 3: Implement**

(a) Imports in `handler.mjs`:
- Add `editMessageText` to the `telegram.mjs` import block (which already imports `editMessageReplyMarkup`, `answerCallbackQuery`).
- Add `buildWatchedKeyboard` (already added in Task 4) and `applyEntityMutation` to the `../../commands.mjs` import block. (Verify whether `applyEntityMutation` is already imported there; if yes, don't duplicate.)

(b) Deps injection — near the existing `const _editMessageReplyMarkup = deps.editMessageReplyMarkup ?? editMessageReplyMarkup;` line, add:

```js
  const _editMessageText = deps.editMessageText ?? editMessageText;
```

(c) Thread the three deps into the callback. At the `handleCallbackQuery({ ... })` call site in `runHandler`, add `_loadWatchedEntities, _saveWatchedEntities, _editMessageText`:

```js
    return handleCallbackQuery({
      cq, env, _editMessageReplyMarkup, _editMessageText, _answerCallbackQuery,
      _loadAllowedUsers, _saveAllowedUsers,
      _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
      _loadWatchedEntities, _saveWatchedEntities,
      _fetchTender, _extractSnapshot,
    });
```

And in the `handleCallbackQuery` parameter destructure, add the same three:

```js
async function handleCallbackQuery({
  cq, env, _editMessageReplyMarkup, _editMessageText, _answerCallbackQuery,
  _loadAllowedUsers, _saveAllowedUsers,
  _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
  _loadWatchedEntities, _saveWatchedEntities,
  _fetchTender, _extractSnapshot,
}) {
```

(d) New branch — insert AFTER the `if (data.startsWith('add:')) { ... }` block and BEFORE the final `await ack('❓ Невідома кнопка');`:

```js
  if (data.startsWith('unwatch:')) {
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    const edrpou = data.slice('unwatch:'.length);
    if (!/^\d{8}$/.test(edrpou)) {
      await ack('❌ Невалідний ЄДРПОУ');
      return;
    }
    const auditMessage = formatAuditMessage({ action: 'unwatch', target: edrpou, actor: actorName, chatId, role });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { entities, sha } = await _loadWatchedEntities(env);
        const { mutation } = handleUnwatch({ watchedEntities: entities }, { edrpou });
        let newEntities = entities;
        if (mutation) {
          newEntities = applyEntityMutation(entities, mutation);
          await _saveWatchedEntities(env, newEntities, sha, { message: auditMessage });
        }
        try {
          await _editMessageText({
            token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
            text: handleWatched({ watchedEntities: newEntities }),
            replyMarkup: buildWatchedKeyboard(newEntities) ?? undefined,
          });
        } catch (err) {
          console.error('worker: unwatch edit failed:', err.message);
        }
        await ack(mutation ? `✅ Прибрано ${edrpou}` : 'Вже прибрано');
        return;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        console.error('worker: unwatch callback failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
    }
    await ack('⚠️ Не зміг зберегти');
    return;
  }
```

(`formatAuditMessage`, `handleUnwatch`, `handleWatched`, `ConflictError` are already imported; `actorName`, `role`, `isEditor`, `ack`, `chatId`, `messageId` are already computed at the top of `handleCallbackQuery`.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS. Then full suite `node --test test/*.test.mjs worker/test/*.test.mjs` → no regression.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "handler: unwatch:<edrpou> callback removes entity + refreshes list"
```

---

## Task 6: Full suite, README, finish

**Files:** `README.md` (verification + small doc fix)

- [ ] **Step 1: Full suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: all pass. Investigate/fix any regression (esp. any test that asserted the old `/unwatch` command behavior or the old plain-text `/watched`).

- [ ] **Step 2: README**

In `README.md`, update the entity-monitoring line so it no longer advertises `/unwatch` as a command. Find the line listing `/watch <EDRPOU> / /unwatch / /watched` and change it to:

```
- `/watch <EDRPOU>` / `/watched` — стежити за всіма новими тендерами замовника. Прибрати замовника — кнопкою 🗑 у списку `/watched`.
```

(If the README on this branch differs from that exact text, adapt minimally — only the `/unwatch` mention needs to change.)

- [ ] **Step 3: Commit docs**

```bash
git add README.md
git commit -m "docs: /watched delete button replaces /unwatch command"
```

- [ ] **Step 4: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. Deployment note: merging to `main` triggers `worker-deploy.yml` (paths include `worker/**`, `commands.mjs`, `telegram.mjs`) → runs the suite, then deploys the Worker. The chat-scope command list (no longer listing `unwatch`) self-heals on the next `/start` or reply via `setMyCommands`.

---

## Self-Review Notes

- **Spec coverage:** variant-A layout (Task 4 keyboard + Task 1 editMessageText refresh), single-tap delete (Task 5), `/unwatch` retired → hint (Tasks 3+4), editor/admin-only buttons + viewer text-only (Task 4), defensive callback reject (Task 5), audit action `unwatch` preserved (Task 5), double-tap/last-entity/empty edge cases (Task 5), `editMessageText` primitive (Task 1), `buildWatchedKeyboard` (Task 2). All spec sections map to a task.
- **Type/name consistency:** `buildWatchedKeyboard(entities) → { inline_keyboard }|null`; `callback_data` is `unwatch:<edrpou>` everywhere; `watchedReplyMarkup` is the new send-slot name; `_editMessageText`/`editMessageText` follow the `deps.x ?? x` convention; `handleUnwatch`/`handleWatched`/`applyEntityMutation` reused unchanged.
- **No placeholders:** every code step shows full code.
- **Reused, not rebuilt:** `handleUnwatch` and `handleWatched` are untouched; the callback recomputes the post-mutation list locally via `applyEntityMutation` (no extra GitHub read), matching the spec.
