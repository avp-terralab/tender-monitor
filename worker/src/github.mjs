const REPO = 'avp-terralab/tender-monitor';
const WATCHLIST_FILE = 'watchlist.json';
const ENTITIES_FILE = 'watched_entities.json';
const SEEN_FILE = '_state/_watched_seen.json';
const API_BASE = 'https://api.github.com';

export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
  }
}

export async function loadWatchlist(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/contents/${WATCHLIST_FILE}?ref=main`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'tender-monitor-worker',
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
  }
  const { content, sha } = await res.json();
  const bytes = Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return { watchlist: JSON.parse(text), sha };
}

export async function saveWatchlist(env, watchlist, sha, { fetch: fetchImpl = fetch } = {}) {
  const json = JSON.stringify(watchlist, null, 2) + '\n';
  const bytes = new TextEncoder().encode(json);
  const base64 = btoa(String.fromCharCode(...bytes));
  const body = {
    message: `bot: update watchlist ${new Date().toISOString()}`,
    content: base64,
    sha,
    branch: 'main',
  };
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/contents/${WATCHLIST_FILE}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'tender-monitor-worker',
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 409) {
    throw new ConflictError(`GitHub PUT 409 conflict on ${WATCHLIST_FILE}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function loadFile(env, filePath, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/contents/${filePath}?ref=main`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'tender-monitor-worker',
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) {
    throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
  }
  const { content, sha } = await res.json();
  const bytes = Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return { content: text, sha };
}

async function saveFile(env, filePath, text, sha, { fetch: fetchImpl = fetch } = {}) {
  const bytes = new TextEncoder().encode(text);
  const base64 = btoa(String.fromCharCode(...bytes));
  const body = {
    message: `bot: update ${filePath} ${new Date().toISOString()}`,
    content: base64,
    branch: 'main',
  };
  if (sha != null) body.sha = sha;
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'User-Agent': 'tender-monitor-worker',
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 409) {
    throw new ConflictError(`GitHub PUT 409 conflict on ${filePath}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  }
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

const INVITES_FILE = '_state/invites.json';
const ALLOWED_USERS_FILE = '_state/allowed_users.json';

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

const ARCHIVED_TENDERS_FILE = '_state/archived_tenders.json';

export async function loadArchivedTenders(env, opts = {}) {
  const { content, sha } = await loadFile(env, ARCHIVED_TENDERS_FILE, opts);
  if (content === null) return { archive: [], sha: null };
  return { archive: JSON.parse(content), sha };
}

export async function saveArchivedTenders(env, archive, sha, opts = {}) {
  const text = JSON.stringify(archive, null, 2) + '\n';
  return saveFile(env, ARCHIVED_TENDERS_FILE, text, sha, opts);
}
