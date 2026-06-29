const ICONS = {
  monitoring_started: '🟢',
  deadline_changed: '📅',
  prequalification_started: '🔄',
  auction_scheduled: '🕐',
  auction_rescheduled: '🕐',
  auction_started: '⚡',
  qualification_started: '🔍',
  awarded_phase: '🏆',
  award_created: '👤',
  award_qualified: '🏆',
  award_disqualified: '❌',
  award_cancelled: '↩️',
  contract_created: '📜',
  contract_documents_added: '📎',
  contract_signed: '✍️',
  contract_terminated: '⛔',
  new_question: '❓',
  question_answered: '💬',
  td_amended: '📝',
  new_complaint: '⚖️',
  complaint_status_changed: '⚖️',
  cancellation_initiated: '⚠️',
  cancelled: '🛑',
  unsuccessful: '🛑',
  complete: '✅',
  status_changed: '🔄',
  new_tender_announced: '🆕',
  deadline_approaching: '⏰',
};

const STATUS_LABELS = {
  'draft': 'Чернетка',
  'active.tendering': 'Приймання пропозицій',
  'active.pre-qualification': 'Прекваліфікація',
  'active.pre-qualification.stand-still': 'Період оскарження прекваліфікації',
  'active.auction': 'Триває аукціон',
  'active.qualification': 'Розгляд пропозицій',
  'active.awarded': 'Очікування підписання договору',
  'complete': 'Завершено',
  'cancelled': 'Скасовано',
  'unsuccessful': 'Не відбулась',
};

const PROC_METHOD_LABELS = {
  aboveThreshold: 'Відкриті торги з особливостями',
  aboveThresholdUA: 'Відкриті торги (Україна)',
  aboveThresholdEU: 'Відкриті торги (ЄС)',
  belowThreshold: 'Спрощена закупівля',
  priceQuotation: 'Запит цінових пропозицій',
  reporting: 'Звіт про договір',
  negotiation: 'Переговорна процедура',
  'negotiation.quick': 'Переговорна (нагальна)',
  competitiveDialogueUA: 'Конкурентний діалог (Україна)',
  competitiveDialogueEU: 'Конкурентний діалог (ЄС)',
  closeFrameworkAgreementUA: 'Закрита рамкова угода',
  closeFrameworkAgreementSelectionUA: 'Вибірка з рамкової угоди',
  esco: 'ESCO',
  simple: 'Спрощена',
};

export const fmtStatus = (s) => STATUS_LABELS[s] ?? (s ?? '');

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatPhone(raw) {
  if (!raw) return '';
  return raw.split(',').map(p => {
    const digits = p.replace(/\D/g, '');
    if (digits.startsWith('380') && digits.length === 12) {
      return `+380 ${digits.slice(3, 5)} ${digits.slice(5, 8)}-${digits.slice(8, 10)}-${digits.slice(10, 12)}`;
    }
    return p.trim();
  }).join(', ');
}

export function truncate(s, max) {
  if (!s || s.length <= max) return s ?? '';
  return s.slice(0, max - 1) + '…';
}

export function stripDkCode(title) {
  if (!title) return '';
  // Covers ", код ДК ..." (canonical) and "за кодом ДК ..." / "за ДК ..." forms
  // that appear in many real Prozorro titles (e.g. "...за кодом ДК 021:2015 - 72260000-5 ...").
  return title
    .replace(/\s*[,;]?\s*за\s+кодом\s+ДК\s+.+$/i, '')
    .replace(/\s*[,;]?\s*за\s+ДК\s+.+$/i, '')
    .replace(/\s*[,;]\s*код\s+ДК\s+.+$/i, '')
    .trim();
}

