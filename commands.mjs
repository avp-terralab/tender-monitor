import { stripDkCode, truncate, fmtStatus, fmtDeadline, fmtTimeLeft, escapeHtml, formatMoney, formatPhone } from './telegram.mjs';

const TENDER_ID_RE_STR = 'UA-\\d{4}-\\d{2}-\\d{2}-\\d{6}-[a-zA-Z]';
const EDRPOU_RE = /^\d{8}$/;

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
