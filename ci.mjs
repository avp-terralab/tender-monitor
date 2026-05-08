import { runOnce } from './monitor.mjs';
import { fetchTender, extractSnapshot } from './prozorro.mjs';
import { sendDigest as tgSend } from './telegram.mjs';
import { checkWatchedEntities } from './entity_watch.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI-mode entrypoint: secrets from env, watchlist + state at repo root.
// Used by GitHub Actions; for local development use main.mjs.

const REPO = dirname(fileURLToPath(import.meta.url));
const watchlistPath = join(REPO, 'watchlist.json');
const stateDir = join(REPO, '_state');
mkdirSync(stateDir, { recursive: true });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars.');
  process.exit(1);
}
if (!existsSync(watchlistPath)) {
  console.error(`Missing ${watchlistPath}. Commit a JSON array at repo root.`);
  process.exit(1);
}

const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf-8'));

const watchedEntitiesPath = join(REPO, 'watched_entities.json');
const watchedEntities = existsSync(watchedEntitiesPath)
  ? JSON.parse(readFileSync(watchedEntitiesPath, 'utf-8'))
  : [];

const cursorPath = join(stateDir, '_watched_feed_cursor.json');
const seenPath = join(stateDir, '_watched_seen.json');

const result = await runOnce({
  runIso: new Date().toISOString(),
  watchlist,
  fetchTender,
  extractSnapshot,
  loadState: async (id) => {
    const p = join(stateDir, `${id}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')).snapshot;
  },
  saveState: async (id, snap) => {
    const p = join(stateDir, `${id}.json`);
    writeFileSync(p, JSON.stringify({
      tender_id: id,
      saved_at: new Date().toISOString(),
      snapshot: snap,
    }, null, 2));
  },
  sendDigest: async (text) => tgSend({ token, chatId }, text),
  updateSheet: async () => { /* no-op in CI */ },
  watchedEntities,
  checkWatchedEntities,
  loadCursor: async () => {
    if (!existsSync(cursorPath)) return null;
    return JSON.parse(readFileSync(cursorPath, 'utf-8'));
  },
  saveCursor: async (c) => {
    writeFileSync(cursorPath, JSON.stringify(c, null, 2));
  },
  loadSeen: async () => {
    if (!existsSync(seenPath)) return null;
    return JSON.parse(readFileSync(seenPath, 'utf-8'));
  },
  saveSeen: async (s) => {
    writeFileSync(seenPath, JSON.stringify(s, null, 2));
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
