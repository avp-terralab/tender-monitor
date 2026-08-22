# Переїзд стану бота з GitHub на GitLab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести стан бота `tender-monitor` (watchlist, черга задач агента, архів тощо) з GitHub Contents API на GitLab API, з перемиканням одним прапорцем `STATE_BACKEND`, без переписування бізнес-логіки `handler.mjs`.

**Architecture:** Новий `worker/src/gitlab.mjs` дзеркалить усі 19 функцій `worker/src/github.mjs` під GitLab Repository Files/Tree/Commits API. Тонка прошарка `worker/src/state.mjs` обирає бекенд за `env.STATE_BACKEND`. `handler.mjs` міняє один рядок імпорту. `agent_poller.py` отримує аналогічний прапорець `cfg.backend`.

**Tech Stack:** Cloudflare Workers (ESM, `node --test`), GitLab CE 19.2 REST API v4, Python 3 (`urllib.request`), GitLab CI.

## Global Constraints

- Дизайн: `docs/superpowers/specs/2026-08-19-gitlab-state-backend-migration-design.md` — джерело істини для всіх рішень нижче.
- GitHub-бік (`worker-deploy.yml`, `monitor.yml`, продовий Worker) **не змінюється** до моменту cutover (Task 10) — жодна із задач 1-9 не торкається GitHub.
- Секрети — тільки в `.env`/masked CI-змінних, ніколи в коді чи закомічених файлах.
- `handler.mjs` (107 КБ) не рефакториться — лише один рядок імпорту (Task 5).
- Автентифікація GitLab API: заголовок `PRIVATE-TOKEN: <token>`, не `Authorization: Bearer`.
- API-контракти нижче **перевірені наживо** на `cl-gl.listerralab.com` (не з документації):
  - `GET /projects/:id/repository/files/:file_path?ref=<ref>` → 200 `{content (base64), last_commit_id, ...}` або 404.
  - `POST /projects/:id/repository/files/:file_path` (форма: `branch`, `content`, `commit_message`) — створення нового файлу.
  - `PUT /projects/:id/repository/files/:file_path` (форма: `branch`, `content`, `commit_message`, `last_commit_id`) — оновлення; конфлікт → **400**, тіло `{"message":"You are attempting to update a file that has changed since you started editing it."}` (НЕ 409, як GitHub).
  - `GET /projects/:id/repository/tree?path=<dir>&ref=<ref>` → 200 масив `{name, path, type: "blob"|"tree"}` або 404 якщо теки нема.
  - `GET /projects/:id/repository/commits?ref_name=<ref>&per_page=N` → масив `{short_id, title, committed_date, ...}`.

---

### Task 1: GitLab-проєкт `tender-monitor` і staging-гілка

**Files:** немає змін коду — інфраструктурні кроки через GitLab API/git.

**Interfaces:**
- Produces: проєкт `terralab-manual/tender-monitor` (GitLab, id відомий після створення), гілка `main` (копія поточного GitHub `main`), гілка `staging-state` (насіяна тими самими даними).

- [ ] **Крок 1: Створити проєкт**

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "name=tender-monitor" \
  --data-urlencode "namespace_id=14" \
  --data-urlencode "visibility=private" \
  --data-urlencode "initialize_with_readme=false" \
  "$GITLAB_URL/api/v4/projects"
```

Записати `id` з відповіді — використовується у всіх наступних задачах як `<PROJECT_ID>`.

- [ ] **Крок 2: Push поточного `main` з локальної теки**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git remote add gitlab https://cl-gl.listerralab.com/terralab-manual/tender-monitor.git
git -c http.extraHeader="PRIVATE-TOKEN: $GITLAB_TOKEN" push gitlab main
```

- [ ] **Крок 3: Перевірити, що `main` захищена автоматично (instance default)**

```bash
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<PROJECT_ID>/protected_branches"
```

Очікується: `main` із `push_access_levels: Maintainers`, `allow_force_push: false` — так само, як на `tender-agent`.