// Note: JS regex \b is ASCII-only — use \s+ to require whitespace separator.
// Trailing separator after the form word: at least one whitespace OR a lookahead
// at an opening quote (Prozorro entries sometimes drop the space, e.g.
// "...ПІДПРИЄМСТВО\"ЛЮБОТИНСЬКА...\"" without a separator).
const _SEP = '(?:\\s+|(?=["«]))';
const LEGAL_FORM_ABBREVIATIONS = [
  // [іи] tolerates the "некомерцийне" typo seen in some Prozorro registry entries.
  // (підприємство|товариство): standard form is "підприємство", but registry has
  // entries like "Комунальне некомерцийне товариство" that are semantically КНП too.
  [new RegExp(`^Комунальне\\s+некомерц[іи]йне\\s+(?:підприємство|товариство)${_SEP}`, 'i'), 'КНП '],
  [new RegExp(`^Комунальне\\s+підприємство${_SEP}`, 'i'), 'КП '],
  [new RegExp(`^Комунальний\\s+заклад${_SEP}`, 'i'), 'КЗ '],
  [new RegExp(`^Комунальна\\s+установа${_SEP}`, 'i'), 'КУ '],
  [new RegExp(`^Товариство\\s+з\\s+обмеженою\\s+відповідальністю${_SEP}`, 'i'), 'ТОВ '],
  [new RegExp(`^Приватне\\s+акціонерне\\s+товариство${_SEP}`, 'i'), 'ПрАТ '],
  [new RegExp(`^Публічне\\s+акціонерне\\s+товариство${_SEP}`, 'i'), 'ПАТ '],
  [new RegExp(`^Акціонерне\\s+товариство${_SEP}`, 'i'), 'АТ '],
  [new RegExp(`^Державна\\s+некомерційна\\s+установа${_SEP}`, 'i'), 'ДНУ '],
  [new RegExp(`^Державне\\s+підприємство${_SEP}`, 'i'), 'ДП '],
  [new RegExp(`^Державна\\s+установа${_SEP}`, 'i'), 'ДУ '],
  [new RegExp(`^Приватне\\s+підприємство${_SEP}`, 'i'), 'ПП '],
  [new RegExp(`^Фізична\\s+особа[-\\s]+підприємець${_SEP}`, 'i'), 'ФОП '],
];

// Governance suffix -> abbreviation (longest first), applied AFTER the leading
// legal form: «… Одеської міської ради» -> «… Одеської МР».
const GOV_FORM_ABBREVIATIONS = [
  [/обласної\s+державної\s+адміністрації/i, 'ОДА'],
  [/міської\s+державної\s+адміністрації/i, 'МДА'],
  [/районної\s+державної\s+адміністрації/i, 'РДА'],
  [/обласної\s+ради/i, 'ОР'],
  [/міської\s+ради/i, 'МР'],
  [/районної\s+ради/i, 'РР'],
  [/сільської\s+ради/i, 'СР'],
  [/селищної\s+ради/i, 'СР'],
];

// Facility-type phrases ANYWHERE in the name (incl. inside a quoted core) ->
// abbreviation. Longest/most-specific first so e.g. «центральна міська лікарня»
// wins over «міська лікарня».
const FACILITY_ABBREVIATIONS = [
  [/територіальне\s+медичне\s+об['’ʼ]?єднання/i, 'ТМО'],
  [/центральна\s+міська\s+лікарня/i, 'ЦМЛ'],
  [/обласна\s+клінічна\s+лікарня/i, 'ОКЛ'],
  [/міська\s+клінічна\s+лікарня/i, 'МКЛ'],
  [/багатопрофільна\s+лікарня/i, 'БПЛ'],
  [/швидкої\s+медичної\s+допомоги/i, 'ШМД'],
  [/міська\s+лікарня/i, 'МЛ'],
];

export function abbreviateLegalForm(name) {
  if (!name) return name;
  // Trim first — leading-form regexes are anchored at ^ and Prozorro entries
  // sometimes have surrounding whitespace. Apply the leading legal form (first
  // match), then facility-type phrases and governance suffixes anywhere — so the
  // whole name shortens, e.g. «КНП «Львівське територіальне медичне об'єднання…»
  // … обласної ради» -> «КНП «Львівське ТМО…» … ОР».
  let s = name.trim();
  for (const [re, replacement] of LEGAL_FORM_ABBREVIATIONS) {
    if (re.test(s)) { s = s.replace(re, replacement); break; }
  }
  for (const [re, replacement] of FACILITY_ABBREVIATIONS) {
    s = s.replace(re, replacement);
  }
  for (const [re, replacement] of GOV_FORM_ABBREVIATIONS) {
    s = s.replace(re, replacement);
  }
  return s.replace(/\s+/g, ' ').trim();
}

function fmtDate(iso) {
  if (!iso) return '';
  // Full ISO timestamp: YYYY-MM-DDThh:mm → DD.MM.YYYY hh:mm
  const dt = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dt) return `${dt[3]}.${dt[2]}.${dt[1]} ${dt[4]}:${dt[5]}`;
  // Date only fallback: YYYY-MM-DD → DD.MM.YYYY
  const d = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (d) return `${d[3]}.${d[2]}.${d[1]}`;
  return iso;
}

export function fmtDeadline(iso) {
  if (!iso) return '';
  // Deadlines render as "DD.MM.YYYY до HH:MM" (час як крайній термін)
  const dt = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dt) return `${dt[3]}.${dt[2]}.${dt[1]} до ${dt[4]}:${dt[5]}`;
  const d = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (d) return `${d[3]}.${d[2]}.${d[1]}`;
  return iso;
}

