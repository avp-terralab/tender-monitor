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

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPhone(raw) {
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
  return title.replace(/\s*[,;]\s*код\s+ДК\s+.+$/i, '').trim();
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

function plural(n, [one, few, many]) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function fmtTimeLeft(deadlineIso, nowIso) {
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
      sections.push(`  👥 Замовник: ${escapeHtml(g.procuring_entity.name)}${edrpou}`);
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
    if (g.status && g.deadline) {
      sections.push(`  ℹ️ Статус: ${fmtStatus(g.status)}, дедлайн ${fmtDeadline(g.deadline)}`);
      if (runIso) {
        const left = fmtTimeLeft(g.deadline, runIso);
        if (left) sections.push(`  ⏰ Залишилось: ${left}`);
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

function formatMoney(amount) {
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
  if (snapshots.length > 0) {
    lines.push('');
    lines.push('Поточні дедлайни:');
    for (const s of snapshots) {
      const left = fmtTimeLeft(s.deadline, runIso);
      const leftPart = left ? `, ⏰ ${left}` : '';
      const idLink = `<a href="https://prozorro.gov.ua/tender/${escapeHtml(s.tender_id)}">${escapeHtml(s.tender_id)}</a>`;
      lines.push(`— ${idLink} — ${fmtStatus(s.status)} (до ${fmtDeadline(s.deadline)}${leftPart})`);
    }
  }
  return lines.join('\n');
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

async function sendOne({ token, chatId }, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', body });
      if (res.ok) return await res.json();
      lastErr = new Error(`Telegram ${res.status}: ${await res.text()}`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

export async function sendDigest({ token, chatId }, text) {
  const chunks = chunkMessage(text, 4000);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const annotated = chunks.length > 1
      ? `${chunks[i]}\n\n— ${i + 1}/${chunks.length} —`
      : chunks[i];
    last = await sendOne({ token, chatId }, annotated);
  }
  return last;
}
