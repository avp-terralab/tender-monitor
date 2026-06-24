# Агент — меню + «Останні задачі» (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `🤖 Агент` відкриває меню дій (`🚀 Надіслати тендер` / `📊 Останні задачі`) замість одразу списку тендерів; вибір тендера з пагінацією + «назад»; новий екран статусів agent-job із лінками на Drive.

**Architecture:** Чисті функції в `commands.mjs` (`buildAgentMenu`, `buildAgentPickView`, `buildAgentJobsPage`, `handleAgentMenuNav`). Нова `listAgentJobs` у `github.mjs` (лістинг директорії `_state/agent_jobs/`). Worker: `cmd 'agent'` → меню; `handleAgentCallback` додає дії `menu`/`pick`/`jobs`; наявні `start/co/confirm/cancel` без змін. Усе admin-only.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Cloudflare Worker, GitHub Contents API, Telegram Bot API.

**Спека:** `docs/superpowers/specs/2026-06-24-bot-inline-menus-design.md` (розділ 3).

**Це Фаза 3 із 3.** Залежності від Фаз 1–2 немає.

---

## File Structure

- `commands.mjs` — **Modify.** Додати `buildAgentMenu`/`buildAgentPickView`/`buildAgentJobsPage`/`handleAgentMenuNav` після `buildAgentConfirmText` (~1706). Reuse наявних `buildAgentTenderListKeyboard`, `escapeHtml`.
- `worker/src/github.mjs` — **Modify.** Додати `listAgentJobs(env)` після `loadAgentJob` (~272).
- `worker/src/handler.mjs` — **Modify.** Імпорт `listAgentJobs`; dep `_listAgentJobs`; протягнути `_loadWatchlist`/`_loadAgentJob`/`_listAgentJobs` у `handleCallbackQuery`→`handleAgentCallback`; `cmd 'agent'` (636–664) → меню; нові дії в `handleAgentCallback` (~944).
- `test/commands.test.mjs`, `worker/test/github.test.mjs`, `worker/test/handler.test.mjs` — **Modify.** Тести.

**Команди:** `node --test test/commands.test.mjs` · `node --test worker/test/github.test.mjs` · `node --test worker/test/handler.test.mjs`

**Наявні символи:** `buildAgentTenderListKeyboard(watchlist)` → `{inline_keyboard}` (по рядку `🤖 <label>` callback `agent:start:<tid>`, +рядок url-лінка якщо `r.preparedUrl`). Job = `{ tender_id, company, price, status, created_at, result?.drive_link }`, status ∈ `pending|running|done|error`. `github.mjs`: `loadAgentJob(env, tid, {fetch})`, `API_BASE`, `REPO`, `loadFile`.

---

## Task 1: `buildAgentMenu` + `buildAgentPickView`

**Files:** Modify `commands.mjs` (~1706) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючі тести** (додати `buildAgentMenu, buildAgentPickView` до імпорту):

```javascript
const pickTender = (id, notes, preparedUrl) => ({ tender_id: id, enabled: true, notes, preparedUrl });

test('buildAgentMenu: two action buttons', () => {
  const m = buildAgentMenu();
  const cbs = m.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(cbs, ['agent:pick:0', 'agent:jobs:0']);
});

test('buildAgentPickView: empty → back to menu only', () => {
  const v = buildAgentPickView({ tenders: [], page: 0 });
  assert.match(v.text, /Немає тендерів/);
  assert.equal(v.keyboard.inline_keyboard[0][0].callback_data, 'agent:menu');
});

test('buildAgentPickView: tender buttons + back row', () => {
  const v = buildAgentPickView({ tenders: [pickTender('UA-2026-06-01-000002-a', 'КНП')], page: 0 });
  const cbs = JSON.stringify(v.keyboard.inline_keyboard);
  assert.match(cbs, /agent:start:UA-2026-06-01-000002-a/);
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'agent:menu');
});

test('buildAgentPickView: 6/page nav arrows', () => {
  const tenders = Array.from({ length: 8 }, (_, i) => pickTender(`UA-2026-06-01-00000${i}-a`, `n${i}`));
  const r0 = buildAgentPickView({ tenders, page: 0 }).keyboard.inline_keyboard;
  const nav0 = r0.find((row) => row.some((b) => b.callback_data === 'agent:noop'));
  assert.ok(nav0.some((b) => b.text === 'Далі ▶' && b.callback_data === 'agent:pick:1'));
  assert.ok(nav0.some((b) => b.text === '1/2'));
});
```

