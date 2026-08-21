import {
  parseCommand, buildArgPrompt, commandFromReplyPrompt, handleAdd, handleStatus, handleRemove,
  handleWatch, handleUnwatch, handleWatched,
  buildWatchedViewKeyboard, buildWatchedManageKeyboard, WATCHED_MANAGE_PROMPT,
  buildWatchedMenu, buildWatchedEntityCard, handleWatchedNav,
  handleInvite, handleRedeem, handleRevoke, handleRole, handleNotify, buildNotifyButton, buildRoleChangeNotice, handleWhoami, handleUsersList, handleInvitesList,
  handleArchive, handleArchiveDetail, handleUnarchive, buildArchiveMenu, handleArchiveNav,
  applyMutation, applyEntityMutation, applyInviteMutation, applyAllowedUsersMutation,
  applyArchiveMutation,
  formatInfo, buildMonitorMenu, handleMonitorNav, buildHelpText, buildStartGreeting, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD, mainKeyboard,
  TERMINAL_STATUSES, hydrateContractDocs,
  formatAuditMessage,
  sanitizeActor,
  parseAuditCommit,
  formatAuditLog,
  companyForSlug, agentTriggerButtonRow,
  buildAgentCompanyKeyboard, validateAgentPrice,
  buildAgentConfirmKeyboard, buildAgentConfirmText, buildAgentJob,
  buildAgentAdminNotice,
  validateInstruction, buildAgentAmendJob, buildAgentAmendConfirmText,
  buildAgentWinnerJob, buildAgentWinnerConfirmText,
  validateLetterDate, formatLetterDate, buildAgentSignJob,
  buildAgentSignDateKeyboard, buildAgentSignConfirmText, buildAgentCancelKeyboard,
  buildAgentUnifiedList, buildAgentTenderDetail, handleAgentMenuNav,
  buildHistoryCalendar, handleHistoryNav,
  abbreviateLegalForm,
} from '../../commands.mjs';
import { fetchTender, extractSnapshot, fetchTendersFeed, fetchContract, searchTenderByEdrpou } from '../../prozorro.mjs';
import { sendReply, editMessageReplyMarkup, editMessageText, answerCallbackQuery, setMyCommands, deleteMessage, escapeHtml, truncate } from '../../telegram.mjs';
import { loadEphemeral, saveEphemeral, loadAgentPending, saveAgentPending } from './ephemeral.mjs';
import {
  loadWatchlist, saveWatchlist,
  loadWatchedEntities, saveWatchedEntities,
  loadWatchedSeen, saveWatchedSeen, fetchLastCommit,
  loadAllowedUsers, saveAllowedUsers,
  loadInvites, saveInvites,
  loadArchivedTenders, saveArchivedTenders,
  loadPendingDigest, loadTenderState, fetchLatestDeployCommit,
  fetchAuditLog,
  saveAgentJob, loadAgentJob,
  listAgentJobs,
  loadNotificationHistory,
  ConflictError,
} from './state.mjs';

// Module-scope 60-second cache for /status responses, keyed by chatId string.
// Survives across invocations within the same CF Worker instance; cleared on cold start.
const STATUS_CACHE = new Map(); // chatId → { text, builtAt: number }
const STATUS_CACHE_TTL_MS = 60_000;

const BOT_USERNAME = 'terralab_tenders_bot';

// Commands whose reply is an on-demand "view": the bot keeps only the latest one
// in the chat (deletes the previous view + its trigger on the next view command).
// Covers every recognized command except /start (its own namespace — see
// ephemeral.mjs) and force-reply follow-ups, which reuse whichever command
// they complete (e.g. a typed tender_id after /add lands back as 'add').
const EPHEMERAL_VIEW_CMDS = new Set([
  'info', 'watched', 'archive', 'agent', 'help', 'status', 'whoami', 'history',
  'add', 'remove', 'watch', 'unarchive', 'unwatch_removed',
  'invite', 'invites', 'revoke', 'role', 'users', 'log', 'notify',
]);

const GH_UNAVAILABLE = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
// Callback toasts are plain text and capped by Telegram at 200 chars, so they
// carry a shorter base than a full reply.
const GH_UNAVAILABLE_SHORT = '⚠️ GitHub тимчасово недоступний';

// What each status actually means for this bot. An expired PAT (401) and a real
// GitHub outage (5xx) produced identical user-facing text before, so the only
// way to tell them apart was reading the Worker logs.
const GH_STATUS_HINTS = {
  401: 'токен недійсний або протермінований',
  403: 'немає прав або вичерпано ліміт запитів',
  404: 'файл або репозиторій не знайдено',
  409: 'конфлікт версій',
  422: 'GitHub відхилив запит',
};

// One-line diagnosis of a GitHub failure. Falls back to the raw message for
// errors that never reached HTTP at all (network, DNS, JSON parse).
export function describeGithubError(err) {
  const status = err?.status;
  if (typeof status === 'number') {
    const hint = GH_STATUS_HINTS[status] ?? (status >= 500 ? 'збій на боці GitHub' : 'невідома помилка');
    return `HTTP ${status} · ${hint}`;
  }
  const msg = String(err?.message ?? err ?? '').trim();
  return msg ? truncate(msg, 150) : 'невідома помилка';
}

// Admins get the cause appended so it is visible straight from Telegram;
// everyone else keeps the plain "try again" line.
export function githubUnavailableText(err, isAdmin, base = GH_UNAVAILABLE) {
  if (!isAdmin) return base;
  return `${base}\n\n🔧 <code>${escapeHtml(describeGithubError(err))}</code>`;
}

