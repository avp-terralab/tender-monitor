import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diff } from '../compare.mjs';

const snap = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

const clone = (obj) => JSON.parse(JSON.stringify(obj));

// snap_initial fixture has tenderPeriod.endDate = 2026-05-15T14:00+03. Tests that don't care
// about deadline_approaching must pass a runIso far enough before that to keep all thresholds
// (24h/12h/3h) silent — otherwise they become time-bombs once wall-clock approaches the fixture
// date. SAFE_RUN_ISO sits 14 days before the fixture deadline.
const SAFE_RUN_ISO = '2026-05-01T00:00:00Z';

// ─── Task 1.1 ─────────────────────────────────────────────────────────────────
test('diff(null, initial): returns monitoring_started', () => {
  const curr = snap('snap_initial');
  const events = diff(null, curr, SAFE_RUN_ISO);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'monitoring_started');
  assert.equal(events[0].status, 'active.tendering');
  assert.equal(events[0].deadline, '2026-05-15T14:00:00+03:00');
});

// ─── Task 1.2 ─────────────────────────────────────────────────────────────────
test('diff(initial, deadline_changed): returns deadline_changed', () => {
  const prev = snap('snap_initial');
  const curr = snap('snap_deadline_changed');
  // SAFE_RUN_ISO needed: snap_deadline_changed has endDate 2026-05-20; without explicit runIso
  // this test would start failing on 2026-05-19 once wall-clock crosses the 24h threshold.
  const events = diff(prev, curr, SAFE_RUN_ISO);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'deadline_changed');
  assert.equal(events[0].old, '2026-05-15T14:00:00+03:00');
  assert.equal(events[0].new, '2026-05-20T14:00:00+03:00');
});

// ─── Task 1.4 ─────────────────────────────────────────────────────────────────
test('diff: null auction → date produces auction_scheduled', () => {
  const prev = snap('snap_initial'); // auctionPeriod: null
  const curr = clone(prev);
  curr.auctionPeriod = { startDate: '2026-05-16T12:00:00+03:00' };
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'auction_scheduled');
  assert.ok(e, `Expected auction_scheduled in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.date, '2026-05-16T12:00:00+03:00');
});

test('diff: date1 auction → date2 produces auction_rescheduled', () => {
  const prev = clone(snap('snap_initial'));
  prev.auctionPeriod = { startDate: '2026-05-16T12:00:00+03:00' };
  const curr = clone(prev);
  curr.auctionPeriod = { startDate: '2026-05-18T12:00:00+03:00' };
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'auction_rescheduled');
  assert.ok(e, `Expected auction_rescheduled in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.old, '2026-05-16T12:00:00+03:00');
  assert.equal(e.new, '2026-05-18T12:00:00+03:00');
});

// ─── Task 1.10 ────────────────────────────────────────────────────────────────
test('noise filter: bumped dateModified only → []', () => {
  const prev = snap('snap_initial');
  const curr = clone(prev);
  curr.dateModified = '2026-05-04T10:00:00+03:00'; // only timestamp change
  const events = diff(prev, curr, SAFE_RUN_ISO);
  assert.equal(events.length, 0, `Expected [] but got ${JSON.stringify(events)}`);
});

test('noise filter: deep-equal snapshot → []', () => {
  const prev = snap('snap_initial');
  const curr = clone(prev); // identical deep copy, same dateModified
  const events = diff(prev, curr, SAFE_RUN_ISO);
  assert.equal(events.length, 0, `Expected [] but got ${JSON.stringify(events)}`);
});

// ─── Task 1.9 ─────────────────────────────────────────────────────────────────
test('diff: new complaint on tender level → new_complaint', () => {
  const prev = snap('snap_initial'); // complaints: []
  const curr = clone(prev);
  curr.complaints = [{ id: 'cmp1', status: 'pending', type: 'complaint' }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'new_complaint');
  assert.ok(e, `Expected new_complaint in ${JSON.stringify(events.map(x => x.type))}`);
});

test('diff: new complaint on award → new_complaint (flattened)', () => {
  const prev = clone(snap('snap_initial'));
  prev.awards = [{ id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }], complaints: [] }];
  const curr = clone(prev);
  curr.awards = [{ id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }], complaints: [{ id: 'awcmp1', status: 'pending' }] }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'new_complaint');
  assert.ok(e, `Expected new_complaint in ${JSON.stringify(events.map(x => x.type))}`);
});

