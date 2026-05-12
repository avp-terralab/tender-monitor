import { fetchTendersChangesFeed, fetchTendersFeed, fetchTender, extractSnapshot } from './prozorro.mjs';

const ALERT_STATUSES = new Set(['active.tendering', 'active.pre-qualification']);
// Safety cap on forward feed pagination — 100 pages × 100 items = 10000 tenders ≈ 12-15h of
// publishing on a busy day. A typical tick (every few hours) reads 1-2 pages; the cap only
// matters as a safety net for very long downtime / cold-start recovery.
const FEED_PAGE_CAP = 100;
// Per-entity backfill: descending walk of 10 pages (~1000 tenders, ~1.5h of publishing).
// Runs only for entities with name="(unknown)" — i.e. before we've ever resolved a tender
// for them. Closes the gap where /watch <edrpou> happens BEFORE the entity publishes
// (forward feed only catches future publications).
const BACKFILL_PAGE_CAP = 10;

export async function checkWatchedEntities(deps) {
  const {
    watchedEntities,
    loadCursor,
    saveCursor,
    loadSeen,
    saveSeen,
    fetchChangesFeed: _feed = fetchTendersChangesFeed,
    fetchDescendingFeed: _descFeed = fetchTendersFeed,
    fetchTender: _fetch = fetchTender,
    extractSnapshot: _extract = extractSnapshot,
  } = deps;

  const enabled = (watchedEntities ?? []).filter(e => e.enabled);
  if (enabled.length === 0) return { alerts: [], errors: [] };

  const watchedEdrpous = new Set(enabled.map(e => e.edrpou));
  const rawCursor = await loadCursor();
  const seen = (await loadSeen()) ?? {};

  // Forward feed cursor. Resume formats, in priority order:
  //   1. { offset: "<opaque>" } — written by previous tick
  //   2. { last_dateModified: "<ISO>" } — legacy descending-feed cursor; convert to
  //      unix-seconds, which Prozorro accepts as a coarse offset (microsec.shard.hash
  //      defaults to 0 → API returns items strictly after that second).
  //   3. null — cold start (first tick ever / fresh deploy); read from start
  let offset = rawCursor?.offset
    ?? (rawCursor?.last_dateModified
        ? String(Math.floor(new Date(rawCursor.last_dateModified).getTime() / 1000))
        : null);
  let lastOffset = offset;

  const candidates = [];
  const errors = [];

  for (let page = 0; page < FEED_PAGE_CAP; page++) {
    let result;
    try {
      result = await _feed({ offset });
    } catch (err) {
      return { alerts: [], errors: [{ source: 'feed', error: err.message }] };
    }
    const { items, nextOffset } = result;
    for (const item of items) {
      const edrpou = item.procuringEntity?.identifier?.id;
      if (edrpou && watchedEdrpous.has(edrpou)) candidates.push(item);
    }
    if (nextOffset) lastOffset = nextOffset;
    if (items.length === 0) break;
    if (!nextOffset) break;
    offset = nextOffset;
  }

  // Backfill: for each enabled entity whose name we haven't resolved yet,
  // do a per-entity descending walk to catch tenders published BEFORE the
  // forward cursor was set (e.g. before /watch or before the first tick).
  // Disables itself automatically once name resolves (no longer "(unknown)").
  const unknownEntities = enabled.filter(e => !e.name || e.name === '(unknown)');
  for (const entity of unknownEntities) {
    let pageOffset = null;
    for (let page = 0; page < BACKFILL_PAGE_CAP; page++) {
      let result;
      try {
        result = await _descFeed({ pageOffset });
      } catch (err) {
        errors.push({ source: 'backfill', edrpou: entity.edrpou, error: err.message });
        break;
      }
      const { items, next } = result;
      if (items.length === 0) break;
      for (const item of items) {
        if (item.procuringEntity?.identifier?.id === entity.edrpou) candidates.push(item);
      }
      if (!next) break;
      pageOffset = next;
    }
  }

  const alerts = [];
  // Lazy-resolve names: when we fetch a tender for an entity whose stored name is "(unknown)",
  // capture the real name so the caller can persist it back to watched_entities.json.
  const discoveredNames = {};
  const watchedByEdrpou = new Map((watchedEntities ?? []).map(e => [e.edrpou, e]));
  for (const cand of candidates) {
    const edrpou = cand.procuringEntity.identifier.id;
    const seenForEntity = new Set(seen[edrpou] ?? []);
    if (seenForEntity.has(cand.tenderID)) continue;
    try {
      const raw = await _fetch(cand.tenderID);
      const snap = _extract(raw);
      if (!ALERT_STATUSES.has(snap.status)) continue;
      alerts.push(buildAlertGroup(snap));
      seen[edrpou] = [...seenForEntity, cand.tenderID];
      const watchedRow = watchedByEdrpou.get(edrpou);
      if (watchedRow && (!watchedRow.name || watchedRow.name === '(unknown)') && snap.procuringEntity?.name) {
        discoveredNames[edrpou] = snap.procuringEntity.name;
      }
    } catch (err) {
      errors.push({ tender_id: cand.tenderID, error: err.message });
    }
  }

  await saveCursor({ offset: lastOffset });
  await saveSeen(seen);
  return { alerts, errors, discoveredNames };
}

function buildAlertGroup(snap) {
  return {
    tender_id: snap.tender_id,
    title: snap.title,
    status: snap.status,
    deadline: snap.tenderPeriod?.endDate ?? null,
    procuring_entity: snap.procuringEntity,
    value: snap.value,
    classification: snap.classification,
    contact: snap.contact,
    procurement_method_type: snap.procurementMethodType,
    prozorro_url: `https://prozorro.gov.ua/tender/${snap.tender_id}`,
    events: [{ type: 'new_tender_announced' }],
  };
}
