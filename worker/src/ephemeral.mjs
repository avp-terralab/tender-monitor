// Per-chat "last on-demand view" message ids, stored in Cloudflare KV so the
// next view command can delete the previous one. Keyed by chatId; 48h TTL (a
// message older than 48h can't be deleted anyway). `kv` is the EPHEMERAL_KV
// binding (or a fake in tests); a missing kv degrades to a no-op.
const key = (chatId) => `eph:${chatId}`;

export async function loadEphemeral(kv, chatId) {
  if (!kv) return [];
  const raw = await kv.get(key(chatId));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveEphemeral(kv, chatId, ids) {
  if (!kv) return;
  await kv.put(key(chatId), JSON.stringify(ids), { expirationTtl: 172800 });
}
