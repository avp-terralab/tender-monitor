import { stripDkCode, truncate, fmtStatus, fmtDeadline, escapeHtml, formatMoney, formatPhone, abbreviateLegalForm, plural } from './telegram.mjs';
export { abbreviateLegalForm };

const TENDER_ID_RE_STR = 'UA-\\d{4}-\\d{2}-\\d{2}-\\d{6}-[a-zA-Z]';
const EDRPOU_RE = /^\d{8}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/i;
const NUMERIC_RE = /^\d+$/;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_ROLES = new Set(['editor', 'viewer']);

// Reply-keyboard button labels. Tapping a button sends its text as a normal
// message; parseCommand maps the exact label to the matching slash command.
// Keep labels in sync with MAIN_KEYBOARD below.
const BUTTON_ALIASES = {
  '📋 Моніторинг закупівель': 'info',
  '👁 Моніторинг замовників': 'watched',
  '📦 Архів закупівель': 'archive',
  '❓ Допомога (список команд)': 'help',
};

// Reply keyboard sent with each bot response to an allowed user. Telegram
// renders it persistently above the text input. Buttons with arguments
// (/add, /watch, /remove, /unwatch, /info UA-..., /archive UA-...,
// /unarchive UA-...) stay text-only since you can't put a tender_id on a
// button label.
export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📋 Моніторинг закупівель' }, { text: '👁 Моніторинг замовників' }],
    [{ text: '📦 Архів закупівель' }, { text: '❓ Допомога (список команд)' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export function parseCommand(text) {
  if (typeof text !== 'string') return { cmd: null };
  const trimmed = text.trim();
  if (trimmed === '') return { cmd: null };

  if (Object.prototype.hasOwnProperty.call(BUTTON_ALIASES, trimmed)) {
    return { cmd: BUTTON_ALIASES[trimmed] };
  }

  if (/^\/help(?:@\w+)?$/i.test(trimmed)) return { cmd: 'help' };
  if (/^\/status(?:@\w+)?$/i.test(trimmed)) return { cmd: 'status' };
  if (/^\/watched(?:@\w+)?$/i.test(trimmed)) return { cmd: 'watched' };
  if (/^\/whoami(?:@\w+)?$/i.test(trimmed)) return { cmd: 'whoami' };

  const logMatch = trimmed.match(/^\/log(?:@\w+)?(?:\s+(\d+))?\s*$/i);
  if (logMatch) {
    const n = logMatch[1] ? parseInt(logMatch[1], 10) : 20;
    return { cmd: 'log', limit: Math.min(Math.max(n, 1), 50) };
  }

  const notifyMatch = trimmed.match(/^\/notify(?:@\w+)?(?:\s+(\S+))?\s*$/i);
  if (notifyMatch) {
    const arg = (notifyMatch[1] || '').toLowerCase();
    if (!arg) return { cmd: 'notify' };
    if (arg === 'on') return { cmd: 'notify', action: 'on' };
    if (arg === 'off') return { cmd: 'notify', action: 'off' };
    return { cmd: 'notify', error: 'invalid_arg' };
  }

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

  const archiveMatch = trimmed.match(/^\/archive(?:@\w+)?(?:\s+(.+))?$/i);
  if (archiveMatch) {
    const args = (archiveMatch[1] || '').trim();
    if (!args) return { cmd: 'archive' };
    const idMatch = args.match(new RegExp(`^(${TENDER_ID_RE_STR})$`));
    if (!idMatch) return { cmd: 'unknown' };
    const id = idMatch[1].slice(0, -1) + idMatch[1].slice(-1).toLowerCase();
    return { cmd: 'archive', tender_id: id };
  }

  const unarchiveMatch = trimmed.match(/^\/unarchive(?:@\w+)?(?:\s+(.+))?$/i);
  if (unarchiveMatch) {
    const args = (unarchiveMatch[1] || '').trim();
    if (!args) return { cmd: 'unarchive', error: 'missing_id' };
    const idMatch = args.match(new RegExp(`^(${TENDER_ID_RE_STR})$`));
    if (!idMatch) return { cmd: 'unarchive', error: 'invalid_id' };
    const id = idMatch[1].slice(0, -1) + idMatch[1].slice(-1).toLowerCase();
    return { cmd: 'unarchive', tender_id: id };
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
    const args = (inviteMatch[1] || '').trim();
    if (!args) return { cmd: 'invite', error: 'missing_role' };
    const parts = args.split(/\s+/);
    const role = parts[0].toLowerCase();
    if (!VALID_ROLES.has(role)) {
      return { cmd: 'invite', error: 'invalid_role' };
    }
    const label = parts.slice(1).join(' ').trim();
    if (!label) return { cmd: 'invite', error: 'missing_label' };
    return { cmd: 'invite', role, label };
  }

  const roleMatch = trimmed.match(/^\/role(?:@\w+)?(?:\s+(.+))?$/i);
  if (roleMatch) {
    const args = (roleMatch[1] || '').trim();
    if (!args) return { cmd: 'role', error: 'missing_args' };
    const parts = args.split(/\s+/);
    const role = parts[0].toLowerCase();
    if (!VALID_ROLES.has(role)) {
      return { cmd: 'role', error: 'invalid_role' };
    }
    const chat_id = parts[1];
    if (!chat_id) return { cmd: 'role', error: 'missing_chat_id' };
    if (!NUMERIC_RE.test(chat_id)) return { cmd: 'role', error: 'invalid_chat_id' };
    return { cmd: 'role', role, chat_id };
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

// ── Audit log ────────────────────────────────────────────────────────────
// Mutating actions are recorded by enriching the commit message that already
// accompanies each state write. Format (parseable first line):
//   audit: <action> <target> · <actor> [<chatId>/<role>]

export function sanitizeActor(name) {
  return String(name ?? '')
    .replace(/[\r\n·\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '?';
}

// `target` must not contain " · " — that token delimits actor in the commit line.
// The only free-text target (the /invite label) is sanitized by the caller before
// being passed here. Validated targets (tender_id, edrpou, chat_id) are safe.
export function formatAuditMessage({ action, target, actor, chatId, role }) {
  const t = target ? ` ${target}` : '';
  return `audit: ${action}${t} · ${sanitizeActor(actor)} [${chatId}/${role}]`;
}

export function parseAuditCommit(message) {
  const line = String(message ?? '').split('\n')[0];
  const m = line.match(/^audit:\s+(\S+)(?:\s+(.+?))?\s+·\s+(.+?)\s+\[([^\/\]]+)\/([^\]]+)\]\s*$/);
  if (!m) return null;
  return { action: m[1], target: m[2] ?? null, actor: m[3], chatId: m[4], role: m[5] };
}

function auditPhrase(e) {
  const tgt = escapeHtml(e.target ?? '');
  switch (e.action) {
    case 'add':       return `додав ${tgt}`;
    case 'remove':    return `видалив ${tgt}`;
    case 'watch':     return `почав стеження за ${tgt}`;
    case 'unwatch':   return `прибрав стеження за ${tgt}`;
    case 'unarchive': return `повернув з архіву ${tgt}`;
    case 'revoke':    return `прибрав доступ ${tgt}`;
    case 'invite': {
      const raw = e.target ?? '';
      const [role, ...rest] = raw.split(':');
      const label = escapeHtml(rest.join(':'));
      return `видав invite (${role}: ${label})`;
    }
    default:
      if (e.action.startsWith('role→')) {
        return `змінив роль ${tgt} → ${e.action.slice('role→'.length)}`;
      }
      return `${e.action} ${tgt}`.trim();
  }
}

export function formatAuditLog(entries, { limit }) {
  if (!entries || entries.length === 0) {
    return '📋 Журнал порожній — поки немає зафіксованих дій.';
  }
  const shown = entries.slice(0, limit);
  const lines = shown.map(e => {
    const when = e.date ? KYIV_DT_FMT.format(new Date(e.date)) : '??';
    return `• ${when} — ${escapeHtml(e.actor)} ${auditPhrase(e)}`;
  });
  return `📋 Журнал дій (останні ${shown.length})\n\n` + lines.join('\n');
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
    lines.push(`ℹ️ Статус: ${fmtStatus(snapshot.status)}`);
    const deadline = snapshot.tenderPeriod?.endDate;
    if (snapshot.status === 'active.tendering' && deadline) {
      lines.push(`⏰ Подача пропозиції до: ${fmtDeadline(deadline)}`);
    }
  }
  lines.push('Перший snapshot — на наступному monitor-тіку (09/12/15/18 Київ).');
  return lines.join('\n');
}

// Legal-form abbreviations for Ukrainian entity names. Order matters —
// longer phrases must be matched before their shorter prefixes.
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
    sections.push(`ℹ️ Статус: ${fmtStatus(g.status)}`);
    // Submission deadline is only meaningful while bidders can still submit
    // (active.tendering). For other statuses tenderPeriod.endDate is in the past.
    if (g.status === 'active.tendering' && g.deadline) {
      sections.push(`⏰ Подача пропозиції до: ${fmtDeadline(g.deadline)}`);
    }
    if (g.status === 'active.qualification' && Array.isArray(g.awards)) {
      const pending = g.awards.filter(a => a.status === 'pending');
      const suppliers = pending
        .map(a => a.suppliers?.[0])
        .filter(s => s?.name);
      if (suppliers.length === 1) {
        const s = suppliers[0];
        const name = abbreviateLegalForm(s.name);
        const edrpou = s.identifier?.id ? ` (ЄДРПОУ ${s.identifier.id})` : '';
        sections.push(`👤 Учасник: ${escapeHtml(name)}${edrpou}`);
      } else if (suppliers.length > 1) {
        const lines = ['👤 Учасники:'];
        for (const s of suppliers) {
          const name = abbreviateLegalForm(s.name);
          const edrpou = s.identifier?.id ? ` (ЄДРПОУ ${s.identifier.id})` : '';
          lines.push(`  • ${escapeHtml(name)}${edrpou}`);
        }
        sections.push(lines.join('\n'));
      }
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
  const lines = [`📋 Статус тендерів (${time}, ${date})`];
  for (let i = 0; i < groups.length; i++) {
    lines.push('');
    lines.push(`━━━━━━━━━━ ${i + 1} ━━━━━━━━━━`);
    lines.push(formatInfoEntry(groups[i], runIso));
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

const INFO_TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});
const INFO_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric',
});

// Procurement-phase pages for /info, in lifecycle order. Any status not listed
// here falls into the OTHER_PHASE bucket so nothing is silently dropped.
const PHASES = [
  { emoji: '📥', label: 'Приймання пропозицій',           statuses: ['active.tendering'] },
  { emoji: '🧮', label: 'Прекваліфікація',                statuses: ['active.pre-qualification', 'active.pre-qualification.stand-still'] },
  { emoji: '🔨', label: 'Триває аукціон',                 statuses: ['active.auction'] },
  { emoji: '🔍', label: 'Розгляд пропозицій',             statuses: ['active.qualification'] },
  { emoji: '✍️', label: 'Очікування підписання договору', statuses: ['active.awarded'] },
];
const OTHER_PHASE = { emoji: '📦', label: 'Інші статуси', statuses: [] };

// deadline is a valid ISO string when non-null (validated upstream in monitor.mjs);
// null sorts last via +Infinity.
function deadlineKey(g) {
  return g.deadline ? new Date(g.deadline).getTime() : Number.POSITIVE_INFINITY;
}

// Groups for the all-tenders /info view into one page (message) per non-empty
// phase, in lifecycle order, plus an optional final errors page. The global
// header is prepended to the first page only. Returns string[].
export function formatInfoPages({ runIso, groups, errors = [] }) {
  if (groups.length === 0 && errors.length === 0) {
    return ['📭 Немає активних тендерів.'];
  }

  const known = new Set(PHASES.flatMap(p => p.statuses));
  const buckets = PHASES.map(p => ({ ...p, items: groups.filter(g => p.statuses.includes(g.status)) }));
  const otherItems = groups.filter(g => !known.has(g.status));
  if (otherItems.length > 0) buckets.push({ ...OTHER_PHASE, items: otherItems });

  for (const b of buckets) {
    if (b.statuses.includes('active.tendering')) {
      b.items.sort((a, c) => deadlineKey(a) - deadlineKey(c));
    } else {
      b.items.sort((a, c) => a.tender_id.localeCompare(c.tender_id));
    }
  }

  const pages = [];
  for (const b of buckets) {
    if (b.items.length === 0) continue;
    const lines = [`${b.emoji} ${b.label} (${b.items.length})`];
    b.items.forEach((g, i) => {
      lines.push('');
      lines.push(`━━━━━━━━━━ ${i + 1} ━━━━━━━━━━`);
      lines.push(formatInfoEntry(g, runIso));
    });
    pages.push(lines.join('\n'));
  }

  if (errors.length > 0) {
    const lines = [`⚠️ Не вдалось перевірити (${errors.length})`];
    for (const e of errors) lines.push(`  • ${e.tender_id} — ${e.error}`);
    pages.push(lines.join('\n'));
  }

  const header = `📋 Статус тендерів (${INFO_TIME_FMT.format(new Date(runIso))}, ${INFO_DATE_FMT.format(new Date(runIso))})`;
  pages[0] = `${header}\n\n${pages[0]}`;
  return pages;
}

const KYIV_HM_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});

