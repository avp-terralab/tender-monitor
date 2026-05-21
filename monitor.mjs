import { diff, DEADLINE_THRESHOLD_KEYS } from './compare.mjs';
import { formatDigest, formatHeartbeat } from './telegram.mjs';

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

  if (!hasContent && archivedNow.length === 0 && isHeartbeatHour(runIso)) {
    // Debounce: multiple cron triggers can land in the same Kyiv-09 hour
    // (GHA scheduled + external pinger). Skip if heartbeat already sent today.
    const today = kyivDate(runIso);
    const lastHeartbeatDate = deps.loadHeartbeatDate ? await deps.loadHeartbeatDate() : null;
    if (lastHeartbeatDate !== today) {
      const heartbeat = formatHeartbeat(runIso, results
        .filter(r => !r.error && r.curr)
        .map(r => ({
          tender_id: r.row.tender_id,
          title: r.curr.title,
          status: r.curr.status,
          deadline: r.curr.tenderPeriod?.endDate ?? null,
        }))
      );
      // Heartbeat is operational ops info (admin-facing). Use sendHeartbeat if
      // provided to route it to admin-only; fall back to sendDigest broadcast
      // for backward-compat in tests.
      if (deps.sendHeartbeat) {
        await deps.sendHeartbeat(heartbeat);
      } else {
        await sendDigest(heartbeat);
      }
      if (deps.saveHeartbeatDate) await deps.saveHeartbeatDate(today);
    }
    // Update sheet last_check, but DO NOT save state (no events to acknowledge)
    await Promise.all(results.map(r =>
      updateSheet(r.row.tender_id, {
        last_check: runIso,
        last_status: r.curr?.status,
        last_dateModified: r.curr?.dateModified,
      }).catch(() => {})
    ));
    return {
      sent: lastHeartbeatDate !== today,
      groups: 0,
      errors: 0,
      heartbeat: lastHeartbeatDate !== today,
    };
  }

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
    await sendDigest(text, addButtonsForTenders.length > 0 ? { addButtonsForTenders } : undefined);

    // Save state only for tenders with events (errors → no save, retry next run).
    // Archived tenders are skipped — their snapshot was unlinked by archiveTender
    // and saving here would recreate a stale file for a row no longer in watchlist.
    const archivedIds = new Set(archivedNow.map(a => a.tender_id));
    await Promise.all(results.map(async r => {
      if (r.error || r.events.length === 0) return;
      if (archivedIds.has(r.row.tender_id)) return;
      await saveState(r.row.tender_id, r.curr);
    }));
  }

  // Always update sheet last_check timestamp for all attempted rows
  await Promise.all(results.map(r =>
    updateSheet(r.row.tender_id, {
      last_check: runIso,
      last_status: r.curr?.status,
      last_dateModified: r.curr?.dateModified,
    }).catch(() => {}) // sheet update failure is non-fatal
  ));

  return {
    sent: !isSilent || archivedNow.length > 0,
    groups: groups.length,
    errors: errors.length,
  };
}
