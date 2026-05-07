const REPO = 'avp-terralab/tender-monitor';
const FILE = 'watchlist.json';
const API_BASE = 'https://api.github.com';

export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
  }
}

export async function loadWatchlist(env, { fetch: fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${API_BASE}/repos/${REPO}/contents/${FILE}?ref=main`,
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
    `${API_BASE}/repos/${REPO}/contents/${FILE}`,
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
    throw new ConflictError(`GitHub PUT 409 conflict on ${FILE}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
