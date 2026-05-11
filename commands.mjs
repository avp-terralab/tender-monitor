import { stripDkCode, truncate, fmtStatus, fmtDeadline, fmtTimeLeft, escapeHtml, formatMoney, formatPhone } from './telegram.mjs';

const TENDER_ID_RE_STR = 'UA-\\d{4}-\\d{2}-\\d{2}-\\d{6}-[a-zA-Z]';
const EDRPOU_RE = /^\d{8}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/i;
const NUMERIC_RE = /^\d+$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function parseCommand(text) {
  if (typeof text !== 'string') return { cmd: null };
  const trimmed = text.trim();
  if (trimmed === '') return { cmd: null };

  if (/^\/list(?:@\w+)?$/i.test(trimmed)) return { cmd: 'list' };
  if (/^\/help(?:@\w+)?$/i.test(trimmed)) return { cmd: 'help' };
  if (/^\/status(?:@\w+)?$/i.test(trimmed)) return { cmd: 'status' };
  if (/^\/watched(?:@\w+)?$/i.test(trimmed)) return { cmd: 'watched' };

  const infoMatch = trimmed.match(/^\/info(?:@\w+)?(?:\s+(.+))?$/i);
  if (infoMatch) {
    const args = (infoMatch[1] || '').trim();
    if (!args) return { cmd: 'info' };
    const idMatch = args.match(new RegExp(`^(${TENDER_ID_RE_STR})$`));
    if (!idMatch) return { cmd: 'unknown' };
    const id = idMatch[1].slice(0, -1) + idMatch[1].slice(-1).toLowerCase();
    return { cmd: 'info', tender_id: id };
  }

  const addMatch = trimmed.match(/^\/add(?:@\w+)?(?:\s+(.*))?$/i);
  if (addMatch) {
    const args = (addMatch[1] || '').trim();
    if (!args) return { cmd: 'add', error: 'missing_id' };
    const idMatch = args.match(new RegExp(`^(${TENDER_ID_RE_STR})(?:\\s+(.+))?$`));
    if (!idMatch) return { cmd: 'add', error: 'invalid_id' };
    const id = idMatch[1].slice(0, -1) + idMatch[1].slice(-1).toLowerCase();
    return {
      cmd: 'add',
      tender_id: id,
      notes: idMatch[2] ? idMatch[2].trim() : null,
    };
  }

  const removeMatch = trimmed.match(/^\/remove(?:@\w+)?(?:\s+(.*))?$/i);
  if (removeMatch) {
    const args = (removeMatch[1] || '').trim();
    if (!args) return { cmd: 'remove', error: 'missing_id' };
    const idMatch = args.match(new RegExp(`^(${TENDER_ID_RE_STR})$`));
    if (!idMatch) return { cmd: 'remove', error: 'invalid_id' };
    const id = idMatch[1].slice(0, -1) + idMatch[1].slice(-1).toLowerCase();
    return { cmd: 'remove', tender_id: id };
  }

  const watchMatch = trimmed.match(/^\/watch(?:@\w+)?(?:\s+(.*))?$/i);
  if (watchMatch) {
    const args = (watchMatch[1] || '').trim();
    if (!args) return { cmd: 'watch', error: 'missing_edrpou' };
    if (!EDRPOU_RE.test(args)) return { cmd: 'watch', error: 'invalid_edrpou' };
    return { cmd: 'watch', edrpou: args };
  }

  const unwatchMatch = trimmed.match(/^\/unwatch(?:@\w+)?(?:\s+(.*))?$/i);
  if (unwatchMatch) {
    const args = (unwatchMatch[1] || '').trim();
    if (!args) return { cmd: 'unwatch', error: 'missing_edrpou' };
    if (!EDRPOU_RE.test(args)) return { cmd: 'unwatch', error: 'invalid_edrpou' };
    return { cmd: 'unwatch', edrpou: args };
  }

  const startMatch = trimmed.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (startMatch) {
    const arg = (startMatch[1] || '').trim();
    if (!arg) return { cmd: 'start' };
    if (!TOKEN_RE.test(arg)) return { cmd: 'start', error: 'invalid_token' };
    return { cmd: 'start', token: arg.toLowerCase() };
  }

  const inviteMatch = trimmed.match(/^\/invite(?:@\w+)?(?:\s+(.+))?$/i);
  if (inviteMatch) {
    const label = (inviteMatch[1] || '').trim();
    if (!label) return { cmd: 'invite', error: 'missing_label' };
    return { cmd: 'invite', label };
  }

  if (/^\/invites(?:@\w+)?$/i.test(trimmed)) return { cmd: 'invites' };
  if (/^\/users(?:@\w+)?$/i.test(trimmed)) return { cmd: 'users' };

  const revokeMatch = trimmed.match(/^\/revoke(?:@\w+)?(?:\s+(.+))?$/i);
  if (revokeMatch) {
    const arg = (revokeMatch[1] || '').trim();
    if (!arg) return { cmd: 'revoke', error: 'missing_chat_id' };
    if (!NUMERIC_RE.test(arg)) return { cmd: 'revoke', error: 'invalid_chat_id' };
    return { cmd: 'revoke', chat_id: arg };
  }

  if (trimmed.startsWith('/')) return { cmd: 'unknown' };
  return { cmd: null };
}

