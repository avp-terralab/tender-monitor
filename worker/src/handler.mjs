import {
  parseCommand, handleAdd, handleStatus, handleRemove,
  handleWatch, handleUnwatch, handleWatched,
  handleInvite, handleRedeem, handleRevoke, handleRole, handleNotify, buildNotifyButton, buildRoleChangeNotice, handleWhoami, handleUsersList, handleInvitesList,
  handleArchive, handleArchiveDetail, handleUnarchive,
  applyMutation, applyEntityMutation, applyInviteMutation, applyAllowedUsersMutation,
  applyArchiveMutation,
  formatInfo, formatInfoPages, buildHelpText, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD,
  TERMINAL_STATUSES, hydrateContractDocs,
} from '../../commands.mjs';
import { fetchTender, extractSnapshot, fetchTendersFeed, fetchContract, searchTenderByEdrpou } from '../../prozorro.mjs';
import { sendReply, editMessageReplyMarkup, answerCallbackQuery, setMyCommands } from '../../telegram.mjs';
import {
  loadWatchlist, saveWatchlist,
  loadWatchedEntities, saveWatchedEntities,
  loadWatchedSeen, saveWatchedSeen, fetchLastCommit,
  loadAllowedUsers, saveAllowedUsers,
  loadInvites, saveInvites,
  loadArchivedTenders, saveArchivedTenders,
  loadPendingDigest, loadTenderState, fetchLatestDeployCommit,
  ConflictError,
} from './github.mjs';

// Module-scope 60-second cache for /status responses, keyed by chatId string.
// Survives across invocations within the same CF Worker instance; cleared on cold start.
const STATUS_CACHE = new Map(); // chatId → { text, builtAt: number }
const STATUS_CACHE_TTL_MS = 60_000;

