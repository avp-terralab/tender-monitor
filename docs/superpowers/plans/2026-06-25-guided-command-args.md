# Guided Command-Argument Input (Feature C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bare `/add` `/remove` `/watch` `/unarchive` (or an invalid arg) reply with a `force_reply` prompt + placeholder instead of a dry error; the user's reply (via `reply_to_message`) is parsed as the command's argument; invalid → re-prompt.

**Architecture:** Pure helpers in `commands.mjs` (`buildArgPrompt`, `commandFromReplyPrompt`); the worker rewrites a reply-to-a-prompt into `/<cmd> <text>` before parsing, and replaces the dry-error branch of each of the 4 commands with a `force_reply` prompt. Stateless — the reply carries the command context.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Cloudflare Worker, Telegram Bot API (`force_reply`).

**Spec:** `docs/superpowers/specs/2026-06-25-guided-command-args-design.md`

**Baseline:** `node --test test/commands.test.mjs` = 376 pass; `node --test worker/test/handler.test.mjs` = 181 pass. All 0 fail.

---

## File Structure

- `commands.mjs` — **Modify.** Add `ARG_REPLY_SPECS` (private), `buildArgPrompt(cmd, {retry})`, `commandFromReplyPrompt(replyText)` after the `parseCommand` function.
- `worker/src/handler.mjs` — **Modify.** Import the two helpers; add `let forceReplyMarkup = null;`; rewrite the reply-to-prompt into a command before `parseCommand`; replace the error branch of each of `add`/`remove`/`watch`/`unarchive` with a prompt; add `forceReplyMarkup` to the send-markup chain.
- `test/commands.test.mjs`, `worker/test/handler.test.mjs` — **Modify.** Tests.

**Commands:** `node --test test/commands.test.mjs` · `node --test worker/test/handler.test.mjs`

**Harness facts:** handler `ENV.ADMIN_CHAT_ID = '123'` (chat 123 = admin/editor); `makeDeps(overrides)`; default `sendReply` returns undefined. A viewer is made by overriding `loadAllowedUsers` to return that chat with `role:'viewer'`. `commandFromReplyPrompt` matches by the per-command `core` substring, so a test can set `reply_to_message.text` to the literal core (e.g. `'додати в моніторинг'`) without importing the prompt.

---

## Task 1: Pure helpers — buildArgPrompt + commandFromReplyPrompt

**Files:** Modify `commands.mjs` (after the `parseCommand` function) · Test `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `buildArgPrompt, commandFromReplyPrompt` to the top import in `test/commands.test.mjs`, and append:

```javascript
test('buildArgPrompt: add → force_reply prompt + UA placeholder', () => {
  const p = buildArgPrompt('add');
  assert.match(p.text, /додати в моніторинг/);
  assert.equal(p.replyMarkup.force_reply, true);
  assert.match(p.replyMarkup.input_field_placeholder, /^UA-/);
  assert.ok(!p.text.startsWith('❌'));
});

test('buildArgPrompt: watch → ЄДРПОУ prompt + 8-digit placeholder', () => {
  const p = buildArgPrompt('watch');
  assert.match(p.text, /ЄДРПОУ замовника/);
  assert.equal(p.replyMarkup.input_field_placeholder, '12345678');
});

test('buildArgPrompt: retry → ❌ prefix kept with the core', () => {
  const p = buildArgPrompt('add', { retry: true });
  assert.match(p.text, /^❌ Невірний формат\./);
  assert.match(p.text, /додати в моніторинг/);
});

test('buildArgPrompt: unknown command → null', () => {
  assert.equal(buildArgPrompt('info'), null);
});