export function buildAutoNotes(snapshot) {
  const entity = snapshot?.procuringEntity?.name ?? '';
  const title = stripDkCode(snapshot?.title ?? '');
  let combined;
  if (entity && title) combined = `${entity} — ${title}`;
  else if (entity) combined = entity;
  else if (title) combined = title;
  else combined = '';
  return truncate(combined, 200);
}

export function formatAddReply(snapshot, { reEnable, nowIso }) {
  const lines = [];
  const verb = reEnable ? 'Поновив моніторинг' : 'Додано';
  lines.push(`✅ ${verb} ${snapshot.tender_id}`);
  const title = stripDkCode(snapshot.title ?? '');
  if (title) lines.push(`📦 ${escapeHtml(truncate(title, 200))}`);
  if (snapshot.procuringEntity?.name) {
    lines.push(`👥 ${escapeHtml(abbreviateLegalForm(snapshot.procuringEntity.name))}`);
  }
  if (snapshot.status) {
    let line = `ℹ️ Статус: ${fmtStatus(snapshot.status)}`;
    const deadline = snapshot.tenderPeriod?.endDate;
    if (deadline) line += `, дедлайн ${fmtDeadline(deadline)}`;
    lines.push(line);
    const deadline2 = snapshot.tenderPeriod?.endDate;
    if (deadline2 && nowIso) {
      const left = fmtTimeLeft(deadline2, nowIso);
      if (left) lines.push(`⏰ Залишилось: ${left}`);
    }
  }
  lines.push('Перший snapshot — на наступному monitor-тіку (09/12/15/18 Київ).');
  return lines.join('\n');
}

// Legal-form abbreviations for Ukrainian entity names. Order matters —
// longer phrases must be matched before their shorter prefixes.
// Note: JS regex \b is ASCII-only — use \s+ to require whitespace separator.
const LEGAL_FORM_ABBREVIATIONS = [
  [/^Комунальне\s+некомерційне\s+підприємство\s+/i, 'КНП '],
  [/^Комунальне\s+підприємство\s+/i, 'КП '],
  [/^Товариство\s+з\s+обмеженою\s+відповідальністю\s+/i, 'ТОВ '],
  [/^Приватне\s+акціонерне\s+товариство\s+/i, 'ПрАТ '],
  [/^Публічне\s+акціонерне\s+товариство\s+/i, 'ПАТ '],
  [/^Акціонерне\s+товариство\s+/i, 'АТ '],
  [/^Державне\s+підприємство\s+/i, 'ДП '],
  [/^Приватне\s+підприємство\s+/i, 'ПП '],
  [/^Фізична\s+особа[-\s]+підприємець\s+/i, 'ФОП '],
];