const BOT_USERNAME = 'terralab_tenders_bot';

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
  const _searchTenderByEdrpou = deps.searchTenderByEdrpou ?? searchTenderByEdrpou;
  const _fetchContract = deps.fetchContract ?? fetchContract;
  const _loadAllowedUsers = deps.loadAllowedUsers ?? loadAllowedUsers;
  const _saveAllowedUsers = deps.saveAllowedUsers ?? saveAllowedUsers;
  const _loadInvites = deps.loadInvites ?? loadInvites;
  const _saveInvites = deps.saveInvites ?? saveInvites;
  const _loadArchivedTenders = deps.loadArchivedTenders ?? loadArchivedTenders;
  const _saveArchivedTenders = deps.saveArchivedTenders ?? saveArchivedTenders;
  const _generateToken = deps.generateToken ?? (() => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  });
  const _now = deps.now ?? (() => new Date());
  const _editMessageReplyMarkup = deps.editMessageReplyMarkup ?? editMessageReplyMarkup;
  const _answerCallbackQuery = deps.answerCallbackQuery ?? answerCallbackQuery;
  const _setMyCommands = deps.setMyCommands ?? setMyCommands;
  const _fetchLastCommit = deps.fetchLastCommit ?? fetchLastCommit;
  const _loadPendingDigest = deps.loadPendingDigest ?? loadPendingDigest;
  const _loadTenderState = deps.loadTenderState ?? loadTenderState;
  const _fetchLatestDeployCommit = deps.fetchLatestDeployCommit ?? fetchLatestDeployCommit;
  // Tests may inject their own Map to avoid cross-test cache pollution.
  const _statusCache = deps.statusCache ?? STATUS_CACHE;

  const cq = update.callback_query;
  if (cq) {
    return handleCallbackQuery({
      cq, env, _editMessageReplyMarkup, _answerCallbackQuery,
      _loadAllowedUsers, _saveAllowedUsers,
      _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
      _fetchTender, _extractSnapshot,
    });
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat?.id ?? '');
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const { isAdmin, isInvited, isAllowed, isEditor, role, userRecord } =
    await resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where: 'msg' });

  // /start works for everyone — reveals chat_id; for allowed users, also seeds chat-scope command list.
  // /start <token> is handled in a later branch.
  if (typeof msg.text === 'string' && /^\/start(?:@\w+)?\s*$/i.test(msg.text)) {
    const startReply = isAdmin
      ? `👋 Привіт!\n\nТвій chat_id: <code>${chatId}</code>\n\n/help — список команд.`
      : `👋 Привіт!\n\nЦе приватний бот. Твій chat_id: <code>${chatId}</code>\n\nНадішли цей id адміну, щоб отримати доступ.`;
    try {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: startReply,
        replyToMessageId: msg.message_id,
        replyMarkup: isAllowed ? MAIN_KEYBOARD : undefined,
      });
    } catch (err) {
      console.error('worker: sendReply /start failed:', err.message);
    }
    if (isAllowed) {
      // Fire-and-forget; logs but doesn't block.
      syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, chatId, role);
    }
    return;
  }

  // /start <token> handled below regardless of allowlist (it grants access).
  const isStartWithToken = typeof msg.text === 'string' && /^\/start(?:@\w+)?\s+\S/i.test(msg.text);
  if (!isAllowed && !isStartWithToken) return;
  if (typeof msg.text !== 'string') return;

  const cmd = parseCommand(msg.text);
  let reply;
  let notifyReplyMarkup = null;

  const MUTATING = new Set(['add', 'remove', 'watch', 'unwatch', 'unarchive']);
  if (MUTATING.has(cmd.cmd) && !isEditor) {
    reply = '🚫 Це команда для редакторів. У тебе доступ лише для перегляду.';
  } else if (cmd.cmd === 'start') {
    // /start without payload was handled earlier; here we only see /start <token>.
    if (cmd.error === 'invalid_token') {
      reply = '❌ Невалідне посилання';
    } else if (cmd.token) {
      try {
        const { invites, sha: inviteSha } = await _loadInvites(env);
        const { users, sha: usersSha } = await _loadAllowedUsers(env);
        const result = handleRedeem(
          { invites, allowedUsers: users, adminChatId, chatId, now: _now },
          { token: cmd.token },
        );
        reply = result.reply;
        if (result.inviteMutation && result.userMutation) {
          let mutationASucceeded = false;
          let mutationBSucceeded = false;
          // Mutation A: invites.json — consume token
          try {
            const newInvites = applyInviteMutation(invites, result.inviteMutation);
            await _saveInvites(env, newInvites, inviteSha);
            mutationASucceeded = true;
          } catch (err) {
            console.error('worker: saveInvites in redeem failed:', err.message);
            reply = '⚠️ Помилка збереження. Спробуй ще раз.';
            // No partial state created since Mutation A failed before Mutation B.
          }
          // Mutation B only if A succeeded.
          if (mutationASucceeded) {
            try {
              const newUsers = applyAllowedUsersMutation(users, result.userMutation);
              await _saveAllowedUsers(env, newUsers, usersSha);
              mutationBSucceeded = true;
            } catch (err) {
              console.error('worker: saveAllowedUsers in redeem failed:', err.message);
              reply = '⚠️ Токен спалено, але доступ не додано. Напиши адміну chat_id.';
            }
          }
          // Notify admin only if both mutations succeeded.
          if (mutationBSucceeded && result.adminNotice && adminChatId) {
            try {
              await _sendReply({
                token: env.TELEGRAM_BOT_TOKEN,
                chatId: Number(adminChatId),
                text: result.adminNotice,
              });
            } catch (err) {
              console.error('worker: admin notification failed:', err.message);
            }
          }
          // Sync chat-scope commands for the freshly-redeemed user.
          if (mutationBSucceeded && result.userMutation?.row?.role) {
            syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, chatId, result.userMutation.row.role);
          }
        }
      } catch (err) {
        console.error('worker: redeem load failed:', err.message);
        reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
      }
    } else {
      // /start without payload was supposed to be handled earlier — defensive only
      return;
    }
  } else if (cmd.cmd === 'add') {
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /add UA-YYYY-MM-DD-NNNNNN-x';
    } else {
      let archive = [];
      try {
        ({ archive } = await _loadArchivedTenders(env));
      } catch (err) {
        console.error('worker: /add loadArchivedTenders failed:', err.message);
        // continue without archive cross-check on transient failures
      }
      reply = await applyMutationWithRetry({
        env,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        computeMutation: ({ watchlist }) =>
          handleAdd({ watchlist, archive, fetchTender: _fetchTender, extractSnapshot: _extractSnapshot }, cmd),
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
  } else if (cmd.cmd === 'status') {
    if (!isAdmin) return;
    try {
      const cacheKey = String(chatId);
      const cached = _statusCache.get(cacheKey);
      if (cached && Date.now() - cached.builtAt < STATUS_CACHE_TTL_MS) {
        const ageSec = Math.round((Date.now() - cached.builtAt) / 1000);
        reply = cached.text + `\n\n<i>(cached, ${ageSec}с тому)</i>`;
      } else {
        // Parallel base fetches; watchlist failure is fatal, others are best-effort.
        const [wlRes, usersRes, invitesRes, lastCommitRes] = await Promise.allSettled([
          _loadWatchlist(env),
          _loadAllowedUsers(env),
          _loadInvites(env),
          _fetchLastCommit(env),
        ]);
        if (wlRes.status !== 'fulfilled') throw wlRes.reason;
        const { watchlist, sha } = wlRes.value;
        const users = usersRes.status === 'fulfilled' ? usersRes.value.users : undefined;
        const invites = invitesRes.status === 'fulfilled' ? invitesRes.value.invites : undefined;
        const lastCommit = lastCommitRes.status === 'fulfilled' ? lastCommitRes.value : null;

        // Admin-only rich enrichment fetched in parallel (all best-effort).
        const [archiveRes, entitiesRes, pendingDigestRes, latestDeployRes] = await Promise.allSettled([
          _loadArchivedTenders(env),
          _loadWatchedEntities(env),
          _loadPendingDigest(env),
          _fetchLatestDeployCommit(env),
        ]);
        const archiveArr = archiveRes.status === 'fulfilled'
          ? (archiveRes.value.archive ?? archiveRes.value ?? [])
          : [];
        const entitiesArr = entitiesRes.status === 'fulfilled'
          ? (entitiesRes.value.entities ?? entitiesRes.value ?? [])
          : [];
        const rawPendingDigest = pendingDigestRes.status === 'fulfilled' ? pendingDigestRes.value : null;
        const latestDeploy = latestDeployRes.status === 'fulfilled' ? latestDeployRes.value : null;

        // Compute watchlist breakdown: classify each enabled tender as activeIntake
        // (deadline in the future) or waiting (past/missing deadline).
        const enabledRows = watchlist.filter(r => r.enabled);
        const snapshots = await Promise.all(
          enabledRows.map(r => _loadTenderState(env, r.tender_id).catch(() => null))
        );
        const runIso = _now().toISOString();
        let activeIntake = 0;
        let waiting = 0;
        for (const snap of snapshots) {
          if (!snap?.tenderPeriod?.endDate) { waiting++; continue; }
          if (new Date(snap.tenderPeriod.endDate) > new Date(runIso)) activeIntake++;
          else waiting++;
        }

        // Summarise pending digest buffer.
        let pendingDigestSummary = null;
        if (rawPendingDigest) {
          const items = rawPendingDigest.items ?? {};
          const itemCount = Object.keys(items).length;
          const allFiredAts = [
            ...Object.values(items).map(i => i.first_fired_at),
            ...(rawPendingDigest.archived ?? []).map(a => a.fired_at),
            ...(rawPendingDigest.errors ?? []).map(e => e.fired_at),
          ].filter(Boolean);
          const oldestEventAt = allFiredAts.length > 0
            ? allFiredAts.reduce((a, b) => (a < b ? a : b))
            : null;
          pendingDigestSummary = { itemCount, oldestEventAt };
        }

        const rich = {
          watchlistBreakdown: { activeIntake, waiting, runIso },
          archiveCount: Array.isArray(archiveArr) ? archiveArr.length : 0,
          watchedEntitiesCount: Array.isArray(entitiesArr) ? entitiesArr.length : 0,
          pendingDigest: pendingDigestSummary,
          latestDeploy,
        };

        reply = handleStatus({ watchlist, sha, users, invites, lastCommit, now: _now, rich });
        _statusCache.set(cacheKey, { text: reply, builtAt: Date.now() });
      }
    } catch (err) {
      console.error('worker: status loadWatchlist failed:', err.message);
      reply = `⚠️ Worker live, але GitHub недоступний: ${err.message}`;
    }
  } else if (cmd.cmd === 'info') {
    try {
      const { watchlist } = await _loadWatchlist(env);
      let targets;
      if (cmd.tender_id) {
        const row = watchlist.find(r => r.tender_id === cmd.tender_id);
        if (!row) {
          // Check archive before saying "not in watchlist"
          try {
            const { archive } = await _loadArchivedTenders(env);
            if (archive.some(a => a.tender_id === cmd.tender_id)) {
              reply = `📦 Ця закупівля в архіві. /archive ${cmd.tender_id}`;
              targets = null;
            } else {
              reply = `❓ ${cmd.tender_id} не у watchlist. Додай: /add ${cmd.tender_id}`;
              targets = null;
            }
          } catch (err) {
            reply = `❓ ${cmd.tender_id} не у watchlist. Додай: /add ${cmd.tender_id}`;
            targets = null;
          }
        } else {
          targets = [row];
        }
      } else {
        targets = watchlist.filter(r => r.enabled);
      }
      if (targets && targets.length === 0) {
        reply = '📭 Немає активних тендерів.';
      } else if (targets) {
        const results = await Promise.all(targets.map(async r => {
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
              awards: snap.awards,
              _snapshot: snap,
              _row: r,
            };
          } catch (err) {
            return { tender_id: r.tender_id, error: err.message };
          }
        }));
        const groups = results.filter(r => !r.error);
        const errors = results.filter(r => r.error);
        reply = cmd.tender_id
          ? formatInfo({ runIso: new Date().toISOString(), groups, errors })
          : formatInfoPages({ runIso: new Date().toISOString(), groups, errors });

        // Live archive: when /info UA-... shows a terminal status for a watchlist
        // tender, archive it inline. Reduces archive lag from monitor-cron cadence
        // to per-/info-call. Only triggered for single-tender queries.
        if (cmd.tender_id && groups.length === 1 && TERMINAL_STATUSES.has(groups[0].status)) {
          const archived = await applyLiveArchive({
            env,
            loadArchivedTenders: _loadArchivedTenders,
            saveArchivedTenders: _saveArchivedTenders,
            loadWatchlist: _loadWatchlist,
            saveWatchlist: _saveWatchlist,
            fetchContract: _fetchContract,
            tender_id: cmd.tender_id,
            snapshot: groups[0]._snapshot,
            notes: groups[0]._row.notes ?? '',
          });
          if (archived) {
            reply = reply + `\n\n📦 Архівовано — переміщено в /archive ${cmd.tender_id}`;
          }
        }
      }
    } catch (err) {
      console.error('worker: info loadWatchlist failed:', err.message);
      reply = '⚠️ GitHub недоступний, спробуй ще раз';
    }
  } else if (cmd.cmd === 'watch') {
    if (cmd.error === 'invalid_edrpou') {
      reply = '❌ ЄДРПОУ має бути 8 цифр';
    } else if (cmd.error === 'missing_edrpou') {
      reply = '❌ Не вказано ЄДРПОУ. /watch 12345678';
    } else {
      reply = await applyEntityMutationWithRetry({
        env,
        loadWatchedEntities: _loadWatchedEntities,
        saveWatchedEntities: _saveWatchedEntities,
        computeMutation: ({ entities }) => handleWatch({
          watchedEntities: entities,
          fetchTendersFeed: _fetchTendersFeed,
          fetchTender: _fetchTender,
          extractSnapshot: _extractSnapshot,
          searchTenderByEdrpou: _searchTenderByEdrpou,
        }, cmd),
        onSuccess: async (mutation) => {
          if (mutation.bootstrap && mutation.bootstrap.ids.length > 0) {
            const { seen, sha } = await _loadWatchedSeen(env);
            const updated = { ...seen };
            updated[mutation.bootstrap.edrpou] = [
              ...(updated[mutation.bootstrap.edrpou] ?? []),
              ...mutation.bootstrap.ids,
            ];
            await _saveWatchedSeen(env, updated, sha);
          }
        },
      });
    }
  } else if (cmd.cmd === 'unwatch') {
    if (cmd.error === 'invalid_edrpou') {
      reply = '❌ ЄДРПОУ має бути 8 цифр';
    } else if (cmd.error === 'missing_edrpou') {
      reply = '❌ Не вказано ЄДРПОУ. /unwatch 12345678';
    } else {
      reply = await applyEntityMutationWithRetry({
        env,
        loadWatchedEntities: _loadWatchedEntities,
        saveWatchedEntities: _saveWatchedEntities,
        computeMutation: ({ entities }) => handleUnwatch({ watchedEntities: entities }, cmd),
      });
    }
  } else if (cmd.cmd === 'watched') {
    try {
      const { entities } = await _loadWatchedEntities(env);
      reply = handleWatched({ watchedEntities: entities });
    } catch (err) {
      console.error('worker: /watched failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'invite') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_role') {
      reply = '❌ Вкажи роль першим: /invite editor [імʼя] або /invite viewer [імʼя]';
    } else if (cmd.error === 'invalid_role') {
      reply = '❌ Невалідна роль. Тільки editor або viewer.';
    } else if (cmd.error === 'missing_label') {
      reply = '❌ Вкажи імʼя: /invite editor [імʼя]';
    } else {
      reply = await applyInviteMutationWithRetry({
        env,
        loadInvites: _loadInvites,
        saveInvites: _saveInvites,
        computeMutation: ({ invites }) =>
          handleInvite({ invites, generateToken: _generateToken, now: _now, botUsername: BOT_USERNAME }, cmd),
      });
    }
  } else if (cmd.cmd === 'invites') {
    if (!isAdmin) return;
    try {
      const { invites } = await _loadInvites(env);
      reply = handleInvitesList({ invites, now: _now });
    } catch (err) {
      console.error('worker: /invites failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'users') {
    if (!isAdmin) return;
    try {
      const { users } = await _loadAllowedUsers(env);
      reply = handleUsersList({ allowedUsers: users, adminChatId });
    } catch (err) {
      console.error('worker: /users failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'revoke') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_chat_id') {
      reply = '❌ Не вказано chat_id. /revoke 12345';
    } else if (cmd.error === 'invalid_chat_id') {
      reply = '❌ chat_id має бути числом';
    } else {
      reply = await applyAllowedUsersMutationWithRetry({
        env,
        loadAllowedUsers: _loadAllowedUsers,
        saveAllowedUsers: _saveAllowedUsers,
        computeMutation: ({ users }) =>
          handleRevoke({ allowedUsers: users, adminChatId }, cmd),
      });
    }
  } else if (cmd.cmd === 'role') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_args') {
      reply = '❌ Формат: /role [editor|viewer] [chat_id]';
    } else if (cmd.error === 'invalid_role') {
      reply = '❌ Невалідна роль. Тільки editor або viewer.';
    } else if (cmd.error === 'missing_chat_id') {
      reply = '❌ Не вказано chat_id. /role editor 12345';
    } else if (cmd.error === 'invalid_chat_id') {
      reply = '❌ chat_id має бути числом';
    } else {
      reply = await applyAllowedUsersMutationWithRetry({
        env,
        loadAllowedUsers: _loadAllowedUsers,
        saveAllowedUsers: _saveAllowedUsers,
        computeMutation: ({ users }) =>
          handleRole({ allowedUsers: users, adminChatId }, cmd),
      });
      // Success replies lead with the role icon (✏️ editor / 📄 viewer); error
      // and no-op replies use other prefixes (❓ 🚫 ℹ️). Detect success by the
      // role-icon prefix so we only fan out side-effects on real changes.
      const roleSuccess = typeof reply === 'string'
        && (reply.startsWith('✏️') || reply.startsWith('📄'));
      if (roleSuccess) {
        syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, cmd.chat_id, cmd.role);
        // Notify the target user about their new role + role-filtered command list.
        try {
          await _sendReply({
            token: env.TELEGRAM_BOT_TOKEN,
            chatId: Number(cmd.chat_id),
            text: buildRoleChangeNotice(cmd.role),
          });
        } catch (err) {
          console.error('worker: /role target notify failed:', err.message);
        }
      }
    }
  } else if (cmd.cmd === 'archive') {
    try {
      const { archive } = await _loadArchivedTenders(env);
      if (cmd.tender_id) {
        reply = await handleArchiveDetail(
          { archive, fetchTender: _fetchTender, extractSnapshot: _extractSnapshot, fetchContract: _fetchContract },
          cmd,
        );
      } else {
        reply = handleArchive({ archive });
      }
    } catch (err) {
      console.error('worker: /archive failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'unarchive') {
    if (cmd.error === 'invalid_id') {
      reply = '❌ Невалідний tender_id. Формат: /unarchive UA-YYYY-MM-DD-NNNNNN-x';
    } else if (cmd.error === 'missing_id') {
      reply = '❌ Не вказано tender_id. /unarchive UA-YYYY-MM-DD-NNNNNN-x';
    } else {
      reply = await applyUnarchive({
        env,
        loadArchivedTenders: _loadArchivedTenders,
        saveArchivedTenders: _saveArchivedTenders,
        tender_id: cmd.tender_id,
      });
    }
  } else if (cmd.cmd === 'help') {
    reply = buildHelpText(role);
  } else if (cmd.cmd === 'whoami') {
    try {
      const { users } = await _loadAllowedUsers(env);
      reply = handleWhoami({ allowedUsers: users, adminChatId, chatId });
    } catch (err) {
      console.error('worker: /whoami failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний';
    }
  } else if (cmd.cmd === 'notify') {
    if (cmd.error === 'invalid_arg') {
      reply = '❌ Формат: /notify on або /notify off';
    } else {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { users, sha } = await _loadAllowedUsers(env);
          const result = handleNotify({ allowedUsers: users, adminChatId, chatId }, cmd);
          notifyReplyMarkup = result.replyMarkup;
          reply = result.reply;
          if (!result.mutation) break;
          const newUsers = applyAllowedUsersMutation(users, result.mutation);
          await _saveAllowedUsers(env, newUsers, sha);
          break;
        } catch (err) {
          if (err instanceof ConflictError && attempt === 0) continue;
          if (err instanceof ConflictError) {
            reply = '⚠️ Конфлікт версій, спробуй ще раз';
            break;
          }
          console.error('worker: /notify failed:', err.message);
          reply = err.message.includes('GitHub')
            ? '⚠️ GitHub тимчасово недоступний, спробуй за хвилину'
            : '⚠️ Сталася помилка на стороні бота';
          break;
        }
      }
    }
  } else if (cmd.cmd === 'unknown') {
    reply = '❓ Не розумію. /help';
  } else {
    return; // free text or other unhandled — no reply
  }

  const pages = Array.isArray(reply) ? reply : [reply];
  for (let i = 0; i < pages.length; i++) {
    const isLast = i === pages.length - 1;
    try {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: pages[i],
        replyToMessageId: i === 0 ? msg.message_id : undefined,
        replyMarkup: isLast
          ? (notifyReplyMarkup ?? (isAllowed ? MAIN_KEYBOARD : undefined))
          : undefined,
      });
    } catch (err) {
      console.error('worker: sendReply failed:', err.message);
    }
  }

  // Keep this chat's "/" autocomplete in sync with the current role's command
  // list on every reply (fire-and-forget). Self-heals when BOT_COMMANDS_BY_ROLE
  // changes without requiring the user to send /start.
  if (isAllowed) {
    syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, chatId, role);
  }
}

