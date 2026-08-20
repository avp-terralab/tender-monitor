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
    encoding: 'base64',
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
    encoding: 'base64',
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

// Скільки останніх завдань показуємо і скільки сторінок дерева заради цього
// готові пройти. Стеля Cloudflare — 50 підзапитів на виклик Worker'а, тож
// числа тут свідомі: 20 сторінок дерева + 20 читань файлів = 40 < 50.
// 20 сторінок по 100 імен — це 2000 завдань, за нинішнього темпу роки.
const AGENT_JOBS_LIMIT = 20;
const AGENT_JOBS_MAX_TREE_PAGES = 20;

// Дерево GitLab віддає щонайбільше 100 записів на сторінку й сортує імена
// **за зростанням**, а файли завдань не видаляються ніколи. Тобто зупинитись
// на першій сторінці означає з часом показувати найдавніші двадцять замість
// найновіших — рівно той самий баг, що й дефолтні 20 на сторінку, лише
// відкладений. Сторінки дерева — це самі лише імена (дешево); підзапит на
// вміст іде вже тільки за відібраними двадцятьма.
async function listAgentJobIds(env, fetchImpl) {
  const names = [];
  for (let page = 1; page <= AGENT_JOBS_MAX_TREE_PAGES; page += 1) {
    const res = await fetchImpl(
      `${projectUrl(env)}/repository/tree?path=_state/agent_jobs&ref=${ref(env)}&per_page=100&page=${page}`,
      { headers: authHeaders(env) }
    );
    if (res.status === 404) return [];
    if (!res.ok) throw glError(`GitLab GET ${res.status}: list agent_jobs`, res.status);
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      if (it.type === 'blob' && it.name.endsWith('.json')) {
        names.push(it.name.replace(/\.json$/, ''));
      }
    }
    // GitLab називає наступну сторінку заголовком `x-next-page`; порожній —
    // сторінок більше немає. Заголовків може не бути взагалі (інший fetch) —
    // тоді теж зупиняємось: неповна сторінка вже означала б кінець.
    if (!res.headers?.get?.('x-next-page')) break;
  }
  return names;
}

export async function listAgentJobs(env, { fetch: fetchImpl = fetch } = {}) {
  const tids = (await listAgentJobIds(env, fetchImpl))
    // tender_id має вигляд UA-РРРР-ММ-ДД-…, тож лексикографічний порядок
    // збігається з хронологічним: спадне сортування дає найновіші зверху.
    // Зрізаємо ДО завантаження, а не після — інакше кожен зайвий файл коштує
    // окремого підзапиту.
    .sort((a, b) => b.localeCompare(a))
    .slice(0, AGENT_JOBS_LIMIT);
  const jobs = await Promise.all(tids.map((tid) => loadAgentJob(env, tid, { fetch: fetchImpl })));
  return jobs
    .filter(Boolean)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
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
