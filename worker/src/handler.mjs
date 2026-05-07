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

  if (cmd.cmd === 'help') {
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