const TENDER_ID_RE = /^UA-\d{4}-\d{2}-\d{2}-\d{6}-[a-zA-Z]$/;

const KYIV_TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});

async function handleCallbackQuery({
  cq, env, _editMessageReplyMarkup, _answerCallbackQuery,
  _loadAllowedUsers, _saveAllowedUsers,
  _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
  _fetchTender, _extractSnapshot,
}) {
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const chatId = String(cq.message?.chat?.id ?? '');
  const messageId = cq.message?.message_id;
  const { isAdmin, isAllowed, isEditor } =
    await resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where: 'callback' });

  const ack = (text, showAlert = false) => _answerCallbackQuery({
    token: env.TELEGRAM_BOT_TOKEN, callbackQueryId: cq.id, text, showAlert,
  });

  if (!isAllowed) {
    await ack('🚫 Доступ заборонено', true);
    return;
  }

  const data = String(cq.data ?? '');
  if (data === 'noop') { await ack(); return; }

  if (data === 'notify:on' || data === 'notify:off') {
    if (isAdmin) { await ack('🔔 Адмін завжди отримує'); return; }
    const desired = data === 'notify:on';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { users, sha } = await _loadAllowedUsers(env);
        const mutation = { type: 'set_notifications', chat_id: chatId, value: desired };
        const newUsers = applyAllowedUsersMutation(users, mutation);
        await _saveAllowedUsers(env, newUsers, sha);
        try {
          await _editMessageReplyMarkup({
            token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
            replyMarkup: buildNotifyButton(desired),
          });
        } catch (err) {
          console.error('worker: notify edit keyboard failed:', err.message);
        }
        await ack(desired ? '✅ Сповіщення увімкнено' : '✅ Сповіщення вимкнено');
        return;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        console.error('worker: notify callback failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
    }
    await ack('⚠️ Не зміг зберегти');
    return;
  }

  if (data.startsWith('add:')) {
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    const tenderId = data.slice(4);
    if (!TENDER_ID_RE.test(tenderId)) {
      await ack('❌ Невалідний tender_id');
      return;
    }
    const result = await applyMutationWithRetry({
      env,
      loadWatchlist: _loadWatchlist,
      saveWatchlist: _saveWatchlist,
      computeMutation: async ({ watchlist }) => {
        let archive = [];
        try {
          ({ archive } = await _loadArchivedTenders(env));
        } catch (err) {
          console.error('worker: callback add loadArchivedTenders failed:', err.message);
        }
        return handleAdd({
          watchlist, archive,
          fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
        }, { tender_id: tenderId, notes: null });
      },
    });
    await onAddResult({ result, tenderId, chatId, messageId, env, _editMessageReplyMarkup, ack });
    return;
  }

  await ack('❓ Невідома кнопка');
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