test('commandFromReplyPrompt: recognizes each prompt (incl. retry); null otherwise', () => {
  assert.equal(commandFromReplyPrompt(buildArgPrompt('add').text), 'add');
  assert.equal(commandFromReplyPrompt(buildArgPrompt('add', { retry: true }).text), 'add');
  assert.equal(commandFromReplyPrompt(buildArgPrompt('remove').text), 'remove');
  assert.equal(commandFromReplyPrompt(buildArgPrompt('watch').text), 'watch');
  assert.equal(commandFromReplyPrompt(buildArgPrompt('unarchive').text), 'unarchive');
  assert.equal(commandFromReplyPrompt('щось стороннє'), null);
  assert.equal(commandFromReplyPrompt(123), null);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `buildArgPrompt is not a function`.

- [ ] **Step 3: Implement in `commands.mjs`** (immediately after the `parseCommand` function)

```javascript
// Guided argument prompts. Commands that need an argument (/add, /remove, /watch,
// /unarchive) reply with a force_reply prompt instead of a dry error; the user's
// reply is then parsed as the argument. `core` is a stable phrase used to map a
// reply's reply_to_message text back to its command (survives the retry prefix).
const ARG_REPLY_SPECS = {
  add:       { core: 'додати в моніторинг',   prompt: '➕ Надішли tender_id, який додати в моніторинг (UA-…):',   placeholder: 'UA-2026-06-19-008800-a' },
  remove:    { core: 'прибрати з моніторингу', prompt: '🗑 Надішли tender_id, який прибрати з моніторингу (UA-…):', placeholder: 'UA-2026-06-19-008800-a' },
  watch:     { core: 'ЄДРПОУ замовника',       prompt: '👁 Надішли ЄДРПОУ замовника (8 цифр):',                    placeholder: '12345678' },
  unarchive: { core: 'повернути з архіву',     prompt: '↩️ Надішли tender_id, який повернути з архіву (UA-…):',    placeholder: 'UA-2026-06-19-008800-a' },
};

// { text, replyMarkup } for a guided prompt, or null for a non-guided command.
// retry → prepend an error note (the core phrase stays, so the reply still maps back).
export function buildArgPrompt(cmd, { retry = false } = {}) {
  const spec = ARG_REPLY_SPECS[cmd];
  if (!spec) return null;
  return {
    text: (retry ? '❌ Невірний формат. ' : '') + spec.prompt,
    replyMarkup: { force_reply: true, input_field_placeholder: spec.placeholder },
  };
}

// Maps a reply's reply_to_message text back to the command it was prompting for,
// or null. Matches by the per-command core phrase (substring).
export function commandFromReplyPrompt(replyText) {
  if (typeof replyText !== 'string') return null;
  for (const [cmd, spec] of Object.entries(ARG_REPLY_SPECS)) {
    if (replyText.includes(spec.core)) return cmd;
  }
  return null;
}
```

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test test/commands.test.mjs`
Expected: PASS (376 + 5 = 381).

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(commands): guided arg prompt helpers (buildArgPrompt, commandFromReplyPrompt)"
```

---

## Task 2: Worker — rewrite reply, prompt instead of error

**Files:** Modify `worker/src/handler.mjs` (commands import; line 156 parse; accumulators ~158-162; the 4 command branches at ~229/251/420/570; send-chain ~670) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/handler.test.mjs`:

```javascript
test('runHandler: bare /add (editor) → force_reply prompt, no mutation', async () => {
  const sent = []; let saved = false;
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 5, text: '/add', from: { id: 123 } } },
    env: ENV,
    deps: { ...makeDeps({ saveWatchlist: async () => { saved = true; } }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(saved, false, 'no mutation on a bare /add');
  assert.match(sent[0].text, /додати в моніторинг/);
  assert.match(JSON.stringify(sent[0].replyMarkup), /"force_reply":true/);
});

test('runHandler: reply to the add-prompt with a valid UA → add happens', async () => {
  let saved = null;
  await runHandler({
    update: { message: {
      chat: { id: 123 }, message_id: 6, from: { id: 123 },
      text: 'UA-2026-06-19-008800-a',
      reply_to_message: { text: 'додати в моніторинг' },
    } },
    env: ENV,
    deps: { ...makeDeps({
      loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
      saveWatchlist: async (_e, wl) => { saved = wl; },
      fetchTender: async () => ({ data: { status: 'active.tendering', tenderPeriod: {}, procuringEntity: { name: 'X' } } }),
      loadArchivedTenders: async () => ({ archive: [], sha: null }),
    }).deps },
  });
  assert.ok(saved, 'watchlist saved → the reply was treated as the /add argument');
});

test('runHandler: reply to the add-prompt with invalid text → retry prompt, no mutation', async () => {
  const sent = []; let saved = false;
  await runHandler({
    update: { message: {
      chat: { id: 123 }, message_id: 7, from: { id: 123 },
      text: 'абищо',
      reply_to_message: { text: 'додати в моніторинг' },
    } },
    env: ENV,
    deps: { ...makeDeps({ saveWatchlist: async () => { saved = true; } }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(saved, false);
  assert.match(sent[0].text, /❌ Невірний формат/);
  assert.match(JSON.stringify(sent[0].replyMarkup), /"force_reply":true/);
});

test('runHandler: bare /add (non-editor) → permission message, no prompt', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 456 }, message_id: 8, text: '/add', from: { id: 456 } } },
    env: ENV,
    deps: { ...makeDeps({ loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }) }).deps, sendReply: async (a) => sent.push(a) },
  });
  assert.match(sent[0].text, /редакторів/);
  assert.ok(!JSON.stringify(sent[0].replyMarkup ?? {}).includes('force_reply'));
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — bare `/add` still returns the dry `❌ Не вказано tender_id` (no force_reply); the reply-to-prompt update is parsed as plain text, not `/add`.