const _KYIV_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit',
});
const _KYIV_TIME_FMT2 = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
});
const KYIV_DT_FMT = {
  format: (d) => `${_KYIV_DATE_FMT.format(d)} ${_KYIV_TIME_FMT2.format(d)}`,
};

export function handleStatus({ watchlist, sha, users, invites, lastCommit, now, rich }) {
  const active = watchlist.filter(r => r.enabled).length;
  const lines = ['🟢 Worker live'];

  lines.push(`📋 Watchlist: ${watchlist.length} тендерів (${active} активних)`);

  // Admin-only breakdown line directly below watchlist count
  if (rich && rich.watchlistBreakdown) {
    const { activeIntake, waiting } = rich.watchlistBreakdown;
    if (activeIntake > 0 || waiting > 0) {
      lines.push(`   ↳ ${activeIntake} в прийомі / ${waiting} очікують`);
    }
  }

  if (users) {
    const optedIn = users.filter(u => u.notifications === true).length;
    lines.push(`👥 Користувачі: ${users.length + 1} (admin + ${users.length}; opted-in на сповіщення: ${optedIn})`);
  }
  if (invites) {
    const nowDate = (now ?? (() => new Date()))();
    const activeInvites = invites.filter(i => i.status === 'pending' && new Date(i.expires_at) > nowDate).length;
    lines.push(`🎟 Активних invite-посилань: ${activeInvites}`);
  }
  if (lastCommit && lastCommit.date) {
    // Last monitor tick = last commit on main (state commits from github-actions[bot])
    const ageMin = Math.round((Date.now() - new Date(lastCommit.date).getTime()) / 60000);
    const ageStr = ageMin < 60 ? `${ageMin} хв тому`
      : ageMin < 1440 ? `${Math.round(ageMin / 60)} год тому`
      : `${Math.round(ageMin / 1440)} дн тому`;
    lines.push(`⏱ Останній tick: ${ageStr} (${lastCommit.sha})`);
  }

  // Admin-only rich rows — inserted before "✅ GitHub auth:"
  if (rich) {
    lines.push(`📦 Архівованих: ${rich.archiveCount ?? 0}`);
    lines.push(`🏢 Замовників у entity-watch: ${rich.watchedEntitiesCount ?? 0}`);

    // Pending digest / night buffer
    const pd = rich.pendingDigest;
    if (!pd || pd.itemCount === 0) {
      lines.push('🌙 Нічний буфер: порожній');
    } else {
      let bufLine = `🌙 Нічний буфер: ${pd.itemCount} тендерів`;
      if (pd.oldestEventAt) {
        const timeStr = KYIV_HM_FMT.format(new Date(pd.oldestEventAt));
        bufLine += `, найстаріша подія ${timeStr}`;
      }
      lines.push(bufLine);
    }

    // Latest deploy commit (omit row if null)
    if (rich.latestDeploy) {
      const { sha: dSha, message: dMsg } = rich.latestDeploy;
      const truncated = dMsg.length > 50 ? dMsg.slice(0, 50) + '…' : dMsg;
      lines.push(`🚀 Деплой: ${dSha} · ${truncated}`);
    }
  }

  lines.push(`✅ GitHub auth: OK (sha ${sha.slice(0, 7)})`);

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
    return '📭 Не стежу за жодним замовником. Додай: /watch [ЄДРПОУ]';
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
  const archive = deps.archive ?? [];
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const existing = watchlist.find(r => r.tender_id === tender_id);

  if (existing?.enabled) {
    return {
      reply: `⚠️ Вже моніторю ${tender_id}`,
      mutation: null,
    };
  }

  const archived = archive.find(a => a.tender_id === tender_id);
  if (archived) {
    return {
      reply: `⚠️ ${tender_id} в архіві (${archived.final_status}). Спочатку /unarchive ${tender_id} щоб видалити з архіву, потім /add знову.`,
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
      reply: `⚠️ Не зміг перевірити ЄДРПОУ: ${err.message}. Спробуй ще раз.`,
      mutation: null,
    };
  }

  // Name fallback: when the descending feed walk found no tender for this ЄДРПОУ
  // (rare publisher, or no publication in the last ~1000 fresh tenders), try the
  // BFF text-search endpoint — it can pull the legalName from historical tenders
  // anywhere in Prozorro. Soft enrichment: failure leaves name as "(unknown)".
  if (entityName === '(unknown)' && deps.searchTenderByEdrpou) {
    try {
      const { name } = await deps.searchTenderByEdrpou(edrpou);
      if (name) entityName = name;
    } catch {
      // ignore — keep "(unknown)"
    }
  }

  const newRow = {
    edrpou,
    name: entityName,
    enabled: true,
    added_at: new Date().toISOString(),
  };
  const reply = entityName === '(unknown)'
    ? `✅ ${edrpou} збережено. Серед ~1000 останніх публікацій Prozorro тендерів від цього замовника не виявлено — нормально, якщо замовник публікує рідко. Назва замовника зʼявиться у /watched коли bot знайде його перший новий тендер. Якщо ЄДРПОУ помилковий — /unwatch ${edrpou}.`
    : `✅ Стежу за ${edrpou} — ${escapeHtml(abbreviateLegalForm(entityName))}\nПомічено як уже-побачені: ${bootstrapIds.length} активних тендерів. Алерт буде на нові.`;
  return {
    reply,
    mutation: { type: 'append', row: newRow, bootstrap: { edrpou, ids: bootstrapIds } },
  };
}