export function githubUnavailableAck(err, isAdmin, base = GH_UNAVAILABLE_SHORT) {
  if (!isAdmin) return base;
  return truncate(`${base} · ${describeGithubError(err)}`, 200);
}

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
      _loadNotificationHistory, _loadTenderState,
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

  // Agent-trigger price step: if this user has a pending dialog awaiting a price
  // (or an amend instruction), the next plain text message is it — intercept
  // before command parsing. Admin + editor (the dialog can only be opened by them).
  if (isEditor && typeof msg.text === 'string' && !msg.text.startsWith('/')) {
    const handled = await handleAgentTextReply({
      env, chatId, msg, _sendReply, _editMessageText,
      _loadAgentPending, _saveAgentPending, _now, _loadTenderState,
    });
    if (handled) return;
  }

  // /start works for everyone — reveals chat_id; for allowed users, also seeds chat-scope command list.
  // /start <token> is handled in a later branch.
  if (typeof msg.text === 'string' && /^\/start(?:@\w+)?\s*$/i.test(msg.text)) {
    const startReply = buildStartGreeting(chatId, role, isAllowed);
    // OWN namespace, deliberately NOT the shared view-command slot below: this
    // is the one message that carries the persistent ReplyKeyboardMarkup, and
    // none of the other view replies re-attach it (most show an inline
    // keyboard instead). Sharing the slot meant the very next /info, /agent,
    // /watched etc. deleted THIS message as "the previous ephemeral view" and
    // silently dropped the persistent keyboard off the chat. Best-effort;
    // never blocks the reply.
    if (_ephemeralKV) {
      try {
        const prevIds = await loadEphemeral(_ephemeralKV, chatId, 'start');
        for (const id of prevIds) {
          await _deleteMessage({ token: env.TELEGRAM_BOT_TOKEN, chatId, messageId: id });
        }
      } catch (err) {
        console.error('worker: start ephemeral cleanup failed:', err.message);
      }
      // «Меню» (Telegram's own menu button) is the one command registered via
      // setMyCommands, and it sends exactly this /start — the owner expects it
      // to act like "go home", overwriting whatever screen was open (agent
      // card, /info, /watched …), not stack a greeting on top of it. That
      // screen lives in the SHARED view slot below (own reasoning in
      // ephemeral.mjs — /start keeps its own slot only so a LATER /info etc.
      // doesn't delete the greeting's persistent keyboard; deleting the
      // shared slot's message here doesn't touch that).
      try {
        const prevViewIds = await loadEphemeral(_ephemeralKV, chatId);
        for (const id of prevViewIds) {
          await _deleteMessage({ token: env.TELEGRAM_BOT_TOKEN, chatId, messageId: id });
        }
      } catch (err) {
        console.error('worker: start shared-view cleanup failed:', err.message);
      }
    }
    let botReplyId;
    try {
      const resp = await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: startReply,
        replyToMessageId: msg.message_id,
        replyMarkup: isAllowed ? mainKeyboard(role) : undefined,
      });
      botReplyId = resp?.result?.message_id;
    } catch (err) {
      console.error('worker: sendReply /start failed:', err.message);
    }
    if (_ephemeralKV) {
      try {
        const ids = [msg.message_id, botReplyId].filter((x) => x != null);
        await saveEphemeral(_ephemeralKV, chatId, ids, 'start');
      } catch (err) {
        console.error('worker: start ephemeral save failed:', err.message);
      }
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
        reply = githubUnavailableText(err, isAdmin);
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
        isAdmin,
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
        isAdmin,
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
      reply = githubUnavailableText(err, true, '⚠️ Worker live, але GitHub недоступний');
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
        // Admin/editor can fire the agent from a single-tender /info card — but
        // only while proposals are still being accepted (active.tendering).
        if (cmd.tender_id && isEditor && groups.length === 1
            && groups[0].status === 'active.tendering') {
          agentReplyMarkup = { inline_keyboard: [agentTriggerButtonRow(cmd.tender_id, role)] };
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
      reply = githubUnavailableText(err, isAdmin, '⚠️ GitHub недоступний, спробуй ще раз');
    }
  } else if (cmd.cmd === 'watch') {
    if (cmd.error) {
      const p = buildArgPrompt('watch', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
      reply = await applyEntityMutationWithRetry({
        isAdmin,
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
      reply = githubUnavailableText(err, isAdmin);
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
        isAdmin,
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
      reply = githubUnavailableText(err, isAdmin);
    }
  } else if (cmd.cmd === 'users') {
    if (!isAdmin) return;
    try {
      const { users } = await _loadAllowedUsers(env);
      reply = handleUsersList({ allowedUsers: users, adminChatId });
    } catch (err) {
      console.error('worker: /users failed:', err.message);
      reply = githubUnavailableText(err, isAdmin);
    }
  } else if (cmd.cmd === 'revoke') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_chat_id') {
      reply = '❌ Не вказано chat_id. /revoke 12345';
    } else if (cmd.error === 'invalid_chat_id') {
      reply = '❌ chat_id має бути числом';
    } else {
      reply = await applyAllowedUsersMutationWithRetry({
        isAdmin,
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
        isAdmin,
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
          {
            archive, fetchTender: _fetchTender, extractSnapshot: _extractSnapshot, fetchContract: _fetchContract,
            loadAgentJob: (tid) => _loadAgentJob(env, tid), role,
          },
          cmd,
        );
      } else {
        const menu = buildArchiveMenu({ archive });
        reply = menu.text;
        archiveReplyMarkup = menu.keyboard ?? undefined;
      }
    } catch (err) {
      console.error('worker: /archive failed:', err.message);
      reply = githubUnavailableText(err, isAdmin);
    }
  } else if (cmd.cmd === 'unarchive') {
    if (cmd.error) {
      const p = buildArgPrompt('unarchive', { retry: cmd.error.startsWith('invalid') });
      reply = p.text;
      forceReplyMarkup = p.replyMarkup;
    } else {
      reply = await applyUnarchive({
        isAdmin,
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
      const view = buildHistoryCalendar({ items });
      reply = view.text;
      histReplyMarkup = view.keyboard ?? undefined;
    } catch (err) {
      console.error('worker: /history failed:', err.message);
      reply = githubUnavailableText(err, isAdmin);
    }
  } else if (cmd.cmd === 'help') {
    reply = buildHelpText(role);
  } else if (cmd.cmd === 'whoami') {
    try {
      const { users } = await _loadAllowedUsers(env);
      reply = handleWhoami({ allowedUsers: users, adminChatId, chatId });
    } catch (err) {
      console.error('worker: /whoami failed:', err.message);
      reply = githubUnavailableText(err, isAdmin, GH_UNAVAILABLE_SHORT);
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
            ? githubUnavailableText(err, isAdmin)
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
      reply = githubUnavailableText(err, isAdmin);
    }
  } else if (cmd.cmd === 'agent') {
    if (!isEditor) return;
    try {
      const [{ watchlist }, jobs] = await Promise.all([_loadWatchlist(env), _listAgentJobs(env)]);
      const view = buildAgentUnifiedList({ watchlist, jobs, page: 0 });
      reply = view.text;
      agentReplyMarkup = view.keyboard;
    } catch (err) {
      console.error('worker: /agent failed:', err.message);
      reply = githubUnavailableText(err, isAdmin);
    }
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

  // Inline view keyboard (history, archive, agent, etc.) goes on the main message.
  // reply keyboard (mainKeyboard) persists in Telegram without being refreshed.
  const inlineView = histReplyMarkup ?? archiveReplyMarkup ?? agentReplyMarkup
    ?? watchedReplyMarkup ?? monitorReplyMarkup ?? notifyReplyMarkup;

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
          ? (inlineView ?? forceReplyMarkup ?? (isAllowed ? mainKeyboard(role) : undefined))
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
  _loadNotificationHistory, _loadTenderState,
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
      await ack(githubUnavailableAck(err, isAdmin, '⚠️ Prozorro/GitHub тимчасово недоступний'), true);
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
      await ack(githubUnavailableAck(err, isAdmin), true);
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
      await ack(githubUnavailableAck(err, isAdmin), true);
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
    let addedEdrpou = null;
    const result = await applyMutationWithRetry({
      isAdmin,
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
        const r = await handleAdd({
          watchlist, archive,
          fetchTender: _fetchTender, extractSnapshot: _extractSnapshot,
        }, { tender_id: tenderId, notes: null });
        // Лише коли справді щось міняємо у watchlist (не «вже моніторю» / архів).
        if (r.mutation) addedEdrpou = r.edrpou ?? null;
        return r;
      },
      auditMessage: formatAuditMessage({ action: 'add', target: tenderId, actor: actorName, chatId, role }),
    });
    await onAddResult({ result, tenderId, chatId, messageId, env, _editMessageReplyMarkup, ack });
    // Ця кнопка з'являється ТІЛЬКИ під оголошенням відстежуваного замовника
    // (`new_tender_announced`). Щойно його закупівля поїхала в моніторинг
    // тендерів — тримати самого замовника у стеженні немає сенсу.
    if (typeof result === 'string' && /^✅/.test(result) && addedEdrpou) {
      await dropWatchedEntityAfterAdd({
        env, edrpou: addedEdrpou, tenderId, chatId, actorName, role,
        _loadWatchedEntities, _saveWatchedEntities, _sendReply,
      });
    }
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
      await ack(githubUnavailableAck(err, isAdmin), true);
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
      await ack(githubUnavailableAck(err, isAdmin), true);
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
    // Agent steps are open to admin + editor (canUseAgent). Viewers get a clear
    // reject (they never see the entry button, but guard the callback regardless).
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    await handleAgentCallback({
      data, env, chatId, messageId, ack, isAdmin, adminChatId, actorName, role,
      _sendReply, _editMessageText,
      _loadAgentPending, _saveAgentPending, _saveAgentJob, _now,
      _fetchTender, _extractSnapshot,
      _loadWatchlist, _loadAgentJob, _listAgentJobs, _loadTenderState,
    });
    return;
  }

  await ack('❓ Невідома кнопка');
}

// Abandoned price dialogs older than this are dropped, so a stray later number
// is not swallowed as the stale tender's price.
const AGENT_PENDING_TTL_MS = 15 * 60 * 1000;

// Кроки, з яких дотик по клавіатурі дати може ПРОДОВЖИТИ діалог підписання.
// `confirm` і `await_letter_date` тут не зайві: повідомлення з кнопками дати
// лишається у чаті після вибору, тож «обрав не ту дату → обираю іншу» — це
// звичайне виправлення, а не новий діалог.
const SIGN_CONTINUE_STEPS = new Set(['await_date', 'await_letter_date', 'confirm']);

// Tells the admin that someone ELSE queued an agent run. The agent's result goes
// only to `requested_by`, so without this the admin would never learn about it.
// No-op when the actor is the admin, when no admin chat is configured, or when
// Telegram rejects the send (best effort — must never fail the queued job).
async function notifyAdminAgentRun({
  env, isAdmin, adminChatId, _sendReply,
  kind, actorName, chatId, tenderId, company, price, instruction, letterDate,
}) {
  if (isAdmin || !adminChatId) return;
  try {
    await _sendReply({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: Number(adminChatId),
      text: buildAgentAdminNotice({ kind, actorName, chatId, tenderId, company, price, instruction, letterDate }),
    });
  } catch (err) {
    console.error('worker: agent admin notice failed:', err.message);
  }
}

// Every step of the agent dialog originates from a tap on a message WE sent
// (the company picker, the price prompt, the confirm buttons) — so instead of
// piling up a new message per step, edit that same message in place. Falls
// back to a fresh send only if the edit itself fails (e.g. the message is too
// old for Telegram to edit), and returns whichever message id now carries the
// dialog so the caller can persist it for the next step.
async function editOrSend({ _editMessageText, _sendReply, env, chatId, messageId, text, replyMarkup }) {
  if (messageId != null) {
    try {
      await _editMessageText({
        token: env.TELEGRAM_BOT_TOKEN, chatId, messageId, text,
        replyMarkup: replyMarkup ?? undefined,
      });
      return messageId;
    } catch (err) {
      console.error('worker: agent dialog edit failed, sending new message:', err.message);
    }
  }
  const resp = await _sendReply({
    token: env.TELEGRAM_BOT_TOKEN, chatId: Number(chatId), text, replyMarkup,
  });
  return resp?.result?.message_id ?? null;
}

// Drives the agent-trigger dialog for admin + editor (start → pick company →
// enter price → confirm). State between the company tap and the price text lives in
// _state/agent_pending.json keyed by chatId (the Worker is stateless across
// invocations). Messages go out without HTML-sensitive interpolation: company
// names are Cyrillic, price is digits, tenderId is an id — so the HTML parse_mode
// the send helpers always set is harmless (buildAgent*Text escape anyway).
async function handleAgentCallback({
  data, env, chatId, messageId, ack, isAdmin, adminChatId, actorName, role,
  _sendReply, _editMessageText,
  _loadAgentPending, _saveAgentPending, _saveAgentJob, _now,
  _fetchTender, _extractSnapshot,
  _loadWatchlist, _loadAgentJob, _listAgentJobs, _loadTenderState,
}) {
  const parts = data.split(':'); // agent:<action>:<tid>[:<slug>]
  const action = parts[1];
  const tid = parts[2] ?? '';

  // Customer name for the winner confirmation, from the monitor's own saved
  // snapshot (_state/<tid>.json) — no Prozorro round-trip, and null whenever the
  // snapshot is missing, so the confirm text simply degrades to id + company.
  // Purely cosmetic: this must NOT gate anything (whether a winner run is
  // allowed for a given tender status is the owner's call, not this function's).
  const winnerEntityName = async () => {
    if (!_loadTenderState) return null;
    try {
      const snap = await _loadTenderState(env, tid);
      const name = snap?.procuringEntity?.name;
      return name ? abbreviateLegalForm(name) : null;
    } catch (err) {
      console.error('worker: agent winner entity lookup failed:', err.message);
      return null;
    }
  };

  // Menu-level navigation (edit-in-place). Dialog actions fall through below.
  if (action === 'noop') { await ack(); return; }
  if (action === 'menu' || action === 'pick' || action === 'jobs') {
    let watchlist = [];
    let jobs = [];
    try {
      [{ watchlist }, jobs] = await Promise.all([_loadWatchlist(env), _listAgentJobs(env)]);
    } catch (err) {
      console.error('worker: agent menu nav load failed:', err.message);
      await ack(githubUnavailableAck(err, isAdmin, '⚠️ Prozorro/GitHub тимчасово недоступний'), true);
      return;
    }
    const view = handleAgentMenuNav({ watchlist, jobs, data });
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

  // Drill-down for one tender, reached by tapping its row in the merged list.
  // agent:view:<tid>:<page> — page carries back where "⬅ До списку" returns to.
  if (action === 'view') {
    const backPage = Number(parts[3] ?? 0);
    let entry = null;
    let job = null;
    try {
      const [{ watchlist }, loadedJob] = await Promise.all([_loadWatchlist(env), _loadAgentJob(env, tid)]);
      entry = watchlist.find((r) => r.tender_id === tid) ?? null;
      job = loadedJob;
    } catch (err) {
      console.error('worker: agent view load failed:', err.message);
      await ack(githubUnavailableAck(err, isAdmin, '⚠️ Prozorro/GitHub тимчасово недоступний'), true);
      return;
    }
    const detail = buildAgentTenderDetail({ tenderId: tid, entry, job, page: backPage });
    try {
      await _editMessageText({
        token: env.TELEGRAM_BOT_TOKEN, chatId, messageId,
        text: detail.text, replyMarkup: detail.keyboard ?? undefined,
      });
    } catch (err) {
      console.error('worker: agent view edit failed:', err.message);
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
      await ack(githubUnavailableAck(err, isAdmin), true);
      return;
    }
    if (!prior || prior.status !== 'done' || !prior.result?.drive_link) {
      await ack('🚫 Пропозиція ще не готова', true);
      return;
    }
    try {
      const newId = await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: `✏️ Напиши, що доробити в пропозиції ${tid} (одним повідомленням):`,
        replyMarkup: buildAgentCancelKeyboard(tid),
      });
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, kind: 'amend', step: 'await_instruction', messageId: newId, at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent amend save pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }

  // Підписання й архів. На відміну від winner, тут ОБОВ'ЯЗКОВО потрібна готова
  // пропозиція: підписують теку `result.package_dir`, і без неї агенту нічого
  // відкривати. Тому кнопка й живе лише на готовій задачі в «📊 Останні задачі».
  if (action === 'sign') {
    let prior;
    try {
      prior = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent sign load job failed:', err.message);
      await ack(githubUnavailableAck(err, isAdmin), true);
      return;
    }
    if (!prior || prior.status !== 'done' || !prior.result?.package_dir) {
      await ack('🚫 Пропозиція ще не готова', true);
      return;
    }
    try {
      const newId = await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: 'Яку дату проставити в документах?',
        replyMarkup: buildAgentSignDateKeyboard(tid, formatLetterDate(_now())),
      });
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = {
        tid, kind: 'sign', step: 'await_date', messageId: newId,
        company: prior.company ?? null, at: _now().toISOString(),
      };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent sign date prompt failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }

  if (action === 'signdate' || action === 'signother') {
    let entry;
    try {
      const loaded = await _loadAgentPending(env);
      entry = loaded.pending?.[chatId];
    } catch (err) {
      console.error('worker: agent signdate load pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    // Звіряються ВСІ ТРИ поля — kind, tid і step. Урок гілки `co` з winner-флоу:
    // коли гілка дивиться лише на одне поле, покинутий діалог перехоплює пізніший
    // дотик. Тут ціна помилки більша за незручність: дотик по старій кнопці дати
    // інакше вписав би `letterDate` у чужий pending-запис (winner/amend того ж
    // чату) або проставив дату тендера A в діалог тендера B — а дата їде в кожен
    // лист поданого пакета. Кнопки не мають TTL (він працює лише для текстових
    // кроків), тож такий запис може лежати скільки завгодно.
    if (!entry || entry.kind !== 'sign' || entry.tid !== tid
      || !SIGN_CONTINUE_STEPS.has(entry.step)) {
      await ack('⚠️ Немає активного запиту');
      return;
    }
    if (action === 'signother') {
      try {
        const newId = await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: 'Надішли дату у форматі ДД.ММ.РРРР (напр. 13.08.2026):',
        });
        const { pending, sha } = await _loadAgentPending(env);
        pending[chatId] = { ...entry, step: 'await_letter_date', messageId: newId, at: _now().toISOString() };
        await _saveAgentPending(env, pending, sha);
      } catch (err) {
        console.error('worker: agent signother failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      await ack();
      return;
    }
    const letterDate = validateLetterDate(parts[3] ?? '', _now());
    if (!letterDate) { await ack('❌ Невірна дата', true); return; }
    try {
      const newId = await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: buildAgentSignConfirmText({ tenderId: tid, company: entry.company, letterDate }),
        replyMarkup: buildAgentConfirmKeyboard(tid),
      });
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { ...entry, step: 'confirm', letterDate, messageId: newId };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent signdate confirm failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }

  if (action === 'winner') {
    // Unlike amend, a winner run needs no prior agent job at all — it may be
    // fired straight from a "we won" notification for a tender the agent never
    // prepared. So a missing/failed prior job is a normal path, not an error.
    //
    // The company comes, in order of authority:
    //   1. the slug in callback_data — resolved in monitor.mjs from the award's
    //      ЄДРПОУ, i.e. the entity Prozorro says actually WON;
    //   2. the prior agent job (the 📊 Останні задачі button carries no slug);
    //   3. the company picker.
    // (1) must beat (2): the job file is per-tender and a re-prepare under a
    // different legal entity overwrites it, so the prior job can easily name an
    // entity that lost — and the draft contract would then be filled with the
    // wrong requisites, director, tax system and bank details.
    const fromSlug = companyForSlug(parts[3] ?? '');
    let prior = null;
    if (!fromSlug) {
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent winner load job failed:', err.message);
      }
    }
    const company = fromSlug ?? prior?.company ?? null;
    if (!company) {
      // Company unknown — ask with the same picker `prepare` uses, then land
      // on the winner confirm (not the price step; see the `co` branch below).
      try {
        const newId = await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: 'Оберіть компанію-переможця:', replyMarkup: buildAgentCompanyKeyboard(tid),
        });
        const { pending, sha } = await _loadAgentPending(env);
        pending[chatId] = { tid, kind: 'winner', step: 'await_company', messageId: newId, at: _now().toISOString() };
        await _saveAgentPending(env, pending, sha);
      } catch (err) {
        console.error('worker: agent winner company prompt failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      await ack();
      return;
    }
    const entityName = await winnerEntityName();
    try {
      const newId = await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: buildAgentWinnerConfirmText({ tenderId: tid, company, entityName }),
        replyMarkup: buildAgentConfirmKeyboard(tid),
      });
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, kind: 'winner', step: 'confirm', company, messageId: newId, at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent winner confirm prompt failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }

  if (action === 'start') {
    // A tender the owner isn't monitoring has no one watching for the award,
    // deadline changes or amendments once the agent prepares a proposal for
    // it — so require «Додати в моніторинг» first. Best-effort: a watchlist
    // load failure must not block an otherwise legitimate start (fail open,
    // same as the status/pending checks right below).
    try {
      const { watchlist } = await _loadWatchlist(env);
      if (!watchlist.some((r) => r.tender_id === tid)) {
        await ack('🚫 Спершу додай тендер у моніторинг («➕ Додати в моніторинг»), тоді агент буде доступний', true);
        return;
      }
    } catch (err) {
      console.error('worker: agent start watchlist check failed:', err.message);
    }
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
    // Starting a PREPARE of this tender supersedes an abandoned winner dialog
    // for the SAME tender: without this the `co` tap that follows would be read
    // as a winner continuation (its step is already `confirm`) and would queue a
    // winner job for a tender that was never awarded — the C1 hijack. Scoped
    // deliberately: only `kind:'winner'` AND the same tid is dropped. Clearing
    // pending unconditionally would kill an unrelated in-flight dialog (e.g. an
    // `amend` awaiting its instruction for another tender) — one bug traded for
    // another. Best-effort: a failure here must not block the picker.
    try {
      const { pending, sha } = await _loadAgentPending(env);
      const prior = pending?.[chatId];
      if (prior?.kind === 'winner' && prior?.tid === tid) {
        delete pending[chatId];
        await _saveAgentPending(env, pending, sha);
      }
    } catch (err) {
      console.error('worker: agent start clear stale winner pending failed:', err.message);
    }
    try {
      await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: 'Оберіть компанію-учасника:', replyMarkup: buildAgentCompanyKeyboard(tid),
      });
    } catch (err) {
      console.error('worker: agent start edit failed:', err.message);
    }
    await ack();
    return;
  }

  if (action === 'co') {
    const slug = parts[3] ?? '';
    const company = companyForSlug(slug);
    if (!company) { await ack('❌ Невідома компанія'); return; }

    // Company selection is shared between `prepare` (→ await_price) and
    // `winner` (→ straight to confirm, no price). Only winner's own pending
    // entry, for THIS SAME tid, continues the winner dialog — button taps
    // aren't covered by AGENT_PENDING_TTL_MS (that only fires from text-reply
    // steps), so a `winner` entry can otherwise sit there indefinitely and
    // hijack a later `co` tap for an unrelated tender.
    //
    // Both `await_company` and `confirm` are legitimate continuation steps.
    // `confirm` matters because the company picker message stays visible after
    // a pick: tapping the WRONG company and then the right one on that same
    // message is an ordinary correction, and it must land back on the winner
    // confirmation — not fall through to prepare, which would ask for a price
    // and then queue a full re-generation of the proposal.
    // The SAME-tender hijack (C1) is closed on the other side instead: a fresh
    // `agent:start` for this tender clears the abandoned winner dialog first
    // (see the `start` branch above), so by the time `co` runs there is no
    // winner pending left to continue. Anything else (no pending, different
    // tender, different kind) falls through to the ordinary prepare behaviour.
    let pending, sha, isWinnerContinuation = false;
    try {
      ({ pending, sha } = await _loadAgentPending(env));
      const prior = pending?.[chatId];
      isWinnerContinuation = prior?.kind === 'winner'
        && prior?.tid === tid
        && (prior?.step === 'await_company' || prior?.step === 'confirm');
    } catch (err) {
      console.error('worker: agent co load pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }

    if (isWinnerContinuation) {
      const entityName = await winnerEntityName();
      try {
        const newId = await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: buildAgentWinnerConfirmText({ tenderId: tid, company, entityName }),
          replyMarkup: buildAgentConfirmKeyboard(tid),
        });
        pending[chatId] = { tid, kind: 'winner', company, step: 'confirm', messageId: newId, at: _now().toISOString() };
        await _saveAgentPending(env, pending, sha);
      } catch (err) {
        console.error('worker: agent winner co save pending failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      await ack();
      return;
    }

    try {
      const newId = await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: 'Введіть ціну пропозиції (грн) або «auto»:',
      });
      pending[chatId] = { tid, company, step: 'await_price', messageId: newId, at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent co save pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
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

    // Sign: job_type:'sign' із датою листа й текою готового пакета. Без ціни.
    if (entry.kind === 'sign') {
      // Без обраної дати підписувати нічого не можна: вона підставляється в
      // КОЖЕН лист пакета, тож «порожня дата» — це не дефолт, а зупинка.
      if (!entry.letterDate) { await ack('⚠️ Немає активного запиту'); return; }
      let prior;
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent sign confirm load job failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      // Перевіряється ще раз, а не лише на кнопці: між відкриттям діалогу і
      // підтвердженням job-файл могли переписати (повторний prepare), і тоді
      // теки, яку збиралися підписувати, вже немає.
      if (!prior?.result?.package_dir) { await ack('🚫 Пропозиція ще не готова', true); return; }
      const job = buildAgentSignJob({
        tenderId: tid,
        company: entry.company ?? prior.company ?? null,
        letterDate: entry.letterDate,
        milestones: prior.milestones,
        target: {
          drive_link: prior.result.drive_link ?? null,
          package_dir: prior.result.package_dir,
          // published_dir — саме та тека архіву відділу, куди поллер уже поклав
          // пропозицію. Без неї він шукає теку ЗА НАЗВОЮ, а відділ теки
          // перейменовує руками («79. КНП Локачинської СелР Локачинська
          // лікарня» -> «79. Локачинська Лікарня»), тож підписаний пакет
          // поїхав би в НОВУ нумеровану теку, з'ївши номер у чужій ручній
          // послідовності й розчепивши один тендер надвоє. Winner-флоу
          // передає це поле з тієї ж причини.
          published_dir: prior.result.published_dir ?? null,
        },
        requestedBy: String(chatId),
        createdAt: _now().toISOString(),
      });
      try {
        await _saveAgentJob(env, job, {
          message: formatAuditMessage({ action: 'agent_sign', target: tid, actor: actorName, chatId, role }),
        });
      } catch (err) {
        console.error('worker: saveAgentJob (sign) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: '✅ Підписання поставлено в чергу. Сповіщу, коли буде готово.',
        });
      } catch (err) {
        console.error('worker: agent sign confirm reply failed:', err.message);
      }
      await notifyAdminAgentRun({
        env, isAdmin, adminChatId, _sendReply,
        kind: 'sign', actorName, chatId, tenderId: tid,
        company: job.company, letterDate: job.letter_date,
      });
      await ack('✅ В черзі');
      return;
    }

    // Winner: build a job_type:'winner' record. No price. `target` carries the
    // prior done job's Drive folders unchanged when one exists — omitted
    // entirely otherwise (a winner run needs no prior prepare/agent job).
    if (entry.kind === 'winner') {
      let prior = null;
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent winner confirm load job failed:', err.message);
      }
      const target = prior?.result
        ? {
            drive_link: prior.result.drive_link ?? null,
            package_dir: prior.result.package_dir ?? null,
            published_dir: prior.result.published_dir ?? null,
          }
        : null;
      const job = buildAgentWinnerJob({
        tenderId: tid,
        company: entry.company ?? prior?.company ?? null,
        target,
        requestedBy: String(chatId),
        createdAt: _now().toISOString(),
        milestones: prior?.milestones,
      });
      try {
        await _saveAgentJob(env, job, {
          message: formatAuditMessage({ action: 'agent_winner', target: tid, actor: actorName, chatId, role }),
        });
      } catch (err) {
        console.error('worker: saveAgentJob (winner) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: '✅ Документи переможця поставлено в чергу. Сповіщу, коли буде готово.',
        });
      } catch (err) {
        console.error('worker: agent winner confirm reply failed:', err.message);
      }
      await notifyAdminAgentRun({
        env, isAdmin, adminChatId, _sendReply,
        kind: 'winner', actorName, chatId, tenderId: tid, company: job.company,
      });
      await ack('✅ В черзі');
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
        milestones: prior?.milestones,
      });
      try {
        await _saveAgentJob(env, job, {
          message: formatAuditMessage({ action: 'agent_amend', target: tid, actor: actorName, chatId, role }),
        });
      } catch (err) {
        console.error('worker: saveAgentJob (amend) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: '✅ Завдання на доробку поставлено в чергу. Сповіщу, коли буде готово.',
        });
      } catch (err) {
        console.error('worker: agent amend confirm reply failed:', err.message);
      }
      await notifyAdminAgentRun({
        env, isAdmin, adminChatId, _sendReply,
        kind: 'amend', actorName, chatId, tenderId: tid, instruction: entry.instruction,
      });
      await ack('✅ В черзі');
      return;
    }

    // Prepare (existing): requires a price.
    if (!entry.price) { await ack('⚠️ Немає активного запиту'); return; }
    // A pending/running job for this tender is already in flight. Queuing a
    // second one silently overwrites the file the first run reads its status
    // back into (one file per tender_id, see saveAgentJob) — two "запустив
    // агента" admin notices a few minutes apart with no sign that the second
    // one did nothing useful. Refuse outright instead of re-queuing.
    let existingJob = null;
    try {
      existingJob = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent prepare dedup check failed:', err.message);
    }
    if (existingJob && (existingJob.status === 'pending' || existingJob.status === 'running')) {
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      const verb = existingJob.status === 'running' ? 'вже виконується' : 'вже в черзі';
      try {
        await editOrSend({
          _editMessageText, _sendReply, env, chatId, messageId,
          text: `⚠️ Підготовку для ${tid} ${verb} — дочекайся результату, перш ніж запускати знову.`,
        });
      } catch (err) {
        console.error('worker: agent prepare dup reply failed:', err.message);
      }
      await ack('⚠️ Вже в черзі');
      return;
    }
    const link = `https://prozorro.gov.ua/tender/${tid}`;
    const job = buildAgentJob({
      tenderId: tid, link, company: entry.company, price: entry.price,
      requestedBy: String(chatId), createdAt: _now().toISOString(),
      milestones: existingJob?.milestones,
    });
    try {
      await _saveAgentJob(env, job, {
        message: formatAuditMessage({ action: 'agent', target: tid, actor: actorName, chatId, role }),
      });
    } catch (err) {
      console.error('worker: saveAgentJob failed:', err.message);
      await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
      return;
    }
    await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
    try {
      await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: '✅ Завдання поставлено в чергу. Сповіщу, коли буде готово.',
      });
    } catch (err) {
      console.error('worker: agent confirm reply failed:', err.message);
    }
    await notifyAdminAgentRun({
      env, isAdmin, adminChatId, _sendReply,
      kind: 'prepare', actorName, chatId, tenderId: tid,
      company: entry.company, price: entry.price,
    });
    await ack('✅ В черзі');
    return;
  }

  if (action === 'retry') {
    let job;
    try {
      job = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent retry load failed:', err.message);
      await ack(githubUnavailableAck(err, isAdmin), true);
      return;
    }
    if (!job) { await ack('⚠️ Job не знайдено', true); return; }
    if (job.status !== 'error') { await ack('ℹ️ Job вже не в стані error', true); return; }

    // «Повторити» НЕ ставить задачу в чергу саме — воно веде в те саме вікно
    // підтвердження, що й ручне введення ціни, з підставленими компанією й
    // ціною зі старої задачі. Далі все робить `action === 'confirm'` вище.
    //
    // Раніше тут була коротка обхідна стежка (`{...job, status: 'pending'}` →
    // `saveAgentJob`), і вона ТРИЧІ забувала те, що вміє головна:
    //   1. перевірку ціни проти оголошеної вартості закупівлі;
    //   2. `requested_by` — успадковувався разом із задачею, тож звіт ішов
    //      початковому авторові, а не тому, хто натиснув (реальний випадок
    //      21.08.2026: оператор перезапустив задачу колеги, прочекав пів
    //      години й не отримав нічого);
    //   3. `notifyAdminAgentRun` — механізм, зроблений саме для того, щоб
    //      адмін дізнавався про запуски, зроблені кимось іншим.
    // Латати три пропуски окремо означало б лишити дві стежки, які розійдуться
    // знову при наступній зміні. Тому стежка одна.
    let announcedValue = null;
    try {
      const snap = _loadTenderState ? await _loadTenderState(env, tid) : null;
      announcedValue = snap?.value?.amount ?? null;
    } catch (err) {
      console.error('worker: agent retry price snapshot lookup failed:', err.message);
    }
    let newId;
    try {
      newId = await editOrSend({
        _editMessageText, _sendReply, env, chatId, messageId,
        text: buildAgentConfirmText({
          company: job.company, price: job.price, tenderId: tid, announcedValue,
        }),
        replyMarkup: buildAgentConfirmKeyboard(tid),
      });
    } catch (err) {
      console.error('worker: agent retry confirm prompt failed:', err.message);
    }
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = {
        tid, company: job.company, price: job.price, step: 'confirm',
        messageId: newId ?? messageId,
      };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent retry save pending failed:', err.message);
      await ack('⚠️ Не вдалось відкрити підтвердження, спробуй ще раз', true);
      return;
    }
    await ack('↩️ Перевір ціну й підтверди');
    return;
  }

  if (action === 'cancel') {
    await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
    // Повертаємось на картку тендера (як «⬅ До списку»/agent:view), а не
    // лишаємо голе «Скасовано.» без жодної кнопки — інакше єдиний шлях назад
    // був заново шукати цей тендер у списку (реальна скарга власника
    // 17.08.2026). Без tid (теоретично можливо для старих кнопок) — той самий
    // текст, що й раніше, як безпечний фолбек.
    let text = 'Скасовано.';
    let replyMarkup;
    if (tid) {
      try {
        const [{ watchlist }, job] = await Promise.all([_loadWatchlist(env), _loadAgentJob(env, tid)]);
        const entry = watchlist.find((r) => r.tender_id === tid) ?? null;
        const detail = buildAgentTenderDetail({ tenderId: tid, entry, job, page: 0 });
        text = detail.text;
        replyMarkup = detail.keyboard ?? undefined;
      } catch (err) {
        console.error('worker: agent cancel detail reload failed:', err.message);
      }
    }
    try {
      await editOrSend({ _editMessageText, _sendReply, env, chatId, messageId, text, replyMarkup });
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
// free-text reply — the price (await_price), the amend instruction
// (await_instruction) or the letter date (await_letter_date). Returns true if it
// consumed the message (so the caller stops), false if there was no matching
// pending step (caller continues normal parsing).
async function handleAgentTextReply({
  env, chatId, msg, _sendReply, _editMessageText, _loadAgentPending, _saveAgentPending, _now,
  _loadTenderState,
}) {
  let pending, sha, entry;
  try {
    ({ pending, sha } = await _loadAgentPending(env));
    entry = pending?.[chatId];
  } catch (err) {
    console.error('worker: agent text-reply load pending failed:', err.message);
    return false; // can't verify state → let normal handling proceed
  }
  if (!entry || (entry.step !== 'await_price'
    && entry.step !== 'await_instruction'
    && entry.step !== 'await_letter_date')) return false;

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

  // The prompt this reply is answering lives in ONE message (edited in place at
  // every step since the company picker was tapped — see editOrSend). Update
  // it rather than replying with a new message, so an invalid retry doesn't
  // leave a trail of "Введіть ціну…" copies in the chat. Falls back to a fresh
  // reply (with no persisted id to fall back to, or if the edit itself fails).
  const update = (text, replyMarkup) => editOrSend({
    _editMessageText, _sendReply, env, chatId: msg.chat.id, messageId: entry.messageId,
    text, replyMarkup,
  });

  if (entry.step === 'await_letter_date') {
    const letterDate = validateLetterDate(msg.text, now);
    if (!letterDate) {
      try {
        await update('❌ Дата має бути у форматі ДД.ММ.РРРР і в межах ±30 днів. Спробуй ще раз:');
      } catch (err) { console.error('worker: agent invalid-date reply failed:', err.message); }
      return true;
    }
    let newId;
    try {
      newId = await update(
        buildAgentSignConfirmText({ tenderId: entry.tid, company: entry.company, letterDate }),
        buildAgentConfirmKeyboard(entry.tid),
      );
    } catch (err) { console.error('worker: agent sign confirm prompt failed:', err.message); }
    try {
      pending[chatId] = { ...entry, letterDate, step: 'confirm', messageId: newId ?? entry.messageId };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent letter-date save pending failed:', err.message);
    }
    return true;
  }

  if (entry.step === 'await_instruction') {
    const instruction = validateInstruction(msg.text);
    if (instruction === null) {
      try { await update('Порожня інструкція. Напиши текстом, що доробити.'); }
      catch (err) { console.error('worker: agent empty-instruction reply failed:', err.message); }
      return true; // consumed; stay at await_instruction
    }
    let newId;
    try {
      newId = await update(
        buildAgentAmendConfirmText({ tenderId: entry.tid, instruction }),
        buildAgentConfirmKeyboard(entry.tid),
      );
    } catch (err) { console.error('worker: agent amend confirm prompt failed:', err.message); }
    try {
      pending[chatId] = { ...entry, instruction, step: 'confirm', messageId: newId ?? entry.messageId };
      await _saveAgentPending(env, pending, sha);
    } catch (err) {
      console.error('worker: agent instruction save pending failed:', err.message);
    }
    return true;
  }

  const price = validateAgentPrice(msg.text);
  // Reject null AND a zero price ('0', '0,00', etc.) — validateAgentPrice allows
  // '0' but a zero-priced proposal is never intended.
  const isZero = typeof price === 'string' && price !== 'auto'
    && parseFloat(price.replace(/\s/g, '').replace(',', '.')) === 0;
  if (price === null || isZero) {
    try {
      await update('Невірна ціна. Введіть число (грн) або «auto».');
    } catch (err) {
      console.error('worker: agent invalid-price reply failed:', err.message);
    }
    return true; // consumed; stay at await_price
  }

  // Advance to confirm. Cross-check against the tender's own announced value
  // (cached snapshot) so a mistyped price gets flagged BEFORE a real run starts —
  // see buildAgentConfirmText for the incident that motivated this.
  let announcedValue = null;
  try {
    const snap = _loadTenderState ? await _loadTenderState(env, entry.tid) : null;
    announcedValue = snap?.value?.amount ?? null;
  } catch (err) {
    console.error('worker: agent price snapshot lookup failed:', err.message);
  }
  let newId;
  try {
    newId = await update(
      buildAgentConfirmText({ company: entry.company, price, tenderId: entry.tid, announcedValue }),
      buildAgentConfirmKeyboard(entry.tid),
    );
  } catch (err) {
    console.error('worker: agent confirm prompt failed:', err.message);
  }
  try {
    pending[chatId] = { ...entry, price, step: 'confirm', messageId: newId ?? entry.messageId };
    await _saveAgentPending(env, pending, sha);
  } catch (err) {
    console.error('worker: agent price save pending failed:', err.message);
  }
  return true;
}

async function applyMutationWithRetry({ env, loadWatchlist, saveWatchlist, computeMutation, auditMessage , isAdmin }) {
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
        return githubUnavailableText(err, isAdmin);
      }
      return '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}

async function applyAllowedUsersMutationWithRetry({ env, loadAllowedUsers, saveAllowedUsers, computeMutation, auditMessage , isAdmin }) {
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
        ? githubUnavailableText(err, isAdmin)
        : '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}

async function applyInviteMutationWithRetry({ env, loadInvites, saveInvites, computeMutation, auditMessage , isAdmin }) {
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
        ? githubUnavailableText(err, isAdmin)
        : '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}

async function applyEntityMutationWithRetry({ env, loadWatchedEntities, saveWatchedEntities, computeMutation, onSuccess, auditMessage , isAdmin }) {
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
        return githubUnavailableText(err, isAdmin);
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

async function applyUnarchive({ env, loadArchivedTenders, saveArchivedTenders, tender_id, auditMessage , isAdmin }) {
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
      ? githubUnavailableText(err, isAdmin)
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

// Прибирає замовника зі стеження після того, як його оголошену закупівлю додали
// в моніторинг тендерів (рішення власника 11.08.2026: далі він там зайвий).
// Best-effort: тендер уже додано, тож жодна помилка тут не має ламати результат —
// лише лог. Мовчить, якщо цього ЄДРПОУ у стеженні не було.
async function dropWatchedEntityAfterAdd({
  env, edrpou, tenderId, chatId, actorName, role,
  _loadWatchedEntities, _saveWatchedEntities, _sendReply,
}) {
  try {
    const { entities, sha } = await _loadWatchedEntities(env);
    const watched = entities.find((e) => e.edrpou === edrpou);
    if (!watched) return;                       // за цим замовником не стежили
    const next = applyEntityMutation(entities, { type: 'delete_entity', edrpou });
    await _saveWatchedEntities(env, next, sha, {
      message: formatAuditMessage({
        action: 'unwatch', target: edrpou, actor: actorName, chatId, role,
      }),
    });
    const namePart = watched.name && watched.name !== '(unknown)'
      ? ` (${escapeHtml(watched.name)})` : '';
    await _sendReply({
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: Number(chatId),
      text: `🗑 Замовника <code>${escapeHtml(edrpou)}</code>${namePart} прибрано зі стеження — `
        + `його закупівля ${escapeHtml(tenderId)} тепер у моніторингу тендерів.`,
    });
  } catch (err) {
    console.error('worker: drop watched entity after add failed:', err.message);
  }
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