export function abbreviateLegalForm(name) {
  if (!name) return name;
  for (const [re, replacement] of LEGAL_FORM_ABBREVIATIONS) {
    if (re.test(name)) return name.replace(re, replacement).trim();
  }
  return name;
}

export function handleList({ watchlist }) {
  if (!watchlist || watchlist.length === 0) {
    return '📭 Список порожній. Додай тендер: /add UA-...';
  }
  const rows = watchlist.map((r, i) => {
    const icon = r.enabled ? '🟢' : '🔴';
    // Auto-notes format is "<customer> — <title>"; show only customer.
    const rawCustomer = r.notes ? r.notes.split(' — ')[0].trim() : '';
    const customer = abbreviateLegalForm(rawCustomer);
    const customerSuffix = customer ? ` — ${escapeHtml(truncate(customer, 150))}` : '';
    // Optional value (provided by handler from Prozorro fetch on enabled rows)
    let valueSuffix = '';
    if (r._value && typeof r._value.amount === 'number') {
      const amount = formatMoney(r._value.amount);
      valueSuffix = ` — ${amount} ${r._value.currency}`;
    }
    return `${i + 1}. ${icon} ${r.tender_id}${customerSuffix}${valueSuffix}`;
  });
  const active = watchlist.filter(r => r.enabled).length;
  return rows.join('\n\n') + `\n\nВсього: ${watchlist.length} (${active} active)`;
}

function formatInfoEntry(g, runIso) {
  const sections = [];
  sections.push(`🆔 Ідентифікатор закупівлі: <a href="${escapeHtml(g.prozorro_url)}">${escapeHtml(g.tender_id)}</a>`);
  if (g.procuring_entity?.name) {
    const edrpou = g.procuring_entity.edrpou ? ` (ЄДРПОУ ${g.procuring_entity.edrpou})` : '';
    const name = abbreviateLegalForm(g.procuring_entity.name);
    sections.push(`👥 Замовник: ${escapeHtml(name)}${edrpou}`);
  }
  if (g.classification?.id) {
    const desc = g.classification.description ? ` — ${escapeHtml(g.classification.description)}` : '';
    sections.push(`🔖 ДК: ${g.classification.id}${desc}`);
  }
  if (g.value && typeof g.value.amount === 'number') {
    const amount = formatMoney(g.value.amount);
    const vatTag = g.value.valueAddedTaxIncluded ? 'з ПДВ' : 'без ПДВ';
    sections.push(`💰 Вартість: ${amount} ${g.value.currency} (${vatTag})`);
  }
  if (g.contact?.name) {
    const tel = formatPhone(g.contact.telephone ?? '');
    const phoneLine = `📞 ${escapeHtml(g.contact.name)}: ${escapeHtml(tel)}`;
    const emailLine = g.contact.email ? `✉️ ${escapeHtml(g.contact.email)}` : '';
    sections.push(emailLine ? `${phoneLine}\n${emailLine}` : phoneLine);
  }
  if (g.status) {
    let statusLine = `ℹ️ Статус: ${fmtStatus(g.status)}`;
    if (g.deadline) statusLine += ` до ${fmtDeadline(g.deadline)}`;
    sections.push(statusLine);
    if (g.deadline && runIso) {
      const left = fmtTimeLeft(g.deadline, runIso);
      if (left) sections.push(`⏰ Залишилось: ${left}`);
    }
  }
  return sections.join('\n');
}

export function formatInfo({ runIso, groups, errors = [] }) {
  if (groups.length === 0 && errors.length === 0) {
    return '📭 Немає активних тендерів.';
  }
  const KYIV_TIME = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const KYIV_DATE = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const time = KYIV_TIME.format(new Date(runIso));
  const date = KYIV_DATE.format(new Date(runIso));
  const lines = [`📋 Статус тендерів (${time}, ${date})`, ''];
  for (let i = 0; i < groups.length; i++) {
    lines.push(`${i + 1}. ${formatInfoEntry(groups[i], runIso)}`);
    if (i < groups.length - 1) {
      lines.push('');
      lines.push('━'.repeat(24));
      lines.push('');
    }
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push('⚠️ не вдалось перевірити:');
    for (const e of errors) {
      lines.push(`  • ${e.tender_id} — ${e.error}`);
    }
  }
  return lines.join('\n');
}