export function handleInvite(deps, { role, label }) {
  const token = deps.generateToken();
  const now = deps.now();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const row = {
    token,
    label,
    role,
    created_at: createdAt,
    expires_at: expiresAt,
    status: 'pending',
    redeemed_by: null,
    redeemed_at: null,
  };
  const link = `https://t.me/${deps.botUsername}?start=${token}`;
  const reply = `🔗 Invite для <b>${escapeHtml(label)}</b> (${role})\n\n${link}\n\nПерешли цій людині. Дійсне 24 години.`;
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
  if (mutation.type === 'set_role') {
    return users.map(u =>
      u.chat_id === mutation.chat_id ? { ...u, role: mutation.role } : u
    );
  }
  if (mutation.type === 'set_notifications') {
    return users.map(u =>
      u.chat_id === mutation.chat_id ? { ...u, notifications: mutation.value } : u
    );
  }
  return users;
}

export function applyArchiveMutation(archive, mutation) {
  if (mutation.type === 'append_archive') {
    if (archive.some(a => a.tender_id === mutation.row.tender_id)) return archive;
    return [...archive, mutation.row];
  }
  if (mutation.type === 'remove_archive') {
    return archive.filter(a => a.tender_id !== mutation.tender_id);
  }
  return archive;
}

const ARCHIVE_ICONS = {
  complete: '✅',
  cancelled: '⊘',
  unsuccessful: '❌',
};

