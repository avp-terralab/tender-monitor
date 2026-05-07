import { parseCommand, handleAdd, handleList, applyMutation, HELP_TEXT } from '../../commands.mjs';
import { fetchTender, extractSnapshot } from '../../prozorro.mjs';
import { sendReply } from '../../telegram.mjs';
import { loadWatchlist, saveWatchlist, ConflictError } from './github.mjs';

export async function runHandler({ update, env, deps = {} }) {
  const _loadWatchlist = deps.loadWatchlist ?? loadWatchlist;
  const _saveWatchlist = deps.saveWatchlist ?? saveWatchlist;
  const _fetchTender = deps.fetchTender ?? fetchTender;
  const _extractSnapshot = deps.extractSnapshot ?? extractSnapshot;
  const _sendReply = deps.sendReply ?? sendReply;

  const msg = update.message;
  if (!msg) return;
  if (String(msg.chat?.id) !== String(env.ALLOWED_CHAT_ID)) return;
  if (typeof msg.text !== 'string') return;

  const cmd = parseCommand(msg.text);
  let reply;

  if (cmd.cmd === 'add') {
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /add UA-YYYY-MM-DD-NNNNNN-x';
    } else {
      reply = await handleAddWithRetry({
        env, cmd,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        fetchTender: _fetchTender,
        extractSnapshot: _extractSnapshot,
      });
    }
  } else if (cmd.cmd === 'list') {
    try {
      const { watchlist } = await _loadWatchlist(env);
      reply = handleList({ watchlist });
    } catch (err) {
      console.error('worker: loadWatchlist failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'help') {
    reply = HELP_TEXT;
  } else if (cmd.cmd === 'unknown') {
    reply = '❓ Не розумію. /help';
  } else {
    return; // free text or other unhandled — no reply
  }

  try {
    await _sendReply({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: msg.chat.id,
      text: reply,
      replyToMessageId: msg.message_id,
    });
  } catch (err) {
    console.error('worker: sendReply failed:', err.message);
  }
}

async function handleAddWithRetry({ env, cmd, loadWatchlist, saveWatchlist, fetchTender, extractSnapshot }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { watchlist, sha } = await loadWatchlist(env);
      const result = await handleAdd({ watchlist, fetchTender, extractSnapshot }, cmd);
      if (!result.mutation) return result.reply;
      const newWatchlist = applyMutation(watchlist, result.mutation);
      await saveWatchlist(env, newWatchlist, sha);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: handleAdd failed:', err.message);
      if (err.message.includes('GitHub')) {
        return '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
      }
      return '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}
