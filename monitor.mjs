import { diff, DEADLINE_THRESHOLD_KEYS } from './compare.mjs';
import { formatDigest, formatHeartbeat, formatNightDigest } from './telegram.mjs';

const TENDER_ID_RE = /^UA-\d{4}-\d{2}-\d{2}-\d{6}-[a-z]$/;

const TERMINAL_STATUSES = new Set(['complete', 'cancelled', 'unsuccessful']);

const STATUS_ICONS = {
  complete: '✅',
  cancelled: '⊘',
  unsuccessful: '❌',
};

function isHeartbeatHour(runIso) {
  const hour = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(runIso));
  return hour === '09';
}

export function isQuietHour(runIso) {
  const hour = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(runIso));
  const h = parseInt(hour, 10);
  return h >= 0 && h < 6;
}

export function emptyPending() {
  return { items: {}, archived: [], errors: [] };
}

export function mergePending(pending, { groups = [], archived = [], errors = [], runIso }) {
  const next = {
    items: { ...pending.items },
    archived: [...pending.archived, ...archived.map(a => ({ ...a, fired_at: runIso }))],
    errors: [...pending.errors, ...errors.map(e => ({ ...e, fired_at: runIso }))],
  };
  for (const g of groups) {
    const existing = next.items[g.tender_id];
    if (existing) {
      next.items[g.tender_id] = {
        ...existing,
        ...g,
        events: [...existing.events, ...g.events],
        first_fired_at: existing.first_fired_at,
        last_fired_at: runIso,
      };
    } else {
      next.items[g.tender_id] = {
        ...g,
        first_fired_at: runIso,
        last_fired_at: runIso,
      };
    }
  }
  return next;
}