function fmtArchivedDate(iso) {
  const d = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return '';
  return `${d[3]}.${d[2]}.${d[1]}`;
}

// Find first signed-contract download URL in a frozen archive entry.
// Skips documentType === 'notice' (those are КЕП-signature .p7s, not the contract PDF).
function findContractDocUrl(entry) {
  for (const c of entry.final_snapshot?.contracts ?? []) {
    for (const d of c.documents ?? []) {
      if (!d.url) continue;
      if (d.documentType === 'notice') continue;
      return d.url;
    }
  }
  return null;
}

// Service provider = supplier on the winning award (status === 'active').
// Disqualified ('unsuccessful') and 'cancelled' awards are ignored.
function findServiceProvider(entry) {
  const active = (entry.final_snapshot?.awards ?? []).find(a => a.status === 'active');
  const s = active?.suppliers?.[0];
  if (!s?.name) return null;
  return { name: s.name, edrpou: s.identifier?.id ?? null };
}

function renderArchiveItem(a, localIndex) {
  const icon = ARCHIVE_ICONS[a.final_status] ?? '📦';
  const customerRaw = a.final_snapshot?.procuringEntity?.name ?? '';
  const customerEdrpou = a.final_snapshot?.procuringEntity?.edrpou ?? null;
  const edrpouSuffix = customerEdrpou ? ` (ЄДРПОУ ${customerEdrpou})` : '';
  const customer = customerRaw
    ? ` — ${escapeHtml(truncate(abbreviateLegalForm(customerRaw), 100))}${edrpouSuffix}`
    : '';
  let value = '';
  if (a.final_snapshot?.value?.amount != null) {
    const amt = formatMoney(a.final_snapshot.value.amount);
    value = ` — ${amt} ${a.final_snapshot.value.currency}`;
  }
  const dateSuffix = a.archived_at ? ` (${fmtArchivedDate(a.archived_at)})` : '';
  const tenderUrl = `https://prozorro.gov.ua/tender/${a.tender_id}`;
  const idLink = `<a href="${escapeHtml(tenderUrl)}">${escapeHtml(a.tender_id)}</a>`;
  const mainLine = `${localIndex + 1}. ${icon} ${idLink}${customer}${value}${dateSuffix}`;
  const docUrl = findContractDocUrl(a);
  if (!docUrl) return mainLine;
  return `${mainLine}\n📄 <a href="${escapeHtml(docUrl)}">Завантажити договір</a>`;
}