export function plural(n, [one, few, many]) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function fmtTimeLeft(deadlineIso, nowIso) {
  if (!deadlineIso || !nowIso) return '';
  const ms = new Date(deadlineIso) - new Date(nowIso);
  const abs = Math.abs(ms);
  const totalHours = Math.floor(abs / 3600000);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  if (Math.abs(ms) < 60000) return 'закінчується зараз';
  if (ms < 0) return `минув на ${days} ${plural(days, ['день', 'дні', 'днів'])} (${totalHours} год тому)`;
  if (days > 0) return `${days} ${plural(days, ['день', 'дні', 'днів'])} ${hours} год (${totalHours} год)`;
  return `${hours} год`;
}

function fmtEvent(e) {
  const icon = ICONS[e.type] ?? '•';
  switch (e.type) {
    case 'monitoring_started':
      return `📎 Документів: ${e.docs_count ?? 0} · Питань: ${e.questions_count ?? 0} · Скарг: ${e.complaints_count ?? 0}`;
    case 'deadline_changed':
      return `${icon} Дедлайн перенесено: ${fmtDeadline(e.old)} → ${fmtDeadline(e.new)}`;
    case 'auction_scheduled':
      return `${icon} Аукціон призначено на ${fmtDate(e.new)}`;
    case 'auction_rescheduled':
      return `${icon} Аукціон перенесено: ${fmtDate(e.old)} → ${fmtDate(e.new)}`;
    case 'auction_started':
      return `${icon} Аукціон розпочався`;
    case 'qualification_started':
      return `${icon} Замовник почав розгляд пропозицій`;
    case 'prequalification_started':
      return `${icon} Розпочалась прекваліфікація`;
    case 'awarded_phase':
      return `${icon} Етап визначення переможця`;
    case 'award_created':
      return `${icon} Розгляд учасника: ${escapeHtml(e.supplier_name)} (ЄДРПОУ ${escapeHtml(e.supplier_edrpou) ?? '—'})`;
    case 'award_qualified':
      return `${icon} Учасника визнано переможцем\n     ↳ ${escapeHtml(e.supplier_name)} (ЄДРПОУ ${escapeHtml(e.supplier_edrpou) ?? '—'})`;
    case 'award_disqualified':
      return `${icon} Учасника відхилено: ${escapeHtml(e.supplier_name)} (ЄДРПОУ ${escapeHtml(e.supplier_edrpou) ?? '—'})`;
    case 'award_cancelled':
      return `${icon} Рішення щодо учасника скасовано: ${escapeHtml(e.supplier_name)}`;
    case 'contract_created':
      return `${icon} Створено запис договору`;
    case 'contract_documents_added':
      return `${icon} Замовник додав документи договору (${e.count})`;
    case 'contract_signed':
      return `${icon} Договір підписано`;
    case 'contract_terminated':
      return `${icon} Договір розірвано`;
    case 'new_question':
      return `${icon} Нове питання: «${escapeHtml(e.title)}»`;
    case 'question_answered':
      return `${icon} Відповідь на питання: «${escapeHtml(e.title)}»\n     ↳ ${escapeHtml(e.answer)}`;
    case 'td_amended':
      return `${icon} Виправлення/новий документ ТД: «${escapeHtml(e.title)}»`;
    case 'new_tender_announced':
      return `${icon} Нове оголошення замовника`;
    case 'deadline_approaching':
      return `${icon} До дедлайну подачі менше 24 годин`;
    case 'new_complaint':
      return `${icon} Подано скаргу (статус: ${e.status})`;
    case 'complaint_status_changed':
      return `${icon} Статус скарги: ${e.old} → ${e.new}`;
    case 'cancellation_initiated':
      return `${icon} Розпочато процедуру скасування`;
    case 'cancelled':
      return `${icon} Закупівлю скасовано`;
    case 'unsuccessful':
      return `${icon} Закупівля не відбулась`;
    case 'complete':
      return `${icon} Закупівлю завершено`;
    default:
      return `${icon} ${e.type}`;
  }
}