export function handleStatus({ watchlist, sha }) {
  const active = watchlist.filter(r => r.enabled).length;
  const lines = [
    '🟢 Worker live',
    `📋 Watchlist: ${watchlist.length} tenders (${active} active)`,
    `✅ GitHub auth: OK (sha ${sha.slice(0, 7)})`,
  ];
  return lines.join('\n');
}

export function applyMutation(watchlist, mutation) {
  if (mutation.type === 'append') {
    return [...watchlist, mutation.row];
  }
  if (mutation.type === 'update') {
    return watchlist.map(r =>
      r.tender_id === mutation.tender_id
        ? { ...r, ...mutation.fields }
        : r
    );
  }
  if (mutation.type === 'delete') {
    return watchlist.filter(r => r.tender_id !== mutation.tender_id);
  }
  return watchlist;
}

export function handleRemove({ watchlist }, { tender_id }) {
  const existing = watchlist.find(r => r.tender_id === tender_id);
  if (!existing) {
    return {
      reply: `❓ ${tender_id} не у watchlist`,
      mutation: null,
    };
  }
  return {
    reply: `✅ Видалено ${tender_id}\nДодати знову: /add ${tender_id}`,
    mutation: { type: 'delete', tender_id },
  };
}

export function handleWatched({ watchedEntities }) {
  if (!watchedEntities || watchedEntities.length === 0) {
    return '📭 Не стежу за жодним замовником. Додай: /watch <EDRPOU>';
  }
  const rows = watchedEntities.map((e, i) => {
    const icon = e.enabled ? '🟢' : '🔴';
    const name = e.name && e.name !== '(unknown)'
      ? ` — ${escapeHtml(truncate(abbreviateLegalForm(e.name), 100))}`
      : '';
    return `${i + 1}. ${icon} ${e.edrpou}${name}`;
  });
  return rows.join('\n\n') + `\n\nВсього: ${watchedEntities.length}`;
}

export function handleUnwatch({ watchedEntities }, { edrpou }) {
  const existing = watchedEntities.find(e => e.edrpou === edrpou);
  if (!existing) {
    return { reply: `❓ ${edrpou} не у watched-списку`, mutation: null };
  }
  const namePart = existing.name && existing.name !== '(unknown)' ? ` (${existing.name})` : '';
  return {
    reply: `✅ Прибрав ${edrpou}${namePart}`,
    mutation: { type: 'delete_entity', edrpou },
  };
}

export function applyEntityMutation(watchedEntities, mutation) {
  if (mutation.type === 'append') {
    return [...watchedEntities, mutation.row];
  }
  if (mutation.type === 'delete_entity') {
    return watchedEntities.filter(e => e.edrpou !== mutation.edrpou);
  }
  return watchedEntities;
}

export async function handleAdd(deps, { tender_id, notes }) {
  const { watchlist, fetchTender, extractSnapshot } = deps;
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const existing = watchlist.find(r => r.tender_id === tender_id);

  if (existing?.enabled) {
    return {
      reply: `⚠️ Вже моніторю ${tender_id}`,
      mutation: null,
    };
  }

  let snapshot;
  try {
    const raw = await fetchTender(tender_id);
    snapshot = extractSnapshot(raw);
  } catch (err) {
    if (/(404|not found|no UUID)/i.test(err.message)) {
      return {
        reply: `❌ ${tender_id} не знайдено в Prozorro. Перевір id.`,
        mutation: null,
      };
    }
    return {
      reply: `⚠️ Не зміг перевірити ${tender_id} в Prozorro: ${err.message}. Спробуй ще раз.`,
      mutation: null,
    };
  }

  const finalNotes = notes ?? buildAutoNotes(snapshot);

  if (existing) {
    return {
      reply: formatAddReply(snapshot, { reEnable: true, nowIso }),
      mutation: {
        type: 'update',
        tender_id,
        fields: { enabled: true, notes: finalNotes },
      },
    };
  }

  return {
    reply: formatAddReply(snapshot, { reEnable: false, nowIso }),
    mutation: {
      type: 'append',
      row: { tender_id, enabled: true, notes: finalNotes },
    },
  };
}

