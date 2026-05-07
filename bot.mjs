import { parseCommand, handleAdd, handleList, applyMutation } from './commands.mjs';

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
