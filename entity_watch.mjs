import { fetchTendersChangesFeed, fetchTendersFeed, fetchTender, extractSnapshot, searchTenderByEdrpou } from './prozorro.mjs';

const ALERT_STATUSES = new Set(['active.tendering', 'active.pre-qualification']);
// Default CPV (ДК 021:2015) prefix whitelist for alert generation. 48 = software packages
// and information systems; 72 = IT services. Tenders whose items contain none of these
// codes are silently skipped — TerraLab's business is purely software/IT, so other
// categories are noise.
//
// Per-entity override: a row in watched_entities.json may set "cpv_prefixes": ["33", ...]
// to use a different whitelist for that EDRPOU only. Useful when watching an entity
// whose relevant tenders fall outside the default 48/72 (e.g. a defense contractor).
const RELEVANT_CPV_PREFIXES = ['48', '72'];
// Safety cap on forward feed pagination — 500 pages × 100 items = 50000 tenders ≈ 2.5–4 days
// of publishing. With hourly cron a tick reads ~5 pages on the happy path; the cap is a
// safety net for GitHub Actions schedule drops (free-tier may skip several consecutive ticks)
// and cold-start recovery. Was 100 (~19h coverage); raised after a missed-tick backlog left
// the cursor short of a freshly-published watched-entity tender.
const FEED_PAGE_CAP = 500;
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
    searchTenderByEdrpou: _search = searchTenderByEdrpou,
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
      // Learn the entity name regardless of CPV — even if we'll silently skip the alert
      // because the tender's CPV is irrelevant, the snapshot's procuringEntity.name is
      // still authoritative for resolving "(unknown)".
      const watchedRow = watchedByEdrpou.get(edrpou);
      if (watchedRow && (!watchedRow.name || watchedRow.name === '(unknown)') && snap.procuringEntity?.name) {
        discoveredNames[edrpou] = snap.procuringEntity.name;
      }
      const prefixes = watchedRow?.cpv_prefixes ?? RELEVANT_CPV_PREFIXES;
      if (!hasRelevantCpv(snap.classification_ids ?? [], prefixes)) continue;
      alerts.push(buildAlertGroup(snap));
      seen[edrpou] = [...seenForEntity, cand.tenderID];
    } catch (err) {
      errors.push({ tender_id: cand.tenderID, error: err.message });
    }
  }

  // Step 3 — BFF name-resolve: for each still-unknown entity (no name from feed
  // walk OR backfill), try the BFF text-search to pull legalName from historical
  // Prozorro data. Cheap (one HTTP per still-unknown entity per tick) and
  // self-extinguishing — once name is resolved, this loop skips that entity
  // on future ticks because it's no longer "(unknown)".
  if (_search) {
    for (const entity of unknownEntities) {
      if (discoveredNames[entity.edrpou]) continue;
      const { name } = await _search(entity.edrpou);
      if (name) discoveredNames[entity.edrpou] = name;
    }
  }

  await saveCursor({ offset: lastOffset });
  await saveSeen(seen);
  return { alerts, errors, discoveredNames };
}

function hasRelevantCpv(cpvIds, prefixes) {
  return cpvIds.some(cpv => prefixes.some(p => cpv.startsWith(p)));
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