- [ ] **Крок 4: Створити `staging-state` з поточного стану**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git checkout -b staging-state
git -c http.extraHeader="PRIVATE-TOKEN: $GITLAB_TOKEN" push gitlab staging-state
git checkout main
```

Гілка стартує як точна копія `main` (включно з поточними `watchlist.json`/`_state/*`) — цього достатньо, дані тендерів публічні.

- [ ] **Крок 5: Додати запис у `docs/infrastructure.md` репозиторію `terralab-ai-bootstrap`**

За зразком запису про `tender-agent` (рядок у таблиці проєктів групи `terralab-manual`), плюс новий MR у `terralab-ai-bootstrap`.

- [ ] **Крок 6: Commit**

Це інфраструктурний крок без файлів коду в `tender-monitor` — коміт не потрібен тут; комітиться лише правка в `terralab-ai-bootstrap` (звичайний MR-цикл цього репозиторію).

---

### Task 2: Винести `ConflictError` у спільний модуль

**Files:**
- Create: `worker/src/state-errors.mjs`
- Modify: `worker/src/github.mjs:1-13` (прибрати локальний клас, імпортувати)
- Test: наявний `worker/test/github.test.mjs` не змінюється — `ConflictError` і далі імпортується з `../src/github.mjs` (github.mjs ре-експортує).

**Interfaces:**
- Produces: `export class ConflictError extends Error` у `state-errors.mjs`, з полем `status = 409`.
- Consumes: нічого.

- [ ] **Крок 1: Написати тест, що фіксує поточну поведінку `ConflictError` (regression guard)**

Додати на початок `worker/test/github.test.mjs` (перед наявними тестами):

```js
test('ConflictError: has status 409 and is instanceof Error', () => {
  const e = new ConflictError('conflict on x');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 409);
  assert.equal(e.name, 'ConflictError');
});
```

- [ ] **Крок 2: Прогнати тест — має пройти вже зараз (не впаде, бо клас іще тут)**

Run: `node --test worker/test/github.test.mjs`
Expected: PASS (це regression guard, не TDD-red — клас іще на місці).

- [ ] **Крок 3: Створити `worker/src/state-errors.mjs`**

```js
export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
    this.status = 409;
  }
}
```

- [ ] **Крок 4: Прибрати клас із `github.mjs`, імпортувати й ре-експортувати**

У `worker/src/github.mjs` замінити рядки 7-13 (визначення класу):

```js
export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
    this.status = 409;
  }
}
```

на:

```js
export { ConflictError } from './state-errors.mjs';
```

- [ ] **Крок 5: Прогнати весь тестовий набір Worker'а**

Run: `node --test worker/test/*.test.mjs`
Expected: PASS, без регресій (github.test.mjs і handler.test.mjs далі бачать той самий клас через ре-експорт).

- [ ] **Крок 6: Commit**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add worker/src/state-errors.mjs worker/src/github.mjs worker/test/github.test.mjs
git commit -m "worker: extract ConflictError into shared state-errors.mjs"
```

---

### Task 3: `worker/src/gitlab.mjs` — GitLab-бекенд стану

**Files:**
- Create: `worker/src/gitlab.mjs`
- Test: `worker/test/gitlab.test.mjs`

**Interfaces:**
- Consumes: `ConflictError` з `./state-errors.mjs` (Task 2).
- Produces: рівно ті самі 19 іменованих експортів, що й `github.mjs` — `fetchLastCommit`, `loadWatchlist`, `saveWatchlist`, `loadWatchedEntities`, `saveWatchedEntities`, `loadWatchedSeen`, `saveWatchedSeen`, `loadInvites`, `saveInvites`, `loadAllowedUsers`, `saveAllowedUsers`, `loadArchivedTenders`, `saveArchivedTenders`, `loadNotificationHistory`, `loadPendingDigest`, `loadTenderState`, `saveAgentJob`, `loadAgentJob`, `listAgentJobs`, `fetchLatestDeployCommit`, `fetchAuditLog`. Сигнатури ідентичні `github.mjs` — це те, на що спиратиметься `state.mjs` (Task 4).
- Читає з `env`: `GITLAB_TOKEN` (PRIVATE-TOKEN), `GITLAB_PROJECT_ID`, `GITLAB_REF` (типово `"main"`).

⚠️ **Критична деталь парності з `github.mjs`:** `loadWatchlist`/`saveWatchlist` у оригіналі **не проходять** через спільний приватний `loadFile`/`saveFile` — вони мають власний inline-fetch, і `loadWatchlist` **не толерує 404** (кидає помилку, якщо файла нема — на відміну від `loadWatchedEntities` та решти, які проходять через `loadFile` і на 404 повертають порожнє значення). Це поведінка оригіналу, не помилка — файл `watchlist.json` вважається завжди існуючим. Gitlab-версія повторює цю асиметрію рівно так само.

- [ ] **Крок 1: Написати `worker/test/gitlab.test.mjs` (падаючі тести)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWatchlist, saveWatchlist, ConflictError,
  loadWatchedEntities, saveWatchedEntities,
  loadInvites, saveInvites,
  saveAgentJob, listAgentJobs,
  fetchAuditLog, fetchLastCommit, fetchLatestDeployCommit,
} from '../src/gitlab.mjs';

const ENV = { GITLAB_TOKEN: 'glpat-TEST', GITLAB_PROJECT_ID: '99', GITLAB_REF: 'main' };

test('loadWatchlist: builds correct GET request against Files API', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    const json = JSON.stringify([{ tender_id: 'UA-X', enabled: true }]);
    const content = Buffer.from(json).toString('base64');
    return { ok: true, status: 200, json: async () => ({ content, last_commit_id: 'commit123' }) };
  };
  const result = await loadWatchlist(ENV, { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /projects\/99\/repository\/files\/watchlist\.json\?ref=main/);
  assert.equal(calls[0].opts.headers['PRIVATE-TOKEN'], 'glpat-TEST');
  assert.deepEqual(result.watchlist, [{ tender_id: 'UA-X', enabled: true }]);
  assert.equal(result.sha, 'commit123');
});

test('loadWatchlist: throws on 404 (does NOT tolerate missing file — matches github.mjs)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  await assert.rejects(() => loadWatchlist(ENV, { fetch: fakeFetch }), /404/);
});

test('saveWatchlist: builds PUT with last_commit_id and correct body', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const wl = [{ tender_id: 'UA-X', enabled: true }];
  await saveWatchlist(ENV, wl, 'oldCommit', { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /repository\/files\/watchlist\.json$/);
  assert.equal(calls[0].opts.method, 'PUT');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.last_commit_id, 'oldCommit');
  assert.equal(body.branch, 'main');
  const decoded = atob(body.content);
  assert.deepEqual(JSON.parse(decoded), wl);
});

test('saveWatchlist: throws ConflictError on 400 with "changed since" message', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ message: 'You are attempting to update a file that has changed since you started editing it.' }),
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof ConflictError
  );
});

test('saveWatchlist: throws plain Error on unrelated 400 (not a conflict)', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ message: 'branch is invalid' }),
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof Error && !(err instanceof ConflictError)
  );
});

test('loadWatchedEntities: 404 returns empty array (goes through tolerant loadFile)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const result = await loadWatchedEntities(ENV, { fetch: fakeFetch });
  assert.deepEqual(result.entities, []);
  assert.equal(result.sha, null);
});

test('saveWatchedEntities: POSTs (create) when sha is null', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201, json: async () => ({}) }; };
  await saveWatchedEntities(ENV, [{ edrpou: '1' }], null, { fetch: fakeFetch });
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(JSON.parse(calls[0].opts.body).last_commit_id, undefined);
});

test('saveWatchedEntities: PUTs (update) with last_commit_id when sha present', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveWatchedEntities(ENV, [{ edrpou: '1' }], 'commitAbc', { fetch: fakeFetch });
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(JSON.parse(calls[0].opts.body).last_commit_id, 'commitAbc');
});

test('loadInvites: 404 → empty list + null sha', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  const { invites, sha } = await loadInvites(ENV, { fetch: fakeFetch });
  assert.deepEqual(invites, []);
  assert.equal(sha, null);
});

test('saveAgentJob: existence GET (404) then POST create', async () => {
  const tid = 'UA-2026-08-19-000001-a';
  const job = { tender_id: tid, status: 'pending' };
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (!opts || opts.method === undefined) {
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }
    return { ok: true, status: 201, json: async () => ({}) };
  };
  await saveAgentJob(ENV, job, { fetch: fakeFetch });
  const post = calls.find(c => c.opts && c.opts.method === 'POST');
  assert.ok(post, 'a POST must be issued when the job file does not exist yet');
  assert.match(post.url, /_state%2Fagent_jobs%2FUA-2026-08-19-000001-a\.json/);
});

test('listAgentJobs: lists tree, filters .json blobs, sorts desc, caps 20', async () => {
  const jobA = { tender_id: 'UA-1', status: 'done', created_at: '2026-06-20T10:00:00Z' };
  const jobB = { tender_id: 'UA-2', status: 'pending', created_at: '2026-06-22T10:00:00Z' };
  const fakeFetch = async (url) => {
    if (/repository\/tree\?path=_state\/agent_jobs/.test(url)) {
      return { ok: true, status: 200, json: async () => ([
        { name: 'UA-1.json', path: '_state/agent_jobs/UA-1.json', type: 'blob' },
        { name: 'UA-2.json', path: '_state/agent_jobs/UA-2.json', type: 'blob' },
        { name: 'README.md', path: '_state/agent_jobs/README.md', type: 'blob' },
      ]) };
    }
    const job = /UA-1\.json/.test(url) ? jobA : jobB;
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(job)).toString('base64'), last_commit_id: 's' }) };
  };
  const jobs = await listAgentJobs(ENV, { fetch: fakeFetch });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].tender_id, 'UA-2'); // newest first
});

test('listAgentJobs: 404 (missing tree) → empty array', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  assert.deepEqual(await listAgentJobs(ENV, { fetch: fakeFetch }), []);
});

test('fetchLastCommit: maps GitLab commit shape (short_id/committed_date/title)', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { short_id: 'abc1234', committed_date: '2026-08-19T10:00:00Z', title: 'monitor: state update 2026' },
  ]) });
  const out = await fetchLastCommit(ENV, { fetch: fakeFetch });
  assert.deepEqual(out, { sha: 'abc1234', date: '2026-08-19T10:00:00Z', message: 'monitor: state update 2026' });
});

test('fetchLatestDeployCommit: skips bot-authored commits (same BOT_RE as github.mjs)', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { short_id: 'aaa1111', title: 'agent job UA-X: done', committed_date: '2026-06-27T08:00:00Z' },
    { short_id: 'bbb2222', title: 'feat: add history view', committed_date: '2026-06-25T10:00:00Z' },
  ]) });
  const out = await fetchLatestDeployCommit(ENV, { fetch: fakeFetch });
  assert.equal(out.message, 'feat: add history view');
});

test('fetchAuditLog: maps title+committed_date for each commit', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { title: 'audit: add UA-x · A [1/editor]', committed_date: '2026-05-26T10:00:00Z' },
  ]) });
  const out = await fetchAuditLog(ENV, { fetch: fakeFetch });
  assert.deepEqual(out, [{ message: 'audit: add UA-x · A [1/editor]', date: '2026-05-26T10:00:00Z' }]);
});
```

- [ ] **Крок 2: Прогнати — має впасти (модуля ще нема)**

Run: `node --test worker/test/gitlab.test.mjs`
Expected: FAIL з `Cannot find module '../src/gitlab.mjs'`

- [ ] **Крок 3: Написати `worker/src/gitlab.mjs`**

```js
import { ConflictError } from './state-errors.mjs';

const API_BASE = 'https://cl-gl.listerralab.com/api/v4';
const WATCHLIST_FILE = 'watchlist.json';
const ENTITIES_FILE = 'watched_entities.json';
const SEEN_FILE = '_state/_watched_seen.json';
const INVITES_FILE = '_state/invites.json';
const ALLOWED_USERS_FILE = '_state/allowed_users.json';
const ARCHIVED_TENDERS_FILE = '_state/archived_tenders.json';
const NOTIFICATION_HISTORY_FILE = '_state/notification_history.json';
const PENDING_DIGEST_FILE = '_state/_pending_digest.json';

function glError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function projectUrl(env) {
  return `${API_BASE}/projects/${env.GITLAB_PROJECT_ID}`;
}

function ref(env) {
  return env.GITLAB_REF ?? 'main';
}

function authHeaders(env, extra = {}) {
  return { 'PRIVATE-TOKEN': env.GITLAB_TOKEN, ...extra };
}

function encodeFilePath(filePath) {
  return encodeURIComponent(filePath);
}

// Same 400-with-message convention GitLab uses for a stale last_commit_id.
// Everything else on 400 is a genuine bad request, not a conflict.
const CONFLICT_MESSAGE_RE = /changed since you started editing/;

async function throwOnBadResponse(res, verb, target) {
  if (res.status === 400) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }
    if (CONFLICT_MESSAGE_RE.test(parsed.message ?? '')) {
      throw new ConflictError(`GitLab ${verb} 400 conflict on ${target}`);
    }
    throw glError(`GitLab ${verb} 400: ${text}`, 400);
  }
  if (!res.ok) throw glError(`GitLab ${verb} ${res.status}: ${await res.text()}`, res.status);
}

export async function fetchLastCommit(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/commits?ref_name=${ref(env)}&per_page=1`,
    { headers: authHeaders(env) }
  );
  if (!res.ok) throw glError(`GitLab GET ${res.status}: ${await res.text()}`, res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const c = arr[0];
  return {
    sha: c.short_id ?? (c.id ?? '').slice(0, 7),
    date: c.committed_date ?? null,
    message: (c.title ?? '').split('\n')[0],
  };
}

// loadWatchlist/saveWatchlist mirror github.mjs's own hand-rolled pair —
// deliberately NOT routed through loadFile/saveFile below. watchlist.json is
// assumed to always exist; a 404 here is a real error, not "file missing".
export async function loadWatchlist(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/files/${encodeFilePath(WATCHLIST_FILE)}?ref=${ref(env)}`,
    { headers: authHeaders(env) }
  );
  if (!res.ok) throw glError(`GitLab GET ${res.status}: ${await res.text()}`, res.status);
  const { content, last_commit_id } = await res.json();
  const bytes = Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return { watchlist: JSON.parse(text), sha: last_commit_id };
}

export async function saveWatchlist(env, watchlist, sha, { fetch: fetchImpl = fetch, message } = {}) {
  const json = JSON.stringify(watchlist, null, 2) + '\n';
  const bytes = new TextEncoder().encode(json);
  const base64 = btoa(String.fromCharCode(...bytes));
  const body = {
    commit_message: message ?? `bot: update watchlist ${new Date().toISOString()}`,
    content: base64,
    last_commit_id: sha,
    branch: ref(env),
  };
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/files/${encodeFilePath(WATCHLIST_FILE)}`,
    { method: 'PUT', headers: authHeaders(env, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }
  );
  await throwOnBadResponse(res, 'PUT', WATCHLIST_FILE);
  return res.json();
}

async function loadFile(env, filePath, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/files/${encodeFilePath(filePath)}?ref=${ref(env)}`,
    { headers: authHeaders(env) }
  );
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw glError(`GitLab GET ${res.status}: ${await res.text()}`, res.status);
  const { content, last_commit_id } = await res.json();
  const bytes = Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return { content: text, sha: last_commit_id };
}

// sha == null → file doesn't exist yet → POST (create).
// sha present → PUT with last_commit_id (update, conflict-checked).
async function saveFile(env, filePath, text, sha, { fetch: fetchImpl = fetch, message } = {}) {
  const bytes = new TextEncoder().encode(text);
  const base64 = btoa(String.fromCharCode(...bytes));
  const body = {
    branch: ref(env),
    content: base64,
    commit_message: message ?? `bot: update ${filePath} ${new Date().toISOString()}`,
  };
  const method = sha != null ? 'PUT' : 'POST';
  if (sha != null) body.last_commit_id = sha;
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/files/${encodeFilePath(filePath)}`,
    { method, headers: authHeaders(env, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }
  );
  await throwOnBadResponse(res, method, filePath);
  return res.json();
}

export async function loadWatchedEntities(env, opts = {}) {
  const { content, sha } = await loadFile(env, ENTITIES_FILE, opts);
  if (content === null) return { entities: [], sha: null };
  return { entities: JSON.parse(content), sha };
}

export async function saveWatchedEntities(env, entities, sha, opts = {}) {
  const text = JSON.stringify(entities, null, 2) + '\n';
  return saveFile(env, ENTITIES_FILE, text, sha, opts);
}

export async function loadWatchedSeen(env, opts = {}) {
  const { content, sha } = await loadFile(env, SEEN_FILE, opts);
  if (content === null) return { seen: {}, sha: null };
  return { seen: JSON.parse(content), sha };
}

export async function saveWatchedSeen(env, seen, sha, opts = {}) {
  const text = JSON.stringify(seen, null, 2) + '\n';
  return saveFile(env, SEEN_FILE, text, sha, opts);
}

export async function loadInvites(env, opts = {}) {
  const { content, sha } = await loadFile(env, INVITES_FILE, opts);
  if (content === null) return { invites: [], sha: null };
  return { invites: JSON.parse(content), sha };
}

export async function saveInvites(env, invites, sha, opts = {}) {
  const text = JSON.stringify(invites, null, 2) + '\n';
  return saveFile(env, INVITES_FILE, text, sha, opts);
}

export async function loadAllowedUsers(env, opts = {}) {
  const { content, sha } = await loadFile(env, ALLOWED_USERS_FILE, opts);
  if (content === null) return { users: [], sha: null };
  return { users: JSON.parse(content), sha };
}

export async function saveAllowedUsers(env, users, sha, opts = {}) {
  const text = JSON.stringify(users, null, 2) + '\n';
  return saveFile(env, ALLOWED_USERS_FILE, text, sha, opts);
}

export async function loadArchivedTenders(env, opts = {}) {
  const { content, sha } = await loadFile(env, ARCHIVED_TENDERS_FILE, opts);
  if (content === null) return { archive: [], sha: null };
  return { archive: JSON.parse(content), sha };
}

export async function saveArchivedTenders(env, archive, sha, opts = {}) {
  const text = JSON.stringify(archive, null, 2) + '\n';
  return saveFile(env, ARCHIVED_TENDERS_FILE, text, sha, opts);
}

export async function loadNotificationHistory(env, opts = {}) {
  const { content } = await loadFile(env, NOTIFICATION_HISTORY_FILE, opts);
  if (content === null) return { items: [] };
  try {
    const parsed = JSON.parse(content);
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

export async function loadPendingDigest(env, opts = {}) {
  const { content } = await loadFile(env, PENDING_DIGEST_FILE, opts);
  if (content === null) return null;
  try { return JSON.parse(content); } catch { return null; }
}

export async function loadTenderState(env, tenderId, opts = {}) {
  const { content } = await loadFile(env, `_state/${tenderId}.json`, opts);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

export async function saveAgentJob(env, job, { fetch: fetchImpl = fetch, message } = {}) {
  const filePath = `_state/agent_jobs/${job.tender_id}.json`;
  const { sha } = await loadFile(env, filePath, { fetch: fetchImpl });
  const text = JSON.stringify(job, null, 2) + '\n';
  return saveFile(env, filePath, text, sha, {
    fetch: fetchImpl,
    message: message ?? `agent job ${job.tender_id}: pending`,
  });
}

export async function loadAgentJob(env, tenderId, { fetch: fetchImpl = fetch } = {}) {
  const { content } = await loadFile(env, `_state/agent_jobs/${tenderId}.json`, { fetch: fetchImpl });
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

export async function listAgentJobs(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/tree?path=_state/agent_jobs&ref=${ref(env)}`,
    { headers: authHeaders(env) }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw glError(`GitLab GET ${res.status}: list agent_jobs`, res.status);
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  const tids = items
    .filter((it) => it.type === 'blob' && it.name.endsWith('.json'))
    .map((it) => it.name.replace(/\.json$/, ''));
  const jobs = await Promise.all(tids.map((tid) => loadAgentJob(env, tid, { fetch: fetchImpl })));
  return jobs
    .filter(Boolean)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, 20);
}

export async function fetchLatestDeployCommit(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/commits?ref_name=${ref(env)}&per_page=20`,
    { headers: authHeaders(env) }
  );
  if (!res.ok) throw glError(`GitLab commits API ${res.status}`, res.status);
  const commits = await res.json();
  const BOT_RE = /^(monitor: state update|monitor: cursor sync|bot:|audit:|agent job )/;
  for (const c of commits) {
    const msg = (c.title ?? '').split('\n')[0];
    if (BOT_RE.test(msg)) continue;
    return { sha: c.short_id ?? (c.id ?? '').slice(0, 7), message: msg, date: c.committed_date ?? null };
  }
  return null;
}

export async function fetchAuditLog(env, { fetch: fetchImpl = fetch, perPage = 100 } = {}) {
  const res = await fetchImpl(
    `${projectUrl(env)}/repository/commits?ref_name=${ref(env)}&per_page=${perPage}`,
    { headers: authHeaders(env) }
  );
  if (!res.ok) throw glError(`GitLab GET ${res.status}: ${await res.text()}`, res.status);
  const commits = await res.json();
  if (!Array.isArray(commits)) throw new Error(`GitLab commits API: unexpected response shape`);
  return commits.map(c => ({ message: (c.title ?? '').split('\n')[0], date: c.committed_date ?? null }));
}

export { ConflictError };
```

- [ ] **Крок 4: Прогнати тести — очікується PASS**

Run: `node --test worker/test/gitlab.test.mjs`
Expected: усі тести з Кроку 1 проходять.

- [ ] **Крок 5: Прогнати весь набір Worker'а, переконатись у відсутності регресій**

Run: `node --test worker/test/*.test.mjs`
Expected: PASS (наявні `github.test.mjs`/`handler.test.mjs` не зачеплені).

- [ ] **Крок 6: Commit**

```bash
git add worker/src/gitlab.mjs worker/test/gitlab.test.mjs
git commit -m "worker: add GitLab-backed state module (gitlab.mjs), mirrors github.mjs"
```

---

### Task 4: `worker/src/state.mjs` — прошарка-диспетчер

**Files:**
- Create: `worker/src/state.mjs`
- Test: `worker/test/state.test.mjs`

**Interfaces:**
- Consumes: усі експорти `github.mjs` (Task 2 стан) і `gitlab.mjs` (Task 3).
- Produces: той самий набір із 19 функцій + `ConflictError`, обраний за `env.STATE_BACKEND`. Це те, що `handler.mjs` імпортуватиме в Task 5.

- [ ] **Крок 1: Написати падаючий тест**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWatchlist } from '../src/state.mjs';

test('state.mjs: STATE_BACKEND="gitlab" routes to gitlab.mjs (Files API shape)', async () => {
  const env = { STATE_BACKEND: 'gitlab', GITLAB_TOKEN: 't', GITLAB_PROJECT_ID: '1', GITLAB_REF: 'main' };
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    const content = Buffer.from('[]').toString('base64');
    return { ok: true, status: 200, json: async () => ({ content, last_commit_id: 'c1' }) };
  };
  await loadWatchlist(env, { fetch: fakeFetch });
  assert.match(calls[0], /repository\/files\/watchlist\.json/);
});

test('state.mjs: default (no STATE_BACKEND) routes to github.mjs (Contents API shape)', async () => {
  const env = { GITHUB_PAT: 't' };
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const content = Buffer.from('[]').toString('base64');
    return { ok: true, status: 200, json: async () => ({ content, sha: 's1' }) };
  };
  await loadWatchlist(env, { fetch: fakeFetch });
  assert.match(calls[0], /api\.github\.com\/repos/);
});
```

- [ ] **Крок 2: Прогнати — FAIL (модуля нема)**

Run: `node --test worker/test/state.test.mjs`
Expected: FAIL, `Cannot find module '../src/state.mjs'`

- [ ] **Крок 3: Написати `worker/src/state.mjs`**

```js
import * as gh from './github.mjs';
import * as gl from './gitlab.mjs';
import { ConflictError } from './state-errors.mjs';

function backend(env) {
  return env.STATE_BACKEND === 'gitlab' ? gl : gh;
}

export async function fetchLastCommit(env, opts) { return backend(env).fetchLastCommit(env, opts); }
export async function loadWatchlist(env, opts) { return backend(env).loadWatchlist(env, opts); }
export async function saveWatchlist(env, w, sha, opts) { return backend(env).saveWatchlist(env, w, sha, opts); }
export async function loadWatchedEntities(env, opts) { return backend(env).loadWatchedEntities(env, opts); }
export async function saveWatchedEntities(env, e, sha, opts) { return backend(env).saveWatchedEntities(env, e, sha, opts); }
export async function loadWatchedSeen(env, opts) { return backend(env).loadWatchedSeen(env, opts); }
export async function saveWatchedSeen(env, s, sha, opts) { return backend(env).saveWatchedSeen(env, s, sha, opts); }
export async function loadInvites(env, opts) { return backend(env).loadInvites(env, opts); }
export async function saveInvites(env, i, sha, opts) { return backend(env).saveInvites(env, i, sha, opts); }
export async function loadAllowedUsers(env, opts) { return backend(env).loadAllowedUsers(env, opts); }
export async function saveAllowedUsers(env, u, sha, opts) { return backend(env).saveAllowedUsers(env, u, sha, opts); }
export async function loadArchivedTenders(env, opts) { return backend(env).loadArchivedTenders(env, opts); }
export async function saveArchivedTenders(env, a, sha, opts) { return backend(env).saveArchivedTenders(env, a, sha, opts); }
export async function loadNotificationHistory(env, opts) { return backend(env).loadNotificationHistory(env, opts); }
export async function loadPendingDigest(env, opts) { return backend(env).loadPendingDigest(env, opts); }
export async function loadTenderState(env, tid, opts) { return backend(env).loadTenderState(env, tid, opts); }
export async function saveAgentJob(env, job, opts) { return backend(env).saveAgentJob(env, job, opts); }
export async function loadAgentJob(env, tid, opts) { return backend(env).loadAgentJob(env, tid, opts); }
export async function listAgentJobs(env, opts) { return backend(env).listAgentJobs(env, opts); }
export async function fetchLatestDeployCommit(env, opts) { return backend(env).fetchLatestDeployCommit(env, opts); }
export async function fetchAuditLog(env, opts) { return backend(env).fetchAuditLog(env, opts); }

export { ConflictError };
```

- [ ] **Крок 4: Прогнати — PASS**

Run: `node --test worker/test/state.test.mjs`
Expected: обидва тести проходять.

- [ ] **Крок 5: Commit**

```bash
git add worker/src/state.mjs worker/test/state.test.mjs
git commit -m "worker: add state.mjs backend dispatcher (STATE_BACKEND flag)"
```

---

### Task 5: Перемкнути `handler.mjs` на `state.mjs`

**Files:**
- Modify: `worker/src/handler.mjs:31-44`

**Interfaces:**
- Consumes: `worker/src/state.mjs` (Task 4) — той самий набір імен, що й раніше з `github.mjs`.

- [ ] **Крок 1: Змінити джерело імпорту**

У `worker/src/handler.mjs`, рядок 44, замінити:

```js
} from './github.mjs';
```

на:

```js
} from './state.mjs';
```

(Імпортований список функцій, рядки 31-43, лишається без змін — усі імена присутні в `state.mjs`.)

- [ ] **Крок 2: Прогнати повний тестовий набір Worker'а**

Run: `node --test worker/test/*.test.mjs`
Expected: PASS, включно з усіма 4506 рядками `handler.test.mjs` — жодного регресу, бо `env` у тестах не має `STATE_BACKEND`, тож диспетчер обирає `github.mjs` (поточну поведінку) так само, як і до зміни.

- [ ] **Крок 3: Commit**

```bash
git add worker/src/handler.mjs
git commit -m "worker: route handler.mjs through state.mjs dispatcher"
```

---

### Task 6: `wrangler.toml` — середовища staging/production

**Files:**
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Produces: два Cloudflare-середовища одного Worker-скрипта, що різняться лише `STATE_BACKEND`, `GITLAB_PROJECT_ID`, `GITLAB_REF` і KV namespace.

⚠️ **Потребує оператора:** id staging KV namespace і project access token GitLab (Task 1) мають бути відомі до цього кроку.

- [ ] **Крок 1: Дописати `wrangler.toml`**

```toml
name = "tender-monitor-bot"
main = "src/index.mjs"
compatibility_date = "2026-05-01"

[[kv_namespaces]]
binding = "EPHEMERAL_KV"
id = "f9c6d80922f24615ab394d3cc1aa7251"   # KV namespace "tender-monitor-ephemeral"

[env.staging]
name = "tender-monitor-bot-staging"
vars = { STATE_BACKEND = "gitlab", GITLAB_PROJECT_ID = "<PROJECT_ID з Task 1>", GITLAB_REF = "staging-state" }

[[env.staging.kv_namespaces]]
binding = "EPHEMERAL_KV"
id = "<staging-kv-id, окремий namespace>"

[env.production]
name = "tender-monitor-bot"
vars = { STATE_BACKEND = "github" }
```

`STATE_BACKEND` у `[env.production]` лишається `"github"` до моменту cutover (Task 10) — код деплоїться заздалегідь, поведінка не міняється.

- [ ] **Крок 2: Секрети (не в `wrangler.toml`, окремо через wrangler)**

```bash
cd worker
wrangler secret put GITLAB_TOKEN --env staging
# (продовий GITHUB_PAT уже є секретом — не чіпається)
```

- [ ] **Крок 3: Перевірити конфіг без деплою**

Run: `wrangler deploy --env staging --dry-run`
Expected: валідна конфігурація, без помилок парсингу.

- [ ] **Крок 4: Commit**

```bash
git add worker/wrangler.toml
git commit -m "worker: add staging/production environments to wrangler.toml"
```

---

### Task 7: `agent_poller.py` — GitLab-бекенд (проєкт `tender-agent`)

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\agent_poller.py:978-1128`
- Modify: `_secrets/agent_poller.example.json` (додати приклад полів)
- Test: наявний тестовий файл поллера (той, що покриває `make_list_jobs`/`make_set_status`)

**Interfaces:**
- Consumes: `cfg.backend` (`"github"`/`"gitlab"`), `cfg.gitlab_token`, `cfg.gitlab_project_id`, `cfg.gitlab_ref`.
- Produces: `make_list_jobs(cfg)`/`make_set_status(cfg)` повертають те саме замикання незалежно від бекенду — виклики з `main()` не змінюються.

- [ ] **Крок 1: Написати падаючі тести на GitLab-гілку фабрик**

Додати в тестовий файл поллера:

```python
def test_make_list_jobs_gitlab_backend(monkeypatch):
    cfg = SimpleNamespace(
        backend="gitlab", gitlab_token="glpat-x",
        gitlab_project_id="99", gitlab_ref="main",
    )
    calls = []

    def fake_gl_request(url, token, *, method="GET", payload=None):
        calls.append((url, token, method))
        if "tree" in url:
            return [{"name": "UA-1.json", "path": "_state/agent_jobs/UA-1.json", "type": "blob"}]
        content = base64.b64encode(json.dumps({"tender_id": "UA-1"}).encode()).decode()
        return {"content": content, "last_commit_id": "c1"}

    monkeypatch.setattr(agent_poller, "_gl_request", fake_gl_request)
    list_jobs = agent_poller.make_list_jobs(cfg)
    jobs = list_jobs()
    assert len(jobs) == 1
    assert jobs[0][1]["tender_id"] == "UA-1"
    assert jobs[0][1]["_sha"] == "c1"
    assert any("PRIVATE-TOKEN" not in str(c) for c in calls)  # токен передається окремим аргументом, не в url


def test_make_set_status_gitlab_backend_update(monkeypatch):
    cfg = SimpleNamespace(
        backend="gitlab", gitlab_token="glpat-x",
        gitlab_project_id="99", gitlab_ref="main",
    )
    captured = {}

    def fake_gl_request(url, token, *, method="GET", payload=None):
        if method == "GET":
            return {"last_commit_id": "old-commit"}
        captured["payload"] = payload
        captured["method"] = method
        return {}

    monkeypatch.setattr(agent_poller, "_gl_request", fake_gl_request)
    set_status = agent_poller.make_set_status(cfg)
    set_status("UA-1.json", {"tender_id": "UA-1", "status": "done", "_sha": "old-commit"})
    assert captured["method"] == "PUT"
    assert captured["payload"]["last_commit_id"] == "old-commit"
    assert "_sha" not in json.loads(base64.b64decode(captured["payload"]["content"]))
```

- [ ] **Крок 2: Прогнати — FAIL**

Run: `py -m pytest tests/ -k gitlab_backend -v`
Expected: FAIL, `AttributeError: module 'agent_poller' has no attribute '_gl_request'`

- [ ] **Крок 3: Реалізувати GitLab-гілку в `agent_poller.py`**

Додати поруч із наявним `_gh_request` (після рядка 1001):

```python
_GL_API = "https://cl-gl.listerralab.com/api/v4"


def _gl_request(url, token, *, method="GET", payload=None):
    """Issue an authenticated GitLab API request; return parsed JSON or None."""
    data = None
    headers = {"PRIVATE-TOKEN": token}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
```

Далі перевести `make_list_jobs`/`make_set_status` (рядки 1004-1058) на дві гілки за `cfg.backend`:

```python
def make_list_jobs(cfg):
    """Return a list_jobs() that lists pending job files from the bot repo."""
    if cfg.backend == "gitlab":
        def list_jobs_gitlab():
            url = "%s/projects/%s/repository/tree?path=%s&ref=%s" % (
                _GL_API, cfg.gitlab_project_id, _JOBS_DIR, cfg.gitlab_ref)
            entries = _gl_request(url, cfg.gitlab_token)
            if not entries:
                return []
            out = []
            for entry in entries:
                if entry.get("type") != "blob" or not entry.get("name", "").endswith(".json"):
                    continue
                file_url = "%s/projects/%s/repository/files/%s?ref=%s" % (
                    _GL_API, cfg.gitlab_project_id,
                    urllib.parse.quote(entry["path"], safe=""), cfg.gitlab_ref)
                meta = _gl_request(file_url, cfg.gitlab_token)
                if not meta or "content" not in meta:
                    continue
                raw = base64.b64decode(meta["content"]).decode("utf-8")
                try:
                    job = json.loads(raw)
                except ValueError:
                    continue
                job["_sha"] = meta.get("last_commit_id")
                out.append((entry["name"], job))
            return out
        return list_jobs_gitlab

    def list_jobs():
        url = "%s/repos/%s/contents/%s" % (_GH_API, cfg.repo, _JOBS_DIR)
        entries = _gh_request(url, cfg.github_pat)
        if not entries:
            return []
        out = []
        for entry in entries:
            if not entry.get("name", "").endswith(".json"):
                continue
            file_url = "%s/repos/%s/contents/%s/%s" % (
                _GH_API, cfg.repo, _JOBS_DIR, entry["name"])
            meta = _gh_request(file_url, cfg.github_pat)
            if not meta or "content" not in meta:
                continue
            raw = base64.b64decode(meta["content"]).decode("utf-8")
            try:
                job = json.loads(raw)
            except ValueError:
                continue
            job["_sha"] = meta.get("sha")
            out.append((entry["name"], job))
        return out
    return list_jobs


def make_set_status(cfg):
    """Return a set_status(name, job) that writes the job file back to the repo."""
    if cfg.backend == "gitlab":
        def set_status_gitlab(name, job):
            file_path = urllib.parse.quote("%s/%s" % (_JOBS_DIR, name), safe="")
            url = "%s/projects/%s/repository/files/%s" % (_GL_API, cfg.gitlab_project_id, file_path)
            current = _gl_request(url + "?ref=" + cfg.gitlab_ref, cfg.gitlab_token)
            last_commit_id = current.get("last_commit_id") if isinstance(current, dict) else None
            clean = {k: v for k, v in job.items() if k != "_sha"}
            content = json.dumps(clean, ensure_ascii=False, indent=2)
            payload = {
                "branch": cfg.gitlab_ref,
                "content": content,
                "commit_message": "agent job %s: %s" % (job.get("tender_id", name), job.get("status", "?")),
            }
            if last_commit_id:
                payload["last_commit_id"] = last_commit_id
                method = "PUT"
            else:
                method = "POST"
            _gl_request(url, cfg.gitlab_token, method=method, payload=payload)
        return set_status_gitlab

    def set_status(name, job):
        url = "%s/repos/%s/contents/%s/%s" % (_GH_API, cfg.repo, _JOBS_DIR, name)
        current = _gh_request(url + "?ref=" + cfg.branch, cfg.github_pat)
        sha = current.get("sha") if isinstance(current, dict) else None
        clean = {k: v for k, v in job.items() if k != "_sha"}
        content = base64.b64encode(
            json.dumps(clean, ensure_ascii=False, indent=2).encode("utf-8")
        ).decode("ascii")
        payload = {
            "message": "agent job %s: %s" % (job.get("tender_id", name), job.get("status", "?")),
            "content": content,
            "branch": cfg.branch,
        }
        if sha:
            payload["sha"] = sha
        _gh_request(url, cfg.github_pat, method="PUT", payload=payload)
    return set_status
```

Додати `import urllib.parse` до наявних імпортів на початку файлу, якщо його там ще немає.

У `Config`/`load_config` (де читається `_secrets/agent_poller.json`) додати поля `backend` (типово `"github"` — зворотна сумісність), `gitlab_token`, `gitlab_project_id`, `gitlab_ref` за тим самим зразком, що й наявні `github_pat`/`repo`/`branch`.

- [ ] **Крок 4: Прогнати тести — PASS**

Run: `py -m pytest tests/ -k gitlab_backend -v`
Expected: обидва нові тести проходять.

- [ ] **Крок 5: Прогнати весь набір поллера — без регресій**

Run: `py -m pytest tests/ -q`
Expected: усі наявні 33+ тести на GitHub-гілку далі проходять незмінно (`cfg.backend` типово `"github"`).

- [ ] **Крок 6: Оновити `_secrets/agent_poller.example.json`**

Додати (без реальних значень) поля `backend`, `gitlab_token`, `gitlab_project_id`, `gitlab_ref` до прикладу структури, з коментарем про признач кожного.

- [ ] **Крок 7: Commit**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/agent_poller.py _secrets/agent_poller.example.json tests/
git commit -m "poller: add GitLab backend to make_list_jobs/make_set_status"
```

---

### Task 8: GitLab CI для `tender-monitor`

**Files:**
- Create: `.gitlab-ci.yml` (у проєкті `terralab-manual/tender-monitor`)

**Interfaces:**
- Consumes: masked CI-змінні `GITLAB_TOKEN` (project access token, для деплой-джобів), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (ті самі, що вже в GitHub Actions).

- [ ] **Крок 1: Додати CI-змінні через API (masked, protected)**

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "key=CLOUDFLARE_API_TOKEN" --data-urlencode "value=<...>" \
  --data-urlencode "masked=true" --data-urlencode "protected=true" \
  "$GITLAB_URL/api/v4/projects/<PROJECT_ID>/variables"
# повторити для CLOUDFLARE_ACCOUNT_ID
```

- [ ] **Крок 2: Написати `.gitlab-ci.yml`**

```yaml
stages:
  - test
  - deploy

test:
  stage: test
  script:
    - node --test test/*.test.mjs worker/test/*.test.mjs

deploy-staging:
  stage: deploy
  when: manual
  script:
    - cd worker && npm install --no-save wrangler@^3 && npx wrangler deploy --env staging

monitor-staging:
  stage: test
  script:
    - node ci.mjs
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $SCHEDULE_TARGET == "staging"'

deploy-production:
  stage: deploy
  script:
    - cd worker && npm install --no-save wrangler@^3 && npx wrangler deploy --env production
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: manual
```

- [ ] **Крок 3: Створити Scheduled Pipeline (staging cron) через API**

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "description=staging monitor cron" \
  --data-urlencode "ref=staging-state" \
  --data-urlencode "cron=*/15 * * * *" \
  --data-urlencode "variables[][key]=SCHEDULE_TARGET" \
  --data-urlencode "variables[][value]=staging" \
  "$GITLAB_URL/api/v4/projects/<PROJECT_ID>/pipeline_schedules"