- [ ] **Step 3: Implement**

3a. In the commands import block (`worker/src/handler.mjs`, the line starting `  parseCommand, handleAdd, ...`), add the two helpers (e.g. on that first line):
```javascript
  parseCommand, buildArgPrompt, commandFromReplyPrompt, handleAdd, handleStatus, handleRemove,
```

3b. Replace `const cmd = parseCommand(msg.text);` (line ~156) with:
```javascript
  // A reply to a guided "send me the <arg>" prompt → treat the reply text as that
  // command's argument (stateless; reply_to_message carries the command context).
  const replyCmd = msg.reply_to_message
    ? commandFromReplyPrompt(msg.reply_to_message.text)
    : null;
  const cmd = parseCommand(replyCmd ? `/${replyCmd} ${msg.text}` : msg.text);
```

3c. Add the accumulator next to the others (after `let monitorReplyMarkup = null;`, ~line 162):
```javascript
  let forceReplyMarkup = null;
```

3d. In the `cmd.cmd === 'add'` branch, replace the two error lines:
```javascript
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /add UA-YYYY-MM-DD-NNNNNN-x';
    } else {
```
with:
```javascript
    if (cmd.error) {
      const p = buildArgPrompt('add', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
```

3e. In the `cmd.cmd === 'remove'` branch, replace:
```javascript
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: /remove UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /remove UA-YYYY-MM-DD-NNNNNN-x';
    } else {
```
with:
```javascript
    if (cmd.error) {
      const p = buildArgPrompt('remove', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
```

3f. In the `cmd.cmd === 'watch'` branch, replace:
```javascript
    if (cmd.error === 'invalid_edrpou') {
      reply = '❌ ЄДРПОУ має бути 8 цифр';
    } else if (cmd.error === 'missing_edrpou') {
      reply = '❌ Не вказано ЄДРПОУ. /watch 12345678';
    } else {
```
with:
```javascript
    if (cmd.error) {
      const p = buildArgPrompt('watch', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
```

3g. In the `cmd.cmd === 'unarchive'` branch, replace:
```javascript
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: /unarchive UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /unarchive UA-YYYY-MM-DD-NNNNNN-x';
    } else {
```
with:
```javascript
    if (cmd.error) {
      const p = buildArgPrompt('unarchive', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
```

3h. In the send-markup chain (~line 670), add `forceReplyMarkup` at the FRONT of the `??` chain:
```javascript
          ? (forceReplyMarkup ?? archiveReplyMarkup ?? agentReplyMarkup ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
```

- [ ] **Step 4: Run — confirm PASS (both suites)**

Run: `node --test worker/test/handler.test.mjs` → 181 + 4 = 185, 0 fail. Existing tests pass unchanged: a direct valid `/add UA-…` has no `cmd.error`, so it takes the `else` (work) branch; non-reply messages have `replyCmd === null`, so `parseCommand(msg.text)` is unchanged.
Run: `node --test test/commands.test.mjs` → 381, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(commands): guided force_reply prompts for /add /remove /watch /unarchive"
```

---

## Self-Review

**Spec coverage:**
- `ARG_REPLY_SPECS` (4 cmds, core/prompt/placeholder) + `buildArgPrompt` + `commandFromReplyPrompt` → Task 1 ✓
- Reply-to-prompt rewrite (`/<cmd> <text>`) before parse → Task 2 step 3b ✓
- Prompt instead of dry error for the 4 commands, retry on invalid → Task 2 steps 3d-3g (`retry: cmd.error.startsWith('invalid')` covers invalid_id AND invalid_edrpou) ✓
- `forceReplyMarkup` accumulator + send-chain priority → Task 2 steps 3c, 3h ✓
- Permission unchanged (non-editor → 🚫, no prompt) → the MUTATING/!isEditor check precedes the command branches; test covers it ✓
- `/info`/`/archive`/`/watched` untouched → not in scope; only the 4 branches changed ✓

**Placeholder scan:** every step has full code; no TBD.

**Type consistency:** `buildArgPrompt(cmd, {retry})` → `{text, replyMarkup}` and `commandFromReplyPrompt(text)` signatures identical across Task 1 def, Task 1 tests, Task 2 handler, Task 2 tests; the `core` phrases in `ARG_REPLY_SPECS` match the literals used in the handler tests' `reply_to_message.text`; `forceReplyMarkup` name consistent (decl ↔ 4 branches ↔ send-chain).