export async function handleWatch(deps, { edrpou }) {
  const existing = deps.watchedEntities.find(e => e.edrpou === edrpou);
  if (existing) {
    const namePart = existing.name && existing.name !== '(unknown)' ? ` (${existing.name})` : '';
    return {
      reply: `⚠️ Вже стежу за ${edrpou}${namePart}`,
      mutation: null,
    };
  }

  let entityName = '(unknown)';
  let bootstrapIds = [];
  // Walk up to 10 pages (~1000 tenders) to better cover rare publishers when discovering name + bootstrap
  const WATCH_PAGE_CAP = 10;
  try {
    const allItems = [];
    let pageOffset = null;
    for (let page = 0; page < WATCH_PAGE_CAP; page++) {
      const { items, next } = await deps.fetchTendersFeed({ pageOffset });
      if (items.length === 0) break;
      allItems.push(...items);
      if (!next) break;
      pageOffset = next;
    }
    const matches = allItems.filter(t => t.procuringEntity?.identifier?.id === edrpou);
    if (matches.length > 0) {
      entityName = matches[0].procuringEntity.name ?? '(unknown)';
      for (const m of matches) {
        try {
          const raw = await deps.fetchTender(m.tenderID);
          const snap = deps.extractSnapshot(raw);
          if (['active.tendering', 'active.pre-qualification'].includes(snap.status)) {
            bootstrapIds.push(m.tenderID);
          }
        } catch {
          // skip individual fetch failures
        }
      }
    }
  } catch (err) {
    return {
      reply: `⚠️ Не зміг перевірити EDRPOU: ${err.message}. Спробуй ще раз.`,
      mutation: null,
    };
  }

  const newRow = {
    edrpou,
    name: entityName,
    enabled: true,
    added_at: new Date().toISOString(),
  };
  const reply = entityName === '(unknown)'
    ? `✅ ${edrpou} збережено. Серед ~1000 останніх публікацій Prozorro тендерів від цього замовника не виявлено — нормально, якщо замовник публікує рідко. Назва замовника зʼявиться у /watched коли bot знайде його перший новий тендер. Якщо EDRPOU помилковий — /unwatch ${edrpou}.`
    : `✅ Стежу за ${edrpou} — ${escapeHtml(abbreviateLegalForm(entityName))}\nПомічено як уже-побачені: ${bootstrapIds.length} активних тендерів. Алерт буде на нові.`;
  return {
    reply,
    mutation: { type: 'append', row: newRow, bootstrap: { edrpou, ids: bootstrapIds } },
  };
}

export function handleInvite(deps, { label }) {
  const token = deps.generateToken();
  const now = deps.now();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const row = {
    token,
    label,
    created_at: createdAt,
    expires_at: expiresAt,
    status: 'pending',
    redeemed_by: null,
    redeemed_at: null,
  };
  const link = `https://t.me/${deps.botUsername}?start=${token}`;
  const reply = `🔗 Invite для <b>${escapeHtml(label)}</b>\n\n${link}\n\nПерешли цій людині. Дійсне 7 днів.`;
  return {
    reply,
    mutation: { type: 'append_invite', row },
  };
}

export function applyInviteMutation(invites, mutation) {
  if (mutation.type === 'append_invite') {
    return [...invites, mutation.row];
  }
  if (mutation.type === 'update_invite_status') {
    return invites.map(inv =>
      inv.token === mutation.token ? { ...inv, ...mutation.fields } : inv
    );
  }
  return invites;
}

export function applyAllowedUsersMutation(users, mutation) {
  if (mutation.type === 'append_user') {
    return [...users, mutation.row];
  }
  if (mutation.type === 'remove_user') {
    return users.filter(u => u.chat_id !== mutation.chat_id);
  }
  return users;
}

