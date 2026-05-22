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
  [new RegExp(`^Товариство\\s+з\\s+обмеженою\\s+відповідальністю${_SEP}`, 'i'), 'ТОВ '],
  [new RegExp(`^Приватне\\s+акціонерне\\s+товариство${_SEP}`, 'i'), 'ПрАТ '],
  [new RegExp(`^Публічне\\s+акціонерне\\s+товариство${_SEP}`, 'i'), 'ПАТ '],
  [new RegExp(`^Акціонерне\\s+товариство${_SEP}`, 'i'), 'АТ '],
  [new RegExp(`^Державне\\s+підприємство${_SEP}`, 'i'), 'ДП '],
  [new RegExp(`^Приватне\\s+підприємство${_SEP}`, 'i'), 'ПП '],
  [new RegExp(`^Фізична\\s+особа[-\\s]+підприємець${_SEP}`, 'i'), 'ФОП '],
];

export function abbreviateLegalForm(name) {
  if (!name) return name;
  // Prozorro registry sometimes returns names with leading/trailing whitespace
  // (e.g. " Комунальне підприємство ..."). All abbreviation regexes are anchored
  // at ^, so trim before matching — otherwise the regex misses and the long form
  // leaks through to /watched, /info, digests, etc.
  const trimmed = name.trim();
  for (const [re, replacement] of LEGAL_FORM_ABBREVIATIONS) {
    if (re.test(trimmed)) return trimmed.replace(re, replacement).trim();
  }
  return trimmed;
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

export async function sendDigest({ token, chatId, fetch: fetchImpl = fetch }, text, { addButtonsForTenders = [] } = {}) {
  const chunks = chunkMessage(text, 4000);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const annotated = chunks.length > 1
      ? `${chunks[i]}\n\n— ${i + 1}/${chunks.length} —`
      : chunks[i];
    const buttonsHere = addButtonsForTenders.filter(id => annotated.includes(id));
    const replyMarkup = buttonsHere.length > 0
      ? {
          inline_keyboard: buttonsHere.map(id => [
            { text: `➕ Додати в моніторинг ${id}`, callback_data: `add:${id}` },
          ]),
        }
      : null;
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
  for (const recipient of chatIds) {
    const isObj = typeof recipient === 'object' && recipient !== null;
    const chatId = isObj ? recipient.chatId : recipient;
    const role = isObj ? recipient.role : null;
    const effectiveOpts = role === 'viewer' && opts
      ? { ...opts, addButtonsForTenders: [] }
      : opts;
    try {
      await sendDigest({ token, chatId, fetch: fetchImpl }, text, effectiveOpts);
    } catch (err) {
      console.error(`broadcastDigest to ${chatId} failed:`, err.message);
    }
  }
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

export async function sendReply({ token, chatId, text, replyToMessageId, replyMarkup, fetch: fetchImpl = fetch }) {
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
