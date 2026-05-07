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

  // Routing logic added in next tasks
  return;
}
