// Per-chat "last on-demand view" message ids, stored in Cloudflare KV so the
// next view command can delete the previous one. Keyed by chatId; 48h TTL (a
// message older than 48h can't be deleted anyway). `kv` is the EPHEMERAL_KV
// binding (or a fake in tests); a missing kv degrades to a no-op.
//
// `ns` namespaces the slot (default '' — the original view-command bucket
// shared by /info, /agent, /watched, etc.). /start uses its OWN namespace
// ('start'): its reply is the ONE message that carries the persistent
// ReplyKeyboardMarkup, and none of the other view replies re-attach it (most
// show an inline keyboard instead) — so if /start shared the default bucket,
// the very next unrelated view command would delete /start's message as
// "the previous ephemeral view", silently dropping the persistent keyboard
// off the chat until the owner ran /start again to restore it.
const key = (chatId, ns = '') => `eph:${ns ? ns + ':' : ''}${chatId}`;

export async function loadEphemeral(kv, chatId, ns) {
  if (!kv) return [];
  const raw = await kv.get(key(chatId, ns));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveEphemeral(kv, chatId, ids, ns) {
  if (!kv) return;
  await kv.put(key(chatId, ns), JSON.stringify(ids), { expirationTtl: 172800 });
}

// Pending agent-trigger dialog state (company pick → price/date prompt →
// confirm), keyed by chatId inside one object. Moved here from a GitHub-
// committed file 2026-08-19 — see
// docs/superpowers/plans/2026-08-19-agent-pending-to-kv.md. This is the ONLY
// _state file that's exclusively Worker-owned (never read/written by ci.mjs
// or the Python poller), which is what makes KV safe here: everything else
// (agent_jobs/, watchlist.json, _watched_seen.json, ...) still needs git,
// since more than one execution context has to reach it.
//
// Unlike `loadEphemeral`/`saveEphemeral` above (keyed by chatId, take `kv`
// directly), these two take `env` as their first argument and return/accept
// a `sha` — matching the GitHub-era signature exactly, so every call site in
// handler.mjs (`_loadAgentPending(env)` / `_saveAgentPending(env, pending,
// sha)`) needed zero changes. `sha` is vestigial now (KV has no versioning
// concept) — always null on load, ignored on save.
const AGENT_PENDING_KEY = 'agent_pending';

export async function loadAgentPending(env) {
  const kv = env?.EPHEMERAL_KV;
  if (!kv) return { pending: {}, sha: null };
  const raw = await kv.get(AGENT_PENDING_KEY);
  if (!raw) return { pending: {}, sha: null };
  try {
    return { pending: JSON.parse(raw), sha: null };
  } catch {
    return { pending: {}, sha: null };
  }
}

export async function saveAgentPending(env, pending, _sha) {
  const kv = env?.EPHEMERAL_KV;
  if (!kv) return;
  await kv.put(AGENT_PENDING_KEY, JSON.stringify(pending));
}