function kyivDate(runIso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(runIso));
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function runOnce(deps) {
  const {
    runIso, watchlist, fetchTender, extractSnapshot,
    loadState, saveState, sendDigest, updateSheet,
    disableTender,
    loadPendingDigest, savePendingDigest, clearPendingDigest,
  } = deps;

  const enabled = watchlist.filter(w => w.enabled);

  const results = await Promise.all(enabled.map(async (row) => {
    if (!TENDER_ID_RE.test(row.tender_id)) {
      return { row, curr: null, events: [], error: 'invalid tender_id format' };
    }
    try {
      const raw = await fetchTender(row.tender_id);
      const curr = extractSnapshot(raw);
      const prev = await loadState(row.tender_id);
      const events = diff(prev, curr, runIso);
      const newThresholds = events
        .filter(e => e.type === 'deadline_approaching')
        .map(e => e.threshold);
      const prevDeadline = prev?.tenderPeriod?.endDate ?? null;
      const currDeadline = curr.tenderPeriod?.endDate ?? null;
      const deadlineChanged = prevDeadline && prevDeadline !== currDeadline;
      const baseNotified = deadlineChanged
        ? []
        : (prev?._notifiedDeadlines ?? []).filter(k => DEADLINE_THRESHOLD_KEYS.includes(k));
      const merged = [...new Set([...baseNotified, ...newThresholds])];
      if (merged.length > 0) curr._notifiedDeadlines = merged;
      return { row, curr, events, error: null };
    } catch (err) {
      return { row, curr: null, events: [], error: err.message };
    }
  }));

  // Auto-disable on 404 / not found / no UUID / invalid format
  for (const r of results) {
    if (r.error && /(404|not found|no UUID)/i.test(r.error)) {
      await disableTender?.(r.row.tender_id, r.error);
    }
  }

  const groups = [];
  const errors = [];

  for (const r of results) {
    if (r.error) {
      errors.push({
        tender_id: r.row.tender_id,
        error: r.error,
        is_invalid: /(404|not found|no UUID|invalid tender_id format)/i.test(r.error),
      });
      continue;
    }
    if (r.events.length === 0) continue;
    groups.push({
      tender_id: r.row.tender_id,
      title: r.curr.title,
      status: r.curr.status,
      deadline: r.curr.tenderPeriod?.endDate ?? null,
      procuring_entity: r.curr.procuringEntity ?? null,
      value: r.curr.value ?? null,
      procurement_method_type: r.curr.procurementMethodType ?? null,
      classification: r.curr.classification ?? null,
      contact: r.curr.contact ?? null,
      prozorro_url: `https://prozorro.gov.ua/tender/${r.row.tender_id}`,
      events: r.events,
    });
  }

  // Entity-watch: new tender announcements from watched EDRPOUs
  if (deps.checkWatchedEntities) {
    try {
      const watchResult = await deps.checkWatchedEntities({
        watchedEntities: deps.watchedEntities ?? [],
        loadCursor: deps.loadCursor,
        saveCursor: deps.saveCursor,
        loadSeen: deps.loadSeen,
        saveSeen: deps.saveSeen,
      });
      if (watchResult.alerts?.length) groups.push(...watchResult.alerts);
      if (watchResult.errors?.length) {
        for (const e of watchResult.errors) {
          errors.push({
            tender_id: e.tender_id ?? `[entity-watch ${e.source}]`,
            error: e.error,
            is_invalid: false,
          });
        }
      }
      // Lazy-resolve entity names: persist any newly-discovered names back to watched_entities.json
      if (watchResult.discoveredNames && Object.keys(watchResult.discoveredNames).length > 0 && deps.saveWatchedEntities) {
        const updated = (deps.watchedEntities ?? []).map(e =>
          watchResult.discoveredNames[e.edrpou]
            ? { ...e, name: watchResult.discoveredNames[e.edrpou] }
            : e
        );
        try {
          await deps.saveWatchedEntities(updated);
        } catch (err) {
          console.error('saveWatchedEntities failed:', err.message);
        }
      }
    } catch (err) {
      console.error('checkWatchedEntities failed:', err.message);
    }
  }

  const hasContent = groups.length > 0 || errors.length > 0;

  // Collect terminal-status archival candidates.
  const archivedNow = [];
  if (deps.archiveTender) {
    for (const r of results) {
      if (r.error || !r.curr) continue;
      if (!TERMINAL_STATUSES.has(r.curr.status)) continue;
      try {
        const ok = await deps.archiveTender(r.row.tender_id, r.curr);
        if (ok) archivedNow.push({ tender_id: r.row.tender_id, status: r.curr.status });
      } catch (err) {
        console.error('archiveTender failed:', r.row.tender_id, err.message);
      }
    }
  }

  const inQuietWindow = isQuietHour(runIso);
  const inHeartbeatSlot = isHeartbeatHour(runIso);
  const today = kyivDate(runIso);
  const lastHeartbeatDate = inHeartbeatSlot && deps.loadHeartbeatDate
    ? await deps.loadHeartbeatDate()
    : null;
  const heartbeatDue = inHeartbeatSlot && lastHeartbeatDate !== today;

  // Phase A: flush pending night digest if heartbeat slot is due
  let nightFlushed = false;
  if (heartbeatDue && loadPendingDigest) {
    const pending = await loadPendingDigest();
    const pendingItems = pending ? Object.values(pending.items ?? {}) : [];
    const pendingHasContent = pending && (
      pendingItems.length > 0 ||
      (pending.archived ?? []).length > 0 ||
      (pending.errors ?? []).length > 0
    );
    if (pendingHasContent) {
      const morningText = formatNightDigest(runIso, pending);
      const nightButtons = pendingItems
        .filter(g => g.events?.some(e => e.type === 'new_tender_announced'))
        .map(g => g.tender_id);
      await sendDigest(
        morningText,
        nightButtons.length > 0 ? { addButtonsForTenders: nightButtons } : undefined,
      );
      if (clearPendingDigest) await clearPendingDigest();
      nightFlushed = true;
    }
  }

  // Phase B: process current-cycle events
  const isSilent = !hasContent;
  if (!isSilent || archivedNow.length > 0) {
    let text = '';
    if (!isSilent) {
      text = formatDigest(runIso, groups);
      if (errors.length > 0) {
        text += '\n\n⚠️ не вдалось перевірити:\n' +
          errors.map(e => {
            const line = e.is_invalid
              ? `  • ${e.tender_id} — не знайдено в Prozorro або невалідний формат, відключено від моніторингу`
              : `  • ${e.tender_id} — ${e.error}`;
            return line;
          }).join('\n');
      }
    }
    if (archivedNow.length > 0) {
      const block = '📦 Архівовано:\n' + archivedNow.map(a =>
        `  ${STATUS_ICONS[a.status] ?? '📦'} ${a.tender_id} — ${a.status}`
      ).join('\n');
      text = text ? `${text}\n\n${block}` : block;
    }
    const addButtonsForTenders = groups
      .filter(g => g.events?.some(e => e.type === 'new_tender_announced'))
      .map(g => g.tender_id);

    if (inQuietWindow) {
      // Buffer instead of broadcast.
      const prevPending = (loadPendingDigest ? await loadPendingDigest() : null) ?? emptyPending();
      const updated = mergePending(prevPending, {
        groups, archived: archivedNow, errors, runIso,
      });
      if (savePendingDigest) await savePendingDigest(updated);
    } else {
      await sendDigest(
        text,
        addButtonsForTenders.length > 0 ? { addButtonsForTenders } : undefined,
      );
    }

    // saveState runs in both branches — dedup must hold across buffered events too.
    const archivedIds = new Set(archivedNow.map(a => a.tender_id));
    await Promise.all(results.map(async r => {
      if (r.error || r.events.length === 0) return;
      if (archivedIds.has(r.row.tender_id)) return;
      await saveState(r.row.tender_id, r.curr);
    }));
  }

  // Phase C: admin heartbeat fallback (only if nothing else fired in the slot)
  let heartbeatSent = false;
  if (heartbeatDue && !nightFlushed && !hasContent && archivedNow.length === 0) {
    const heartbeat = formatHeartbeat(runIso, results
      .filter(r => !r.error && r.curr)
      .map(r => ({
        tender_id: r.row.tender_id,
        title: r.curr.title,
        status: r.curr.status,
        deadline: r.curr.tenderPeriod?.endDate ?? null,
      }))
    );
    if (deps.sendHeartbeat) {
      await deps.sendHeartbeat(heartbeat);
    } else {
      await sendDigest(heartbeat);
    }
    heartbeatSent = true;
  }

  // Phase D: persist heartbeat date if any 09:00-slot send actually happened
  if (heartbeatDue && (nightFlushed || heartbeatSent) && deps.saveHeartbeatDate) {
    await deps.saveHeartbeatDate(today);
  }

  // Phase E: always update sheet last_check
  await Promise.all(results.map(r =>
    updateSheet(r.row.tender_id, {
      last_check: runIso,
      last_status: r.curr?.status,
      last_dateModified: r.curr?.dateModified,
    }).catch(() => {})
  ));

  return {
    sent: nightFlushed || heartbeatSent || (!inQuietWindow && (!isSilent || archivedNow.length > 0)),
    groups: groups.length,
    errors: errors.length,
    heartbeat: heartbeatSent,
    nightFlushed,
    buffered: inQuietWindow && (!isSilent || archivedNow.length > 0),
  };
}