test('diff: new cancellation → cancellation_initiated', () => {
  const prev = snap('snap_initial'); // cancellations: []
  const curr = clone(prev);
  curr.cancellations = [{ id: 'cn1', status: 'pending' }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'cancellation_initiated');
  assert.ok(e, `Expected cancellation_initiated in ${JSON.stringify(events.map(x => x.type))}`);
});

// ─── Task 1.8 ─────────────────────────────────────────────────────────────────
test('diff: new contract → contract_created', () => {
  const prev = snap('snap_initial'); // contracts: []
  const curr = clone(prev);
  curr.contracts = [{ id: 'c1', status: 'pending', documents: [] }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'contract_created');
  assert.ok(e, `Expected contract_created in ${JSON.stringify(events.map(x => x.type))}`);
});

test('diff: contract pending → active → contract_signed', () => {
  const prev = clone(snap('snap_initial'));
  prev.contracts = [{ id: 'c1', status: 'pending', documents: [] }];
  const curr = clone(prev);
  curr.contracts = [{ id: 'c1', status: 'active', documents: [] }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'contract_signed');
  assert.ok(e, `Expected contract_signed in ${JSON.stringify(events.map(x => x.type))}`);
});

test('diff: contract gets additional document → contract_documents_added with count', () => {
  const prevDoc = { id: 'cd1', title: 'Договір', documentType: 'contractSigned', datePublished: '2026-05-20T10:00:00+03:00' };
  const newDoc  = { id: 'cd2', title: 'Додаток до договору', documentType: 'contractAnnexe', datePublished: '2026-05-21T10:00:00+03:00' };
  const prev = clone(snap('snap_initial'));
  prev.contracts = [{ id: 'c1', status: 'active', documents: [prevDoc] }];
  const curr = clone(prev);
  curr.contracts = [{ id: 'c1', status: 'active', documents: [prevDoc, newDoc] }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'contract_documents_added');
  assert.ok(e, `Expected contract_documents_added in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.count, 1);
});

// ─── Task 1.7 ─────────────────────────────────────────────────────────────────
test('diff: new award → award_created with supplier info', () => {
  const prev = snap('snap_initial'); // awards: []
  const curr = clone(prev);
  curr.awards = [{
    id: 'a1',
    status: 'pending',
    suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }],
    complaints: [],
  }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'award_created');
  assert.ok(e, `Expected award_created in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.supplier_name, 'ТОВ ТерраЛаб');
  assert.equal(e.supplier_edrpou, '12345678');
});

test('diff: award pending → active → award_qualified with supplier info', () => {
  const prev = clone(snap('snap_initial'));
  prev.awards = [{ id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }], complaints: [] }];
  const curr = clone(prev);
  curr.awards = [{ id: 'a1', status: 'active', suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }], complaints: [] }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'award_qualified');
  assert.ok(e, `Expected award_qualified in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.supplier_name, 'ТОВ ТерраЛаб');
  assert.equal(e.supplier_edrpou, '12345678');
});

test('diff: award pending → unsuccessful → award_disqualified with supplier info', () => {
  const prev = clone(snap('snap_initial'));
  prev.awards = [{ id: 'a1', status: 'pending', suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }], complaints: [] }];
  const curr = clone(prev);
  curr.awards = [{ id: 'a1', status: 'unsuccessful', suppliers: [{ name: 'ТОВ ТерраЛаб', identifier: { id: '12345678' } }], complaints: [] }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'award_disqualified');
  assert.ok(e, `Expected award_disqualified in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.supplier_name, 'ТОВ ТерраЛаб');
  assert.equal(e.supplier_edrpou, '12345678');
});

// ─── Task 1.6 ─────────────────────────────────────────────────────────────────
test('diff: new question → new_question event with title', () => {
  const prev = snap('snap_initial'); // questions: []
  const curr = clone(prev);
  curr.questions = [{ id: 'q1', title: 'Чи можна подавати ФОП?', answer: null }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'new_question');
  assert.ok(e, `Expected new_question in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.title, 'Чи можна подавати ФОП?');
});

test('diff: existing question gets answer → question_answered event', () => {
  const prev = clone(snap('snap_initial'));
  prev.questions = [{ id: 'q1', title: 'Чи можна подавати ФОП?', answer: null }];
  const curr = clone(prev);
  curr.questions = [{ id: 'q1', title: 'Чи можна подавати ФОП?', answer: 'Так, ФОП може подавати.' }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'question_answered');
  assert.ok(e, `Expected question_answered in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.answer, 'Так, ФОП може подавати.');
  assert.equal(e.title, 'Чи можна подавати ФОП?');
});