export function handleRedeem(deps, { token }) {
  const { invites, allowedUsers, adminChatId, chatId } = deps;
  const now = deps.now();
  const nowIso = now.toISOString();

  const invite = invites.find(i => i.token === token);
  if (!invite) {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '❌ Невалідне посилання',
    };
  }
  if (invite.status !== 'pending') {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '❌ Посилання вже використане або відкликане',
    };
  }
  if (new Date(invite.expires_at) <= now) {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '❌ Посилання застаріло (>7 днів)',
    };
  }
  // Token NOT consumed when redeemer already has access — preserves a fresh
  // invite for its intended recipient if it was accidentally tapped by an
  // existing user (e.g. admin or an already-invited person).
  const alreadyAllowed =
    chatId === adminChatId ||
    allowedUsers.some(u => u.chat_id === chatId);
  if (alreadyAllowed) {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '✅ Ти вже маєш доступ. /help',
    };
  }
  return {
    inviteMutation: {
      type: 'update_invite_status',
      token,
      fields: { status: 'redeemed', redeemed_by: chatId, redeemed_at: nowIso },
    },
    userMutation: {
      type: 'append_user',
      row: {
        chat_id: chatId,
        label: invite.label,
        invited_via: invite.label,
        added_at: nowIso,
      },
    },
    reply: `✅ Доступ надано: <b>${escapeHtml(invite.label)}</b>.\n\n/help — список команд.`,
    adminNotice: `🆕 <b>${escapeHtml(invite.label)}</b> приєднався (chat_id: <code>${chatId}</code>)`,
  };
}

export function handleUsersList({ allowedUsers, adminChatId }) {
  const lines = [`👥 Користувачі бота:`, ''];
  lines.push(`1. <code>${adminChatId}</code> — admin`);
  allowedUsers.forEach((u, i) => {
    const via = u.invited_via ? ` (від: ${escapeHtml(u.invited_via)})` : '';
    lines.push(`${i + 2}. <code>${u.chat_id}</code> — ${escapeHtml(u.label)}${via}`);
  });
  lines.push('', `Всього: ${allowedUsers.length + 1}`);
  return lines.join('\n');
}

export function handleInvitesList({ invites, now }) {
  const nowDate = now();
  const active = invites.filter(i =>
    i.status === 'pending' && new Date(i.expires_at) > nowDate
  );
  if (active.length === 0) {
    return '📭 Немає активних invite-посилань.';
  }
  const lines = [`🔗 Активні invite-посилання:`, ''];
  active.forEach((inv, i) => {
    const suffix = inv.token.slice(-6);
    const exp = inv.expires_at.slice(0, 10);
    lines.push(`${i + 1}. <b>${escapeHtml(inv.label)}</b> — …${suffix} (до ${exp})`);
  });
  lines.push('', `Всього: ${active.length}`);
  return lines.join('\n');
}

export function handleRevoke({ allowedUsers, adminChatId }, { chat_id }) {
  if (chat_id === adminChatId) {
    return { reply: '❌ Не можу видалити адміна', mutation: null };
  }
  const user = allowedUsers.find(u => u.chat_id === chat_id);
  if (!user) {
    return { reply: `❓ chat_id <code>${chat_id}</code> не у allowlist`, mutation: null };
  }
  return {
    reply: `✅ <b>${escapeHtml(user.label)}</b> видалено (chat_id: <code>${chat_id}</code>)`,
    mutation: { type: 'remove_user', chat_id },
  };
}

export const HELP_TEXT = [
  'Загальні команди:',
  '/help — список команд',
  '/status — здоровʼя бота',
  '',
  'Моніторинг закупівель за ID:',
  '/add UA-YYYY-MM-DD-NNNNNN-x — додати тендер',
  '/remove UA-YYYY-MM-DD-NNNNNN-x — видалити тендер',
  '/list — короткий список (id + Замовник)',
  '/info [UA-...] — детально (всі або один)',
  '',
  'Моніторинг замовників за EDRPOU:',
  '/watch EDRPOU — стежити за замовником',
  '/unwatch EDRPOU — припинити стежити',
  '/watched — список замовників',
].join('\n');