- [ ] **Step 2: Запустити — падає.** `node --test test/commands.test.mjs` → FAIL.

- [ ] **Step 3: Реалізувати** — у `commands.mjs` після `buildAgentConfirmText`:

```javascript
const AGENT_PER_PAGE = 6;

export function buildAgentMenu() {
  return {
    text: '🤖 <b>Агент</b>',
    keyboard: { inline_keyboard: [
      [{ text: '🚀 Надіслати тендер агенту', callback_data: 'agent:pick:0' }],
      [{ text: '📊 Останні задачі', callback_data: 'agent:jobs:0' }],
    ] },
  };
}

// Paginated tender picker. Reuses buildAgentTenderListKeyboard for the per-page
// slice (keeps the 🤖 + prepared-link rows), adds nav + ⬅ back to the agent menu.
export function buildAgentPickView({ tenders, page = 0 }) {
  const list = tenders ?? [];
  if (list.length === 0) {
    return {
      text: '📭 Немає тендерів у статусі «Приймання пропозицій».',
      keyboard: { inline_keyboard: [[{ text: '⬅ Назад', callback_data: 'agent:menu' }]] },
    };
  }
  const pages = Math.max(1, Math.ceil(list.length / AGENT_PER_PAGE));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const slice = list.slice(p * AGENT_PER_PAGE, p * AGENT_PER_PAGE + AGENT_PER_PAGE);
  const kb = buildAgentTenderListKeyboard(slice);
  const rows = kb ? [...kb.inline_keyboard] : [];
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: '◀ Назад', callback_data: `agent:pick:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: 'agent:noop' });
    if (p < pages - 1) nav.push({ text: 'Далі ▶', callback_data: `agent:pick:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '⬅ Назад', callback_data: 'agent:menu' }]);
  return { text: '🤖 Оберіть тендер (приймання пропозицій):', keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(agent): menu + paginated tender picker view"
```

---

## Task 2: `buildAgentJobsPage`

**Files:** Modify `commands.mjs` (після `buildAgentPickView`) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючі тести** (додати `buildAgentJobsPage` до імпорту):

```javascript
const job = (tender_id, status, extra = {}) => ({ tender_id, status, company: 'ТОВ Тест', created_at: '2026-06-20T10:00:00Z', ...extra });

test('buildAgentJobsPage: empty → back only', () => {
  const v = buildAgentJobsPage({ jobs: [], page: 0 });
  assert.match(v.text, /Ще немає задач/);
  assert.equal(v.keyboard.inline_keyboard[0][0].callback_data, 'agent:menu');
});

test('buildAgentJobsPage: status icons + drive button for done', () => {
  const v = buildAgentJobsPage({ jobs: [
    job('UA-2026-06-01-000001-a', 'running'),
    job('UA-2026-06-01-000002-a', 'done', { result: { drive_link: 'https://drive/x' } }),
  ], page: 0 });
  assert.match(v.text, /⏳/);
  assert.match(v.text, /✅/);
  assert.match(v.text, /prozorro\.gov\.ua\/tender\/UA-2026-06-01-000002-a/);
  const urlBtn = v.keyboard.inline_keyboard.flat().find((b) => b.url === 'https://drive/x');
  assert.ok(urlBtn, 'done job exposes a Drive link button');
  assert.equal(v.keyboard.inline_keyboard.at(-1)[0].callback_data, 'agent:menu');
});

test('buildAgentJobsPage: 6/page nav', () => {
  const jobs = Array.from({ length: 8 }, (_, i) => job(`UA-2026-06-01-00000${i}-a`, 'pending'));
  const nav = buildAgentJobsPage({ jobs, page: 0 }).keyboard.inline_keyboard.find((row) => row.some((b) => b.callback_data === 'agent:noop'));
  assert.ok(nav.some((b) => b.callback_data === 'agent:jobs:1'));
});
```

- [ ] **Step 2: Запустити — падає.** FAIL.

- [ ] **Step 3: Реалізувати** — у `commands.mjs` після `buildAgentPickView`:

```javascript
const AGENT_JOB_ICONS = { pending: '📋', running: '⏳', done: '✅', error: '❌' };

export function buildAgentJobsPage({ jobs, page = 0 }) {
  const list = jobs ?? [];
  if (list.length === 0) {
    return {
      text: '📭 Ще немає задач агента.',
      keyboard: { inline_keyboard: [[{ text: '⬅ Назад', callback_data: 'agent:menu' }]] },
    };
  }
  const pages = Math.max(1, Math.ceil(list.length / AGENT_PER_PAGE));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const slice = list.slice(p * AGENT_PER_PAGE, p * AGENT_PER_PAGE + AGENT_PER_PAGE);
  const body = slice.map((j) => {
    const icon = AGENT_JOB_ICONS[j.status] ?? '•';
    const co = j.company ? ` · ${escapeHtml(j.company)}` : '';
    return `${icon} <a href="https://prozorro.gov.ua/tender/${j.tender_id}">${j.tender_id}</a>${co}`;
  }).join('\n');
  const rows = [];
  for (const j of slice) {
    if (j.status === 'done' && j.result?.drive_link) {
      rows.push([{ text: `📁 ${j.tender_id}`, url: j.result.drive_link }]);
    }
  }
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: '◀ Назад', callback_data: `agent:jobs:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: 'agent:noop' });
    if (p < pages - 1) nav.push({ text: 'Далі ▶', callback_data: `agent:jobs:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '⬅ Назад', callback_data: 'agent:menu' }]);
  return { text: `📊 <b>Останні задачі агента</b>\n\n${body}`, keyboard: { inline_keyboard: rows } };
}
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(agent): jobs status page (icons + Drive links)"
```

---

## Task 3: `handleAgentMenuNav` (чистий router)

**Files:** Modify `commands.mjs` (після `buildAgentJobsPage`) · Test `test/commands.test.mjs`

- [ ] **Step 1: Падаючий тест** (додати `handleAgentMenuNav` до імпорту):

```javascript
test('handleAgentMenuNav: noop→null; menu/pick/jobs routing; other→null', () => {
  const args = { tenders: [pickTender('UA-2026-06-01-000002-a', 'КНП')], jobs: [job('UA-2026-06-01-000002-a', 'done')] };
  assert.equal(handleAgentMenuNav({ ...args, data: 'agent:noop' }), null);
  assert.match(handleAgentMenuNav({ ...args, data: 'agent:menu' }).text, /Агент/);
  assert.match(handleAgentMenuNav({ ...args, data: 'agent:pick:0' }).text, /Оберіть тендер/);
  assert.match(handleAgentMenuNav({ ...args, data: 'agent:jobs:0' }).text, /Останні задачі/);
  assert.equal(handleAgentMenuNav({ ...args, data: 'agent:start:UA-2026-06-01-000002-a' }), null);
});
```

- [ ] **Step 2: Запустити — падає.** FAIL.

- [ ] **Step 3: Реалізувати** — у `commands.mjs` після `buildAgentJobsPage`:

```javascript
// Pure router for the agent MENU callbacks (menu/pick/jobs). Returns null for
// agent:noop AND for the dialog actions (start/co/confirm/cancel) — those stay
// in the Worker's handleAgentCallback.
export function handleAgentMenuNav({ tenders, jobs, data }) {
  if (data === 'agent:noop') return null;
  const parts = data.split(':'); // agent:<action>[:<arg>]
  if (parts[1] === 'menu') return buildAgentMenu();
  if (parts[1] === 'pick') return buildAgentPickView({ tenders, page: Number(parts[2] ?? 0) });
  if (parts[1] === 'jobs') return buildAgentJobsPage({ jobs, page: Number(parts[2] ?? 0) });
  return null;
}
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "feat(agent): handleAgentMenuNav router for menu/pick/jobs"
```

---

## Task 4: `listAgentJobs` у `github.mjs`

**Files:** Modify `worker/src/github.mjs` (~272) · Test `worker/test/github.test.mjs`

- [ ] **Step 1: Падаючий тест** — у `worker/test/github.test.mjs` (додати `listAgentJobs` до імпорту з `../src/github.mjs`; `ENV` уже визначено у файлі):

```javascript
test('listAgentJobs: lists dir, reads each, sorts desc by created_at, caps 20', async () => {
  const jobA = { tender_id: 'UA-2026-06-01-000001-a', status: 'done', created_at: '2026-06-20T10:00:00Z' };
  const jobB = { tender_id: 'UA-2026-06-02-000002-a', status: 'pending', created_at: '2026-06-22T10:00:00Z' };
  const fakeFetch = async (url) => {
    if (/contents\/_state\/agent_jobs\?ref=main/.test(url)) {
      return { ok: true, status: 200, json: async () => ([
        { type: 'file', name: 'UA-2026-06-01-000001-a.json' },
        { type: 'file', name: 'UA-2026-06-02-000002-a.json' },
        { type: 'file', name: 'README.md' },
      ]) };
    }
    const job = /000001/.test(url) ? jobA : jobB;
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(job)).toString('base64'), sha: 's' }) };
  };
  const jobs = await listAgentJobs(ENV, { fetch: fakeFetch });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].tender_id, 'UA-2026-06-02-000002-a'); // newest first
});

test('listAgentJobs: 404 dir → empty array', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  assert.deepEqual(await listAgentJobs(ENV, { fetch: fakeFetch }), []);
});
```

- [ ] **Step 2: Запустити — падає.** `node --test worker/test/github.test.mjs` → FAIL (`listAgentJobs is not a function`).

- [ ] **Step 3: Реалізувати** — у `worker/src/github.mjs` після `loadAgentJob`:

```javascript
// Lists _state/agent_jobs/, reads each <tid>.json, returns the 20 newest jobs
// (by created_at desc). Missing dir → []. Used by the agent «Останні задачі» view.
export async function listAgentJobs(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/contents/_state/agent_jobs?ref=main`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'tender-monitor-worker',
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: list agent_jobs`);
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  const tids = items
    .filter((it) => it.type === 'file' && it.name.endsWith('.json'))
    .map((it) => it.name.replace(/\.json$/, ''));
  const jobs = await Promise.all(tids.map((tid) => loadAgentJob(env, tid, { fetch: fetchImpl })));
  return jobs
    .filter(Boolean)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, 20);
}
```

- [ ] **Step 4: Запустити — проходить.** PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/github.mjs worker/test/github.test.mjs
git commit -m "feat(agent): listAgentJobs (newest 20 from _state/agent_jobs)"
```

---

## Task 5: Worker — `/agent` відкриває меню + протягування deps

**Files:** Modify `worker/src/handler.mjs` (імпорти 21–32, deps ~78, call-site 84–91, `handleCallbackQuery` destructure 731–738, `handleAgentCallback` call 910–914 + signature 931–935, `cmd 'agent'` 636–664) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Падаючий тест:**

```javascript
test('runHandler: /agent (admin) → menu with pick + jobs buttons', async () => {
  const sent = [];
  await runHandler({
    update: { message: { chat: { id: 123 }, message_id: 7, text: '🤖 Агент', from: { id: 123 } } },
    env: ENV,
    deps: { ...makeDeps().deps, sendReply: async (a) => sent.push(a) },
  });
  assert.equal(sent.length, 1);
  const cbs = JSON.stringify(sent[0].replyMarkup);
  assert.match(cbs, /agent:pick:0/);
  assert.match(cbs, /agent:jobs:0/);
});
```

- [ ] **Step 2: Запустити — падає.** FAIL (зараз `/agent` шле список тендерів / «Немає тендерів»).

- [ ] **Step 3: Реалізувати:**

3a. github-імпорт (рядок 30): додати `listAgentJobs`:

```javascript
  loadAgentPending, saveAgentPending, saveAgentJob, loadAgentJob, listAgentJobs,
```

3b. commands-імпорт (рядок ~15, де `buildAgentConfirmText, buildAgentJob`): додати меню-білдери:

```javascript
  buildAgentConfirmKeyboard, buildAgentConfirmText, buildAgentJob,
  buildAgentMenu, buildAgentPickView, buildAgentJobsPage, handleAgentMenuNav,
```

3c. dep (після рядок 78 `_loadAgentJob`):

```javascript
  const _listAgentJobs = deps.listAgentJobs ?? listAgentJobs;
```

3d. call-site `handleCallbackQuery({...})` (84–91): додати `_loadAgentJob, _listAgentJobs` (а `_loadWatchlist` уже передається):

```javascript
      _loadAgentPending, _saveAgentPending, _saveAgentJob, _loadAgentJob, _listAgentJobs, _now,
```

3e. `handleCallbackQuery` destructure (731–738): додати `_loadAgentJob, _listAgentJobs`:

```javascript
  _loadAgentPending, _saveAgentPending, _saveAgentJob, _loadAgentJob, _listAgentJobs, _now,
```

3f. `cmd.cmd === 'agent'` (636–664) — увесь блок замінити на меню (старий fetch-список переїжджає в `agent:pick`, Task 6):

```javascript
  } else if (cmd.cmd === 'agent') {
    if (!isAdmin) return;
    const menu = buildAgentMenu();
    reply = menu.text;
    agentReplyMarkup = menu.keyboard;
  } else if (cmd.cmd === 'unknown') {
```

> `agentReplyMarkup` уже існує (рядок 149). Видаляється лише старий inline-fetch блок `/agent`.

- [ ] **Step 4: Запустити — проходить.** `node --test worker/test/handler.test.mjs` → PASS. (Наявний тест, що чекав від `/agent` список тендерів/«Немає тендерів», оновити під меню або перенести в Task 6 як тест `agent:pick`.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(agent): /agent opens action menu; thread job deps"
```

---

## Task 6: Worker — `handleAgentCallback` обробляє `menu`/`pick`/`jobs`

**Files:** Modify `worker/src/handler.mjs` (`handleAgentCallback` signature ~931 + тіло ~944; call ~910) · Test `worker/test/handler.test.mjs`

- [ ] **Step 1: Падаючі тести:**

```javascript
test('runHandler: agent:jobs:0 → edits to jobs page', async () => {
  const edits = []; const acks = [];
  await runHandler({
    update: { callback_query: { id: 'ca1', data: 'agent:jobs:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({}).deps,
      listAgentJobs: async () => ([{ tender_id: 'UA-2026-06-01-000002-a', status: 'done', company: 'ТОВ', created_at: '2026-06-20T10:00:00Z', result: { drive_link: 'https://drive/x' } }]),
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async (a) => acks.push(a),
    },
  });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Останні задачі/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /drive\/x/);
});

test('runHandler: agent:pick:0 → edits to tender picker (active.tendering only)', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca2', data: 'agent:pick:0', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: {
      ...makeDeps({
        loadWatchlist: async () => ({ watchlist: [{ tender_id: 'UA-2026-06-01-000002-a', enabled: true, notes: 'КНП' }], sha: 's' }),
        fetchTender: async () => ({ data: { status: 'active.tendering' } }),
      }).deps,
      editMessageText: async (a) => edits.push(a),
      answerCallbackQuery: async () => {},
    },
  });
  assert.match(edits[0].text, /Оберіть тендер/);
  assert.match(JSON.stringify(edits[0].replyMarkup), /agent:start:UA-2026-06-01-000002-a/);
});

test('runHandler: agent:menu → edits back to menu', async () => {
  const edits = [];
  await runHandler({
    update: { callback_query: { id: 'ca3', data: 'agent:menu', from: { id: 123 }, message: { chat: { id: 123 }, message_id: 42 } } },
    env: ENV,
    deps: { ...makeDeps({}).deps, editMessageText: async (a) => edits.push(a), answerCallbackQuery: async () => {} },
  });
  assert.match(JSON.stringify(edits[0].replyMarkup), /agent:pick:0/);
});
```

- [ ] **Step 2: Запустити — падає.** FAIL (дії menu/pick/jobs не обробляються → доходить до `agent:start` гілки / нічого).

- [ ] **Step 3: Реалізувати:**

3a. Передати нові deps у виклик `handleAgentCallback` (рядки 910–914):

```javascript
    await handleAgentCallback({
      data, env, chatId, messageId, ack, _sendReply, _editMessageText,
      _loadAgentPending, _saveAgentPending, _saveAgentJob, _now,
      _fetchTender, _extractSnapshot, _loadWatchlist, _loadAgentJob, _listAgentJobs,
    });
```

3b. Розширити сигнатуру `handleAgentCallback` (931–935):

```javascript
async function handleAgentCallback({
  data, env, chatId, messageId, ack, _sendReply, _editMessageText,
  _loadAgentPending, _saveAgentPending, _saveAgentJob, _now,
  _fetchTender, _extractSnapshot, _loadWatchlist, _loadAgentJob, _listAgentJobs,
}) {
```

3c. На початку тіла `handleAgentCallback`, **одразу після** `const tid = parts[2] ?? '';` (рядок ~938) і **перед** `if (action === 'start')`:

```javascript
  // Menu-level navigation (edit-in-place). Dialog actions fall through below.
  if (action === 'noop') { await ack(); return; }
  if (action === 'menu' || action === 'pick' || action === 'jobs') {
    let tenders = [];
    let jobs = [];
    try {
      if (action === 'pick') {
        const { watchlist } = await _loadWatchlist(env);
        const checked = await Promise.all(
          watchlist.filter((r) => r.enabled).map(async (r) => {
            try {
              const snap = _extractSnapshot(await _fetchTender(r.tender_id));
              if (snap.status !== 'active.tendering') return null;
              let preparedUrl = null;
              try {
                const j = await _loadAgentJob(env, r.tender_id);
                if (j && j.status === 'done' && j.result?.drive_link) preparedUrl = j.result.drive_link;
              } catch { /* link optional */ }
              return { ...r, preparedUrl };
            } catch { return null; }
          }),
        );
        tenders = checked.filter(Boolean);
      } else if (action === 'jobs') {
        jobs = await _listAgentJobs(env);
      }
    } catch (err) {
      console.error('worker: agent menu nav load failed:', err.message);
      await ack('⚠️ Prozorro/GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleAgentMenuNav({ tenders, jobs, data });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: agent menu nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }
```

> `handleAgentMenuNav`, `buildAgentMenu` тощо імпортовані в Task 5 (3b). `_loadWatchlist`/`_loadAgentJob`/`_listAgentJobs` тепер у сигнатурі. Гейт `isAdmin` уже стоїть на гілці `agent:` (рядки 906–909) — додатково не треба.

- [ ] **Step 4: Запустити — проходить.** `node --test worker/test/handler.test.mjs` → PASS.

- [ ] **Step 5: Фінальна перевірка обох наборів + commit**

```bash
node --test test/commands.test.mjs
node --test worker/test/handler.test.mjs
node --test worker/test/github.test.mjs
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(agent): wire menu/pick/jobs callbacks (edit-in-place)"
```

---

## Self-Review

**Spec coverage (розділ 3):**
- Меню `🚀 / 📊` → Task 1 (`buildAgentMenu`) + Task 5 (`/agent`) ✓
- Вибір тендера з пагінацією + «назад» → Task 1 (`buildAgentPickView`) + Task 6 (`pick`) ✓
- Наявний флоу start/co/confirm/cancel без змін → Task 6 (fall-through) ✓
- «Останні задачі»: статуси + Drive-лінки, 6/стор, 20 останніх → Task 2 + Task 4 (`listAgentJobs`) + Task 6 (`jobs`) ✓
- Admin-only → гейт на гілці `agent:` (наявний) + `/agent` `if(!isAdmin)return` ✓

**Placeholder scan:** увесь код наведено; жодних TBD.

**Type consistency:** `buildAgentMenu()`, `buildAgentPickView({tenders,page})`, `buildAgentJobsPage({jobs,page})`, `handleAgentMenuNav({tenders,jobs,data})` — однакові скрізь; callback-схема `agent:menu` / `agent:pick:<p>` / `agent:jobs:<p>` / `agent:noop` + наявні `agent:start|co|confirm|cancel` не конфліктують (router повертає `null` для останніх); job-shape `{tender_id,company,status,created_at,result.drive_link}` узгоджений між `listAgentJobs`, `buildAgentJobsPage` і тестами; `listAgentJobs` reuse наявного `loadAgentJob`.
