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
