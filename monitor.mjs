import { diff, DEADLINE_THRESHOLD_KEYS } from './compare.mjs';
import { formatDigest, formatDeadlineReminder, summarizeDigest, formatHeartbeat, formatNightDigest } from './telegram.mjs';

const TENDER_ID_RE = /^UA-\d{4}-\d{2}-\d{2}-\d{6}-[a-z]$/;

const HISTORY_CAP = 200;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

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

// Delete messages older than ttl; drop expired deadline items, keep digests
// (marked deleted), cap digests to `cap` (newest-first). deleteMessage best-effort.
export async function expireHistory(items, now, deleteMessage, { ttlMs = HISTORY_TTL_MS, cap = HISTORY_CAP } = {}) {
  const out = [];
  for (let it of items ?? []) {
    const age = now - new Date(it.sent_at).getTime();
    if (!it.deleted && age > ttlMs) {
      for (const r of it.recipients ?? []) {
        try { await deleteMessage(r.chat_id, r.message_id); } catch { /* best-effort */ }
      }
      it = { ...it, deleted: true };
    }
    if (it.type === 'deadline') continue;   // deadline reminders are never archived
    out.push(it);
  }
  let digestsSeen = 0;
  return out.filter((it) => {
    if (it.type !== 'digest') return true;
    digestsSeen += 1;
    return digestsSeen <= cap;   // newest-first → keep first `cap` digests
  });
}

// Prepend a new item (newest-first).
export function logBroadcast(items, item) {
  return [item, ...(items ?? [])];
}

