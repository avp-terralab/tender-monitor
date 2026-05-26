# User-Action Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log mutating user actions (add/remove/watch/unwatch/unarchive + admin invite/revoke/role) by enriching the commit message that already accompanies each state change, and expose an admin-only `/log` command that reads them back.

**Architecture:** Each mutation already writes a file to the GitHub repo via the Contents API — one commit per change. We thread an actor+action descriptor into that commit's message (`audit: <action> <target> · <actor> [<chatId>/<role>]`). The git history becomes the audit log; `/log` reads recent commits via the commits API and formats them. No separate storage file, no second write.

**Tech Stack:** Node.js (ESM, built-ins only), `node:test`, Cloudflare Worker, GitHub Contents/Commits API. Pure logic lives in `commands.mjs`; I/O in `worker/src/github.mjs`; dispatch in `worker/src/handler.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-26-user-action-audit-log-design.md`

**Commit convention:** repo uses an area prefix (`audit:`, `telegram:`, `status:` …). End every commit message with the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

**Run tests with:** `node --test test/*.test.mjs worker/test/*.test.mjs` (or a single file, shown per task).

---

## File Structure

- `commands.mjs` — pure functions (no I/O). New: `sanitizeActor`, `formatAuditMessage`, `parseAuditCommit`, `auditPhrase`, `formatAuditLog`, `KYIV_DT_FMT`, `/log` parse branch, help/command-list entries.
- `worker/src/github.mjs` — GitHub I/O. New: optional `message` in `saveWatchlist`/`saveFile`; `fetchAuditLog`; extend `BOT_RE`.
- `worker/src/handler.mjs` — dispatch. New: actor descriptor; thread `auditMessage` through the four `…WithRetry` helpers + `applyUnarchive`; build descriptors per mutating branch; `/log` branch.
- `test/commands.test.mjs`, `worker/test/github.test.mjs`, `worker/test/handler.test.mjs` — tests alongside.

---

## Task 1: `sanitizeActor` + `formatAuditMessage` (pure)

**Files:**
- Modify: `commands.mjs` (add after `parseCommand`, i.e. after line 178)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `test/commands.test.mjs` (and add `sanitizeActor, formatAuditMessage` to the import block at the top):

```js
test('sanitizeActor: strips separators and newlines, collapses spaces', () => {
  assert.equal(sanitizeActor('Ан\nдрій · [x]'), 'Ан дрій x');
});

test('sanitizeActor: empty → "?"', () => {
  assert.equal(sanitizeActor(''), '?');
  assert.equal(sanitizeActor(null), '?');
});

test('sanitizeActor: caps length at 40', () => {
  assert.ok(sanitizeActor('a'.repeat(100)).length <= 40);
});

test('formatAuditMessage: builds audit line', () => {
  assert.equal(
    formatAuditMessage({ action: 'add', target: 'UA-2026-04-30-010542-a', actor: 'Андрій', chatId: '1', role: 'editor' }),
    'audit: add UA-2026-04-30-010542-a · Андрій [1/editor]'
  );
});

test('formatAuditMessage: null target → no double space', () => {
  assert.equal(
    formatAuditMessage({ action: 'role→editor', target: null, actor: 'admin', chatId: '9', role: 'admin' }),
    'audit: role→editor · admin [9/admin]'
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `sanitizeActor`/`formatAuditMessage` is not exported / not a function.

- [ ] **Step 3: Implement**

In `commands.mjs`, after `parseCommand` (line 178), add:

```js
// ── Audit log ────────────────────────────────────────────────────────────
// Mutating actions are recorded by enriching the commit message that already
// accompanies each state write. Format (parseable first line):
//   audit: <action> <target> · <actor> [<chatId>/<role>]