```

- [ ] **Крок 4: Валідувати YAML перед пушем**

```bash
python3 -c "
import json, urllib.request
content = open('.gitlab-ci.yml', encoding='utf-8').read()
req = urllib.request.Request(
    '$GITLAB_URL/api/v4/projects/<PROJECT_ID>/ci/lint',
    data=json.dumps({'content': content}).encode('utf-8'),
    headers={'PRIVATE-TOKEN': '$GITLAB_TOKEN', 'Content-Type': 'application/json'},
    method='POST')
print(json.load(urllib.request.urlopen(req)))
"
```

Expected: `{'valid': True, 'errors': [], ...}`

- [ ] **Крок 5: Push і перевірити перший тестовий пайплайн**

```bash
git checkout -b ci/gitlab-pipeline
git add .gitlab-ci.yml
git commit -m "ci: add GitLab CI (test, staging schedule, staging/prod deploy)"
git push gitlab ci/gitlab-pipeline
```

Перевірити через API, що `test`-джоба на цьому пуші пройшла (`status: success`).

---

### Task 9: Staging bring-up і валідація

**Files:** без змін коду — прогін і спостереження.

**Interfaces:**
- Consumes: усе з Tasks 1-8.

⚠️ **Потребує оператора:** тестовий бот через BotFather (Крок 1), Cloudflare-креденшели для staging (Крок 2, якщо ще не дані в Task 6).

- [ ] **Крок 1: Отримати токен тестового бота від оператора**

Токен віддається в чаті → одразу `wrangler secret put TELEGRAM_BOT_TOKEN --env staging`, нікуди більше не пишеться.

- [ ] **Крок 2: Задеплоїти staging Worker**

```bash
cd worker && npx wrangler deploy --env staging
```

Прив'язати Telegram-вебхук тестового бота до URL staging Worker'а (`setWebhook` API Telegram).

- [ ] **Крок 3: Пройти таблицю перевірок із дизайн-документа**

Для кожного рядка таблиці «Що перевіряється на staging» (розділ Staging-схема дизайн-документа) — реальна дія в тестовому боті + перевірка, що відповідний файл у гілці `staging-state` GitLab оновився.

- [ ] **Крок 4: Конфлікт-тест**

Двічі поспіль швидко натиснути ту саму кнопку зміни `watchlist`/`watched_entities`. Очікується: другий запит або коректно повторює спробу (перечитавши `last_commit_id`), або явно повідомляє про конфлікт — не губить дані мовчки. Зафіксувати результат.

- [ ] **Крок 5: Спостерігати кілька циклів staging cron (15 хв)**

Мінімум 6-8 годин активного спостереження (кілька десятків циклів), без помилок у логах пайплайну.

---

### Task 10: Cutover (виконується лише за прямою командою оператора)

**Files:** конфігурація, без змін коду.

⚠️ **Не виконувати автоматично** — цей крок обирає момент оператор, за дизайн-документом.

#### КРОК 0: три передумови (додано 22.08.2026, після staging-перевірки)

⛔ **Не починати з Кроку 1.** Під час оживлення тестового стенда 21-22.08
з'ясувалось, що три речі, потрібні для cutover, не існують. Кожна з них
виявиться **вже після перемикання**, тобто в найгірший момент.

- [ ] **0.1. Токен, яким пише стан, не має права писати в `main`. БЛОКЕР.**

  Гілка `main` у проєкті 14 захищена: `push_access_levels` і
  `merge_access_levels` — обидва **Maintainers (40)**. А стан пише **токен
  проєкту** `project_14_bot_…` з рівнем **Developer (30)**.

  На staging це не вилазило, бо `staging-state` **не захищена**. Прод-стан за
  дизайном лежить у `main`.

  Наслідок, якщо не полагодити: після Кроку 2 бот виглядатиме живим (читання
  працює, команди відповідають), але **кожен запис стану впреться в 403** —
  ні додати тендер, ні зняти замовника, ні поставити задачу агентові. Те саме
  з монітором у Кроці 3: порахує стан і не зможе запушити.

  Варіанти, у порядку переваги:
  1. підняти токен проєкту до **Maintainer** — точково, оборотно, нічого не
     послаблює для інших;
  2. додати цей токен у «Allowed to push» для `main`;
  3. тримати прод-стан в окремій незахищеній гілці — найпростіше технічно,
     але суперечить дизайну й ускладнює звірку з GitHub.

  ⚠️ Перевіряти **живим записом**, а не оглядом прав: рівень доступу в API і
  фактичний дозвіл на захищену гілку — різні речі.

- [ ] **0.2. Джоби `monitor-production` не існує.**

  У `.gitlab-ci.yml` є `test`, `deploy-staging`, `monitor-staging`,
  `deploy-production`. Прод-монітора немає, тобто «увімкнути Scheduled
  Pipeline» у Кроці 3 **нічого не запустить**.

  Ця пастка вже спрацювала один раз: staging-розклад стояв активним і мовчав
  місяць, бо на гілці не було `.gitlab-ci.yml` — `last_pipeline: None` за весь
  час існування. Не повторювати.

  Потрібно: джоба з правилом `$CI_PIPELINE_SOURCE == "schedule" &&
  $SCHEDULE_TARGET == "production"`, розклад на `ref: main`,
  `cron: '0 * * * *'`, і **дві CI-змінні** — `TELEGRAM_BOT_TOKEN` і
  `TELEGRAM_CHAT_ID` для СПРАВЖНЬОГО бота (`ci.mjs` читає рівно ці імена; у
  проєкті зараз є лише `_STAGING`-версії). Обидві **unprotected**, інакше не
  доїдуть — див. пастку в `CLAUDE.md` флоту.

  Прогнати розклад **хоч раз до cutover** і побачити зелений цикл.

- [ ] **0.3. `[env.production]` не має GitLab-параметрів.**

  Зараз там лише `STATE_BACKEND = "github"`. А `worker/src/gitlab.mjs` вимагає
  ще `GITLAB_PROJECT_ID` і `GITLAB_REF`. Якщо перемкнути лише прапорець, бот
  зайде в бекенд, який не знає, куди писати. Додавати всі три разом, одним
  редагуванням.

**Після 0.1-0.3 cutover стає перемиканням прапорця, а не розвідкою.**

---

#### Уроки staging-перевірки, що стосуються Кроків 1-6

- **Крок 1 — природна точка зупинки.** Копію ніхто не читає, доки не зроблено
  Крок 2. Можна перенести стан, звірити кількість тендерів і замовників, і
  спокійно спинитись; прод при цьому працює як працював.
- **Перемикачів ДВА, і вони мусять рухатись разом** (Кроки 2 і 4): Worker і
  `_secrets/agent_poller.json`. Забути другий — поллер пише в одне місце, бот
  читає з іншого, **без жодної помилки в логах**. Те саме на відкаті: робити
  чеклистом, а не «головне перемкну, решту потім».
- **Механізм конфлікту при записі доведений, але на іншій гілці.** 21.08 о
  17:03 на `staging-state` живим прогоном перевірено, що при зсуві гілки під
  джобою спрацьовує `Push attempt 1 failed` → `git rebase FETCH_HEAD` →
  `Pushed on attempt 2`, і **стан не втрачається**. Прод-розклад буде на `main`
  з іншим cron — це залишкова невідомість, а не покритий випадок.
- **Гілка `Rebase conflict` так і не викликана.** Саме вона небезпечна: джоба
  виходить ЗЕЛЕНОЮ, відкинувши власний коміт. Щоб її дістати, потрібен
  зустрічний коміт у ті самі рядки стану — справжня гонка бота з монітором.
  У перші дні після cutover варто перевіряти логи саме на цей рядок.
- **Пороги рахувати тим самим джерелом, що й код.** Дебаунс курсора міряє
  `git log -1 --format=%ct --grep='^monitor: cursor sync'`. Розрахунок від
  `committed_date` з API дав розбіжність 15 секунд і зіпсував одну спробу.

- [ ] **Крок 1: Одноразовий перенос реального стану**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git fetch origin main  # GitHub
git checkout gitlab/main
git checkout origin/main -- watchlist.json watched_entities.json _state/
git add watchlist.json watched_entities.json _state/
git commit -m "cutover: import production state snapshot from GitHub"
git push gitlab HEAD:main
```

