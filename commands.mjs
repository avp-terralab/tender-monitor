import { stripDkCode, truncate, fmtStatus, fmtDeadline, escapeHtml } from './telegram.mjs';

const TENDER_ID_RE_STR = 'UA-\\d{4}-\\d{2}-\\d{2}-\\d{6}-[a-zA-Z]';

export function parseCommand(text) {
  if (typeof text !== 'string') return { cmd: null };
  const trimmed = text.trim();
  if (trimmed === '') return { cmd: null };

  if (/^\/list(?:@\w+)?$/i.test(trimmed)) return { cmd: 'list' };
  if (/^\/help(?:@\w+)?$/i.test(trimmed)) return { cmd: 'help' };

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
