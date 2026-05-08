const pickDoc = (d) => ({
  id: d.id,
  title: d.title,
  documentType: d.documentType ?? null,
  datePublished: d.datePublished,
});

const pickQuestion = (q) => ({
  id: q.id,
  title: q.title,
  answer: q.answer ?? null,
});

const pickComplaint = (c) => ({
  id: c.id,
  status: c.status,
  type: c.type ?? null,
});

const pickAward = (a) => ({
  id: a.id,
  status: a.status,
  suppliers: (a.suppliers ?? []).map((s) => ({
    name: s.name,
    identifier: { id: s.identifier?.id ?? null },
  })),
  complaints: (a.complaints ?? []).map(pickComplaint),
});

const pickContract = (c) => ({
  id: c.id,
  status: c.status,
  documents: (c.documents ?? []).map(pickDoc),
});

const pickCancellation = (c) => ({
  id: c.id,
  status: c.status,
});

export function extractSnapshot(raw) {
  const t = raw?.data ?? raw;
  return {
    tender_id: t.tenderID,
    title: t.title,
    status: t.status,
    dateModified: t.dateModified,
    tenderPeriod: t.tenderPeriod?.endDate
      ? { endDate: t.tenderPeriod.endDate }
      : null,
    auctionPeriod: t.auctionPeriod?.startDate
      ? { startDate: t.auctionPeriod.startDate }
      : null,
    procuringEntity: t.procuringEntity?.name
      ? {
          name: t.procuringEntity.name,
          edrpou: t.procuringEntity.identifier?.id ?? null,
        }
      : null,
    value: t.value?.amount != null
      ? {
          amount: t.value.amount,
          currency: t.value.currency,
          valueAddedTaxIncluded: t.value.valueAddedTaxIncluded ?? false,
        }
      : null,
    procurementMethodType: t.procurementMethodType ?? null,
    classification: t.items?.[0]?.classification?.id
      ? {
          id: t.items[0].classification.id,
          description: t.items[0].classification.description ?? null,
          scheme: t.items[0].classification.scheme ?? null,
        }
      : null,
    contact: t.procuringEntity?.contactPoint?.name
      ? {
          name: t.procuringEntity.contactPoint.name,
          email: t.procuringEntity.contactPoint.email ?? null,
          telephone: t.procuringEntity.contactPoint.telephone ?? null,
        }
      : null,
    documents: (t.documents ?? []).map(pickDoc),
    questions: (t.questions ?? []).map(pickQuestion),
    complaints: (t.complaints ?? []).map(pickComplaint),
    awards: (t.awards ?? []).map(pickAward),
    contracts: (t.contracts ?? []).map(pickContract),
    cancellations: (t.cancellations ?? []).map(pickCancellation),
  };
}

export async function fetchTender(tenderId) {
  // Step 1: tenderID -> UUID
  const summaryRes = await fetch(
    `https://prozorro.gov.ua/api/tenders/${encodeURIComponent(tenderId)}/summary`
  );
  if (!summaryRes.ok) {
    throw new Error(`Prozorro summary ${summaryRes.status}: ${tenderId}`);
  }
  const summary = await summaryRes.json();
  const uuid = summary.id;
  if (!uuid) {
    throw new Error(`Prozorro: no UUID returned for ${tenderId}`);
  }
  // Step 2: UUID -> full tender
  const cdbRes = await fetch(
    `https://public-api.prozorro.gov.ua/api/2.5/tenders/${uuid}`
  );
  if (!cdbRes.ok) {
    throw new Error(`Prozorro CDB ${cdbRes.status}: ${uuid}`);
  }
  return cdbRes.json(); // {data: {...}}
}

export async function fetchTendersFeed({ pageOffset = null, fetch: fetchImpl = fetch } = {}) {
  const base = 'https://public.api.openprocurement.org/api/2.5/tenders';
  const opts = 'opt_fields=tenderID,procuringEntity,dateModified,dateCreated&descending=1&limit=100';
  const url = pageOffset ? `${base}${pageOffset.replace(/^\/api\/2\.5\/tenders/, '')}` : `${base}?${opts}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Prozorro feed ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return { items: json.data ?? [], next: json.next_page?.path ?? null };
}