export function handleArchive({ archive }) {
  if (!archive || archive.length === 0) {
    return '📭 Архів порожній.';
  }
  // Group by service provider EDRPOU; entries without an active award land
  // in a synthetic "Без укладеного договору" group rendered last.
  const NO_PROVIDER = '__no_provider__';
  const groups = new Map();
  for (const a of archive) {
    const sp = findServiceProvider(a);
    const key = sp?.edrpou ?? (sp?.name ? `name:${sp.name}` : NO_PROVIDER);
    if (!groups.has(key)) {
      groups.set(key, { provider: sp, entries: [] });
    }
    groups.get(key).entries.push(a);
  }
  // Sort entries within each group by archived_at desc, then sort groups by
  // their max archived_at desc (newest contract first). The synthetic
  // "no provider" group always renders last.
  const groupList = [...groups.values()].map(g => {
    g.entries.sort((x, y) => (y.archived_at ?? '').localeCompare(x.archived_at ?? ''));
    g.maxArchivedAt = g.entries[0]?.archived_at ?? '';
    return g;
  });
  groupList.sort((a, b) => {
    if (!a.provider && b.provider) return 1;
    if (a.provider && !b.provider) return -1;
    return (b.maxArchivedAt ?? '').localeCompare(a.maxArchivedAt ?? '');
  });

  const sections = [];
  for (const g of groupList) {
    const count = g.entries.length;
    const noun = plural(count, ['контракт', 'контракти', 'контрактів']);
    let header;
    if (g.provider) {
      const name = escapeHtml(abbreviateLegalForm(g.provider.name));
      const edrpou = g.provider.edrpou ? ` (ЄДРПОУ ${g.provider.edrpou})` : '';
      header = `👤 ${name}${edrpou} — ${count} ${noun}`;
    } else {
      header = `📦 Без укладеного договору — ${count} ${noun}`;
    }
    const body = g.entries.map((a, i) => renderArchiveItem(a, i)).join('\n\n');
    sections.push(`${header}\n\n${body}`);
  }
  return sections.join('\n\n') + `\n\nВсього в архіві: ${archive.length}`;
}

function formatContractsBlock(contracts) {
  if (!contracts || contracts.length === 0) return null;
  const lines = ['', '📄 Договір:'];
  for (const c of contracts) {
    for (const d of c.documents ?? []) {
      const title = escapeHtml(d.title ?? d.id ?? 'документ');
      if (d.url) {
        lines.push(`  • <a href="${escapeHtml(d.url)}">${title}</a>`);
      } else {
        lines.push(`  • ${title}`);
      }
    }
  }
  if (lines.length === 2) return null; // no docs across all contracts
  return lines.join('\n');
}

