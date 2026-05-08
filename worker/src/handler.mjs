import {
  parseCommand, handleAdd, handleList, handleStatus, handleRemove,
  handleWatch, handleUnwatch, handleWatched,
  applyMutation, applyEntityMutation, formatInfo, HELP_TEXT,
} from '../../commands.mjs';
import { fetchTender, extractSnapshot, fetchTendersFeed } from '../../prozorro.mjs';
import { sendReply } from '../../telegram.mjs';
import {
  loadWatchlist, saveWatchlist,
  loadWatchedEntities, saveWatchedEntities,
  loadWatchedSeen, saveWatchedSeen,
  ConflictError,
} from './github.mjs';

export async function runHandler({ update, env, deps = {} }) {
  const _loadWatchlist = deps.loadWatchlist ?? loadWatchlist;
  const _saveWatchlist = deps.saveWatchlist ?? saveWatchlist;
  const _fetchTender = deps.fetchTender ?? fetchTender;
  const _extractSnapshot = deps.extractSnapshot ?? extractSnapshot;
  const _sendReply = deps.sendReply ?? sendReply;
  const _loadWatchedEntities = deps.loadWatchedEntities ?? loadWatchedEntities;
  const _saveWatchedEntities = deps.saveWatchedEntities ?? saveWatchedEntities;
  const _loadWatchedSeen = deps.loadWatchedSeen ?? loadWatchedSeen;
  const _saveWatchedSeen = deps.saveWatchedSeen ?? saveWatchedSeen;
  const _fetchTendersFeed = deps.fetchTendersFeed ?? fetchTendersFeed;

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
      reply = await applyMutationWithRetry({
        env,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        computeMutation: ({ watchlist }) =>
          handleAdd({ watchlist, fetchTender: _fetchTender, extractSnapshot: _extractSnapshot }, cmd),
      });
    }
  } else if (cmd.cmd === 'remove') {
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: /remove UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /remove UA-YYYY-MM-DD-NNNNNN-x';
    } else {
      reply = await applyMutationWithRetry({
        env,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        computeMutation: ({ watchlist }) => handleRemove({ watchlist }, cmd),
      });
    }
  } else if (cmd.cmd === 'list') {
    try {
      const { watchlist } = await _loadWatchlist(env);
      // Fetch value from Prozorro for enabled rows in parallel; ignore failures (just no value shown)
      const augmented = await Promise.all(watchlist.map(async (r) => {
        if (!r.enabled) return r;
        try {
          const raw = await _fetchTender(r.tender_id);
          const snap = _extractSnapshot(raw);
          return { ...r, _value: snap.value };
        } catch {
          return r;
        }
      }));
      reply = handleList({ watchlist: augmented });
    } catch (err) {
      console.error('worker: loadWatchlist failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'status') {
    try {
      const { watchlist, sha } = await _loadWatchlist(env);
      reply = handleStatus({ watchlist, sha });
    } catch (err) {
      console.error('worker: status loadWatchlist failed:', err.message);
      reply = `⚠️ Worker live, але GitHub недоступний: ${err.message}`;
    }
  } else if (cmd.cmd === 'info') {
    try {
      const { watchlist } = await _loadWatchlist(env);
      const enabled = watchlist.filter(r => r.enabled);
      if (enabled.length === 0) {
        reply = '📭 Немає активних тендерів.';
      } else {
        const results = await Promise.all(enabled.map(async r => {
          try {
            const raw = await _fetchTender(r.tender_id);
            const snap = _extractSnapshot(raw);
            return {
              tender_id: r.tender_id,
              prozorro_url: `https://prozorro.gov.ua/tender/${r.tender_id}`,
              status: snap.status,
              deadline: snap.tenderPeriod?.endDate ?? null,
              procuring_entity: snap.procuringEntity,
              value: snap.value,
              classification: snap.classification,
              contact: snap.contact,
            };
          } catch (err) {
            return { tender_id: r.tender_id, error: err.message };
          }
        }));
        const groups = results.filter(r => !r.error);
        const errors = results.filter(r => r.error);
        reply = formatInfo({ runIso: new Date().toISOString(), groups, errors });
      }
    } catch (err) {
      console.error('worker: info loadWatchlist failed:', err.message);
      reply = '⚠️ GitHub недоступний, спробуй ще раз';
    }
  } else if (cmd.cmd === 'watched') {
    try {
      const { entities } = await _loadWatchedEntities(env);
      reply = handleWatched({ watchedEntities: entities });
    } catch (err) {
      console.error('worker: /watched failed:', err.message);
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

async function applyMutationWithRetry({ env, loadWatchlist, saveWatchlist, computeMutation }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { watchlist, sha } = await loadWatchlist(env);
      const result = await computeMutation({ watchlist });
      if (!result.mutation) return result.reply;
      const newWatchlist = applyMutation(watchlist, result.mutation);
      await saveWatchlist(env, newWatchlist, sha);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: applyMutationWithRetry failed:', err.message);
      if (err.message.includes('GitHub')) {
        return '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
      }
      return '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}
