import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractSnapshot } from '../prozorro.mjs';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/raw_prozorro_response.json', import.meta.url))
);

test('extractSnapshot accepts wrapped {data: ...}', () => {
  const snap = extractSnapshot(raw);
  assert.equal(typeof snap.status, 'string');
  assert.equal(typeof snap.title, 'string');
  assert.equal(typeof snap.dateModified, 'string');
  assert.equal(snap.tender_id, 'UA-2026-04-30-010542-a');
});

test('extractSnapshot accepts unwrapped data directly', () => {
  const snap = extractSnapshot(raw.data);
  assert.equal(snap.tender_id, 'UA-2026-04-30-010542-a');
});

test('extractSnapshot returns arrays for all listing fields', () => {
  const snap = extractSnapshot(raw);
  for (const key of ['documents', 'questions', 'complaints', 'awards', 'contracts', 'cancellations']) {
    assert.ok(Array.isArray(snap[key]), `${key} must be array, got ${typeof snap[key]}`);
  }
});

test('extractSnapshot keeps only required document keys', () => {
  const snap = extractSnapshot(raw);
  for (const d of snap.documents) {
    assert.deepEqual(
      Object.keys(d).sort(),
      ['datePublished', 'documentType', 'id', 'title']
    );
  }
});

test('extractSnapshot tenderPeriod is {endDate} or null', () => {
  const snap = extractSnapshot(raw);
  if (snap.tenderPeriod !== null) {
    assert.equal(typeof snap.tenderPeriod.endDate, 'string');
    assert.deepEqual(Object.keys(snap.tenderPeriod), ['endDate']);
  }
});

test('extractSnapshot synthesises empty arrays when fields missing', () => {
  const partialRaw = {
    data: {
      tenderID: 'UA-X', title: 'X', status: 'active.tendering',
      dateModified: '2026-01-01',
      // no documents, questions, awards, contracts, cancellations, complaints
    },
  };
  const snap = extractSnapshot(partialRaw);
  assert.deepEqual(snap.documents, []);
  assert.deepEqual(snap.questions, []);
  assert.deepEqual(snap.awards, []);
  assert.deepEqual(snap.contracts, []);
  assert.deepEqual(snap.cancellations, []);
  assert.deepEqual(snap.complaints, []);
});

test('extractSnapshot supplier shape preserved for awards', () => {
  // synthetic award since fixture is active.tendering
  const synthetic = {
    data: {
      tenderID: 'UA-X', title: 'X', status: 'complete',
      dateModified: '2026-01-01',
      awards: [{
        id: 'a1', status: 'active',
        suppliers: [{
          name: 'ТОВ ТерраЛаб',
          identifier: { id: '12345678', scheme: 'UA-EDR' },
          contactPoint: { name: 'X', email: 'x@y.com' },
        }],
        complaints: [],
      }],
    },
  };
  const snap = extractSnapshot(synthetic);
  assert.equal(snap.awards.length, 1);
  assert.equal(snap.awards[0].suppliers[0].name, 'ТОВ ТерраЛаб');
  assert.equal(snap.awards[0].suppliers[0].identifier.id, '12345678');
  // contactPoint should NOT be in the slim snapshot
  assert.equal(snap.awards[0].suppliers[0].contactPoint, undefined);
});