- [ ] **Крок 2: Перемкнути прод-прапорець**

Правка `[env.production] vars = { STATE_BACKEND = "gitlab", GITLAB_PROJECT_ID = "<...>", GITLAB_REF = "main" }` у `wrangler.toml`, `npx wrangler deploy --env production`.

- [ ] **Крок 3: Перемкнути cron**

Вимкнути schedule в GitHub Actions (`monitor.yml`) через GitHub UI/API. Увімкнути production Scheduled Pipeline у GitLab (аналогічно Task 8 Кроку 3, `ref: main`, `cron: '0 * * * *'`).

- [ ] **Крок 4: Перемкнути поллер**

Оператор редагує `_secrets/agent_poller.json`: `"backend": "gitlab"`.

- [ ] **Крок 5: Спостереження**

Перші 2-3 цикли — під прямим наглядом (лог staging/prod пайплайну, реальний Telegram).

- [ ] **Крок 6: Grace period**

GitHub Actions workflows лишаються в репозиторії **вимкненими, не видаленими** 1-2 тижні. Після спокійного періоду — видалити або лишити.

## Спец-review (виконано під час написання)

- **Placeholder-скан:** жодних TBD/TODO; усі кроки містять реальний код або конкретну команду.
- **Type consistency:** сигнатури `state.mjs` 1:1 відповідають і `github.mjs`, і новому `gitlab.mjs` (перевірено по іменах і кількості аргументів). `cfg.backend`/`gitlab_*` поля в `agent_poller.py` названі однаково в тестах і реалізації.
- **Покриття дизайну:** усі розділи `2026-08-19-gitlab-state-backend-migration-design.md` мають відповідний Task — архітектура (3-5), staging-схема (1, 9), перемикач (4-6), cutover (10), agent_poller (7), CI (8).