export const TERMINAL_STATUSES = new Set(['complete', 'cancelled', 'unsuccessful']);

// Prozorro tender response returns contract SUMMARY only — documents (signed PDF,
// КЕП) live at /contracts/{id}. Fetch each contract and replace its empty
// `documents` array with the real one. fetchContract failures are tolerated:
// the contract keeps its original (likely empty) documents and downstream
// formatContractsBlock returns null.
export async function hydrateContractDocs(contracts, fetchContract) {
  if (!fetchContract || !contracts) return;
  for (const c of contracts) {
    if (!c.id) continue;
    try {
      const full = await fetchContract(c.id);
      c.documents = full.documents ?? [];
    } catch (err) {
      console.error('fetchContract failed:', c.id, err.message);
    }
  }
}

export async function handleArchiveDetail(deps, { tender_id }) {
  const { archive, fetchTender, extractSnapshot, fetchContract } = deps;
  const entry = archive.find(a => a.tender_id === tender_id);
  if (!entry) return `❓ ${tender_id} не в архіві`;
  const snap = entry.final_snapshot ?? {};
  const url = `https://prozorro.gov.ua/tender/${tender_id}`;
  const lines = [];
  lines.push(`🆔 <a href="${escapeHtml(url)}">${escapeHtml(tender_id)}</a>`);
  if (snap.procuringEntity?.name) {
    const edrpou = snap.procuringEntity.edrpou ? ` (ЄДРПОУ ${snap.procuringEntity.edrpou})` : '';
    lines.push(`👥 Замовник: ${escapeHtml(abbreviateLegalForm(snap.procuringEntity.name))}${edrpou}`);
  }
  if (snap.classification?.id) {
    const desc = snap.classification.description ? ` — ${escapeHtml(snap.classification.description)}` : '';
    lines.push(`🔖 ДК: ${snap.classification.id}${desc}`);
  }
  if (snap.value?.amount != null) {
    const amt = formatMoney(snap.value.amount);
    const vatTag = snap.value.valueAddedTaxIncluded ? 'з ПДВ' : 'без ПДВ';
    lines.push(`💰 Вартість: ${amt} ${snap.value.currency} (${vatTag})`);
  }
  if (snap.contact?.name) {
    const tel = formatPhone(snap.contact.telephone ?? '');
    lines.push(`📞 ${escapeHtml(snap.contact.name)}: ${escapeHtml(tel)}`);
    if (snap.contact.email) lines.push(`✉️ ${escapeHtml(snap.contact.email)}`);
  }
  lines.push(`ℹ️ Статус: ${fmtStatus(entry.final_status)}`);
  lines.push(`📦 Архівовано: ${fmtArchivedDate(entry.archived_at)}`);
  // Fresh contract fetch — only meaningful for complete tenders.
  if (entry.final_status === 'complete') {
    try {
      const raw = await fetchTender(tender_id);
      const fresh = extractSnapshot(raw);
      await hydrateContractDocs(fresh.contracts, fetchContract);
      const block = formatContractsBlock(fresh.contracts);
      if (block) lines.push(block);
    } catch (err) {
      lines.push('');
      lines.push(`⚠️ Не вдалось отримати свіжі дані договору: ${escapeHtml(err.message)}`);
    }
  }
  return lines.join('\n');
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
      reply: '❌ Посилання застаріло (>24 години)',
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
        role: invite.role ?? 'viewer',
        notifications: false,
        added_at: nowIso,
      },
    },
    reply: buildWelcomeText(invite.label, invite.role ?? 'viewer'),
    adminNotice: `🆕 <b>${escapeHtml(invite.label)}</b> приєднався (chat_id: <code>${chatId}</code>)`,
  };
}