async function applyAllowedUsersMutationWithRetry({ env, loadAllowedUsers, saveAllowedUsers, computeMutation }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { users, sha } = await loadAllowedUsers(env);
      const result = computeMutation({ users });
      if (!result.mutation) return result.reply;
      const next = applyAllowedUsersMutation(users, result.mutation);
      await saveAllowedUsers(env, next, sha);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: applyAllowedUsersMutationWithRetry failed:', err.message);
      return err.message.includes('GitHub')
        ? '⚠️ GitHub тимчасово недоступний, спробуй за хвилину'
        : '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}

async function applyInviteMutationWithRetry({ env, loadInvites, saveInvites, computeMutation }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { invites, sha } = await loadInvites(env);
      const result = computeMutation({ invites });
      if (!result.mutation) return result.reply;
      const next = applyInviteMutation(invites, result.mutation);
      await saveInvites(env, next, sha);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: applyInviteMutationWithRetry failed:', err.message);
      return err.message.includes('GitHub')
        ? '⚠️ GitHub тимчасово недоступний, спробуй за хвилину'
        : '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}

async function applyEntityMutationWithRetry({ env, loadWatchedEntities, saveWatchedEntities, computeMutation, onSuccess }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { entities, sha } = await loadWatchedEntities(env);
      const result = await computeMutation({ entities });
      if (!result.mutation) return result.reply;
      const newEntities = applyEntityMutation(entities, result.mutation);
      await saveWatchedEntities(env, newEntities, sha);
      if (onSuccess) await onSuccess(result.mutation);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: applyEntityMutation failed:', err.message);
      if (err.message.includes('GitHub')) {
        return '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
      }
      return '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}

// Triggered inline from /info UA-... when fresh fetch shows a terminal status.
// Two writes: append to archived_tenders.json + remove from watchlist.json.
// Best-effort — failures are logged, not surfaced (caller decides whether to
// add the "📦 Архівовано" notice based on return value).
async function applyLiveArchive({
  env, loadArchivedTenders, saveArchivedTenders,
  loadWatchlist, saveWatchlist,
  fetchContract, tender_id, snapshot, notes,
}) {
  try {
    await hydrateContractDocs(snapshot.contracts, fetchContract);
  } catch (err) {
    // hydrate is best-effort; archive proceeds even if some contracts fail
    console.error('worker: live archive hydrateContractDocs failed:', err.message);
  }

  // 1. Append to archive (idempotent — skip if already present)
  let archiveWritten = false;
  try {
    const { archive, sha } = await loadArchivedTenders(env);
    if (archive.some(a => a.tender_id === tender_id)) {
      archiveWritten = true; // already archived, treat as success
    } else {
      const row = {
        tender_id,
        notes: notes ?? '',
        archived_at: new Date().toISOString(),
        final_status: snapshot.status,
        final_snapshot: snapshot,
      };
      const newArchive = applyArchiveMutation(archive, { type: 'append_archive', row });
      await saveArchivedTenders(env, newArchive, sha);
      archiveWritten = true;
    }
  } catch (err) {
    console.error('worker: live archive saveArchive failed:', err.message);
    return false;
  }

  // 2. Remove from watchlist (best-effort — if it fails, next monitor cycle catches it)
  try {
    const { watchlist, sha } = await loadWatchlist(env);
    if (watchlist.some(r => r.tender_id === tender_id)) {
      const newWatchlist = applyMutation(watchlist, { type: 'delete', tender_id });
      await saveWatchlist(env, newWatchlist, sha);
    }
  } catch (err) {
    console.error('worker: live archive removeWatchlist failed:', err.message);
    // Archive succeeded; watchlist removal will be retried by next monitor cycle.
  }

  return archiveWritten;
}

async function applyUnarchive({ env, loadArchivedTenders, saveArchivedTenders, tender_id }) {
  try {
    const { archive, sha } = await loadArchivedTenders(env);
    const result = handleUnarchive({ archive }, { tender_id });
    if (!result.archiveMutation) return result.reply;
    const newArchive = applyArchiveMutation(archive, result.archiveMutation);
    await saveArchivedTenders(env, newArchive, sha);
    return result.reply;
  } catch (err) {
    if (err instanceof ConflictError) {
      return '⚠️ Конфлікт версій, спробуй ще раз';
    }
    console.error('worker: applyUnarchive failed:', err.message);
    return err.message.includes('GitHub')
      ? '⚠️ GitHub тимчасово недоступний, спробуй за хвилину'
      : '⚠️ Сталася помилка на стороні бота';
  }
}

async function onAddResult({ result, tenderId, chatId, messageId, env, _editMessageReplyMarkup, ack }) {
  const time = formatKyivTime(new Date());
  if (typeof result === 'string' && /^✅/.test(result)) {
    await safeEditKeyboard(_editMessageReplyMarkup, env, chatId, messageId, `✅ Додано ${time}`);
    await ack(`✅ ${tenderId} додано у watchlist`);
    return;
  }
  if (typeof result === 'string' && /Вже моніторю/.test(result)) {
    await safeEditKeyboard(_editMessageReplyMarkup, env, chatId, messageId, `ℹ️ Вже додано`);
    await ack('ℹ️ Вже моніторю');
    return;
  }
  if (typeof result === 'string' && /в архіві/i.test(result)) {
    await safeEditKeyboard(_editMessageReplyMarkup, env, chatId, messageId, `📦 В архіві`);
    await ack('📦 Тендер в архіві');
    return;
  }
  await ack(typeof result === 'string' ? result : '⚠️ Помилка', true);
}

async function safeEditKeyboard(_edit, env, chatId, messageId, label) {
  try {
    await _edit({
      token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      replyMarkup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] },
    });
  } catch (err) {
    console.error('worker: editMessageReplyMarkup failed:', err.message);
  }
}

function formatKyivTime(d) {
  return KYIV_TIME_FMT.format(d);
}

async function syncBotCommands(_setMyCommands, token, chatId, role) {
  const commands = BOT_COMMANDS_BY_ROLE[role] ?? BOT_COMMANDS_BY_ROLE.viewer;
  try {
    await _setMyCommands({ token, commands, chatId });
  } catch (err) {
    console.error('worker: setMyCommands failed:', err.message);
  }
}

// Resolves auth/role context for a chat. Used by both runHandler and
// handleCallbackQuery so they share a single source of truth. `where` tags
// the log line so we can tell message vs callback failures apart.
async function resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where }) {
  const isAdmin = chatId !== '' && chatId === adminChatId;
  let userRecord = null;
  if (!isAdmin) {
    try {
      const { users } = await _loadAllowedUsers(env);
      userRecord = users.find(u => u.chat_id === chatId) ?? null;
    } catch (err) {
      console.error(`worker: ${where} loadAllowedUsers failed:`, err.message);
      // Fail closed — non-admin sees nothing if we can't verify.
    }
  }
  const isInvited = userRecord !== null;
  const userRole = userRecord?.role ?? 'viewer';
  const isEditor = isAdmin || userRole === 'editor';
  const isAllowed = isAdmin || isInvited;
  const role = isAdmin ? 'admin' : (isEditor ? 'editor' : 'viewer');
  return { isAdmin, isInvited, isAllowed, isEditor, role, userRole, userRecord };
}
