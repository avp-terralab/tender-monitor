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
  const text = atob(content.replace(/\n/g, ''));
  return { watchlist: JSON.parse(text), sha };
}
