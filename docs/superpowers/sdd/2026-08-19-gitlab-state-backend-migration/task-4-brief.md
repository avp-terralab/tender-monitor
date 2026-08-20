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

