import { runOnce } from './monitor.mjs';
import { fetchTender, extractSnapshot } from './prozorro.mjs';
import { sendDigest as tgSend } from './telegram.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '.local-state');
mkdirSync(ROOT, { recursive: true });
mkdirSync(join(ROOT, '_state'), { recursive: true });

const pendingDigestPath = join(ROOT, '_state', '_pending_digest.json');
const watchlistPath = join(ROOT, 'watchlist.json');
const secretsPath = join(ROOT, '.secrets.json');

if (!existsSync(watchlistPath)) {
  console.error(`Missing ${watchlistPath}. Create it as a JSON array, e.g.:`);
  console.error('  [{"tender_id": "UA-2026-04-30-010542-a", "enabled": true}]');
  process.exit(1);
}
if (!existsSync(secretsPath)) {
  console.error(`Missing ${secretsPath}. Create it with telegram_bot_token + telegram_chat_id keys.`);
  process.exit(1);
}

const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf-8'));
const secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));

const result = await runOnce({
  runIso: new Date().toISOString(),
  watchlist,
  fetchTender,
  extractSnapshot,
  loadState: async (id) => {
    const p = join(ROOT, '_state', `${id}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')).snapshot;
  },
  saveState: async (id, snap) => {
    const p = join(ROOT, '_state', `${id}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      tender_id: id,
      saved_at: new Date().toISOString(),
      snapshot: snap,
    }, null, 2));
  },
  sendDigest: async (text) => tgSend(
    { token: secrets.telegram_bot_token, chatId: secrets.telegram_chat_id },
    text,
  ),
  updateSheet: async () => { /* no-op locally */ },
  loadPendingDigest: async () => {
    if (!existsSync(pendingDigestPath)) return null;
    try {
      return JSON.parse(readFileSync(pendingDigestPath, 'utf-8'));
    } catch {
      return null;
    }
  },
  savePendingDigest: async (obj) => {
    writeFileSync(pendingDigestPath, JSON.stringify(obj, null, 2));
  },
  clearPendingDigest: async () => {
    if (existsSync(pendingDigestPath)) unlinkSync(pendingDigestPath);
  },
  disableTender: async (tenderId, reason) => {
    const wl = JSON.parse(readFileSync(watchlistPath, 'utf-8'));
    for (const row of wl) {
      if (row.tender_id === tenderId) {
        row.enabled = false;
        row.notes = (row.notes ? row.notes + ' · ' : '') + `auto-disabled: ${reason}`;
      }
    }
    writeFileSync(watchlistPath, JSON.stringify(wl, null, 2));
  },
});

console.log(JSON.stringify(result, null, 2));
