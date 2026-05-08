import { fetchTendersFeed, fetchTender, extractSnapshot } from './prozorro.mjs';

const ALERT_STATUSES = new Set(['active.tendering', 'active.pre-qualification']);
const FEED_PAGE_CAP = 10;

export async function checkWatchedEntities(deps) {
  const {
    watchedEntities,
    loadCursor,
    saveCursor,
    loadSeen,
    saveSeen,
    fetchTendersFeed: _feed = fetchTendersFeed,
    fetchTender: _fetch = fetchTender,
    extractSnapshot: _extract = extractSnapshot,
  } = deps;

  const enabled = (watchedEntities ?? []).filter(e => e.enabled);
  if (enabled.length === 0) return { alerts: [], errors: [] };

  const watchedEdrpous = new Set(enabled.map(e => e.edrpou));
  const cursor = (await loadCursor()) ?? { last_dateModified: null };
  const seen = (await loadSeen()) ?? {};

  const candidates = [];
  let pageCursor = null;
  let newestSeen = cursor.last_dateModified;

  for (let page = 0; page < FEED_PAGE_CAP; page++) {
    let result;
    try {
      result = await _feed({ pageOffset: pageCursor });
    } catch (err) {
      return { alerts: [], errors: [{ source: 'feed', error: err.message }] };
    }
    const { items, next } = result;
    if (items.length === 0) break;
    if (page === 0 && items[0].dateModified) newestSeen = items[0].dateModified;
    let reachedCursor = false;
    for (const item of items) {
      if (cursor.last_dateModified && item.dateModified <= cursor.last_dateModified) {
        reachedCursor = true;
        break;
      }
      const edrpou = item.procuringEntity?.identifier?.id;
      if (edrpou && watchedEdrpous.has(edrpou)) candidates.push(item);
    }
    if (reachedCursor) break;
    pageCursor = next;
    if (!pageCursor) break;
  }

  const alerts = [];
  const errors = [];
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
    } catch (err) {
      errors.push({ tender_id: cand.tenderID, error: err.message });
    }
  }

  await saveCursor({ last_dateModified: newestSeen });
  await saveSeen(seen);
  return { alerts, errors };
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