// ─── Task 1.5 ─────────────────────────────────────────────────────────────────
test('diff: new document in tender.documents → td_amended', () => {
  const prev = snap('snap_initial'); // documents: []
  const curr = clone(prev);
  curr.documents = [{
    id: 'doc1',
    title: 'Виправлення ТД №1',
    documentType: 'tenderNotice',
    datePublished: '2026-05-02T12:00:00+03:00',
  }];
  const events = diff(prev, curr);
  const e = events.find(e => e.type === 'td_amended');
  assert.ok(e, `Expected td_amended in ${JSON.stringify(events.map(x => x.type))}`);
  assert.equal(e.title, 'Виправлення ТД №1');
  assert.equal(e.documentType, 'tenderNotice');
  assert.equal(e.datePublished, '2026-05-02T12:00:00+03:00');
});

// ─── Task 1.3 ─────────────────────────────────────────────────────────────────
test('diff(initial, qualification): contains qualification_started', () => {
  const prev = snap('snap_initial');
  const curr = snap('snap_status_qualification');
  const events = diff(prev, curr);
  const types = events.map(e => e.type);
  assert.ok(types.includes('qualification_started'), `Expected qualification_started in ${JSON.stringify(types)}`);
});

test('diff(qualification, complete): contains complete', () => {
  const prev = snap('snap_status_qualification');
  const curr = snap('snap_status_complete');
  const events = diff(prev, curr);
  const types = events.map(e => e.type);
  assert.ok(types.includes('complete'), `Expected complete in ${JSON.stringify(types)}`);
});

test('diff(initial, initial-with-bumped-dateModified): returns []', () => {
  const prev = snap('snap_initial');
  const curr = clone(prev);
  curr.dateModified = '2026-05-03T10:00:00+03:00';
  const events = diff(prev, curr, SAFE_RUN_ISO);
  assert.equal(events.length, 0);
});

// ─── Fix 1: contract_terminated ───────────────────────────────────────────────
test('diff: contract_terminated (active → terminated)', () => {
  const prev = JSON.parse(JSON.stringify(snap('snap_initial')));
  prev.contracts = [{ id: 'c1', status: 'active', documents: [] }];
  const curr = JSON.parse(JSON.stringify(prev));
  curr.contracts[0].status = 'terminated';
  const events = diff(prev, curr);
  assert.ok(events.some(e => e.type === 'contract_terminated'),
    `expected contract_terminated, got: ${JSON.stringify(events)}`);
});

// ─── Fix 2: complaint_status_changed ──────────────────────────────────────────
test('diff: complaint_status_changed (existing complaint changes status)', () => {
  const prev = JSON.parse(JSON.stringify(snap('snap_initial')));
  prev.complaints = [{ id: 'cmp1', status: 'pending', type: 'complaint' }];
  const curr = JSON.parse(JSON.stringify(prev));
  curr.complaints[0].status = 'satisfied';
  const events = diff(prev, curr);
  const e = events.find(x => x.type === 'complaint_status_changed');
  assert.ok(e, `expected complaint_status_changed, got: ${JSON.stringify(events)}`);
  assert.equal(e.old, 'pending');
  assert.equal(e.new, 'satisfied');
});

// ─── Change 2: pre-existing counts on monitoring_started ─────────────────────
test('diff: monitoring_started includes pre-existing counts', () => {
  const curr = JSON.parse(JSON.stringify(snap('snap_initial')));
  curr.documents = [{ id: 'd1' }, { id: 'd2' }];
  curr.questions = [{ id: 'q1', answer: null }];
  const events = diff(null, curr);
  assert.equal(events[0].docs_count, 2);
  assert.equal(events[0].questions_count, 1);
  assert.equal(events[0].complaints_count, 0);
});

test('diff: complaint_status_changed on award-level complaint', () => {
  const prev = JSON.parse(JSON.stringify(snap('snap_initial')));
  prev.awards = [{
    id: 'a1', status: 'active',
    suppliers: [{ name: 'X', identifier: { id: '1' } }],
    complaints: [{ id: 'awcmp1', status: 'pending' }],
  }];
  const curr = JSON.parse(JSON.stringify(prev));
  curr.awards[0].complaints[0].status = 'declined';
  const events = diff(prev, curr);
  assert.ok(events.some(e => e.type === 'complaint_status_changed' && e.old === 'pending' && e.new === 'declined'));
});