export function sanitizeActor(name) {
  return String(name ?? '')
    .replace(/[\r\n·\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '?';
}

export function formatAuditMessage({ action, target, actor, chatId, role }) {
  const t = target ? ` ${target}` : '';
  return `audit: ${action}${t} · ${sanitizeActor(actor)} [${chatId}/${role}]`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS (all 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "audit: add sanitizeActor + formatAuditMessage"
```

---

## Task 2: `parseAuditCommit` (pure) + round-trip

**Files:**
- Modify: `commands.mjs` (after `formatAuditMessage`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to imports: `parseAuditCommit`. Then:

```js
test('parseAuditCommit: parses a full line', () => {
  assert.deepEqual(
    parseAuditCommit('audit: add UA-2026-04-30-010542-a · Андрій Парасина [786078813/editor]'),
    { action: 'add', target: 'UA-2026-04-30-010542-a', actor: 'Андрій Парасина', chatId: '786078813', role: 'editor' }
  );
});

test('parseAuditCommit: parses role→ and chat_id target', () => {
  assert.deepEqual(
    parseAuditCommit('audit: role→editor 7321709183 · admin [9/admin]'),
    { action: 'role→editor', target: '7321709183', actor: 'admin', chatId: '9', role: 'admin' }
  );
});

test('parseAuditCommit: returns null for non-audit messages', () => {
  assert.equal(parseAuditCommit('bot: update watchlist 2026-05-26T00:00:00Z'), null);
  assert.equal(parseAuditCommit('monitor: state update'), null);
  assert.equal(parseAuditCommit(''), null);
});

test('parseAuditCommit: round-trips formatAuditMessage (cyrillic name with spaces)', () => {
  const x = { action: 'invite', target: 'editor:Олег', actor: 'Андрій Парасина', chatId: '786078813', role: 'admin' };
  const parsed = parseAuditCommit(formatAuditMessage(x));
  assert.deepEqual(parsed, x);
});

test('parseAuditCommit: only reads the first line', () => {
  const msg = 'audit: remove UA-2026-05-01-012131-a · Оксана [7321709183/editor]\n\nbody text';
  assert.equal(parseAuditCommit(msg).action, 'remove');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `parseAuditCommit` not a function.

- [ ] **Step 3: Implement**

After `formatAuditMessage`, add:

```js
export function parseAuditCommit(message) {
  const line = String(message ?? '').split('\n')[0];
  const m = line.match(/^audit:\s+(\S+)(?:\s+(.+?))?\s+·\s+(.+?)\s+\[([^\/\]]+)\/([^\]]+)\]\s*$/);
  if (!m) return null;
  return { action: m[1], target: m[2] ?? null, actor: m[3], chatId: m[4], role: m[5] };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "audit: add parseAuditCommit with round-trip coverage"
```

---

## Task 3: `auditPhrase` + `formatAuditLog` (pure)

**Files:**
- Modify: `commands.mjs` (after `parseAuditCommit`; add `KYIV_DT_FMT` near the existing `KYIV_HM_FMT`)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to imports: `formatAuditLog`. Then:

```js
const D = '2026-05-26T11:32:00Z'; // 14:32 Kyiv (UTC+3)

test('formatAuditLog: empty → placeholder', () => {
  assert.match(formatAuditLog([], { limit: 20 }), /порожній/);
});

test('formatAuditLog: renders date, actor, and per-action phrase', () => {
  const out = formatAuditLog([
    { action: 'add', target: 'UA-2026-04-30-010542-a', actor: 'Андрій', date: D },
  ], { limit: 20 });
  assert.match(out, /26\.05 14:32/);
  assert.match(out, /Андрій додав UA-2026-04-30-010542-a/);
});

test('formatAuditLog: phrase per action', () => {
  const mk = (action, target) => formatAuditLog([{ action, target, actor: 'X', date: D }], { limit: 20 });
  assert.match(mk('remove', 'UA-x'), /видалив UA-x/);
  assert.match(mk('watch', '12345678'), /почав стеження за 12345678/);
  assert.match(mk('unwatch', '12345678'), /прибрав стеження за 12345678/);
  assert.match(mk('unarchive', 'UA-x'), /повернув з архіву UA-x/);
  assert.match(mk('invite', 'editor:Олег'), /видав invite \(editor: Олег\)/);
  assert.match(mk('revoke', '123'), /прибрав доступ 123/);
  assert.match(mk('role→editor', '123'), /змінив роль 123 → editor/);
});

test('formatAuditLog: escapes HTML in actor', () => {
  const out = formatAuditLog([{ action: 'add', target: 'UA-x', actor: '<b>x</b>', date: D }], { limit: 20 });
  assert.doesNotMatch(out, /<b>x<\/b>/);
  assert.match(out, /&lt;b&gt;/);
});

test('formatAuditLog: respects limit', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ action: 'add', target: `UA-${i}`, actor: 'X', date: D }));
  const out = formatAuditLog(entries, { limit: 5 });
  assert.match(out, /останні 5/);
  assert.equal((out.match(/^•/gm) || []).length, 5);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `formatAuditLog` not a function.

- [ ] **Step 3: Implement**

Near the existing `KYIV_HM_FMT` declaration in `commands.mjs`, add:

```js
const KYIV_DT_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
```

After `parseAuditCommit`, add (`escapeHtml` already exists in this module):

```js
function auditPhrase(e) {
  const tgt = e.target ?? '';
  switch (e.action) {
    case 'add':       return `додав ${tgt}`;
    case 'remove':    return `видалив ${tgt}`;
    case 'watch':     return `почав стеження за ${tgt}`;
    case 'unwatch':   return `прибрав стеження за ${tgt}`;
    case 'unarchive': return `повернув з архіву ${tgt}`;
    case 'revoke':    return `прибрав доступ ${tgt}`;
    case 'invite': {
      const [role, ...rest] = tgt.split(':');
      const label = rest.join(':');
      return `видав invite (${role}: ${label})`;
    }
    default:
      if (e.action.startsWith('role→')) {
        return `змінив роль ${tgt} → ${e.action.slice('role→'.length)}`;
      }
      return `${e.action} ${tgt}`.trim();
  }
}

export function formatAuditLog(entries, { limit }) {
  if (!entries || entries.length === 0) {
    return '📋 Журнал порожній — поки немає зафіксованих дій.';
  }
  const shown = entries.slice(0, limit);
  const lines = shown.map(e => {
    const when = e.date ? KYIV_DT_FMT.format(new Date(e.date)) : '??';
    return `• ${when} — ${escapeHtml(e.actor)} ${auditPhrase(e)}`;
  });
  return `📋 Журнал дій (останні ${shown.length})\n\n` + lines.join('\n');
}
```

> Note on the Kyiv-time test: the format formatter renders `день.місяць год:хв`; the comment in the test fixture (`14:32 Kyiv`) assumes UTC+3 summer offset for `2026-05-26`. The assertion matches `26.05 14:32`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "audit: add formatAuditLog + per-action phrasing"
```

---

## Task 4: `parseCommand('/log')` (pure)

**Files:**
- Modify: `commands.mjs:47` (insert after the `/whoami` matcher, line 47)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('parseCommand: /log default limit 20', () => {
  assert.deepEqual(parseCommand('/log'), { cmd: 'log', limit: 20 });
});
test('parseCommand: /log N', () => {
  assert.deepEqual(parseCommand('/log 5'), { cmd: 'log', limit: 5 });
});
test('parseCommand: /log caps at 50', () => {
  assert.deepEqual(parseCommand('/log 999'), { cmd: 'log', limit: 50 });
});
test('parseCommand: /log floors at 1', () => {
  assert.deepEqual(parseCommand('/log 0'), { cmd: 'log', limit: 1 });
});
test('parseCommand: /log abc → unknown', () => {
  assert.deepEqual(parseCommand('/log abc'), { cmd: 'unknown' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — `/log` currently returns `{ cmd: 'unknown' }`.

- [ ] **Step 3: Implement**

In `parseCommand`, immediately after the `/whoami` line (`commands.mjs:47`):

```js
  if (/^\/whoami(?:@\w+)?$/i.test(trimmed)) return { cmd: 'whoami' };

  const logMatch = trimmed.match(/^\/log(?:@\w+)?(?:\s+(\d+))?\s*$/i);
  if (logMatch) {
    const n = logMatch[1] ? parseInt(logMatch[1], 10) : 20;
    return { cmd: 'log', limit: Math.min(Math.max(n, 1), 50) };
  }
```

(The `/log abc` case falls through to the existing `if (trimmed.startsWith('/')) return { cmd: 'unknown' };`.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "audit: parse /log [N] command"
```

---

## Task 5: `/log` in help text + command list (pure)

**Files:**
- Modify: `commands.mjs` — `HELP_ADMIN` (line 1093-1101) and `ADMIN_COMMANDS` (line 1183-1190)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('buildHelpText: admin includes /log', () => {
  assert.match(buildHelpText('admin'), /\/log/);
});
test('buildHelpText: editor/viewer do not include /log', () => {
  assert.doesNotMatch(buildHelpText('editor'), /\/log/);
  assert.doesNotMatch(buildHelpText('viewer'), /\/log/);
});
test('BOT_COMMANDS_BY_ROLE: only admin has log', () => {
  assert.ok(BOT_COMMANDS_BY_ROLE.admin.some(c => c.command === 'log'));
  assert.ok(!BOT_COMMANDS_BY_ROLE.editor.some(c => c.command === 'log'));
  assert.ok(!BOT_COMMANDS_BY_ROLE.viewer.some(c => c.command === 'log'));
});
test('BOT_COMMANDS_BY_ROLE: all command names within Telegram 32-char limit', () => {
  for (const set of Object.values(BOT_COMMANDS_BY_ROLE)) {
    for (const c of set) assert.ok(c.command.length <= 32);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commands.test.mjs`
Expected: FAIL — help/commands lack `log`.

- [ ] **Step 3: Implement**

In `HELP_ADMIN` (after the `/revoke` line), add:
```js
  '/revoke [chat_id] — видалити користувача',
  '/log [N] — журнал дій користувачів (хто що додав/видалив)',
].join('\n');
```

In `ADMIN_COMMANDS` (after the `revoke` entry), add:
```js
  { command: 'revoke',  description: 'Видалити користувача' },
  { command: 'log',     description: 'Журнал дій користувачів' },
];
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "audit: surface /log in admin help + command list"
```

---

## Task 6: optional commit `message` in `saveWatchlist` + `saveFile`

**Files:**
- Modify: `worker/src/github.mjs` — `saveWatchlist` (line 58-88), `saveFile` (line 111-140)
- Test: `worker/test/github.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/github.test.mjs`:

```js
test('saveWatchlist: uses custom message when provided', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch, message: 'audit: add UA-x · A [1/editor]' });
  assert.equal(JSON.parse(calls[0].opts.body).message, 'audit: add UA-x · A [1/editor]');
});

test('saveWatchlist: default message unchanged when no message (back-compat)', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch });
  assert.match(JSON.parse(calls[0].opts.body).message, /^bot: update watchlist /);
});

test('saveAllowedUsers: threads custom message through saveFile', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveAllowedUsers(ENV, [], 'sha', { fetch: fakeFetch, message: 'audit: revoke 1 · admin [9/admin]' });
  assert.equal(JSON.parse(calls[0].opts.body).message, 'audit: revoke 1 · admin [9/admin]');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/github.test.mjs`
Expected: FAIL — message is still the hardcoded `bot: update …` for the custom-message cases.

- [ ] **Step 3: Implement**

In `saveWatchlist` (line 58), change the signature and message:
```js
export async function saveWatchlist(env, watchlist, sha, { fetch: fetchImpl = fetch, message } = {}) {
  const json = JSON.stringify(watchlist, null, 2) + '\n';
  const bytes = new TextEncoder().encode(json);
  const base64 = btoa(String.fromCharCode(...bytes));
  const body = {
    message: message ?? `bot: update watchlist ${new Date().toISOString()}`,
    content: base64,
    sha,
    branch: 'main',
  };
```

In `saveFile` (line 111), change the signature and message:
```js
async function saveFile(env, filePath, text, sha, { fetch: fetchImpl = fetch, message } = {}) {
  const bytes = new TextEncoder().encode(text);
  const base64 = btoa(String.fromCharCode(...bytes));
  const body = {
    message: message ?? `bot: update ${filePath} ${new Date().toISOString()}`,
    content: base64,
    branch: 'main',
  };
  if (sha != null) body.sha = sha;
```

(The wrappers `saveWatchedEntities`/`saveWatchedSeen`/`saveInvites`/`saveAllowedUsers`/`saveArchivedTenders` already forward `opts` to `saveFile`, so `opts.message` reaches it with no signature change.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/github.test.mjs`
Expected: PASS (including the unchanged existing `^bot: update watchlist` test at line 80).

- [ ] **Step 5: Commit**

```bash
git add worker/src/github.mjs worker/test/github.test.mjs
git commit -m "audit: allow custom commit message in save functions"
```

---

## Task 7: `fetchAuditLog` + extend `BOT_RE`

**Files:**
- Modify: `worker/src/github.mjs` — add `fetchAuditLog`; extend `BOT_RE` in `fetchLatestDeployCommit` (line 242)
- Test: `worker/test/github.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `fetchAuditLog, fetchLatestDeployCommit` to the import block at the top of `worker/test/github.test.mjs`, then:

```js
test('fetchAuditLog: returns first lines + dates', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { sha: 'a', commit: { message: 'audit: add UA-x · A [1/editor]\n\nbody', committer: { date: '2026-05-26T10:00:00Z' } } },
    { sha: 'b', commit: { message: 'bot: update watchlist 2026', committer: { date: '2026-05-26T09:00:00Z' } } },
  ]) });
  const out = await fetchAuditLog(ENV, { fetch: fakeFetch });
  assert.deepEqual(out, [
    { message: 'audit: add UA-x · A [1/editor]', date: '2026-05-26T10:00:00Z' },
    { message: 'bot: update watchlist 2026', date: '2026-05-26T09:00:00Z' },
  ]);
});

test('fetchAuditLog: throws on non-ok', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => fetchAuditLog(ENV, { fetch: fakeFetch }), /500/);
});

test('fetchLatestDeployCommit: skips audit: commits', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { sha: 'aaaaaaa', commit: { message: 'audit: add UA-x · A [1/editor]', committer: { date: '2026-05-26T10:00:00Z' } } },
    { sha: 'ddddddd', commit: { message: 'telegram: ship feature', committer: { date: '2026-05-25T10:00:00Z' } } },
  ]) });
  const out = await fetchLatestDeployCommit(ENV, { fetch: fakeFetch });
  assert.equal(out.message, 'telegram: ship feature');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/github.test.mjs`
Expected: FAIL — `fetchAuditLog` not exported; `fetchLatestDeployCommit` still returns the `audit:` commit.

- [ ] **Step 3: Implement**

In `worker/src/github.mjs`, append `fetchAuditLog` (after `fetchLatestDeployCommit`):

```js
// Reads recent commits on main and returns their first-line message + date.
// /log filters these by the `audit:` prefix to reconstruct the action log.
export async function fetchAuditLog(env, { fetch: fetchImpl = fetch, perPage = 100 } = {}) {
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/commits?per_page=${perPage}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'tender-monitor-worker',
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub commits API ${res.status}`);
  const commits = await res.json();
  return commits.map(c => ({
    message: (c.commit?.message ?? '').split('\n')[0],
    date: c.commit?.committer?.date ?? null,
  }));
}
```

In `fetchLatestDeployCommit`, extend `BOT_RE` (line 242):
```js
  const BOT_RE = /^(monitor: state update|monitor: cursor sync|bot:|audit:)/;
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/github.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/github.mjs worker/test/github.test.mjs
git commit -m "audit: add fetchAuditLog + exclude audit commits from deploy detection"
```

---

## Task 8: handler — actor descriptor + audit on watchlist mutations (`/add`, `/remove`, callback `add:`)

**Files:**
- Modify: `worker/src/handler.mjs` — import `formatAuditMessage`; actor descriptor (after line 81); `applyMutationWithRetry` (line 702); `/add` branch (line 194), `/remove` branch (line 208); callback `add:` (line 678)
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `worker/test/handler.test.mjs`, add a helper to capture the save options and tests. Admin chat is `'123'` (env), so admin = implicit editor.

```js
test('runHandler: /add records audit commit message with actor + role', async () => {
  let savedOpts;
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_env, _wl, _sha, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.ok(savedOpts, 'saveWatchlist received opts');
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Андрій \\[123/admin\\]$`));
});

test('runHandler: /remove records audit commit message', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [{ tender_id: ID, enabled: true }], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: remove ${ID} `));
});

test('runHandler: /remove no-op does NOT save (nothing to log)', async () => {
  let saved = false;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async () => { saved = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(saved, false);
});

test('runHandler: actor falls back to allowed_users label when from is absent', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Оксана', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Оксана \\[456/editor\\]$`));
});

test('runHandler: actor name with separators is sanitized in commit message', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Ан·ій', last_name: '[x]' }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  // sanitized message must still parse back cleanly
  const { parseAuditCommit } = await import('../../commands.mjs');
  assert.ok(parseAuditCommit(savedOpts.message), 'message remains parseable');
});

test('runHandler: callback add: records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 's' }),
    saveWatchlist: async (_e, _w, _s, opts) => { savedOpts = opts; },
    editMessageReplyMarkup: async () => {},
    answerCallbackQuery: async () => {},
  });
  await runHandler({
    update: { callback_query: { id: 'cq1', data: `add:${ID}`, from: { first_name: 'Оксана' }, message: { chat: { id: 123 }, message_id: 5 } } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: add ${ID} · Оксана `));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `savedOpts.message` is `undefined` (handler doesn't pass a message yet).

- [ ] **Step 3: Implement**

Add the import (top of `handler.mjs`, in the `../../commands.mjs` import list):
```js
  formatInfo, buildHelpText, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD,
  TERMINAL_STATUSES, hydrateContractDocs,
  formatAuditMessage,
} from '../../commands.mjs';
```

After `resolveUserContext` (line 81), compute the actor name:
```js
  const { isAdmin, isInvited, isAllowed, isEditor, role, userRecord } =
    await resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where: 'msg' });

  const actorName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || userRecord?.label || chatId;
```

Thread `auditMessage` through `applyMutationWithRetry` (line 702):
```js
async function applyMutationWithRetry({ env, loadWatchlist, saveWatchlist, computeMutation, auditMessage }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { watchlist, sha } = await loadWatchlist(env);
      const result = await computeMutation({ watchlist });
      if (!result.mutation) return result.reply;
      const newWatchlist = applyMutation(watchlist, result.mutation);
      await saveWatchlist(env, newWatchlist, sha, { message: auditMessage });
      return result.reply;
    } catch (err) {
      // ... unchanged ...
```

In the `/add` branch (line 194), add `auditMessage`:
```js
      reply = await applyMutationWithRetry({
        env,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        auditMessage: formatAuditMessage({ action: 'add', target: cmd.tender_id, actor: actorName, chatId, role }),
        computeMutation: ({ watchlist }) =>
          handleAdd({ watchlist, archive, fetchTender: _fetchTender, extractSnapshot: _extractSnapshot }, cmd),
      });
```

In the `/remove` branch (line 208):
```js
      reply = await applyMutationWithRetry({
        env,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        auditMessage: formatAuditMessage({ action: 'remove', target: cmd.tender_id, actor: actorName, chatId, role }),
        computeMutation: ({ watchlist }) => handleRemove({ watchlist }, cmd),
      });
```

For the callback `add:` path, `handleCallbackQuery` needs the actor. Add an actor computation there (after `resolveUserContext`, line 624):
```js
  const { isAdmin, isAllowed, isEditor, role } =
    await resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where: 'callback' });
  const actorName = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ') || chatId;
```
Then in the `add:` block (line 678), pass `auditMessage` to `applyMutationWithRetry`:
```js
    const result = await applyMutationWithRetry({
      env,
      loadWatchlist: _loadWatchlist,
      saveWatchlist: _saveWatchlist,
      auditMessage: formatAuditMessage({ action: 'add', target: tenderId, actor: actorName, chatId, role }),
      computeMutation: async ({ watchlist }) => {
        // ... unchanged ...
```
(`role` is now destructured from `resolveUserContext` in `handleCallbackQuery`; `formatAuditMessage` is already imported at module top.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "audit: log /add, /remove, and add: button with actor"
```

---

## Task 9: handler — audit on entity mutations (`/watch`, `/unwatch`)

**Files:**
- Modify: `worker/src/handler.mjs` — `applyEntityMutationWithRetry` (line 766); `/watch` branch (line 384), `/unwatch` branch (line 414)
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('runHandler: /watch records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [], sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
    searchTenderByEdrpou: async () => ({ name: 'КНП', ids: [] }),
    fetchTendersFeed: async () => ({ items: [], next: null }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: '/watch 12345678', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: watch 12345678 · Андрій \[123\/admin\]$/);
});

test('runHandler: /unwatch records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadWatchedEntities: async () => ({ entities: [{ edrpou: '12345678', name: 'КНП', enabled: true }], sha: 's' }),
    saveWatchedEntities: async (_e, _ent, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: { first_name: 'Андрій' }, text: '/unwatch 12345678', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: unwatch 12345678 /);
});
```

> If the existing `searchTenderByEdrpou`/`fetchTendersFeed` defaults in `makeDeps` already yield a successful `/watch` mutation, drop the redundant overrides above — keep only the `loadWatchedEntities`/`saveWatchedEntities` capture. Confirm by checking the existing `/watch` success test in this file.

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `savedOpts.message` undefined.

- [ ] **Step 3: Implement**

Thread `auditMessage` through `applyEntityMutationWithRetry` (line 766):
```js
async function applyEntityMutationWithRetry({ env, loadWatchedEntities, saveWatchedEntities, computeMutation, onSuccess, auditMessage }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { entities, sha } = await loadWatchedEntities(env);
      const result = await computeMutation({ entities });
      if (!result.mutation) return result.reply;
      const newEntities = applyEntityMutation(entities, result.mutation);
      await saveWatchedEntities(env, newEntities, sha, { message: auditMessage });
      if (onSuccess) await onSuccess(result.mutation);
      return result.reply;
    } catch (err) {
      // ... unchanged ...
```

`/watch` branch (line 384) — add `auditMessage`:
```js
      reply = await applyEntityMutationWithRetry({
        env,
        loadWatchedEntities: _loadWatchedEntities,
        saveWatchedEntities: _saveWatchedEntities,
        auditMessage: formatAuditMessage({ action: 'watch', target: cmd.edrpou, actor: actorName, chatId, role }),
        computeMutation: ({ entities }) => handleWatch({ /* unchanged */ }, cmd),
        onSuccess: async (mutation) => { /* unchanged */ },
      });
```

`/unwatch` branch (line 414):
```js
      reply = await applyEntityMutationWithRetry({
        env,
        loadWatchedEntities: _loadWatchedEntities,
        saveWatchedEntities: _saveWatchedEntities,
        auditMessage: formatAuditMessage({ action: 'unwatch', target: cmd.edrpou, actor: actorName, chatId, role }),
        computeMutation: ({ entities }) => handleUnwatch({ watchedEntities: entities }, cmd),
      });
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "audit: log /watch and /unwatch with actor"
```

---

## Task 10: handler — audit on admin + archive mutations (`/invite`, `/revoke`, `/role`, `/unarchive`)

**Files:**
- Modify: `worker/src/handler.mjs` — `applyInviteMutationWithRetry` (line 745), `applyAllowedUsersMutationWithRetry` (line 724), `applyUnarchive` (line 843); `/invite` (line 438), `/revoke` (line 471), `/role` (line 490), `/unarchive` (line 537) branches
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
const ADMIN_FROM = { first_name: 'Адмін' };

test('runHandler: /invite records audit commit (label sanitized)', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 's' }),
    saveInvites: async (_e, _inv, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/invite editor Олег', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: invite editor:Олег /);
});

test('runHandler: /revoke records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X', role: 'viewer' }], sha: 's' }),
    saveAllowedUsers: async (_e, _u, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/revoke 456', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: revoke 456 /);
});

test('runHandler: /role records audit commit with role suffix', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X', role: 'viewer' }], sha: 's' }),
    saveAllowedUsers: async (_e, _u, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: '/role editor 456', message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, /^audit: role→editor 456 /);
});

test('runHandler: /unarchive records audit commit', async () => {
  let savedOpts;
  const { deps } = makeDeps({
    loadArchivedTenders: async () => ({ archive: [{ tender_id: ID, notes: '' }], sha: 's' }),
    saveArchivedTenders: async (_e, _a, _s, opts) => { savedOpts = opts; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, from: ADMIN_FROM, text: `/unarchive ${ID}`, message_id: 1 } },
    env: ENV, deps,
  });
  assert.match(savedOpts.message, new RegExp(`^audit: unarchive ${ID} `));
});
```

> Check the existing `handleRole`/`handleRevoke`/`handleUnarchive` success tests in this file to confirm the load-dep shapes above match (e.g. whether `/role` requires the target user to currently differ in role). Adjust the fixture users so the mutation is non-null.

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `savedOpts.message` undefined.

- [ ] **Step 3: Implement**

Thread `auditMessage` into the three helpers:

`applyInviteMutationWithRetry` (line 745):
```js
async function applyInviteMutationWithRetry({ env, loadInvites, saveInvites, computeMutation, auditMessage }) {
  // ...
      await saveInvites(env, next, sha, { message: auditMessage });
  // ...
```

`applyAllowedUsersMutationWithRetry` (line 724):
```js
async function applyAllowedUsersMutationWithRetry({ env, loadAllowedUsers, saveAllowedUsers, computeMutation, auditMessage }) {
  // ...
      await saveAllowedUsers(env, next, sha, { message: auditMessage });
  // ...
```

`applyUnarchive` (line 843) — add `auditMessage` param and pass it:
```js
async function applyUnarchive({ env, loadArchivedTenders, saveArchivedTenders, tender_id, auditMessage }) {
  try {
    const { archive, sha } = await loadArchivedTenders(env);
    const result = handleUnarchive({ archive }, { tender_id });
    if (!result.archiveMutation) return result.reply;
    const newArchive = applyArchiveMutation(archive, result.archiveMutation);
    await saveArchivedTenders(env, newArchive, sha, { message: auditMessage });
    return result.reply;
  } catch (err) {
    // ... unchanged ...
```

Add `auditMessage` at the four call sites:

`/invite` (line 438) — note label is free text, so sanitize via the same builder by embedding it in `target`:
```js
      reply = await applyInviteMutationWithRetry({
        env,
        loadInvites: _loadInvites,
        saveInvites: _saveInvites,
        auditMessage: formatAuditMessage({ action: 'invite', target: `${cmd.role}:${cmd.label}`, actor: actorName, chatId, role }),
        computeMutation: ({ invites }) =>
          handleInvite({ invites, generateToken: _generateToken, now: _now, botUsername: BOT_USERNAME }, cmd),
      });
```
(`formatAuditMessage` only sanitizes `actor`, not `target`. The invite `target` carries the free-text label, so wrap it: use `` `${cmd.role}:${sanitizeActor(cmd.label)}` ``. Import `sanitizeActor` alongside `formatAuditMessage` at the top of `handler.mjs`.)

Corrected `/invite` line:
```js
        auditMessage: formatAuditMessage({ action: 'invite', target: `${cmd.role}:${sanitizeActor(cmd.label)}`, actor: actorName, chatId, role }),
```

`/revoke` (line 471):
```js
      reply = await applyAllowedUsersMutationWithRetry({
        env,
        loadAllowedUsers: _loadAllowedUsers,
        saveAllowedUsers: _saveAllowedUsers,
        auditMessage: formatAuditMessage({ action: 'revoke', target: cmd.chat_id, actor: actorName, chatId, role }),
        computeMutation: ({ users }) => handleRevoke({ allowedUsers: users, adminChatId }, cmd),
      });
```

`/role` (line 490):
```js
      reply = await applyAllowedUsersMutationWithRetry({
        env,
        loadAllowedUsers: _loadAllowedUsers,
        saveAllowedUsers: _saveAllowedUsers,
        auditMessage: formatAuditMessage({ action: `role→${cmd.role}`, target: cmd.chat_id, actor: actorName, chatId, role }),
        computeMutation: ({ users }) => handleRole({ allowedUsers: users, adminChatId }, cmd),
      });
```

`/unarchive` (line 537):
```js
      reply = await applyUnarchive({
        env,
        loadArchivedTenders: _loadArchivedTenders,
        saveArchivedTenders: _saveArchivedTenders,
        tender_id: cmd.tender_id,
        auditMessage: formatAuditMessage({ action: 'unarchive', target: cmd.tender_id, actor: actorName, chatId, role }),
      });
```

Update the import at the top of `handler.mjs`:
```js
  formatAuditMessage, sanitizeActor,
} from '../../commands.mjs';
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "audit: log /invite, /revoke, /role, /unarchive with actor"
```

---

## Task 11: handler — `/log` dispatch (admin-only)

**Files:**
- Modify: `worker/src/handler.mjs` — import `parseAuditCommit, formatAuditLog` + `fetchAuditLog`; deps injection; new `/log` branch (insert before the `unknown` branch, line 582)
- Test: `worker/test/handler.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
const COMMITS = [
  { message: 'audit: add UA-2026-04-30-010542-a · Андрій [786078813/editor]', date: '2026-05-26T11:00:00Z' },
  { message: 'bot: update watchlist 2026', date: '2026-05-26T10:30:00Z' },
  { message: 'monitor: state update', date: '2026-05-26T10:00:00Z' },
  { message: 'audit: revoke 1402480451 · admin [123/admin]', date: '2026-05-25T09:00:00Z' },
];

test('runHandler: /log (admin) renders parsed audit actions only', async () => {
  const { deps, sent } = makeDeps({ fetchAuditLog: async () => COMMITS });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/log', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Журнал дій/);
  assert.match(sent[0].text, /Андрій додав UA-2026-04-30-010542-a/);
  assert.match(sent[0].text, /admin прибрав доступ 1402480451/);
  assert.doesNotMatch(sent[0].text, /update watchlist/);
  assert.doesNotMatch(sent[0].text, /state update/);
});

test('runHandler: /log non-admin → silent skip', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X', role: 'editor' }], sha: 's' }),
    fetchAuditLog: async () => COMMITS,
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/log', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /log handles GitHub failure gracefully', async () => {
  const { deps, sent } = makeDeps({ fetchAuditLog: async () => { throw new Error('GitHub 500'); } });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/log', message_id: 1 } },
    env: ENV, deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /недоступн/);
});
```

Also add `fetchAuditLog: async () => []` to the `makeDeps` defaults so unrelated tests don't crash on the new dep.

- [ ] **Step 2: Run to verify failure**

Run: `node --test worker/test/handler.test.mjs`
Expected: FAIL — `/log` currently parses to `{ cmd: 'log' }` but has no dispatch branch → falls through to `return` (no reply), so `sent.length` is 0 for the admin case.

- [ ] **Step 3: Implement**

Imports at top of `handler.mjs`:
```js
  formatAuditMessage, sanitizeActor, parseAuditCommit, formatAuditLog,
} from '../../commands.mjs';
```
```js
  loadPendingDigest, loadTenderState, fetchLatestDeployCommit,
  fetchAuditLog,
  ConflictError,
} from './github.mjs';
```

Deps injection (near the other `_…` assignments, e.g. after line 62):
```js
  const _fetchAuditLog = deps.fetchAuditLog ?? fetchAuditLog;
```

New branch — insert before `} else if (cmd.cmd === 'unknown') {` (line 582):
```js
  } else if (cmd.cmd === 'log') {
    if (!isAdmin) return;
    try {
      const raw = await _fetchAuditLog(env);
      const entries = raw
        .map(c => { const p = parseAuditCommit(c.message); return p ? { ...p, date: c.date } : null; })
        .filter(Boolean);
      reply = formatAuditLog(entries, { limit: cmd.limit });
    } catch (err) {
      console.error('worker: /log failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'unknown') {
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "audit: add admin-only /log command"
```

---

## Task 12: Full suite + branch wrap-up

**Files:** none (verification)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: all suites pass (existing 160+ tests plus the new ones). Investigate and fix any regression — in particular confirm no existing test asserted the exact `bot: update …` message in a path that now sends `audit: …` (only mutating user-action paths changed; the no-message default is preserved).

- [ ] **Step 2: Manual sanity (optional, no live deploy)**

Confirm the round-trip end to end in a node REPL or scratch test: `parseAuditCommit(formatAuditMessage({action:'add',target:ID,actor:'A B',chatId:'1',role:'editor'}))` returns the same fields.

- [ ] **Step 3: Update README**

In `README.md`, under the admin-commands list (around line 41-44), add:
```
- `/log [N]` — журнал дій користувачів (хто додав/видалив тендер чи замовника, видав/забрав доступ). Читає історію комітів; показує останні N (дефолт 20).
```

- [ ] **Step 4: Commit docs**

```bash
git add README.md
git commit -m "docs: document /log audit command"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide merge/PR. Deployment note: merging to `main` triggers `worker-deploy.yml` (path-filtered on worker/commands/telegram changes) — the Worker redeploys automatically. No secrets or BotFather changes needed; the global command list stays viewer-only (admin sees `/log` via per-chat `setMyCommands` on next `/start` or reply).

---

## Self-Review Notes

- **Spec coverage:** format (Task 1), parse (Task 2), `/log` rendering (Task 3), `/log` parsing (Task 4), help/commands (Task 5), commit-message plumbing (Task 6), `fetchAuditLog`+`BOT_RE` (Task 7), actor+watchlist actions (Task 8), entity actions (Task 9), admin+archive actions (Task 10), `/log` dispatch (Task 11), README + verification (Task 12). All spec sections map to a task.
- **No-op handling:** verified in Task 8 (`/remove` no-op does not save) — matches spec "лог фіксує лише реальні зміни".
- **Invite label sanitization:** Task 10 wraps the free-text label with `sanitizeActor` before embedding in `target` — matches spec edge case.
- **Type consistency:** `formatAuditMessage({action,target,actor,chatId,role})` and `parseAuditCommit → {action,target,actor,chatId,role}` are used identically across tasks; `auditMessage` is the param name in all four `…WithRetry`/`applyUnarchive` helpers; `_fetchAuditLog` matches the `deps.fetchAuditLog` injection convention.
- **Excluded paths:** `/notify` deliberately left without `message` (Task 10/11 do not touch it) — stays `bot: update`, not in `/log`. `applyLiveArchive` untouched — system archive stays out of the audit feed.