const KYIV_TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const KYIV_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit', month: '2-digit', year: 'numeric',
});

export function formatDigest(runIso, groups) {
  const time = KYIV_TIME_FMT.format(new Date(runIso));
  const date = KYIV_DATE_FMT.format(new Date(runIso));
  const lines = [`🔔 Зміни в тендерах (${time}, ${date})`, ''];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const sections = [];
    sections.push(`  🆔 Ідентифікатор закупівлі: <a href="${escapeHtml(g.prozorro_url)}">${escapeHtml(g.tender_id)}</a>`);
    if (g.procuring_entity?.name) {
      const edrpou = g.procuring_entity.edrpou ? ` (ЄДРПОУ ${g.procuring_entity.edrpou})` : '';
      sections.push(`  👥 Замовник: ${escapeHtml(abbreviateLegalForm(g.procuring_entity.name))}${edrpou}`);
    }
    sections.push(`  📦 Предмет закупівлі: ${escapeHtml(truncate(stripDkCode(g.title), 200))}`);
    if (g.classification?.id) {
      const desc = g.classification.description ? ` — ${escapeHtml(g.classification.description)}` : '';
      sections.push(`  🔖 ДК: ${g.classification.id}${desc}`);
    }
    if (g.procurement_method_type) {
      const label = PROC_METHOD_LABELS[g.procurement_method_type] ?? g.procurement_method_type;
      sections.push(`  📋 Процедура: ${label}`);
    }
    if (g.value && typeof g.value.amount === 'number') {
      const amount = formatMoney(g.value.amount);
      const vatTag = g.value.valueAddedTaxIncluded ? 'з ПДВ' : 'без ПДВ';
      sections.push(`  💰 Вартість: ${amount} ${g.value.currency} (${vatTag})`);
    }
    if (g.contact?.name) {
      const tel = formatPhone(g.contact.telephone ?? '');
      const phoneLine = `  📞 ${escapeHtml(g.contact.name)}: ${escapeHtml(tel)}`;
      const emailLine = g.contact.email ? `  ✉ ${escapeHtml(g.contact.email)}` : '';
      sections.push(emailLine ? `${phoneLine}\n${emailLine}` : phoneLine);
    }
    if (g.status) {
      sections.push(`  ℹ️ Статус: ${fmtStatus(g.status)}`);
      // Submission deadline only renders while bidders can still submit.
      // For other statuses tenderPeriod.endDate is in the past and misleading.
      if (g.status === 'active.tendering' && g.deadline) {
        sections.push(`  ⏰ Подача пропозиції до: ${fmtDeadline(g.deadline)}`);
      }
    }
    if (g.events.length > 0) {
      sections.push(g.events.map(e => '  ' + fmtEvent(e)).join('\n'));
    }
    lines.push(sections.join('\n\n'));
    lines.push('');
    if (i < groups.length - 1) {
      lines.push('━'.repeat(24));
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

// Separate "24h to submission deadline" reminder — sent on its own (NOT in the
// digest) so it can be deleted after 24h without archiving it to history.
export function formatDeadlineReminder(tenders) {
  const lines = ['⏰ Залишилось 24 год до завершення приймання пропозицій:'];
  for (const t of tenders ?? []) {
    const ent = t.entity ? ` · ${escapeHtml(abbreviateLegalForm(t.entity))}` : '';
    const dl = t.deadline ? ` · ${escapeHtml(fmtDeadline(t.deadline))}` : '';
    lines.push(`🆔 ${escapeHtml(t.tender_id)}${ent}${dl}`);
  }
  return lines.join('\n');
}

// One-line summary of a digest's events for the history list row.
// Priority order: each group (tender) is attributed to its first matching type.
// Sum of all counts = number of tender blocks visible in the detail view.
const SUMMARY_TYPES = [
  ['new_tender_announced', '📥'],
  ['contract_signed', '✍️'],
  ['award_qualified', '🏆'],
  ['status_changed', '🔄'],
  ['award_disqualified', '❌'],
  ['award_cancelled', '↩️'],
  ['award_created', '👤'],
  ['contract_terminated', '⛔'],
  ['contract_created', '📜'],
  ['contract_documents_added', '📎'],
  ['cancellation_initiated', '⚠️'],
  ['new_complaint', '⚖️'],
  ['complaint_status_changed', '⚖️'],
  ['td_amended', '📝'],
  ['deadline_changed', '📅'],
  ['new_question', '❓'],
  ['question_answered', '💬'],
  ['auction_scheduled', '🕐'],
  ['auction_rescheduled', '🕐'],
  ['auction_started', '⚡'],
  ['qualification_started', '🔍'],
  ['prequalification_started', '🔄'],
  ['awarded_phase', '🏅'],
  ['monitoring_started', '🟢'],
];
export function summarizeDigest(groups) {
  // Count groups (tenders), not individual events. Each group is attributed
  // to its highest-priority event type so the total matches the visible blocks.
  const counts = new Map();
  for (const g of groups ?? []) {
    const types = new Set((g.events ?? []).map(e => e.type));
    for (const [type, emoji] of SUMMARY_TYPES) {
      if (types.has(type)) { counts.set(emoji, (counts.get(emoji) ?? 0) + 1); break; }
    }
  }
  const parts = [...counts.entries()].map(([emoji, n]) => `${emoji} ${n}`);
  if (parts.length) return parts.join(' · ');
  const n = (groups ?? []).length;
  return n ? `🔔 ${n}` : '🔔 оновлення';
}

export function formatMoney(amount) {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatHeartbeat(runIso, snapshots) {
  const time = KYIV_TIME_FMT.format(new Date(runIso));
  const date = KYIV_DATE_FMT.format(new Date(runIso));
  const lines = [
    `🟢 Heartbeat (${time}, ${date})`,
    '',
    `Моніторю ${snapshots.length} ${plural(snapshots.length, ['тендер', 'тендери', 'тендерів'])} — без змін за добу.`,
  ];

  // Helper: extract DD.MM from an ISO datetime
  const shortDate = (iso) => {
    if (!iso) return '';
    const parts = new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv',
      day: '2-digit',
      month: '2-digit',
    }).formatToParts(new Date(iso));
    const day = parts.find(p => p.type === 'day')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    return `${day}.${month}`;
  };

  const now = new Date(runIso);
  const active = [];
  const waiting = [];

  // Split into active (future deadline) and waiting (past/no deadline)
  for (const s of snapshots) {
    const d = s.deadline ? new Date(s.deadline) : null;
    if (d && d - now > 0) {
      active.push(s);
    } else {
      waiting.push(s);
    }
  }

  // Sort each section by deadline ascending
  active.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  waiting.sort((a, b) => {
    const aDeadline = a.deadline ? new Date(a.deadline) : new Date(0);
    const bDeadline = b.deadline ? new Date(b.deadline) : new Date(0);
    return aDeadline - bDeadline;
  });

  // Render active section
  if (active.length > 0) {
    lines.push('');
    lines.push(`🎯 Активні дедлайни (${active.length}):`);
    for (const s of active) {
      const idLink = `<a href="https://prozorro.gov.ua/tender/${escapeHtml(s.tender_id)}">${escapeHtml(s.tender_id)}</a>`;
      const left = fmtTimeLeft(s.deadline, runIso);
      const leftPart = left ? `, ⏰ ${left}` : '';
      lines.push(`— ${idLink} — до ${fmtDeadline(s.deadline)}${leftPart}`);
    }
  }

  // Render waiting section
  if (waiting.length > 0) {
    lines.push('');
    lines.push(`⏸ Очікують замовника (${waiting.length}):`);
    for (const s of waiting) {
      const idLink = `<a href="https://prozorro.gov.ua/tender/${escapeHtml(s.tender_id)}">${escapeHtml(s.tender_id)}</a>`;
      const since = shortDate(s.deadline);
      const sincePart = since ? ` (з ${since})` : '';
      lines.push(`— ${idLink} — ${fmtStatus(s.status)}${sincePart}`);
    }
  }

  return lines.join('\n');
}

export function formatNightDigest(runIso, pending) {
  const groups = Object.values(pending.items ?? {});
  const dateStr = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(runIso));
  let text = `🌙 Нічний дайджест за ${dateStr}`;
  if (groups.length > 0) {
    text += '\n\n' + formatDigest(runIso, groups);
  }
  if ((pending.errors ?? []).length > 0) {
    text += '\n\n⚠️ не вдалось перевірити (вночі):\n' +
      pending.errors.map(e => `  • ${e.tender_id} — ${e.error}`).join('\n');
  }
  if ((pending.archived ?? []).length > 0) {
    text += '\n\n📦 Архівовано (вночі):\n' +
      pending.archived.map(a => `  • ${a.tender_id} — ${a.status}`).join('\n');
  }
  return text;
}

