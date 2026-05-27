# `/watched` two-mode UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/watched` show a clean text list with a single «🗑 Прибрати замовника» button (VIEW mode); tapping it switches the message to a delete list (MANAGE mode), removing the current name/ЄДРПОУ duplication.

**Architecture:** Two modes of the one `/watched` message, toggled in place via `editMessageText`. Mode is encoded in `callback_data` (`watched:manage`, `watched:done`, existing `unwatch:<edrpou>`); every tap reloads fresh entities and re-renders. Pure keyboard builders live in `commands.mjs`; dispatch + callbacks in `worker/src/handler.mjs`.

**Tech Stack:** Node.js (ESM, built-ins only), `node:test`, Cloudflare Worker, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-05-27-watched-manage-mode-design.md`

**Baseline:** builds on the merged unwatch-button feature. Already present: `handleWatched` (text list), `buildWatchedKeyboard` (per-entity 🗑 rows → `unwatch:<edrpou>`), `editMessageText`, the `unwatch:` callback, `/watched` dispatch attaching `buildWatchedKeyboard` for editors.

**Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Run tests:** `node --test test/*.test.mjs worker/test/*.test.mjs`.

---

## File Structure

- `commands.mjs` — ADD `buildWatchedViewKeyboard`, `buildWatchedManageKeyboard`, `WATCHED_MANAGE_PROMPT`. `handleWatched` + `buildWatchedKeyboard` unchanged (reused).
- `worker/src/handler.mjs` — `/watched` dispatch uses the VIEW keyboard; ADD two render helpers + the `watched:manage` / `watched:done` callback branches; MODIFY the `unwatch:` callback's refresh to re-render MANAGE mode.
- Tests: `test/commands.test.mjs`, `worker/test/handler.test.mjs`.

---

## Task 1: VIEW/MANAGE keyboard builders + prompt (commands.mjs, pure)

**Files:**
- Modify: `commands.mjs` (add right AFTER `buildWatchedKeyboard`, which ends at the line `}` after its `return { inline_keyboard: … }`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `buildWatchedViewKeyboard, buildWatchedManageKeyboard, WATCHED_MANAGE_PROMPT` to the commands import block at the top of `test/commands.test.mjs`. Then:

```js
test('buildWatchedViewKeyboard: single "Прибрати" button → watched:manage', () => {
  const kb = buildWatchedViewKeyboard([{ edrpou: '12345678', name: 'КНП', enabled: true }]);
  assert.equal(kb.inline_keyboard.length, 1);
  assert.equal(kb.inline_keyboard[0].length, 1);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'watched:manage');
  assert.match(kb.inline_keyboard[0][0].text, /Прибрати/);
});

test('buildWatchedViewKeyboard: empty list → null', () => {
  assert.equal(buildWatchedViewKeyboard([]), null);
  assert.equal(buildWatchedViewKeyboard(null), null);
});

test('buildWatchedManageKeyboard: per-entity 🗑 rows + trailing Готово row', () => {
  const kb = buildWatchedManageKeyboard([
    { edrpou: '12345678', name: 'КНП «Лікарня №1»', enabled: true },
    { edrpou: '01999106', name: 'ТОВ «X»', enabled: true },
  ]);
  // 2 entity rows + 1 done row
  assert.equal(kb.inline_keyboard.length, 3);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'unwatch:12345678');
  assert.equal(kb.inline_keyboard[1][0].callback_data, 'unwatch:01999106');
  const doneRow = kb.inline_keyboard[2];
  assert.equal(doneRow[0].callback_data, 'watched:done');
  assert.match(doneRow[0].text, /Готово/);
});

test('buildWatchedManageKeyboard: empty list → null', () => {
  assert.equal(buildWatchedManageKeyboard([]), null);
  assert.equal(buildWatchedManageKeyboard(null), null);
});

test('WATCHED_MANAGE_PROMPT: exported non-empty string', () => {
  assert.equal(typeof WATCHED_MANAGE_PROMPT, 'string');
  assert.ok(WATCHED_MANAGE_PROMPT.length > 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — the three new symbols are not exported.

- [ ] **Step 3: Implement**

In `commands.mjs`, immediately AFTER the existing `buildWatchedKeyboard` function, add:

```js
// VIEW mode: /watched shows the text list + this single button. Tapping it
// switches the message into MANAGE mode (per-entity delete buttons).
export const WATCHED_MANAGE_PROMPT = '🗑 Кого прибрати? Тапни замовника. «← Готово» — вийти.';

export function buildWatchedViewKeyboard(watchedEntities) {
  if (!watchedEntities || watchedEntities.length === 0) return null;
  return { inline_keyboard: [[{ text: '🗑 Прибрати замовника', callback_data: 'watched:manage' }]] };
}

// MANAGE mode: the per-entity 🗑 rows (from buildWatchedKeyboard) plus a
// trailing "← Готово" row that returns to VIEW mode.
export function buildWatchedManageKeyboard(watchedEntities) {
  const base = buildWatchedKeyboard(watchedEntities);
  if (!base) return null;
  return { inline_keyboard: [...base.inline_keyboard, [{ text: '← Готово', callback_data: 'watched:done' }]] };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: add /watched VIEW + MANAGE keyboard builders"
```

---

## Task 2: handler — VIEW dispatch + manage/done callbacks + unwatch re-render

**Files:**
- Modify: `worker/src/handler.mjs` — import the new symbols; `/watched` dispatch; add two render helpers; add `watched:manage` + `watched:done` callback branches; change the `unwatch:` refresh
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `worker/test/handler.test.mjs`, reuse the existing `makeDeps`, `runHandler`, `ENV`, the `CB(...)` callback helper, and the `WATCHED_TWO` fixture (all already in this file from the unwatch-button feature). Add:

```js
test('runHandler: /watched VIEW shows single "Прибрати" button for editor', async () => {
  const { deps, sent } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  const kb = sent[0].replyMarkup;
  assert.equal(kb.inline_keyboard.length, 1);
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'watched:manage');
});

test('runHandler: /watched VIEW for viewer → no inline keyboard', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/watched', message_id: 1 } },
    env: ENV, deps,
  });
  const kb = sent[0].replyMarkup;
  assert.ok(!kb || !kb.inline_keyboard);
});

test('callback watched:manage → editMessageText shows delete buttons + Готово', async () => {
  let edited, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async (a) => { acked = a; },
  });
  await runHandler({ update: CB('watched:manage'), env: ENV, deps });
  assert.equal(edited.replyMarkup.inline_keyboard.length, 3); // 2 entities + Готово
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'unwatch:12345678');
  assert.equal(edited.replyMarkup.inline_keyboard[2][0].callback_data, 'watched:done');
  assert.ok(acked);
});

test('callback watched:manage → viewer rejected', async () => {
  let edited, acked;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async (a) => { acked = a; },
  });
  await runHandler({ update: CB('watched:manage', 456, { first_name: 'V' }), env: ENV, deps });
  assert.equal(edited, undefined, 'no edit for viewer');
  assert.match(acked.text, /редактор|🚫/);
});

test('callback watched:done → editMessageText returns to VIEW (single button)', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('watched:done'), env: ENV, deps });
  assert.equal(edited.replyMarkup.inline_keyboard.length, 1);
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'watched:manage');
  assert.match(edited.text, /12345678/); // VIEW shows the text list
});

test('callback unwatch: after delete stays in MANAGE mode', async () => {
  let savedOpts, edited, acked;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: WATCHED_TWO, sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async (a) => { acked = a; },
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.match(savedOpts.message, /^audit: unwatch 12345678 /);
  // still MANAGE: remaining entity delete button + Готово row
  assert.equal(edited.replyMarkup.inline_keyboard.length, 2); // 1 entity + Готово
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'unwatch:01999106');
  assert.equal(edited.replyMarkup.inline_keyboard[1][0].callback_data, 'watched:done');
  assert.match(acked.text, /Прибрано/);
});

test('callback unwatch: last entity → empty-state text, no keyboard', async () => {
  let edited;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [{ edrpou: '12345678', name: 'КНП', enabled: true }], sha: 's' }),
    saveWatchedEntities: async () => {},
    editMessageText: async (a) => { edited = a; },
    answerCallbackQuery: async () => {},
  });
  await runHandler({ update: CB('unwatch:12345678'), env: ENV, deps });
  assert.match(edited.text, /Не стежу за жодним замовником/);
  assert.ok(edited.replyMarkup == null);
});
```

> Confirm `CB`, `WATCHED_TWO`, and `makeDeps`' `editMessageText` default exist in this file (added by the unwatch-button feature). If `makeDeps` does not default `editMessageText`, the existing callback tests would already fail — they don't, so it's there.

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `/watched` still attaches the per-entity keyboard (3+ rows, `unwatch:` data) not the single `watched:manage` button; no `watched:manage`/`watched:done` branches; `unwatch:` refresh still re-renders view-style (`buildWatchedKeyboard`).

- [ ] **Step 3: Implement**

(a) Imports — add `buildWatchedViewKeyboard, buildWatchedManageKeyboard, WATCHED_MANAGE_PROMPT` to the `../../commands.mjs` import block (which already imports `buildWatchedKeyboard, handleWatched, handleUnwatch, applyEntityMutation`).

(b) `/watched` dispatch — change the keyboard attachment from `buildWatchedKeyboard` to `buildWatchedViewKeyboard`. Replace:
```js
      if (isEditor) watchedReplyMarkup = buildWatchedKeyboard(entities);
```
with:
```js
      if (isEditor) watchedReplyMarkup = buildWatchedViewKeyboard(entities);
```

(c) Add two render helpers near the other module-level helper functions in `handler.mjs` (e.g. just below `handleCallbackQuery`, beside `applyMutationWithRetry`). Both reload nothing — they take `entities` and edit the message; they swallow+log edit errors (a benign "message is not modified" must not break the ack):
```js
async function renderWatchedManage({ _editMessageText, env, chatId, messageId, entities }) {
  try {
    await _editMessageText({
      token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      text: entities.length ? WATCHED_MANAGE_PROMPT : handleWatched({ watchedEntities: entities }),
      replyMarkup: buildWatchedManageKeyboard(entities) ?? undefined,
    });
  } catch (err) {
    console.error('worker: watched manage edit failed:', err.message);
  }
}

async function renderWatchedView({ _editMessageText, env, chatId, messageId, entities }) {
  try {
    await _editMessageText({
      token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      text: handleWatched({ watchedEntities: entities }),
      replyMarkup: buildWatchedViewKeyboard(entities) ?? undefined,
    });
  } catch (err) {
    console.error('worker: watched view edit failed:', err.message);
  }
}
```

(d) Add the `watched:manage` and `watched:done` callback branches in `handleCallbackQuery`, inserted BEFORE the `if (data.startsWith('unwatch:'))` block:
```js
  if (data === 'watched:manage' || data === 'watched:done') {
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    let entities = [];
    try {
      ({ entities } = await _loadWatchedEntities(env));
    } catch (err) {
      console.error('worker: watched mode load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    if (data === 'watched:manage') {
      await renderWatchedManage({ _editMessageText, env, chatId, messageId, entities });
    } else {
      await renderWatchedView({ _editMessageText, env, chatId, messageId, entities });
    }
    await ack();
    return;
  }
```

(e) MODIFY the `unwatch:` callback's refresh — replace the inner `try { await _editMessageText({ … buildWatchedKeyboard … }) } catch { … }` block with a call to the manage renderer:
```js
        await renderWatchedManage({ _editMessageText, env, chatId, messageId, entities: newEntities });
        await ack(mutation ? `✅ Прибрано ${edrpou}` : 'Вже прибрано');
        return;
```
(i.e. the editMessageText is now done inside `renderWatchedManage`, which swallows its own errors; the surrounding retry `try/catch` for the load/save stays exactly as is.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS. Then full suite `node --test test/*.test.mjs worker/test/*.test.mjs` — fix any existing test that asserted the OLD `/watched` behavior (the unwatch-button feature added tests expecting `/watched` to attach the per-entity `buildWatchedKeyboard`; those must be updated to expect the single `watched:manage` button now). Search `worker/test/handler.test.mjs` for `/watched` tests asserting `callback_data: 'unwatch:'` on the `/watched` reply and update them to the VIEW button. (The new VIEW tests above already cover the replacement — you may delete the now-obsolete old `/watched` keyboard tests rather than duplicate.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "handler: /watched VIEW button + manage/done callbacks; unwatch stays in manage"
```

---

## Task 3: Full suite + finish

**Files:** none (verification)

- [ ] **Step 1: Full suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: all pass. Investigate/fix any regression — especially old `/watched` keyboard tests from the unwatch-button feature that assumed the per-entity buttons attach directly to `/watched`.

- [ ] **Step 2: README check (likely no change)**

The README line already says “Прибрати замовника — кнопкою 🗑 у списку `/watched`.” That remains accurate (still a 🗑 flow). Only adjust if you find it now misleading; otherwise no change.

- [ ] **Step 3: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. Deployment note: merging to `main` triggers `worker-deploy.yml` (paths include `worker/**`, `commands.mjs`) → tests then Worker deploy.

---

## Self-Review Notes

- **Spec coverage:** VIEW keyboard (Task 1 `buildWatchedViewKeyboard` + Task 2 dispatch), MANAGE keyboard with Готово (Task 1 `buildWatchedManageKeyboard`), prompt constant (Task 1), `watched:manage`/`watched:done` callbacks (Task 2), `unwatch:` re-render in MANAGE (Task 2), empty-state handling (renderers fall back to `handleWatched` empty text + null keyboard), editor-guard + viewer reject (Task 2), audit unchanged (untouched), mode-not-stored (every callback reloads). All spec items map to a task.
- **Type/name consistency:** `buildWatchedViewKeyboard`/`buildWatchedManageKeyboard` return `{ inline_keyboard }|null`; `WATCHED_MANAGE_PROMPT` is a string; callback_data tokens `watched:manage`, `watched:done`, `unwatch:<edrpou>`; helpers `renderWatchedManage`/`renderWatchedView` take `{ _editMessageText, env, chatId, messageId, entities }`. `buildWatchedKeyboard` reused unchanged by `buildWatchedManageKeyboard`.
- **No placeholders:** all code shown.
- **Reuse:** `buildWatchedManageKeyboard` composes `buildWatchedKeyboard` (no duplicated row logic); `handleWatched` reused for VIEW + empty-state text.
