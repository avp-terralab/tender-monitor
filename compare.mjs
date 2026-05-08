const DEADLINE_THRESHOLDS = [
  { key: '24h', hours: 24 },
  { key: '12h', hours: 12 },
  { key: '3h', hours: 3 },
];

function computeDeadlineApproaching(prev, curr, runIso) {
  const deadline = curr.tenderPeriod?.endDate;
  if (!deadline || !runIso) return [];
  const ms = new Date(deadline) - new Date(runIso);
  const hoursLeft = ms / 3_600_000;
  if (hoursLeft <= 0) return [];

  const prevDeadline = prev?.tenderPeriod?.endDate ?? null;
  const deadlineChanged = prevDeadline && prevDeadline !== deadline;
  const prevNotified = deadlineChanged ? [] : (prev?._notifiedDeadlines ?? []);

  const events = [];
  for (const t of DEADLINE_THRESHOLDS) {
    if (hoursLeft <= t.hours && !prevNotified.includes(t.key)) {
      events.push({
        type: 'deadline_approaching',
        threshold: t.key,
        hoursLeft: Math.round(hoursLeft * 10) / 10,
        deadline,
      });
    }
  }
  return events;
}

export function diff(prev, curr, runIso = new Date().toISOString()) {
  const events = [];

  // ── Task 1.1: first-time monitoring ───────────────────────────────────────
  if (!prev) {
    events.push({
      type: 'monitoring_started',
      status: curr.status,
      title: curr.title,
      deadline: curr.tenderPeriod?.endDate ?? null,
      docs_count: (curr.documents ?? []).length,
      questions_count: (curr.questions ?? []).length,
      complaints_count: (curr.complaints ?? []).length,
    });
    events.push(...computeDeadlineApproaching(prev, curr, runIso));
    return events;
  }

  // ── Task 1.3: status transitions ─────────────────────────────────────────
  const STATUS_EVENT = {
    'active.pre-qualification': 'prequalification_started',
    'active.auction': 'auction_started',
    'active.qualification': 'qualification_started',
    'active.awarded': 'awarded_phase',
    'cancelled': 'cancelled',
    'unsuccessful': 'unsuccessful',
    'complete': 'complete',
  };
  if (prev.status !== curr.status) {
    events.push({
      type: STATUS_EVENT[curr.status] ?? 'status_changed',
      old: prev.status,
      new: curr.status,
    });
  }

  // ── Task 1.9: complaints + cancellations ─────────────────────────────────
  const allPrevComplaints = [
    ...(prev.complaints ?? []),
    ...((prev.awards ?? []).flatMap(a => a.complaints ?? [])),
  ];
  const allCurrComplaints = [
    ...(curr.complaints ?? []),
    ...((curr.awards ?? []).flatMap(a => a.complaints ?? [])),
  ];
  const prevComplaintsById = new Map(allPrevComplaints.map(c => [c.id, c]));
  for (const c of allCurrComplaints) {
    const prevC = prevComplaintsById.get(c.id);
    if (!prevC) {
      events.push({ type: 'new_complaint', id: c.id, status: c.status });
    } else if (prevC.status !== c.status) {
      events.push({ type: 'complaint_status_changed', id: c.id, old: prevC.status, new: c.status });
    }
  }

  const prevCancellationIds = new Set((prev.cancellations ?? []).map(c => c.id));
  for (const c of (curr.cancellations ?? [])) {
    if (!prevCancellationIds.has(c.id)) {
      events.push({ type: 'cancellation_initiated', id: c.id });
    }
  }

  // ── Task 1.8: contracts lifecycle ─────────────────────────────────────────
  const prevContractMap = new Map((prev.contracts ?? []).map(c => [c.id, c]));
  for (const contract of (curr.contracts ?? [])) {
    const prevContract = prevContractMap.get(contract.id);
    if (!prevContract) {
      events.push({ type: 'contract_created', id: contract.id });
    } else {
      if (prevContract.status !== contract.status) {
        if (contract.status === 'active') events.push({ type: 'contract_signed', id: contract.id });
        else if (contract.status === 'terminated') events.push({ type: 'contract_terminated', id: contract.id });
      }
      const prevDocIds = new Set((prevContract.documents ?? []).map(d => d.id));
      const newDocs = (contract.documents ?? []).filter(d => !prevDocIds.has(d.id));
      if (newDocs.length > 0) {
        events.push({ type: 'contract_documents_added', id: contract.id, count: newDocs.length });
      }
    }
  }

  // ── Task 1.7: awards lifecycle ────────────────────────────────────────────
  const AWARD_EVENT = { active: 'award_qualified', unsuccessful: 'award_disqualified', cancelled: 'award_cancelled' };
  const prevAwardMap = new Map((prev.awards ?? []).map(a => [a.id, a]));
  for (const award of (curr.awards ?? [])) {
    const supplier = award.suppliers?.[0];
    const supplierFields = {
      supplier_name: supplier?.name ?? null,
      supplier_edrpou: supplier?.identifier?.id ?? null,
    };
    const prevAward = prevAwardMap.get(award.id);
    if (!prevAward) {
      events.push({ type: 'award_created', ...supplierFields });
    } else if (prevAward.status !== award.status && AWARD_EVENT[award.status]) {
      events.push({ type: AWARD_EVENT[award.status], ...supplierFields });
    }
  }

  // ── Task 1.6: questions ───────────────────────────────────────────────────
  const prevQMap = new Map((prev.questions ?? []).map(q => [q.id, q]));
  for (const q of (curr.questions ?? [])) {
    const prevQ = prevQMap.get(q.id);
    if (!prevQ) {
      events.push({ type: 'new_question', title: q.title });
    } else if (!prevQ.answer && q.answer) {
      events.push({ type: 'question_answered', title: q.title, answer: q.answer });
    }
  }

  // ── Task 1.5: td_amended (new documents) ─────────────────────────────────
  const prevDocIds = new Set((prev.documents ?? []).map(d => d.id));
  for (const doc of (curr.documents ?? [])) {
    if (!prevDocIds.has(doc.id)) {
      events.push({ type: 'td_amended', title: doc.title, documentType: doc.documentType, datePublished: doc.datePublished });
    }
  }

  // ── Task 1.4: auction scheduled / rescheduled ─────────────────────────────
  const prevAuction = prev.auctionPeriod?.startDate ?? null;
  const currAuction = curr.auctionPeriod?.startDate ?? null;
  if (!prevAuction && currAuction) {
    events.push({ type: 'auction_scheduled', date: currAuction });
  } else if (prevAuction && currAuction && prevAuction !== currAuction) {
    events.push({ type: 'auction_rescheduled', old: prevAuction, new: currAuction });
  }

  // ── Task 1.2: deadline changed ────────────────────────────────────────────
  const prevDeadline = prev.tenderPeriod?.endDate ?? null;
  const currDeadline = curr.tenderPeriod?.endDate ?? null;
  if (prevDeadline !== currDeadline) {
    events.push({ type: 'deadline_changed', old: prevDeadline, new: currDeadline });
  }

  events.push(...computeDeadlineApproaching(prev, curr, runIso));

  return events;
}
