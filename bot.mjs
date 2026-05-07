import { parseCommand, handleAdd, handleList, applyMutation } from './commands.mjs';
import { fetchTender, extractSnapshot } from './prozorro.mjs';
import { getUpdates, sendReply } from './telegram.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HELP_TEXT = [
  'Команди:',
  '/add UA-YYYY-MM-DD-NNNNNN-x [нотатки] — додати тендер',
  '/list — показати всі тендери на моніторингу',
  '/help — це повідомлення',
  '',
  'Видалити/призупинити: github.com/avp-terralab/tender-monitor → watchlist.json',
].join('\n');

export async function runBot(deps) {
  const {
    token, allowedChatId,
    getUpdates, sendReply,
    fetchTender, extractSnapshot,
    loadOffset, saveOffset,
    loadWatchlist, saveWatchlist,
  } = deps;

  const offset = (await loadOffset()) ?? 0;

  let updates;
  try {
    updates = await getUpdates({ token, offset });
  } catch (err) {
    if (/401/.test(err.message)) {
      console.error('Bot: 401 — bad TELEGRAM_BOT_TOKEN');
      return { processed: 0, error: 'unauthorized' };
    }
    console.error('Bot: getUpdates failed:', err.message);
    return { processed: 0, error: 'getUpdates_failed' };
  }

  if (updates.length === 0) {
    return { processed: 0 };
  }

  let watchlist = await loadWatchlist();
  let mutated = false;
  let processed = 0;

  for (const u of updates) {
    const msg = u.message;
    if (!msg || String(msg.chat?.id) !== String(allowedChatId)) continue;
    if (typeof msg.text !== 'string') continue;

    const cmd = parseCommand(msg.text);
    let reply;

    if (cmd.cmd === 'add') {
      if (cmd.error === 'invalid_id') {
        reply = '❌ Невалідний tender_id. Формат: UA-YYYY-MM-DD-NNNNNN-x';
      } else if (cmd.error === 'missing_id') {
        reply = '❌ Не вказано tender_id. /add UA-YYYY-MM-DD-NNNNNN-x';
      } else {
        const result = await handleAdd(
          { watchlist, fetchTender, extractSnapshot },
          cmd
        );
        reply = result.reply;
        if (result.mutation) {
          watchlist = applyMutation(watchlist, result.mutation);
          mutated = true;
        }
      }
    } else if (cmd.cmd === 'list') {
      reply = handleList({ watchlist });
    } else if (cmd.cmd === 'help') {
      reply = HELP_TEXT;
    } else if (cmd.cmd === 'unknown') {
      reply = '❓ Не розумію. /help';
    } else {
      continue; // free text — ignore
    }

    try {
      await sendReply({
        token,
        chatId: msg.chat.id,
        text: reply,
        replyToMessageId: msg.message_id,
      });
    } catch (err) {
      console.error('Bot: sendReply failed:', err.message);
    }
    processed++;
  }

  if (mutated) await saveWatchlist(watchlist);

  const lastId = Math.max(...updates.map(u => u.update_id));
  await saveOffset(lastId + 1);

  return { processed };
}

// CI entrypoint (executed when bot.mjs is run directly)
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const REPO = dirname(fileURLToPath(import.meta.url));
  const watchlistPath = join(REPO, 'watchlist.json');
  const stateDir = join(REPO, '_state');
  const offsetPath = join(stateDir, '_telegram_offset.json');
  mkdirSync(stateDir, { recursive: true });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars.');
    process.exit(1);
  }

  const result = await runBot({
    token,
    allowedChatId: chatId,
    getUpdates: ({ token, offset }) => getUpdates({ token, offset }),
    sendReply: (args) => sendReply(args),
    fetchTender,
    extractSnapshot,
    loadOffset: async () => {
      if (!existsSync(offsetPath)) return 0;
      return JSON.parse(readFileSync(offsetPath, 'utf-8')).offset ?? 0;
    },
    saveOffset: async (offset) => {
      writeFileSync(offsetPath, JSON.stringify({ offset }, null, 2));
    },
    loadWatchlist: async () => {
      if (!existsSync(watchlistPath)) return [];
      return JSON.parse(readFileSync(watchlistPath, 'utf-8'));
    },
    saveWatchlist: async (wl) => {
      writeFileSync(watchlistPath, JSON.stringify(wl, null, 2));
    },
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.error === 'unauthorized') process.exit(1);
}