export async function runOnce(deps) {
  const {
    runIso, watchlist, fetchTender, extractSnapshot,
    loadState, saveState, sendDigest, updateSheet,
    disableTender,
    loadPendingDigest, savePendingDigest, clearPendingDigest,
  } = deps;

  const now = deps.now ?? new Date(runIso);
  const nowMs = now.getTime ? now.getTime() : now;
  let history = (deps.loadNotificationHistory ? (await deps.loadNotificationHistory()).items : []) ?? [];
  if (deps.deleteMessage) {
    history = await expireHistory(history, nowMs, deps.deleteMessage);
  }

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
    // monitoring_started (first-seen baseline) is suppressed from broadcasts: it
    // duplicates the detailed /add reply and the entity-watch announcement. The
    // snapshot is still persisted below (saveState keys off r.events, which keeps
    // monitoring_started), so future diffs have a baseline. Any other first-seen
    // event — e.g. an imminent deadline — is still broadcast.
    const notifyEvents = r.events.filter(e => e.type !== 'monitoring_started');
    if (notifyEvents.length === 0) continue;
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
      events: notifyEvents,
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
      if (watchResult.alerts?.length) {
        // Dedup against the watchlist: a tender already monitored by id would
        // otherwise be double-reported — the entity-watch "🆕 Нове оголошення"
        // alert plus the (richer) watchlist digest. The watchlist wins; suppress
        // the entity alert for any tender_id already on the enabled watchlist.
        const watchlistIds = new Set(enabled.map(w => w.tender_id));
        groups.push(...watchResult.alerts.filter(a => !watchlistIds.has(a.tender_id)));
      }
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

  // Partition errors by nature:
  //  • invalid (404 / not found / no UUID / bad format) — permanent and
  //    actionable (the tender was auto-disabled), so broadcast to everyone.
  //  • transient (network "fetch failed", 5xx) — ops noise. Route to the admin
  //    only; and when EVERY enabled watchlist tender failed transiently, treat
  //    it as a Prozorro/runner outage and stay fully silent (it self-heals next
  //    tick — no point telling anyone, including the admin).
  const invalidErrors = errors.filter(e => e.is_invalid);
  const transientErrors = errors.filter(e => !e.is_invalid);
  const watchlistFetchFailures = results.filter(
    r => r.error && !/(404|not found|no UUID|invalid tender_id format)/i.test(r.error)
  ).length;
  const globalOutage = enabled.length > 0 && watchlistFetchFailures === enabled.length;
  if (globalOutage) {
    console.error(`All ${enabled.length} watchlist tenders failed to fetch — transient outage, staying silent.`);
  }
  const adminErrors = globalOutage ? [] : transientErrors;

  const hasContent = groups.length > 0 || invalidErrors.length > 0;

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
      const nightRec = await sendDigest(
        morningText,
        nightButtons.length > 0 ? { addButtonsForTenders: nightButtons } : undefined,
      );
      if (deps.saveNotificationHistory) {
        history = logBroadcast(history, {
          sent_at: now.toISOString(),
          type: 'digest',
          summary: summarizeDigest(pendingItems),
          text: morningText,
          recipients: nightRec ?? [],
          deleted: false,
        });
      }
      if (clearPendingDigest) await clearPendingDigest();
      nightFlushed = true;
    }
  }

  // Phase B: process current-cycle events

  // Split deadline_approaching events into a separate broadcast.
  // digestGroups = groups with deadline events stripped; empty-events groups excluded
  // from the digest (but kept in groups for quiet-hour buffering via mergePending).
  const deadlineTenders = groups
    .filter((g) => (g.events ?? []).some((e) => e.type === 'deadline_approaching'))
    .map((g) => ({ tender_id: g.tender_id, entity: g.procuring_entity?.name ?? null, deadline: g.deadline ?? null }));
  const digestGroups = groups
    .map((g) => ({ ...g, events: (g.events ?? []).filter((e) => e.type !== 'deadline_approaching') }))
    .filter((g) => g.events.length > 0);

  const isSilent = !hasContent;
  if (!isSilent || archivedNow.length > 0) {
    let text = '';
    if (!isSilent && (digestGroups.length > 0 || invalidErrors.length > 0)) {
      text = formatDigest(runIso, digestGroups);
      if (invalidErrors.length > 0) {
        text += '\n\n⚠️ не вдалось перевірити:\n' +
          invalidErrors.map(e =>
            `  • ${e.tender_id} — не знайдено в Prozorro або невалідний формат, відключено від моніторингу`
          ).join('\n');
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
        groups, archived: archivedNow, errors: invalidErrors, runIso,
      });
      if (savePendingDigest) await savePendingDigest(updated);
    } else {
      // Deadline reminders: sent as a separate message before the main digest.
      if (deadlineTenders.length > 0) {
        const dText = formatDeadlineReminder(deadlineTenders);
        await sendDigest(dText);
      }
      // Main digest — only if there is something to say.
      if (text) {
        const rec = await sendDigest(
          text,
          addButtonsForTenders.length > 0 ? { addButtonsForTenders } : undefined,
        );
        if (deps.saveNotificationHistory) {
          history = logBroadcast(history, {
            sent_at: now.toISOString(),
            type: 'digest',
            summary: summarizeDigest(digestGroups),
            text,
            recipients: rec ?? [],
            deleted: false,
          });
        }
      }
    }
  }

  // Transient fetch errors → admin only, outside quiet hours (self-healing ops
  // noise that nobody needs at 3am). Global outages were already dropped above,
  // and invalid/permanent errors went to everyone in the digest. Best-effort:
  // a failure here must not block state persistence below.
  if (adminErrors.length > 0 && !inQuietWindow && deps.sendAdminAlert) {
    const adminText = '⚠️ Тимчасово не вдалось перевірити (мережа/Prozorro, повтор наступного запуску):\n' +
      adminErrors.map(e => `  • ${e.tender_id} — ${e.error}`).join('\n');
    try {
      await deps.sendAdminAlert(adminText);
    } catch (err) {
      console.error('sendAdminAlert failed:', err.message);
    }
  }

  // Persist state for every tender that produced events — independent of whether
  // this cycle broadcast anything. A monitoring_started-only tender is silent (its
  // event is suppressed above) but still needs its baseline saved, or it would be
  // "first seen" forever. Placed AFTER the broadcast block so a thrown sendDigest
  // aborts runOnce before state advances: a failed delivery must re-fire next run,
  // not be lost. Dedup holds across buffered (quiet-hour) events too.
  const archivedIds = new Set(archivedNow.map(a => a.tender_id));
  await Promise.all(results.map(async r => {
    if (r.error || r.events.length === 0) return;
    if (archivedIds.has(r.row.tender_id)) return;
    await saveState(r.row.tender_id, r.curr);
  }));

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
  const currentCycleBroadcast = !inQuietWindow && (!isSilent || archivedNow.length > 0);
  const anySent = nightFlushed || heartbeatSent || currentCycleBroadcast;
  if (heartbeatDue && anySent && deps.saveHeartbeatDate) {
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

  // Phase F: persist notification history
  if (deps.saveNotificationHistory) {
    await deps.saveNotificationHistory({ items: history });
  }

  return {
    sent: nightFlushed || heartbeatSent || (!inQuietWindow && (!isSilent || archivedNow.length > 0)),
    groups: groups.length,
    errors: errors.length,
    heartbeat: heartbeatSent,
    nightFlushed,
    buffered: inQuietWindow && (!isSilent || archivedNow.length > 0),
  };
}

const AGENT_STALE_MS = 30 * 60 * 1000;

// Pure health-check for agent jobs. Compares job timestamps against nowMs to
// find jobs stuck in pending/running. `alerted` is a { tender_id → iso_ts } map
// of jobs already notified — prevents repeated alerts on subsequent cron ticks.
// Returns { toAlert, alerted } — `alerted` is the updated map (completed/done
// jobs are automatically removed so they can re-alert if requeued later).
export function checkAgentHealth(jobs, alerted, nowMs, { staleMs = AGENT_STALE_MS } = {}) {
  const nextAlerted = {};
  const toAlert = [];

  for (const job of jobs ?? []) {
    const { tender_id, status } = job;
    if (!tender_id || !['pending', 'running'].includes(status)) continue;

    const ts = status === 'running'
      ? (job.updated_at ?? job.created_at)
      : job.created_at;
    if (!ts) continue;

    const ageMs = nowMs - new Date(ts).getTime();
    if (ageMs < staleMs) continue;

    if (!alerted[tender_id]) {
      toAlert.push({ tender_id, status, ageMs });
    }
    nextAlerted[tender_id] = alerted[tender_id] ?? new Date(nowMs).toISOString();
  }

  return { toAlert, alerted: nextAlerted };
}
