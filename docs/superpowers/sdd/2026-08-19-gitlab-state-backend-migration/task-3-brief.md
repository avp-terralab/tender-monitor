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

