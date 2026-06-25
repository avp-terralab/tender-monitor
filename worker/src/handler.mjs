import {
  parseCommand, buildArgPrompt, commandFromReplyPrompt, handleAdd, handleStatus, handleRemove,
  handleWatch, handleUnwatch, handleWatched,
  buildWatchedViewKeyboard, buildWatchedManageKeyboard, WATCHED_MANAGE_PROMPT,
  buildWatchedMenu, buildWatchedEntityCard, handleWatchedNav,
  handleInvite, handleRedeem, handleRevoke, handleRole, handleNotify, buildNotifyButton, buildRoleChangeNotice, handleWhoami, handleUsersList, handleInvitesList,
  handleArchive, handleArchiveDetail, handleUnarchive, buildArchiveMenu, handleArchiveNav,
  applyMutation, applyEntityMutation, applyInviteMutation, applyAllowedUsersMutation,
  applyArchiveMutation,
  formatInfo, buildMonitorMenu, handleMonitorNav, buildHelpText, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD, mainKeyboard,
  TERMINAL_STATUSES, hydrateContractDocs,
  formatAuditMessage,
  sanitizeActor,
  parseAuditCommit,
  formatAuditLog,
  companyForSlug, agentTriggerButtonRow, buildAgentTenderListKeyboard,
  buildAgentCompanyKeyboard, validateAgentPrice,
  buildAgentConfirmKeyboard, buildAgentConfirmText, buildAgentJob,
  validateInstruction, buildAgentAmendJob, buildAgentAmendConfirmText,
  buildAgentMenu, buildAgentPickView, buildAgentJobsPage, handleAgentMenuNav,
  buildHistoryList, handleHistoryNav,
} from '../../commands.mjs';
import { fetchTender, extractSnapshot, fetchTendersFeed, fetchContract, searchTenderByEdrpou } from '../../prozorro.mjs';
import { sendReply, editMessageReplyMarkup, editMessageText, answerCallbackQuery, setMyCommands, deleteMessage } from '../../telegram.mjs';
import { loadEphemeral, saveEphemeral } from './ephemeral.mjs';
import {
  loadWatchlist, saveWatchlist,
  loadWatchedEntities, saveWatchedEntities,
  loadWatchedSeen, saveWatchedSeen, fetchLastCommit,
  loadAllowedUsers, saveAllowedUsers,
  loadInvites, saveInvites,
  loadArchivedTenders, saveArchivedTenders,
  loadPendingDigest, loadTenderState, fetchLatestDeployCommit,
  fetchAuditLog,
  loadAgentPending, saveAgentPending, saveAgentJob, loadAgentJob,
  listAgentJobs,
  loadNotificationHistory,
  ConflictError,
} from './github.mjs';

// Module-scope 60-second cache for /status responses, keyed by chatId string.
// Survives across invocations within the same CF Worker instance; cleared on cold start.
const STATUS_CACHE = new Map(); // chatId → { text, builtAt: number }
const STATUS_CACHE_TTL_MS = 60_000;

const BOT_USERNAME = 'terralab_tenders_bot';