// ─── deadline_approaching ────────────────────────────────────────────────────
const baseSnap = (deadline) => ({
  status: 'active.tendering',
  title: 'X',
  dateModified: '2026-05-01',
  tenderPeriod: { endDate: deadline },
  documents: [], questions: [], complaints: [], awards: [], contracts: [], cancellations: [],
});

test('diff: deadline_approaching emits 24h when 23h left and not previously notified', () => {
  const now = '2026-05-15T15:00:00Z';
  const deadline = '2026-05-16T14:00:00Z'; // ~23h ahead
  const prev = baseSnap(deadline);
  const curr = clone(prev);
  curr.dateModified = '2026-05-15T15:00:00Z';
  const events = diff(prev, curr, now);
  const e = events.find(x => x.type === 'deadline_approaching');
  assert.ok(e, `expected deadline_approaching, got ${JSON.stringify(events)}`);
  assert.equal(e.threshold, '24h');
  assert.equal(e.deadline, deadline);
});

test('diff: deadline_approaching emits 24h+12h+3h when only 2h left and never notified', () => {
  const now = '2026-05-16T12:00:00Z';
  const deadline = '2026-05-16T14:00:00Z'; // 2h ahead
  const prev = baseSnap(deadline);
  const curr = clone(prev); curr.dateModified = '2026-05-16T12:00:00Z';
  const events = diff(prev, curr, now);
  const thresholds = events.filter(x => x.type === 'deadline_approaching').map(x => x.threshold);
  assert.deepEqual(thresholds, ['24h', '12h', '3h']);
});

test('diff: deadline_approaching does NOT re-emit thresholds already in _notifiedDeadlines', () => {
  const now = '2026-05-16T12:00:00Z';
  const deadline = '2026-05-16T14:00:00Z'; // 2h ahead
  const prev = { ...baseSnap(deadline), _notifiedDeadlines: ['24h', '12h'] };
  const curr = clone(prev); curr.dateModified = '2026-05-16T12:00:00Z';
  const events = diff(prev, curr, now);
  const thresholds = events.filter(x => x.type === 'deadline_approaching').map(x => x.threshold);
  assert.deepEqual(thresholds, ['3h']);
});

test('diff: deadline_approaching not emitted after deadline (negative hoursLeft)', () => {
  const now = '2026-05-16T16:00:00Z';
  const deadline = '2026-05-16T14:00:00Z'; // 2h ago
  const prev = baseSnap(deadline);
  const curr = clone(prev); curr.dateModified = '2026-05-16T16:00:00Z';
  const events = diff(prev, curr, now);
  assert.equal(events.filter(e => e.type === 'deadline_approaching').length, 0);
});

test('diff: deadline_approaching re-fires after deadline_changed (notified reset)', () => {
  const now = '2026-05-16T12:00:00Z';
  const oldDeadline = '2026-05-16T13:00:00Z'; // already in past for the prev side
  const newDeadline = '2026-05-16T14:00:00Z'; // 2h ahead in current
  const prev = { ...baseSnap(oldDeadline), _notifiedDeadlines: ['24h', '12h', '3h'] };
  const curr = baseSnap(newDeadline);
  curr.dateModified = '2026-05-16T12:00:00Z';
  const events = diff(prev, curr, now);
  // deadline_changed fires + deadline_approaching for all three thresholds again
  assert.ok(events.some(e => e.type === 'deadline_changed'));
  const thresholds = events.filter(x => x.type === 'deadline_approaching').map(x => x.threshold);
  assert.deepEqual(thresholds, ['24h', '12h', '3h']);
});

test('diff: monitoring_started + deadline_approaching when freshly added near deadline', () => {
  const now = '2026-05-16T12:00:00Z';
  const deadline = '2026-05-16T14:00:00Z'; // 2h ahead
  const curr = baseSnap(deadline);
  const events = diff(null, curr, now);
  assert.equal(events[0].type, 'monitoring_started');
  const thresholds = events.filter(x => x.type === 'deadline_approaching').map(x => x.threshold);
  assert.deepEqual(thresholds, ['24h', '12h', '3h']);
});

test('diff: deadline_approaching ignored when no deadline on snapshot', () => {
  const now = '2026-05-16T12:00:00Z';
  const noDeadline = { ...baseSnap('2026-05-16T14:00:00Z'), tenderPeriod: null };
  const prev = clone(noDeadline);
  const curr = clone(noDeadline);
  curr.dateModified = '2026-05-16T12:00:00Z';
  const events = diff(prev, curr, now);
  assert.equal(events.filter(e => e.type === 'deadline_approaching').length, 0);
});
