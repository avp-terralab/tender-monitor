import { stripDkCode, truncate, fmtStatus, fmtDeadline, escapeHtml } from './telegram.mjs';

const TENDER_ID_RE_STR = 'UA-\\d{4}-\\d{2}-\\d{2}-\\d{6}-[a-zA-Z]';

export function parseCommand(text) {
  if (typeof text !== 'string') return { cmd: null };
  const trimmed = text.trim();
  if (trimmed === '') return { cmd: null };

  if (/^\/list(?:@\w+)?$/i.test(trimmed)) return { cmd: 'list' };
  if (/^\/help(?:@\w+)?$/i.test(trimmed)) return { cmd: 'help' };
  if (/^\/status(?:@\w+)?$/i.test(trimmed)) return { cmd: 'status' };

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

export function formatAddReply(snapshot, { reEnable }) {
  const lines = [];
  const verb = reEnable ? 'Поновив моніторинг' : 'Додано';
  lines.push(`✅ ${verb} ${snapshot.tender_id}`);
  const title = stripDkCode(snapshot.title ?? '');
  if (title) lines.push(`📦 ${escapeHtml(truncate(title, 200))}`);
  if (snapshot.procuringEntity?.name) {
    lines.push(`👥 ${escapeHtml(snapshot.procuringEntity.name)}`);
  }
  if (snapshot.status) {
    let line = `ℹ️ Статус: ${fmtStatus(snapshot.status)}`;
    const deadline = snapshot.tenderPeriod?.endDate;
    if (deadline) line += `, дедлайн ${fmtDeadline(deadline)}`;
    lines.push(line);
  }
  lines.push('Перший snapshot — на наступному monitor-тіку (09/13/18 Київ).');
  return lines.join('\n');
}

export function handleList({ watchlist }) {
  if (!watchlist || watchlist.length === 0) {
    return '📭 Список порожній. Додай тендер: /add UA-...';
  }
  const lines = watchlist.map(r => {
    const icon = r.enabled ? '🟢' : '🔴';
    const notes = r.notes ? ` — ${escapeHtml(truncate(r.notes, 80))}` : '';
    return `${icon} ${r.tender_id}${notes}`;
  });
  const active = watchlist.filter(r => r.enabled).length;
  lines.push('');
  lines.push(`Всього: ${watchlist.length} (${active} active)`);
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

export async function handleAdd(deps, { tender_id, notes }) {
  const { watchlist, fetchTender, extractSnapshot } = deps;
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
      reply: formatAddReply(snapshot, { reEnable: true }),
      mutation: {
        type: 'update',
        tender_id,
        fields: { enabled: true, notes: finalNotes },
      },
    };
  }

  return {
    reply: formatAddReply(snapshot, { reEnable: false }),
    mutation: {
      type: 'append',
      row: { tender_id, enabled: true, notes: finalNotes },
    },
  };
}

export const HELP_TEXT = [
  'Команди:',
  '/add UA-YYYY-MM-DD-NNNNNN-x [нотатки] — додати тендер',
  '/remove UA-YYYY-MM-DD-NNNNNN-x — видалити тендер',
  '/list — показати всі тендери на моніторингу',
  '/status — здоровʼя бота',
  '/help — це повідомлення',
].join('\n');