// Commands whose reply is an on-demand "view": the bot keeps only the latest one
// in the chat (deletes the previous view + its trigger on the next view command).
const EPHEMERAL_VIEW_CMDS = new Set(['info', 'watched', 'archive', 'agent', 'help', 'status', 'whoami', 'history']);

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
  const _editMessageText = deps.editMessageText ?? editMessageText;
  const _answerCallbackQuery = deps.answerCallbackQuery ?? answerCallbackQuery;
  const _setMyCommands = deps.setMyCommands ?? setMyCommands;
  const _deleteMessage = deps.deleteMessage ?? deleteMessage;
  const _ephemeralKV = deps.ephemeralKV ?? env.EPHEMERAL_KV;
  const _fetchLastCommit = deps.fetchLastCommit ?? fetchLastCommit;
  const _loadPendingDigest = deps.loadPendingDigest ?? loadPendingDigest;
  const _loadTenderState = deps.loadTenderState ?? loadTenderState;
  const _fetchLatestDeployCommit = deps.fetchLatestDeployCommit ?? fetchLatestDeployCommit;
  const _fetchAuditLog = deps.fetchAuditLog ?? fetchAuditLog;
  const _loadAgentPending = deps.loadAgentPending ?? loadAgentPending;
  const _saveAgentPending = deps.saveAgentPending ?? saveAgentPending;
  const _saveAgentJob = deps.saveAgentJob ?? saveAgentJob;
  const _loadAgentJob = deps.loadAgentJob ?? loadAgentJob;
  const _listAgentJobs = deps.listAgentJobs ?? listAgentJobs;
  const _loadNotificationHistory = deps.loadNotificationHistory ?? loadNotificationHistory;
  // Tests may inject their own Map to avoid cross-test cache pollution.
  const _statusCache = deps.statusCache ?? STATUS_CACHE;

  const cq = update.callback_query;
  if (cq) {
    return handleCallbackQuery({
      cq, env, _editMessageReplyMarkup, _editMessageText, _answerCallbackQuery, _sendReply,
      _loadAllowedUsers, _saveAllowedUsers,
      _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
      _loadWatchedEntities, _saveWatchedEntities,
      _fetchTender, _extractSnapshot,
      _loadAgentPending, _saveAgentPending, _saveAgentJob, _loadAgentJob, _listAgentJobs, _now,
      _loadNotificationHistory,
    });
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat?.id ?? '');
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const { isAdmin, isInvited, isAllowed, isEditor, role, userRecord } =
    await resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where: 'msg' });

  const actorName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || userRecord?.label || chatId;

  // Agent-trigger price step: if this admin has a pending dialog awaiting a price,
  // the next plain text message is the price — intercept it before command parsing.
  // Admin-only (the dialog can only be opened by an admin in the first place).
  if (isAdmin && typeof msg.text === 'string' && !msg.text.startsWith('/')) {
    const handled = await handleAgentTextReply({
      env, chatId, msg, _sendReply,
      _loadAgentPending, _saveAgentPending, _now,
    });
    if (handled) return;
  }

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
        replyMarkup: isAllowed ? mainKeyboard(role) : undefined,
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

  // A reply to a guided "send me the <arg>" prompt → treat the reply text as that
  // command's argument (stateless; reply_to_message carries the command context).
  const replyCmd = msg.reply_to_message
    ? commandFromReplyPrompt(msg.reply_to_message.text)
    : null;
  const cmd = parseCommand(replyCmd ? `/${replyCmd} ${msg.text}` : msg.text);
  let reply;
  let notifyReplyMarkup = null;
  let watchedReplyMarkup = null;
  let archiveReplyMarkup = null;
  let agentReplyMarkup = null;
  let monitorReplyMarkup = null;
  let forceReplyMarkup = null;
  let histReplyMarkup = null;

  const MUTATING = new Set(['add', 'remove', 'watch', 'unarchive']);
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
    if (cmd.error) {
      const p = buildArgPrompt('add', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
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
        auditMessage: formatAuditMessage({ action: 'add', target: cmd.tender_id, actor: actorName, chatId, role }),
      });
    }
  } else if (cmd.cmd === 'remove') {
    if (cmd.error) {
      const p = buildArgPrompt('remove', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
      reply = await applyMutationWithRetry({
        env,
        loadWatchlist: _loadWatchlist,
        saveWatchlist: _saveWatchlist,
        computeMutation: ({ watchlist }) => handleRemove({ watchlist }, cmd),
        auditMessage: formatAuditMessage({ action: 'remove', target: cmd.tender_id, actor: actorName, chatId, role }),
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
        const { groups, errors } = await tenderGroups(targets, {
          fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
        });
        if (cmd.tender_id) {
          reply = formatInfo({ runIso: new Date().toISOString(), groups, errors });
        } else {
          const menu = buildMonitorMenu({ groups, runIso: new Date().toISOString(), errors });
          reply = menu.text;
          monitorReplyMarkup = menu.keyboard ?? undefined;
        }
        // Admin can fire the agent from a single-tender /info card — but only
        // while proposals are still being accepted (active.tendering).
        if (cmd.tender_id && isAdmin && groups.length === 1
            && groups[0].status === 'active.tendering') {
          agentReplyMarkup = { inline_keyboard: [agentTriggerButtonRow(cmd.tender_id, 'admin')] };
        }

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
    if (cmd.error) {
      const p = buildArgPrompt('watch', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
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
        auditMessage: formatAuditMessage({ action: 'watch', target: cmd.edrpou, actor: actorName, chatId, role }),
      });
    }
  } else if (cmd.cmd === 'watched') {
    try {
      const { entities } = await _loadWatchedEntities(env);
      const menu = buildWatchedMenu({ entities, page: 0 });
      reply = menu.text;
      watchedReplyMarkup = menu.keyboard ?? undefined;
    } catch (err) {
      console.error('worker: /watched failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'unwatch_removed') {
    reply = 'ℹ️ Команду /unwatch прибрано. Відкрий /watched і тисни 🗑 біля замовника, щоб припинити стеження.';
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
        auditMessage: formatAuditMessage({ action: 'invite', target: `${cmd.role}:${sanitizeActor(cmd.label)}`, actor: actorName, chatId, role }),
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
        auditMessage: formatAuditMessage({ action: 'revoke', target: cmd.chat_id, actor: actorName, chatId, role }),
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
        auditMessage: formatAuditMessage({ action: `role→${cmd.role}`, target: cmd.chat_id, actor: actorName, chatId, role }),
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
        const menu = buildArchiveMenu({ archive });
        reply = menu.text;
        archiveReplyMarkup = menu.keyboard ?? undefined;
      }
    } catch (err) {
      console.error('worker: /archive failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'unarchive') {
    if (cmd.error) {
      const p = buildArgPrompt('unarchive', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
      reply = await applyUnarchive({
        env,
        loadArchivedTenders: _loadArchivedTenders,
        saveArchivedTenders: _saveArchivedTenders,
        tender_id: cmd.tender_id,
        auditMessage: formatAuditMessage({ action: 'unarchive', target: cmd.tender_id, actor: actorName, chatId, role }),
      });
    }
  } else if (cmd.cmd === 'history') {
    try {
      const { items } = await _loadNotificationHistory(env);
      const view = buildHistoryList({ items, page: 0 });
      reply = view.text;
      histReplyMarkup = view.keyboard ?? undefined;
    } catch (err) {
      console.error('worker: /history failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
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
  } else if (cmd.cmd === 'log') {
    if (!isAdmin) return;
    try {
      const raw = await _fetchAuditLog(env);
      const entries = raw
        .map(c => { const p = parseAuditCommit(c.message); return p ? { ...p, date: c.date } : null; })
        .filter(Boolean);
      reply = formatAuditLog(entries, { limit: cmd.limit });
    } catch (err) {
      console.error('worker: /log failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'agent') {
    if (!isAdmin) return;
    const menu = buildAgentMenu();
    reply = menu.text;
    agentReplyMarkup = menu.keyboard;
  } else if (cmd.cmd === 'unknown') {
    reply = '❓ Не розумію. /help';
  } else {
    return; // free text or other unhandled — no reply
  }

  // Ephemeral views: before showing a new on-demand view, delete the previous
  // one (its bot reply + the user's trigger). Best-effort; never blocks the reply.
  const isView = EPHEMERAL_VIEW_CMDS.has(cmd.cmd);
  if (isView && _ephemeralKV) {
    try {
      const prevIds = await loadEphemeral(_ephemeralKV, chatId);
      for (const id of prevIds) {
        await _deleteMessage({ token: env.TELEGRAM_BOT_TOKEN, chatId, messageId: id });
      }
    } catch (err) {
      console.error('worker: ephemeral cleanup failed:', err.message);
    }
  }

  const pages = Array.isArray(reply) ? reply : [reply];
  const botReplyIds = [];
  for (let i = 0; i < pages.length; i++) {
    const isLast = i === pages.length - 1;
    try {
      const resp = await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: pages[i],
        replyToMessageId: i === 0 ? msg.message_id : undefined,
        replyMarkup: isLast
          ? (forceReplyMarkup ?? histReplyMarkup ?? archiveReplyMarkup ?? agentReplyMarkup ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
          : undefined,
      });
      const mid = resp?.result?.message_id;
      if (mid != null) botReplyIds.push(mid);
    } catch (err) {
      console.error('worker: sendReply failed:', err.message);
    }
  }

  // Record this view (trigger + bot reply) so the NEXT view command can clear it.
  if (isView && _ephemeralKV) {
    try {
      const ids = [msg.message_id, ...botReplyIds].filter((x) => x != null);
      await saveEphemeral(_ephemeralKV, chatId, ids);
    } catch (err) {
      console.error('worker: ephemeral save failed:', err.message);
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

async function renderWatchedManage({ _editMessageText, env, chatId, messageId, entities }) {
  try {
    await _editMessageText({
      token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      text: entities.length ? WATCHED_MANAGE_PROMPT : handleWatched({ watchedEntities: entities }),
      replyMarkup: buildWatchedManageKeyboard(entities) ?? undefined,
    });
  } catch (err) {
    console.error('worker: watched manage edit failed:', err.message);
  }
}

async function renderWatchedView({ _editMessageText, env, chatId, messageId, entities }) {
  try {
    await _editMessageText({
      token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      text: handleWatched({ watchedEntities: entities }),
      replyMarkup: buildWatchedViewKeyboard(entities) ?? undefined,
    });
  } catch (err) {
    console.error('worker: watched view edit failed:', err.message);
  }
}

// Fetch live Prozorro snapshots for the given watchlist rows → grouped result.
// Shared by the /info menu and the mon: callback (stateless re-fetch).
async function tenderGroups(rows, { fetchTender, extractSnapshot }) {
  const results = await Promise.all((rows ?? []).map(async (r) => {
    try {
      const snap = extractSnapshot(await fetchTender(r.tender_id));
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
  return { groups: results.filter((r) => !r.error), errors: results.filter((r) => r.error) };
}

async function handleCallbackQuery({
  cq, env, _editMessageReplyMarkup, _editMessageText, _answerCallbackQuery, _sendReply,
  _loadAllowedUsers, _saveAllowedUsers,
  _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
  _loadWatchedEntities, _saveWatchedEntities,
  _fetchTender, _extractSnapshot,
  _loadAgentPending, _saveAgentPending, _saveAgentJob, _loadAgentJob, _listAgentJobs, _now,
  _loadNotificationHistory,
}) {
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const chatId = String(cq.message?.chat?.id ?? '');
  const messageId = cq.message?.message_id;
  const { isAdmin, isAllowed, isEditor, role, userRecord } =
    await resolveUserContext({ chatId, adminChatId, env, _loadAllowedUsers, where: 'callback' });
  const actorName = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ')
    || userRecord?.label || chatId;

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

  if (data.startsWith('mon:')) {
    if (data === 'mon:noop') { await ack(); return; }
    let groups = [];
    let errors = [];
    try {
      const { watchlist } = await _loadWatchlist(env);
      const enabled = watchlist.filter((r) => r.enabled);
      ({ groups, errors } = await tenderGroups(enabled, {
        fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
      }));
    } catch (err) {
      console.error('worker: monitor nav load failed:', err.message);
      await ack('⚠️ Prozorro/GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleMonitorNav({ groups, data, runIso: new Date().toISOString(), role, errors });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: monitor nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }

  if (data.startsWith('hist:')) {
    if (data === 'hist:noop') { await ack(); return; }
    let items = [];
    try {
      ({ items } = await _loadNotificationHistory(env));
    } catch (err) {
      console.error('worker: hist nav load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleHistoryNav({ items, data });
    if (view) {
      try {
        await _editMessageText({ token: env.TELEGRAM_BOT_TOKEN, chatId, messageId, text: view.text, replyMarkup: view.keyboard ?? undefined });
      } catch (err) {
        console.error('worker: hist nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }

  if (data.startsWith('arch:')) {
    if (!isAllowed) { await ack('🚫 Немає доступу', true); return; }
    if (data === 'arch:noop') { await ack(); return; }
    let archive = [];
    try {
      ({ archive } = await _loadArchivedTenders(env));
    } catch (err) {
      console.error('worker: archive nav load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleArchiveNav({ archive, data });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: archive nav edit failed:', err.message);
      }
    }
    await ack();
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
      auditMessage: formatAuditMessage({ action: 'add', target: tenderId, actor: actorName, chatId, role }),
    });
    await onAddResult({ result, tenderId, chatId, messageId, env, _editMessageReplyMarkup, ack });
    return;
  }

  if (data.startsWith('wat:')) {
    if (data === 'wat:noop') { await ack(); return; }
    const parts = data.split(':'); // wat:menu:<p> | wat:e:<edrpou>:<page> | wat:toggle:<edrpou>:<page> | wat:rm:<edrpou>:<page>

    if (parts[1] === 'toggle' || parts[1] === 'rm') {
      if (!isEditor) { await ack('🚫 Це команда для редакторів', true); return; }
      const edrpou = parts[2];
      const page = Number(parts[3] ?? 0); // originating list page, preserved across the mutation
      if (!/^\d{8}$/.test(edrpou)) { await ack('❌ Невалідний ЄДРПОУ'); return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { entities, sha } = await _loadWatchedEntities(env);
          let mutation; let action;
          if (parts[1] === 'toggle') {
            const cur = entities.find((e) => e.edrpou === edrpou);
            const next = !(cur?.enabled);
            mutation = { type: 'set_enabled', edrpou, enabled: next };
            action = next ? 'watch_resume' : 'watch_pause';
          } else {
            mutation = { type: 'delete_entity', edrpou };
            action = 'unwatch';
          }
          const newEntities = applyEntityMutation(entities, mutation);
          await _saveWatchedEntities(env, newEntities, sha, {
            message: formatAuditMessage({ action, target: edrpou, actor: actorName, chatId, role }),
          });
          const view = parts[1] === 'toggle'
            ? buildWatchedEntityCard({ entities: newEntities, edrpou, canManage: true, page })
            : buildWatchedMenu({ entities: newEntities, page });
          await _editMessageText({
            token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
            text: view.text, replyMarkup: view.keyboard ?? undefined,
          });
          await ack(parts[1] === 'toggle' ? '✅ Оновлено' : '✅ Прибрано');
          return;
        } catch (err) {
          if (err instanceof ConflictError && attempt === 0) continue;
          console.error('worker: wat mutation failed:', err.message);
          await ack('⚠️ Помилка, спробуй ще раз', true);
          return;
        }
      }
      return;
    }

    // read-only nav: menu / entity card
    let entities = [];
    try {
      ({ entities } = await _loadWatchedEntities(env));
    } catch (err) {
      console.error('worker: wat nav load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleWatchedNav({ entities, data, canManage: isEditor });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: wat nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }

  if (data === 'watched:manage' || data === 'watched:done') {
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    let entities = [];
    try {
      ({ entities } = await _loadWatchedEntities(env));
    } catch (err) {
      console.error('worker: watched mode load failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    if (data === 'watched:manage') {
      await renderWatchedManage({ _editMessageText, env, chatId, messageId, entities });
    } else {
      await renderWatchedView({ _editMessageText, env, chatId, messageId, entities });
    }
    await ack();
    return;
  }

  if (data.startsWith('unwatch:')) {
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    const edrpou = data.slice('unwatch:'.length);
    if (!/^\d{8}$/.test(edrpou)) {
      await ack('❌ Невалідний ЄДРПОУ');
      return;
    }
    const auditMessage = formatAuditMessage({ action: 'unwatch', target: edrpou, actor: actorName, chatId, role });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { entities, sha } = await _loadWatchedEntities(env);
        const { mutation } = handleUnwatch({ watchedEntities: entities }, { edrpou });
        let newEntities = entities;
        if (mutation) {
          newEntities = applyEntityMutation(entities, mutation);
          await _saveWatchedEntities(env, newEntities, sha, { message: auditMessage });
        }
        await renderWatchedManage({ _editMessageText, env, chatId, messageId, entities: newEntities });
        await ack(mutation ? `✅ Прибрано ${edrpou}` : 'Вже прибрано');
        return;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        console.error('worker: unwatch callback failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
    }
    await ack('⚠️ Не зміг зберегти');
    return;
  }

  if (data.startsWith('agent:')) {
    // Every agent step is admin-only. Non-admin allowed users get a clear reject
    // (they never see the entry button, but guard the callback regardless).
    if (!isAdmin) {
      await ack('🚫 Лише адмін', true);
      return;
    }
    await handleAgentCallback({
      data, env, chatId, messageId, ack, _sendReply, _editMessageText,
      _loadAgentPending, _saveAgentPending, _saveAgentJob, _now,
      _fetchTender, _extractSnapshot,
      _loadWatchlist, _loadAgentJob, _listAgentJobs,
    });
    return;
  }

  await ack('❓ Невідома кнопка');
}

// Abandoned price dialogs older than this are dropped, so a stray later number
// is not swallowed as the stale tender's price.
const AGENT_PENDING_TTL_MS = 15 * 60 * 1000;

// Drives the admin-only agent-trigger dialog (start → pick company → enter price
// → confirm). State between the company tap and the price text lives in
// _state/agent_pending.json keyed by chatId (the Worker is stateless across
// invocations). Messages go out without HTML-sensitive interpolation: company
// names are Cyrillic, price is digits, tenderId is an id — so the HTML parse_mode
// the send helpers always set is harmless. entityName is intentionally omitted.
async function handleAgentCallback({
  data, env, chatId, messageId, ack, _sendReply, _editMessageText,
  _loadAgentPending, _saveAgentPending, _saveAgentJob, _now,
  _fetchTender, _extractSnapshot,
  _loadWatchlist, _loadAgentJob, _listAgentJobs,
}) {
  const parts = data.split(':'); // agent:<action>:<tid>[:<slug>]
  const action = parts[1];
  const tid = parts[2] ?? '';

  const sendNew = (text, replyMarkup) => _sendReply({
    token: env.TELEGRAM_BOT_TOKEN, chatId: Number(chatId), text, replyMarkup,
  });

  // Menu-level navigation (edit-in-place). Dialog actions fall through below.
  if (action === 'noop') { await ack(); return; }
  if (action === 'menu' || action === 'pick' || action === 'jobs') {
    let tenders = [];
    let jobs = [];
    try {
      if (action === 'pick') {
        const { watchlist } = await _loadWatchlist(env);
        const checked = await Promise.all(
          watchlist.filter((r) => r.enabled).map(async (r) => {
            try {
              const snap = _extractSnapshot(await _fetchTender(r.tender_id));
              if (snap.status !== 'active.tendering') return null;
              let preparedUrl = null;
              try {
                const j = await _loadAgentJob(env, r.tender_id);
                if (j && j.status === 'done' && j.result?.drive_link) preparedUrl = j.result.drive_link;
              } catch { /* link optional */ }
              return { ...r, preparedUrl };
            } catch { return null; }
          }),
        );
        tenders = checked.filter(Boolean);
      } else if (action === 'jobs') {
        jobs = await _listAgentJobs(env);
      }
    } catch (err) {
      console.error('worker: agent menu nav load failed:', err.message);
      await ack('⚠️ Prozorro/GitHub тимчасово недоступний', true);
      return;
    }
    const view = handleAgentMenuNav({ tenders, jobs, data });
    if (view) {
      try {
        await _editMessageText({
          token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
          text: view.text, replyMarkup: view.keyboard ?? undefined,
        });
      } catch (err) {
        console.error('worker: agent menu nav edit failed:', err.message);
      }
    }
    await ack();
    return;
  }

  if (action === 'amend') {
    let prior;
    try {
      prior = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent amend load job failed:', err.message);
      await ack('⚠️ GitHub тимчасово недоступний', true);
      return;
    }
    if (!prior || prior.status !== 'done' || !prior.result?.drive_link) {
      await ack('🚫 Пропозиція ще не готова', true);
      return;
    }
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, kind: 'amend', step: 'await_instruction', at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent amend save pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    try {
      await sendNew(`✏️ Напиши, що доробити в пропозиції ${tid} (одним повідомленням):`);
    } catch (err) {
      console.error('worker: agent amend prompt send failed:', err.message);
    }
    await ack();
    return;
  }

  if (action === 'start') {
    // Authoritative gate (covers /agent, /info and digest buttons): the agent
    // runs only while the tender is accepting proposals (active.tendering).
    try {
      const snap = _extractSnapshot(await _fetchTender(tid));
      if (snap.status !== 'active.tendering') {
        await ack('🚫 Тендер не приймає пропозиції — агент недоступний', true);
        return;
      }
    } catch (err) {
      console.error('worker: agent start status check failed:', err.message);
    }
    try {
      await _editMessageText({
        token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        text: 'Оберіть компанію-учасника:',
        replyMarkup: buildAgentCompanyKeyboard(tid),
      });
    } catch (err) {
      console.error('worker: agent start edit failed:', err.message);
      try {
        await sendNew('Оберіть компанію-учасника:', buildAgentCompanyKeyboard(tid));
      } catch (err2) {
        console.error('worker: agent start send failed:', err2.message);
      }
    }
    await ack();
    return;
  }

  if (action === 'co') {
    const slug = parts[3] ?? '';
    const company = companyForSlug(slug);
    if (!company) { await ack('❌ Невідома компанія'); return; }
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, company, step: 'await_price', at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent co save pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    try {
      await sendNew('Введіть ціну пропозиції (грн) або «auto»:');
    } catch (err) {
      console.error('worker: agent co prompt send failed:', err.message);
    }
    await ack();
    return;
  }

  if (action === 'confirm') {
    let entry;
    try {
      const loaded = await _loadAgentPending(env);
      entry = loaded.pending?.[chatId];
    } catch (err) {
      console.error('worker: agent confirm load pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    if (!entry || entry.tid !== tid || entry.step !== 'confirm') {
      await ack('⚠️ Немає активного запиту');
      return;
    }

    // Amend: build a job_type:'amend' record, carrying the prior done job's
    // result as the target folder. No price.
    if (entry.kind === 'amend') {
      if (!entry.instruction) { await ack('⚠️ Немає активного запиту'); return; }
      let prior;
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent amend confirm load job failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      const job = buildAgentAmendJob({
        tenderId: tid,
        instruction: entry.instruction,
        company: prior?.company ?? null,
        target: { drive_link: prior?.result?.drive_link ?? null, package_dir: prior?.result?.package_dir ?? null },
        requestedBy: String(chatId),
        createdAt: _now().toISOString(),
      });
      try {
        await _saveAgentJob(env, job);
      } catch (err) {
        console.error('worker: saveAgentJob (amend) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await sendNew('✅ Завдання на доробку поставлено в чергу. Сповіщу, коли буде готово.');
      } catch (err) {
        console.error('worker: agent amend confirm reply failed:', err.message);
      }
      await ack('✅ В черзі');
      return;
    }

    // Prepare (existing): requires a price.
    if (!entry.price) { await ack('⚠️ Немає активного запиту'); return; }
    const link = `https://prozorro.gov.ua/tender/${tid}`;
    const job = buildAgentJob({
      tenderId: tid, link, company: entry.company, price: entry.price,
      requestedBy: String(chatId), createdAt: _now().toISOString(),
    });
    try {
      await _saveAgentJob(env, job);
    } catch (err) {
      console.error('worker: saveAgentJob failed:', err.message);
      await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
      return;
    }
    await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
    try {
      await sendNew('✅ Завдання поставлено в чергу. Сповіщу, коли буде готово.');
    } catch (err) {
      console.error('worker: agent confirm reply failed:', err.message);
    }
    await ack('✅ В черзі');
    return;
  }

  if (action === 'cancel') {
    await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
    try {
      await sendNew('Скасовано.');
    } catch (err) {
      console.error('worker: agent cancel reply failed:', err.message);
    }
    await ack('Скасовано');
    return;
  }

  await ack('❓ Невідома кнопка');
}

// Removes this chat's pending agent dialog entry. Best-effort — a failure here
// just means a stale entry lingers; the next confirm/cancel re-clears it.
async function clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending }) {
  try {
    const { pending, sha } = await _loadAgentPending(env);
    if (pending[chatId]) {
      delete pending[chatId];
      await _saveAgentPending(env, pending, sha);
    }
  } catch (err) {
    console.error('worker: clearAgentPending failed:', err.message);
  }
}

// Handles a plain text message from an admin who is mid-agent-dialog awaiting a
// free-text reply — the price (await_price) or the amend instruction
// (await_instruction). Returns true if it consumed the message (so the caller
// stops), false if there was no matching pending step (caller continues normal
// parsing).
async function handleAgentTextReply({
  env, chatId, msg, _sendReply, _loadAgentPending, _saveAgentPending, _now,
}) {
  let pending, sha, entry;
  try {
    ({ pending, sha } = await _loadAgentPending(env));
    entry = pending?.[chatId];
  } catch (err) {
    console.error('worker: agent text-reply load pending failed:', err.message);
    return false; // can't verify state → let normal handling proceed
  }
  if (!entry || (entry.step !== 'await_price' && entry.step !== 'await_instruction')) return false;

  // Expire an abandoned dialog: if the price step was opened long ago and never
  // finished, do not consume an unrelated number as the stale tender's price.
  const now = (_now ?? (() => new Date()))();
  if (entry.at && now - new Date(entry.at) > AGENT_PENDING_TTL_MS) {
    try {
      delete pending[chatId];
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent stale-pending clear failed:', err.message);
    }
    return false; // treat as no pending → normal handling proceeds
  }

  const send = (text, replyMarkup) => _sendReply({
    token: env.TELEGRAM_BOT_TOKEN, chatId: msg.chat.id, text,
    replyToMessageId: msg.message_id, replyMarkup,
  });

  if (entry.step === 'await_instruction') {
    const instruction = validateInstruction(msg.text);
    if (instruction === null) {
      try { await send('Порожня інструкція. Напиши текстом, що доробити.'); }
      catch (err) { console.error('worker: agent empty-instruction reply failed:', err.message); }
      return true; // consumed; stay at await_instruction
    }
    try {
      pending[chatId] = { ...entry, instruction, step: 'confirm' };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent instruction save pending failed:', err.message);
      try { await send('⚠️ Помилка, спробуй ще раз.'); } catch {}
      return true;
    }
    try {
      await send(
        buildAgentAmendConfirmText({ tenderId: entry.tid, instruction }),
        buildAgentConfirmKeyboard(entry.tid),
      );
    } catch (err) { console.error('worker: agent amend confirm prompt failed:', err.message); }
    return true;
  }

  const price = validateAgentPrice(msg.text);
  // Reject null AND a zero price ('0', '0,00', etc.) — validateAgentPrice allows
  // '0' but a zero-priced proposal is never intended.
  const isZero = typeof price === 'string' && price !== 'auto'
    && parseFloat(price.replace(/\s/g, '').replace(',', '.')) === 0;
  if (price === null || isZero) {
    try {
      await send('Невірна ціна. Введіть число (грн) або «auto».');
    } catch (err) {
      console.error('worker: agent invalid-price reply failed:', err.message);
    }
    return true; // consumed; stay at await_price
  }

  // Advance to confirm.
  try {
    pending[chatId] = { ...entry, price, step: 'confirm' };
    await _saveAgentPending(env, pending, sha);
  } catch (err) {
    console.error('worker: agent price save pending failed:', err.message);
    try {
      await send('⚠️ Помилка, спробуй ще раз.');
    } catch {}
    return true;
  }
  try {
    await send(
      buildAgentConfirmText({ company: entry.company, price, tenderId: entry.tid }),
      buildAgentConfirmKeyboard(entry.tid),
    );
  } catch (err) {
    console.error('worker: agent confirm prompt failed:', err.message);
  }
  return true;
}

async function applyMutationWithRetry({ env, loadWatchlist, saveWatchlist, computeMutation, auditMessage }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { watchlist, sha } = await loadWatchlist(env);
      const result = await computeMutation({ watchlist });
      if (!result.mutation) return result.reply;
      const newWatchlist = applyMutation(watchlist, result.mutation);
      await saveWatchlist(env, newWatchlist, sha, { message: auditMessage });
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

async function applyAllowedUsersMutationWithRetry({ env, loadAllowedUsers, saveAllowedUsers, computeMutation, auditMessage }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { users, sha } = await loadAllowedUsers(env);
      const result = computeMutation({ users });
      if (!result.mutation) return result.reply;
      const next = applyAllowedUsersMutation(users, result.mutation);
      await saveAllowedUsers(env, next, sha, { message: auditMessage });
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

async function applyInviteMutationWithRetry({ env, loadInvites, saveInvites, computeMutation, auditMessage }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { invites, sha } = await loadInvites(env);
      const result = computeMutation({ invites });
      if (!result.mutation) return result.reply;
      const next = applyInviteMutation(invites, result.mutation);
      await saveInvites(env, next, sha, { message: auditMessage });
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

async function applyEntityMutationWithRetry({ env, loadWatchedEntities, saveWatchedEntities, computeMutation, onSuccess, auditMessage }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { entities, sha } = await loadWatchedEntities(env);
      const result = await computeMutation({ entities });
      if (!result.mutation) return result.reply;
      const newEntities = applyEntityMutation(entities, result.mutation);
      await saveWatchedEntities(env, newEntities, sha, { message: auditMessage });
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

async function applyUnarchive({ env, loadArchivedTenders, saveArchivedTenders, tender_id, auditMessage }) {
  try {
    const { archive, sha } = await loadArchivedTenders(env);
    const result = handleUnarchive({ archive }, { tender_id });
    if (!result.archiveMutation) return result.reply;
    const newArchive = applyArchiveMutation(archive, result.archiveMutation);
    await saveArchivedTenders(env, newArchive, sha, { message: auditMessage });
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
