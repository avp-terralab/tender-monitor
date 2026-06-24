# Agent Amend-Proposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin instruct the agent (free text) to add documents / make changes to an already-prepared tender proposal, via a `✏️ Доробити` button in «📊 Останні задачі».

**Architecture:** New pure builders in `commands.mjs` produce an `amend` job record (`job_type:'amend'` + `instruction` + `target` carried from the prior `done` job's `result`) that overwrites `_state/agent_jobs/<tid>.json`. The Worker adds an `agent:amend` dialog (reusing the `agent_pending.json` + free-text-intercept pattern used for price) and branches `agent:confirm` by `entry.kind`. The offline agent that consumes the job is OUT OF SCOPE (user updates it separately).

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Cloudflare Worker, Telegram Bot API, GitHub Contents API.

**Spec:** `docs/superpowers/specs/2026-06-24-agent-amend-proposal-design.md`

**Baseline (this branch, off main):** `test/commands.test.mjs` 371, `worker/test/handler.test.mjs` 174, `worker/test/github.test.mjs` 39 — all 0 fail.

---

## File Structure

- `commands.mjs` — **Modify.** Add `validateInstruction`, `buildAgentAmendJob`, `buildAgentAmendConfirmText` (after `buildAgentJob`, ~line 1882). Modify `buildAgentJobsPage` (~1841) for the `✏️ Доробити` button + amend marker. (`escapeHtml` already imported.)
- `worker/src/handler.mjs` — **Modify.** Add commands imports; rename/extend `handleAgentPriceReply` → `handleAgentTextReply` (~1198) + its call site (~112); add `agent:amend` branch and an `entry.kind` branch in `agent:confirm` inside `handleAgentCallback` (~1019–1176).
- `test/commands.test.mjs` — **Modify.** Tests for the new pure functions + jobs-page button/marker.
- `worker/test/handler.test.mjs` — **Modify.** Tests for the amend dialog (reuse the `makeAgentDeps`/`agentMsg`/`CB`/`AGENT_TID` harness at ~2588).

**Test harness facts (worker):** `makeAgentDeps(overrides)` → `{ deps, store, sent, acks, edits, jobs }`; injected `now` = `2026-06-21T10:00:00.000Z`; `store.pending` is the agent_pending object; `agentMsg(text, chatId=123)` builds a message update; `CB(data, chatId=123)` builds a callback_query update; `AGENT_TID = 'UA-2026-04-30-010542-a'`; chat 123 = admin. `loadAgentJob` is overridable via makeDeps default `async () => null`.

**Commands harness facts:** import block at top of `test/commands.test.mjs`; fixtures `job(tender_id, status, extra = {})` → `{ tender_id, status, company:'ТОВ Тест', created_at:'2026-06-20T10:00:00Z', ...extra }` already exist near the agent tests.

---

## Task 1: Pure helpers — validateInstruction, buildAgentAmendJob, buildAgentAmendConfirmText

**Files:** Modify `commands.mjs` (after `buildAgentJob`, ~1882) · Test `test/commands.test.mjs`

- [ ] **Step 1: Write failing tests**

Add `validateInstruction, buildAgentAmendJob, buildAgentAmendConfirmText` to the top import from `../commands.mjs`, and append:

```javascript
test('validateInstruction: trims, empty→null, non-string→null, caps 4096', () => {
  assert.equal(validateInstruction('   '), null);
  assert.equal(validateInstruction(123), null);
  assert.equal(validateInstruction('  додай довідку  '), 'додай довідку');
  assert.equal(validateInstruction('x'.repeat(5000)).length, 4096);
});

test('buildAgentAmendJob: amend record shape, no price, target carried', () => {
  const j = buildAgentAmendJob({
    tenderId: 'UA-2026-06-01-000002-a', instruction: 'додай КВЕД', company: 'ТОВ',
    target: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' },
    requestedBy: '123', createdAt: '2026-06-21T10:00:00.000Z',
  });
  assert.deepEqual(j, {
    tender_id: 'UA-2026-06-01-000002-a',
    link: 'https://prozorro.gov.ua/tender/UA-2026-06-01-000002-a',
    job_type: 'amend',
    instruction: 'додай КВЕД',
    company: 'ТОВ',
    target: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' },
    requested_by: '123',
    status: 'pending',
    created_at: '2026-06-21T10:00:00.000Z',
  });
  assert.ok(!('price' in j));
});

test('buildAgentAmendConfirmText: shows tid + HTML-escaped instruction', () => {
  const t = buildAgentAmendConfirmText({ tenderId: 'UA-2026-06-01-000002-a', instruction: 'ціна < 5 & більше' });
  assert.match(t, /UA-2026-06-01-000002-a/);
  assert.match(t, /&lt; 5 &amp; більше/);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `validateInstruction is not a function` (and the other two).

- [ ] **Step 3: Implement in `commands.mjs`** (immediately after `buildAgentJob`, ~line 1882)

```javascript
// Free-text agent instruction (amend dialog). Trim; null when empty/non-string;
// cap at 4096 = Telegram's text-message max (instruction lives in the job file,
// not in callback_data, so this is only a defensive ceiling).
export function validateInstruction(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return null;
  return t.slice(0, 4096);
}

// Amend job: re-work an already-prepared proposal per a free-text instruction.
// Overwrites _state/agent_jobs/<tid>.json. `target` carries the prior result so
// the offline agent knows WHERE to amend. No `price` — amend does not reprice.
export function buildAgentAmendJob({ tenderId, instruction, company, target, requestedBy, createdAt }) {
  return {
    tender_id: tenderId,
    link: `https://prozorro.gov.ua/tender/${tenderId}`,
    job_type: 'amend',
    instruction,
    company,
    target,
    requested_by: requestedBy,
    status: 'pending',
    created_at: createdAt,
  };
}

// Confirm prompt for an amend. Instruction is user free text → HTML-escaped
// (the send helpers use parse_mode HTML); truncated for the prompt display only.
export function buildAgentAmendConfirmText({ tenderId, instruction }) {
  const short = instruction.length > 300 ? `${instruction.slice(0, 300)}…` : instruction;
  return `✏️ Доробити ${tenderId}:\n«${escapeHtml(short)}»`;
}
```

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test test/commands.test.mjs`
Expected: PASS (371 + 3 = 374).

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(amend): pure helpers (validateInstruction, buildAgentAmendJob, confirm text)"
```

---

## Task 2: buildAgentJobsPage — ✏️ Доробити button + amend marker

**Files:** Modify `commands.mjs` (`buildAgentJobsPage`, ~1841) · Test `test/commands.test.mjs`

- [ ] **Step 1: Write failing tests**

Append (reuse the existing `job` fixture):

```javascript
test('buildAgentJobsPage: done+drive_link row gets 📁 + ✏️ Доробити; others do not', () => {
  const v = buildAgentJobsPage({ jobs: [
    job('UA-2026-06-01-000002-a', 'done', { result: { drive_link: 'https://drive/x' } }),
    job('UA-2026-06-01-000003-a', 'pending'),
    job('UA-2026-06-01-000004-a', 'error'),
  ], page: 0 });
  const cbs = JSON.stringify(v.keyboard.inline_keyboard);
  assert.match(cbs, /agent:amend:UA-2026-06-01-000002-a/);
  assert.ok(!cbs.includes('agent:amend:UA-2026-06-01-000003-a'));
  assert.ok(!cbs.includes('agent:amend:UA-2026-06-01-000004-a'));
});

test('buildAgentJobsPage: amend job shows ✏️ marker in its line', () => {
  const v = buildAgentJobsPage({ jobs: [
    job('UA-2026-06-01-000002-a', 'running', { job_type: 'amend' }),
  ], page: 0 });
  assert.match(v.text, /✏️/);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — no `agent:amend:` callback exists; no `✏️` in amend line.

- [ ] **Step 3: Implement** — in `buildAgentJobsPage`, replace the body-map and the done-button loop.

Replace the `const body = slice.map(...)` block with (adds the `mark`):
```javascript
  const body = slice.map((j) => {
    const icon = AGENT_JOB_ICONS[j.status] ?? '•';
    const mark = j.job_type === 'amend' ? '✏️ ' : '';
    const co = j.company ? ` · ${escapeHtml(j.company)}` : '';
    const tid = escapeHtml(j.tender_id ?? '');
    return `${mark}${icon} <a href="https://prozorro.gov.ua/tender/${tid}">${tid}</a>${co}`;
  }).join('\n');
```

Replace the `for (const j of slice) { ... }` done-button loop with (adds the amend button to the same row):
```javascript
  for (const j of slice) {
    if (j.status === 'done' && j.result?.drive_link && j.tender_id) {
      rows.push([
        { text: `📁 ${j.tender_id}`, url: j.result.drive_link },
        { text: '✏️ Доробити', callback_data: `agent:amend:${j.tender_id}` },
      ]);
    }
  }
```

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test test/commands.test.mjs`
Expected: PASS (374 + 2 = 376). The existing `buildAgentJobsPage` tests (drive button, nav) still pass — the 📁 button is unchanged, only a sibling button is added.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(amend): ✏️ Доробити button on done jobs + amend marker in jobs page"
```

---

## Task 3: Worker — generalize handleAgentPriceReply → handleAgentTextReply

**Files:** Modify `worker/src/handler.mjs` (imports ~15; call site ~112; function ~1198) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to `worker/test/handler.test.mjs` (near the other agent tests, after the price tests):

```javascript
test('agent instruction reply → stored, amend confirm shown', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'amend', step: 'await_instruction', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: agentMsg('додай довідку КВЕД'), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'confirm');
  assert.equal(store.pending['123'].instruction, 'додай довідку КВЕД');
  assert.match(sent.at(-1).text, /Доробити/);
  assert.match(JSON.stringify(sent.at(-1).replyMarkup), new RegExp(`agent:confirm:${AGENT_TID}`));
});

test('agent empty instruction → stays at await_instruction, no advance', async () => {
  const { deps, store, sent } = makeAgentDeps();
  store.pending['123'] = { tid: AGENT_TID, kind: 'amend', step: 'await_instruction', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: agentMsg('   '), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_instruction');
  assert.match(sent.at(-1).text, /Порожня інструкція/);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — the `await_instruction` step isn't handled (interceptor returns false → message falls to command parsing → no confirm sent).

- [ ] **Step 3: Implement**

3a. In the commands import (the line `buildAgentConfirmKeyboard, buildAgentConfirmText, buildAgentJob,`), add the new helpers:
```javascript
  buildAgentConfirmKeyboard, buildAgentConfirmText, buildAgentJob,
  validateInstruction, buildAgentAmendJob, buildAgentAmendConfirmText,
```

3b. Rename the call site (~line 112): change `handleAgentPriceReply` to `handleAgentTextReply`. The surrounding `if (isAdmin && typeof msg.text === 'string' && !msg.text.startsWith('/'))` stays.

3c. Rename `async function handleAgentPriceReply(` to `async function handleAgentTextReply(` (~line 1198) and restructure it to dispatch by step. Replace the early guard line:
```javascript
  if (!entry || entry.step !== 'await_price') return false;
```
with:
```javascript
  if (!entry || (entry.step !== 'await_price' && entry.step !== 'await_instruction')) return false;
```
Then, AFTER the TTL-expiry block and the `const send = (text, replyMarkup) => ...` declaration (which both stay as-is), and BEFORE the existing `const price = validateAgentPrice(msg.text);` line, insert the instruction branch:
```javascript
  if (entry.step === 'await_instruction') {
    const instruction = validateInstruction(msg.text);
    if (instruction === null) {
      try { await send('Порожня інструкція. Напиши текстом, що доробити.'); }
      catch (err) { console.error('worker: agent empty-instruction reply failed:', err.message); }
      return true; // consumed; stay at await_instruction
    }
    try {
      pending[chatId] = { ...entry, instruction, step: 'confirm' };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent instruction save pending failed:', err.message);
      try { await send('⚠️ Помилка, спробуй ще раз.'); } catch {}
      return true;
    }
    try {
      await send(
        buildAgentAmendConfirmText({ tenderId: entry.tid, instruction }),
        buildAgentConfirmKeyboard(entry.tid),
      );
    } catch (err) { console.error('worker: agent amend confirm prompt failed:', err.message); }
    return true;
  }
```
Leave the entire existing price logic (from `const price = validateAgentPrice(msg.text);` to the final `return true;`) UNCHANGED — it now only runs for `step === 'await_price'`.

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS (174 + 2 = 176). The existing price-reply tests (`agent price reply ...`) still pass — the price path is unchanged and now reached only for `await_price`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(amend): generalize agent text-reply interceptor (price + instruction)"
```

---

## Task 4: Worker — agent:amend start branch

**Files:** Modify `worker/src/handler.mjs` (`handleAgentCallback`, ~1077, after the menu block / before `if (action === 'start')`) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
test('agent:amend on prepared tender → instruction dialog started', async () => {
  const { deps, store, sent, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ', result: { drive_link: 'https://drive/x' } }),
  });
  await runHandler({ update: CB(`agent:amend:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'].step, 'await_instruction');
  assert.equal(store.pending['123'].kind, 'amend');
  assert.match(sent.at(-1).text, /що доробити/);
  assert.equal(acks.length, 1);
});

test('agent:amend on not-prepared tender → rejected, no dialog', async () => {
  const { deps, store, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'pending' }),
  });
  await runHandler({ update: CB(`agent:amend:${AGENT_TID}`), env: ENV, deps });
  assert.equal(store.pending['123'], undefined);
  assert.match(acks[0].text, /не готова/);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `agent:amend` falls through to `await ack('❓ Невідома кнопка')`; no pending written.

- [ ] **Step 3: Implement** — in `handleAgentCallback`, insert this block immediately AFTER the menu block (the one ending `await ack(); return; }` for `action === 'menu'|'pick'|'jobs'`, ~line 1077) and BEFORE `if (action === 'start') {`:

```javascript
  if (action === 'amend') {
    let prior;
    try {
      prior = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent amend load job failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    if (!prior || prior.status !== 'done' || !prior.result?.drive_link) {
      await ack('🚫 Пропозиція ще не готова', true);
      return;
    }
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, kind: 'amend', step: 'await_instruction', at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent amend save pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    try {
      await sendNew(`✏️ Напиши, що доробити в пропозиції ${tid} (одним повідомленням):`);
    } catch (err) {
      console.error('worker: agent amend prompt send failed:', err.message);
    }
    await ack();
    return;
  }
```
(`_loadAgentJob`, `_loadAgentPending`, `_saveAgentPending`, `_now`, `sendNew`, `tid`, `chatId` are all already in scope in `handleAgentCallback`.)

- [ ] **Step 4: Run — confirm PASS**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS (176 + 2 = 178).

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(amend): agent:amend starts instruction dialog (done-only)"
```

---

## Task 5: Worker — agent:confirm branches by kind → amend job

**Files:** Modify `worker/src/handler.mjs` (`action === 'confirm'` block, ~1131–1165) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
test('agent:confirm with kind=amend → amend job saved, target from prior done, pending cleared', async () => {
  const { deps, store, sent, jobs, acks } = makeAgentDeps({
    loadAgentJob: async () => ({ tender_id: AGENT_TID, status: 'done', company: 'МАЙЛАБ', result: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' } }),
  });
  store.pending['123'] = { tid: AGENT_TID, kind: 'amend', step: 'confirm', instruction: 'додай КВЕД', at: '2026-06-21T10:00:00.000Z' };
  await runHandler({ update: CB(`agent:confirm:${AGENT_TID}`), env: ENV, deps });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    tender_id: AGENT_TID,
    link: `https://prozorro.gov.ua/tender/${AGENT_TID}`,
    job_type: 'amend',
    instruction: 'додай КВЕД',
    company: 'МАЙЛАБ',
    target: { drive_link: 'https://drive/x', package_dir: 'G:\\pkg' },
    requested_by: '123',
    status: 'pending',
    created_at: '2026-06-21T10:00:00.000Z',
  });
  assert.equal(store.pending['123'], undefined, 'pending cleared');
  assert.match(sent.at(-1).text, /доробку/);
  assert.equal(acks.length, 1);
});
```

- [ ] **Step 2: Run — confirm FAIL**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — current confirm guard requires `entry.price`; an amend entry has no price → rejected with «Немає активного запиту», no job saved.

- [ ] **Step 3: Implement** — replace the ENTIRE `if (action === 'confirm') { ... }` block (currently ~lines 1131–1165) with:

```javascript
  if (action === 'confirm') {
    let entry;
    try {
      const loaded = await _loadAgentPending(env);
      entry = loaded.pending?.[chatId];
    } catch (err) {
      console.error('worker: agent confirm load pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    if (!entry || entry.tid !== tid || entry.step !== 'confirm') {
      await ack('⚠️ Немає активного запиту');
      return;
    }

    // Amend: build a job_type:'amend' record, carrying the prior done job's
    // result as the target folder. No price.
    if (entry.kind === 'amend') {
      if (!entry.instruction) { await ack('⚠️ Немає активного запиту'); return; }
      let prior;
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent amend confirm load job failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      const job = buildAgentAmendJob({
        tenderId: tid,
        instruction: entry.instruction,
        company: prior?.company ?? null,
        target: { drive_link: prior?.result?.drive_link ?? null, package_dir: prior?.result?.package_dir ?? null },
        requestedBy: String(chatId),
        createdAt: _now().toISOString(),
      });
      try {
        await _saveAgentJob(env, job);
      } catch (err) {
        console.error('worker: saveAgentJob (amend) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await sendNew('✅ Завдання на доробку поставлено в чергу. Сповіщу, коли буде готово.');
      } catch (err) {
        console.error('worker: agent amend confirm reply failed:', err.message);
      }
      await ack('✅ В черзі');
      return;
    }

    // Prepare (existing): requires a price.
    if (!entry.price) { await ack('⚠️ Немає активного запиту'); return; }
    const link = `https://prozorro.gov.ua/tender/${tid}`;
    const job = buildAgentJob({
      tenderId: tid, link, company: entry.company, price: entry.price,
      requestedBy: String(chatId), createdAt: _now().toISOString(),
    });
    try {
      await _saveAgentJob(env, job);
    } catch (err) {
      console.error('worker: saveAgentJob failed:', err.message);
      await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
      return;
    }
    await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
    try {
      await sendNew('✅ Завдання поставлено в чергу. Сповіщу, коли буде готово.');
    } catch (err) {
      console.error('worker: agent confirm reply failed:', err.message);
    }
    await ack('✅ В черзі');
    return;
  }
```
(`buildAgentAmendJob` is imported in Task 3 step 3a. `_loadAgentJob` is already a `handleAgentCallback` param.)

- [ ] **Step 4: Run — confirm PASS (both suites)**

Run: `node --test worker/test/handler.test.mjs` → 178 + 1 = 179, 0 fail. The existing prepare-confirm tests (`agent:confirm → saveAgentJob ...`, `agent:confirm without matching pending ...`) must still pass — the prepare branch is byte-equivalent and the no-pending guard is preserved.
Run: `node --test test/commands.test.mjs` → 376, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(amend): agent:confirm builds amend job when kind=amend"
```

---

## Self-Review

**Spec coverage:**
- amend job contract (`job_type`, `instruction`, `target`, no `price`) → Task 1 (`buildAgentAmendJob`) + Task 5 (worker builds it carrying target) ✓
- prepare job unchanged → Task 5 keeps the prepare branch byte-equivalent ✓
- `✏️ Доробити` button on done+drive_link only; amend marker → Task 2 ✓
- instruction capture via generalized interceptor (step dispatch, TTL reused) → Task 3 ✓
- `agent:amend` start, done-only guard → Task 4 ✓
- `agent:confirm` branch by `kind` → Task 5 ✓
- `validateInstruction` (empty→null, 4096 cap) → Task 1 ✓
- admin-only → existing `agent:` gate (unchanged) ✓
- Agent-side contract → out of scope (spec section), no task ✓

**Placeholder scan:** none — every step has full code.

**Type consistency:** `buildAgentAmendJob({tenderId,instruction,company,target,requestedBy,createdAt})` signature identical in Task 1 def, Task 1 test, and Task 5 call. `validateInstruction`/`buildAgentAmendConfirmText` names consistent across commands + worker. Pending entry shape `{tid, kind:'amend', step:'await_instruction'|'confirm', instruction, at}` consistent across Tasks 3/4/5. Callback `agent:amend:<tid>` consistent (Task 2 button ↔ Task 4 handler). `target` shape `{drive_link, package_dir}` consistent (Task 1 ↔ Task 5).