export function chunkMessage(text, max) {
  if (text.length <= max) return [text];
  // Split at double-newline (group boundary)
  const groups = text.split('\n\n');
  const chunks = [];
  let buf = '';
  for (const g of groups) {
    if ((buf + '\n\n' + g).length > max && buf) {
      chunks.push(buf);
      buf = g;
    } else {
      buf = buf ? buf + '\n\n' + g : g;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function sendOne({ token, chatId, fetch: fetchImpl = fetch }, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const params = {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  };
  if (replyMarkup != null) params.reply_markup = JSON.stringify(replyMarkup);
  const body = new URLSearchParams(params);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', body });
      if (res.ok) return await res.json();
      lastErr = new Error(`Telegram ${res.status}: ${await res.text()}`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

export async function sendDigest({ token, chatId, fetch: fetchImpl = fetch }, text, { addButtonsForTenders = [], role } = {}) {
  const chunks = chunkMessage(text, 4000);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const annotated = chunks.length > 1
      ? `${chunks[i]}\n\n— ${i + 1}/${chunks.length} —`
      : chunks[i];
    const buttonsHere = addButtonsForTenders.filter(id => annotated.includes(id));
    const rows = buttonsHere.flatMap(id => {
      const row = [[{ text: `➕ Додати в моніторинг ${id}`, callback_data: `add:${id}` }]];
      // Admin-only agent-trigger entry button, directly under the add button for
      // the same tender. Inlined (rather than importing agentTriggerButtonRow from
      // commands.mjs) to avoid a telegram.mjs ↔ commands.mjs import cycle; kept in
      // sync with that helper's row shape.
      if (role === 'admin') {
        row.push([{ text: '🤖 Надіслати агенту', callback_data: `agent:start:${id}` }]);
      }
      return row;
    });
    const replyMarkup = rows.length > 0 ? { inline_keyboard: rows } : null;
    last = await sendOne({ token, chatId, fetch: fetchImpl }, annotated, replyMarkup);
  }
  return last;
}

// Fan-out a digest to multiple recipients. Per-recipient failures are logged
// (typically 403 from users who haven't started the bot, or 400 from blocked
// chats) but do not abort delivery to remaining recipients.
//
// chatIds items can be either a string (legacy: same opts for everyone) or
// an object { chatId, role }. Viewers don't receive inline action buttons —
// the callback handler rejects their clicks anyway, so showing the button
// would just mislead them.
export async function broadcastDigest({ token, chatIds, fetch: fetchImpl = fetch }, text, opts) {
  const recipients = [];
  for (const recipient of chatIds) {
    const isObj = typeof recipient === 'object' && recipient !== null;
    const chatId = isObj ? recipient.chatId : recipient;
    const role = isObj ? recipient.role : null;
    const effectiveOpts = role === 'viewer' && opts
      ? { ...opts, addButtonsForTenders: [] }
      : (opts ? { ...opts, role } : opts);
    try {
      const res = await sendDigest({ token, chatId, fetch: fetchImpl }, text, effectiveOpts);
      const mid = res?.result?.message_id;
      if (mid != null) recipients.push({ chat_id: String(chatId), message_id: mid });
    } catch (err) {
      console.error(`broadcastDigest to ${chatId} failed:`, err.message);
    }
  }
  return recipients;
}

export async function getUpdates({ token, offset, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0&limit=100`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Telegram getUpdates ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram getUpdates: ${json.description ?? 'unknown error'}`);
  }
  return json.result ?? [];
}

async function sendReplyOne({ token, chatId, text, replyToMessageId, replyMarkup, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const params = {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  };
  if (replyToMessageId != null) params.reply_to_message_id = String(replyToMessageId);
  if (replyMarkup != null) params.reply_markup = JSON.stringify(replyMarkup);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        body: new URLSearchParams(params),
      });
      if (!res.ok) {
        lastErr = new Error(`Telegram sendReply ${res.status}: ${await res.text()}`);
        continue;
      }
      const json = await res.json();
      if (!json.ok) {
        lastErr = new Error(`Telegram sendReply: ${json.description ?? 'unknown error'}`);
        continue;
      }
      return json;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Telegram rejects any sendMessage over 4096 chars with HTTP 400. A reply that
// exceeds it (e.g. /info with many active tenders) would otherwise fail silently
// — the user sees nothing. Split on paragraph boundaries like sendDigest does,
// anchoring the reply to the user's message on the first chunk and the keyboard
// on the last.
export async function sendReply({ token, chatId, text, replyToMessageId, replyMarkup, fetch: fetchImpl = fetch }) {
  const chunks = chunkMessage(text, 4000);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const annotated = chunks.length > 1
      ? `${chunks[i]}\n\n— ${i + 1}/${chunks.length} —`
      : chunks[i];
    last = await sendReplyOne({
      token, chatId, fetch: fetchImpl,
      text: annotated,
      replyToMessageId: i === 0 ? replyToMessageId : undefined,
      replyMarkup: i === chunks.length - 1 ? replyMarkup : undefined,
    });
  }
  return last;
}

export async function editMessageReplyMarkup({ token, chatId, messageId, replyMarkup, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  const params = new URLSearchParams({
    chat_id: String(chatId),
    message_id: String(messageId),
    reply_markup: JSON.stringify(replyMarkup),
  });
  const res = await fetchImpl(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Telegram editMessageReplyMarkup ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram editMessageReplyMarkup: ${json.description ?? 'unknown'}`);
  return json;
}

// Best-effort delete: returns true on success, false on any failure (message
// already gone, older than 48h, network) — never throws, so cleanup of stale
// messages can't break a command.
export async function deleteMessage({ token, chatId, messageId, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/deleteMessage`;
  const params = new URLSearchParams({
    chat_id: String(chatId),
    message_id: String(messageId),
  });
  try {
    const res = await fetchImpl(url, { method: 'POST', body: params });
    if (!res.ok) return false;
    const json = await res.json();
    return json.ok === true;
  } catch {
    return false;
  }
}

export async function editMessageText({ token, chatId, messageId, text, replyMarkup, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const params = new URLSearchParams({
    chat_id: String(chatId),
    message_id: String(messageId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });
  if (replyMarkup != null) params.set('reply_markup', JSON.stringify(replyMarkup));
  const res = await fetchImpl(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Telegram editMessageText ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram editMessageText: ${json.description ?? 'unknown'}`);
  return json;
}

export async function answerCallbackQuery({ token, callbackQueryId, text, showAlert, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const params = new URLSearchParams({ callback_query_id: String(callbackQueryId) });
  if (text != null) params.set('text', text);
  if (showAlert) params.set('show_alert', 'true');
  const res = await fetchImpl(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`Telegram answerCallbackQuery ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram answerCallbackQuery: ${json.description ?? 'unknown'}`);
  return json;
}

export async function setMyCommands({ token, commands, chatId, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const body = {
    commands,
    scope: { type: 'chat', chat_id: Number(chatId) },
    language_code: '',
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`setMyCommands ${res.status}`);
  }
}