export function handleUsersList({ allowedUsers, adminChatId }) {
  const lines = [`👥 Користувачі бота:`, ''];
  lines.push(`1. 👑 <code>${adminChatId}</code> — admin`);
  allowedUsers.forEach((u, i) => {
    const role = u.role ?? 'viewer';
    lines.push(`${i + 2}. ${roleIcon(role)} <code>${u.chat_id}</code> — ${escapeHtml(u.label)} — ${role}`);
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
    const role = inv.role ?? 'viewer';
    lines.push(`${i + 1}. ${roleIcon(role)} <b>${escapeHtml(inv.label)}</b> — ${role} — …${suffix} (до ${exp})`);
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

// Role-state indicator: editor (can write) → ✏️, viewer (read-only) → 📄.
// The icons reflect the role's capability metaphorically (pencil = editing,
// document = reading).
export function roleIcon(role) {
  return role === 'editor' ? '✏️' : '📄';
}

export function handleRole({ allowedUsers, adminChatId }, { role, chat_id }) {
  if (chat_id === adminChatId) {
    return { reply: '🚫 Не можна змінити роль адміна', mutation: null };
  }
  const user = allowedUsers.find(u => u.chat_id === chat_id);
  if (!user) {
    return {
      reply: `❓ Користувача <code>${chat_id}</code> не знайдено. /users — список`,
      mutation: null,
    };
  }
  const currentRole = user.role ?? 'viewer';
  if (currentRole === role) {
    return {
      reply: `ℹ️ <b>${escapeHtml(user.label)}</b> вже ${roleIcon(role)} ${role}`,
      mutation: null,
    };
  }
  return {
    reply: `${roleIcon(role)} <b>${escapeHtml(user.label)}</b> (<code>${chat_id}</code>) → ${role}`,
    mutation: { type: 'set_role', chat_id, role },
  };
}

// Single state-button representation. The button label IS the state; tapping
// it toggles. Used by both /notify show-state and the inline callback after
// the toggle write succeeds, so the rendered keyboard stays consistent.
export function buildNotifyButton(isOn) {
  return {
    inline_keyboard: [[{
      text: isOn ? '✅ Сповіщення: УВІМКНЕНО' : '❌ Сповіщення: ВИМКНЕНО',
      callback_data: isOn ? 'notify:off' : 'notify:on',
    }]],
  };
}

// Per-user opt-in for monitor digest broadcasts. Admin (env-based) is always on.
// `action` is 'on' | 'off' | undefined (show state-button UX).
export function handleNotify({ allowedUsers, adminChatId, chatId }, { action }) {
  // Admin always receives — toggle is a no-op for them.
  if (chatId === adminChatId) {
    return {
      reply: '🔔 Сповіщення: <b>увімкнено</b> (адмін, завжди отримує)',
      mutation: null,
      replyMarkup: null,
    };
  }
  const user = allowedUsers.find(u => u.chat_id === chatId);
  if (!user) {
    // Should never reach here — gated by isAllowed at the worker level.
    return { reply: '❓ Не знайдено в allowlist', mutation: null, replyMarkup: null };
  }
  const current = user.notifications === true;

  if (action === undefined) {
    // Show current state as a self-explanatory toggle button. Minimal body
    // text — the button's label conveys both state and tappable affordance.
    return {
      reply: '🛎 <b>Сповіщення про зміни в тендерах</b>',
      mutation: null,
      replyMarkup: buildNotifyButton(current),
    };
  }

  const desired = action === 'on';
  if (current === desired) {
    const prefix = desired ? '🔔' : '❌';
    return {
      reply: `${prefix} Сповіщення вже ${desired ? 'увімкнено' : 'вимкнено'}`,
      mutation: null,
      replyMarkup: null,
    };
  }
  return {
    reply: desired
      ? '✅ Сповіщення увімкнено. Наступний дайджест отримаєш.'
      : '✅ Сповіщення вимкнено. Дайджести більше не приходитимуть.',
    mutation: { type: 'set_notifications', chat_id: chatId, value: desired },
    replyMarkup: null,
  };
}

// Self-service "who am I" reply. Shows chat_id, label (if known), role,
// and current notifications preference. Useful before asking admin for
// changes or troubleshooting access.
export function handleWhoami({ allowedUsers, adminChatId, chatId }) {
  if (chatId === adminChatId) {
    return [
      `👤 <b>Admin</b>`,
      `🆔 chat_id: <code>${chatId}</code>`,
      `👑 Роль: admin`,
      `🔔 Сповіщення: завжди увімкнено`,
    ].join('\n');
  }
  const user = allowedUsers.find(u => u.chat_id === chatId);
  if (!user) {
    return [
      `👤 <b>Гість</b>`,
      `🆔 chat_id: <code>${chatId}</code>`,
      `❓ Немає доступу. Звернись до адміна.`,
    ].join('\n');
  }
  const role = user.role ?? 'viewer';
  const notifyOn = user.notifications === true;
  return [
    `👤 <b>${escapeHtml(user.label)}</b>`,
    `🆔 chat_id: <code>${chatId}</code>`,
    `${roleIcon(role)} Роль: ${role}`,
    `${notifyOn ? '✅' : '❌'} Сповіщення: ${notifyOn ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}`,
  ].join('\n');
}

export function handleUnarchive({ archive }, { tender_id }) {
  const entry = archive.find(a => a.tender_id === tender_id);
  if (!entry) {
    return {
      reply: `❓ ${tender_id} не в архіві`,
      archiveMutation: null,
    };
  }
  return {
    reply: `✅ ${tender_id} видалено з архіву`,
    archiveMutation: { type: 'remove_archive', tender_id },
  };
}

const HELP_GENERAL = [
  'Загальні команди:',
  '/help — список команд',
  '/whoami — твоя роль і стан сповіщень',
  '/notify — увімкнути/вимкнути сповіщення про зміни у тендерах',
].join('\n');

const HELP_VIEW_TENDERS = [
  'Моніторинг закупівель за ID:',
  '/info [UA-...] — список усіх або деталі одного тендера',
];

const HELP_VIEW_ENTITIES = [
  'Моніторинг замовників за ЄДРПОУ:',
  '/watched — список замовників',
];

const HELP_VIEW_ARCHIVE = [
  'Архів завершених закупівель:',
  '/archive [UA-...] — список архіву або деталі одного тендера',
];

const HELP_EDIT_TENDERS = [
  '/add UA-YYYY-MM-DD-NNNNNN-x — додати тендер',
  '/remove UA-YYYY-MM-DD-NNNNNN-x — видалити тендер',
];

const HELP_EDIT_ENTITIES = [
  '/watch ЄДРПОУ — стежити за замовником',
  '/unwatch ЄДРПОУ — припинити стежити',
];

const HELP_EDIT_ARCHIVE = [
  '/unarchive [UA-...] — видалити з архіву',
];

const HELP_ADMIN = [
  'Адмін-команди:',
  '/status — здоровʼя бота (розширена статистика для адміна)',
  '/invite [editor|viewer] [імʼя] — створити invite-посилання',
  '/role [editor|viewer] [chat_id] — змінити роль користувача',
  '/invites — активні invite-посилання',
  '/users — список користувачів',
  '/revoke [chat_id] — видалити користувача',
].join('\n');

export function buildHelpText(role) {
  const parts = [HELP_GENERAL];

  const tenders = [...HELP_VIEW_TENDERS];
  if (role === 'editor' || role === 'admin') {
    // Insert edit lines before the view line so order reads: add, remove, info
    tenders.splice(1, 0, ...HELP_EDIT_TENDERS);
  }
  parts.push(tenders.join('\n'));

  const entities = [...HELP_VIEW_ENTITIES];
  if (role === 'editor' || role === 'admin') {
    entities.splice(1, 0, ...HELP_EDIT_ENTITIES);
  }
  parts.push(entities.join('\n'));

  const archive = [...HELP_VIEW_ARCHIVE];
  if (role === 'editor' || role === 'admin') {
    archive.push(...HELP_EDIT_ARCHIVE);
  }
  parts.push(archive.join('\n'));

  if (role === 'admin') parts.push(HELP_ADMIN);

  return parts.join('\n\n');
}

export const HELP_TEXT = buildHelpText('admin');

// Notice sent to a user when admin changes their role via /role.
// Tells them the new role and lists their role-appropriate commands.
export function buildRoleChangeNotice(role) {
  const roleLabel = role === 'editor' ? 'editor (редактор — можеш додавати/змінювати/видаляти)'
    : 'viewer (тільки перегляд)';
  return [
    `${roleIcon(role)} Адмін змінив твою роль: <b>${roleLabel}</b>`,
    '',
    '📋 <b>Доступні тобі команди:</b>',
    '',
    buildHelpText(role),
  ].join('\n');
}

// Composed greeting shown to a user immediately after they redeem an invite via
// /start <token>. Includes bot purpose, the user's resolved role, an /notify
// reminder (default OFF), and the role-filtered help text.
export function buildWelcomeText(label, role) {
  const roleLabel = role === 'editor' ? 'editor (редактор)'
    : role === 'admin' ? 'admin'
    : 'viewer (перегляд)';
  return [
    `✅ Доступ надано: <b>${escapeHtml(label)}</b> (роль: ${roleLabel})`,
    '',
    '👋 Вітаю у боті моніторингу тендерів TerraLab!',
    '',
    'ℹ️ Я стежу за вказаними закупівлями на Prozorro і повідомляю про важливі зміни: дедлайн подачі, нові питання та відповіді, призначення аукціону, переможців, підписання договорів. Також відстежую нові тендери від конкретних замовників за ЄДРПОУ.',
    '',
    '🔔 <b>Сповіщення</b> наразі вимкнені (за замовчуванням). Щоб отримувати дайджест — надішли /notify і натисни кнопку увімкнення.',
    '',
    '📋 <b>Твої команди:</b>',
    '',
    buildHelpText(role),
  ].join('\n');
}

const VIEW_COMMANDS = [
  { command: 'help',    description: 'Список команд' },
  { command: 'whoami',  description: 'Твоя роль і стан сповіщень' },
  { command: 'notify',  description: 'Увімкнути/вимкнути сповіщення' },
  { command: 'info',    description: 'Список або деталі тендерів' },
  { command: 'watched', description: 'Список замовників' },
  { command: 'archive', description: 'Архів завершених закупівель' },
];
const EDIT_COMMANDS = [
  { command: 'add',       description: 'Додати тендер у моніторинг' },
  { command: 'remove',    description: 'Видалити тендер' },
  { command: 'watch',     description: 'Стежити за замовником (ЄДРПОУ)' },
  { command: 'unwatch',   description: 'Припинити стежити за замовником' },
  { command: 'unarchive', description: 'Видалити тендер з архіву' },
];
const ADMIN_COMMANDS = [
  { command: 'status',  description: 'Здоровʼя бота' },
  { command: 'invite',  description: 'Створити invite-посилання' },
  { command: 'role',    description: 'Змінити роль користувача' },
  { command: 'invites', description: 'Активні invite-посилання' },
  { command: 'users',   description: 'Список користувачів' },
  { command: 'revoke',  description: 'Видалити користувача' },
];

export const BOT_COMMANDS_BY_ROLE = {
  viewer: VIEW_COMMANDS,
  editor: [...VIEW_COMMANDS, ...EDIT_COMMANDS],
  admin:  [...VIEW_COMMANDS, ...EDIT_COMMANDS, ...ADMIN_COMMANDS],
};
