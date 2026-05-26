import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractSnapshot, fetchTender } from '../prozorro.mjs';

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

import { fetchTendersFeed, fetchTendersChangesFeed, searchTenderByEdrpou } from '../prozorro.mjs';

test('searchTenderByEdrpou: POSTs to /api/search/tenders with text=edrpou', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        total: 1, data: [{
          procuringEntity: { identifier: { id: '02071091', legalName: 'Одеський університет' } },
        }],
      }),
    };
  };
  const result = await searchTenderByEdrpou('02071091', { fetch: fakeFetch });
  assert.equal(calls[0].url, 'https://prozorro.gov.ua/api/search/tenders');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.text, '02071091');
  assert.equal(result.name, 'Одеський університет');
});

test('searchTenderByEdrpou: returns null when first match has different EDRPOU', async () => {
  // text-search is full-text — a non-existent EDRPOU may surface unrelated tenders
  // that merely mention the digits. Only trust the result when first hit's EDRPOU matches.
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      total: 5, data: [{
        procuringEntity: { identifier: { id: '99999999', legalName: 'Інший замовник' } },
      }],
    }),
  });
  const result = await searchTenderByEdrpou('12345678', { fetch: fakeFetch });
  assert.equal(result.name, null);
});

test('searchTenderByEdrpou: returns null when no results', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ total: 0, data: [] }),
  });
  const result = await searchTenderByEdrpou('99999999', { fetch: fakeFetch });
  assert.equal(result.name, null);
});

test('searchTenderByEdrpou: prefers legalName but falls back to name when legalName missing', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      total: 1, data: [{
        procuringEntity: {
          name: 'Display name',
          identifier: { id: '02071091' },
        },
      }],
    }),
  });
  const result = await searchTenderByEdrpou('02071091', { fetch: fakeFetch });
  assert.equal(result.name, 'Display name');
});

test('searchTenderByEdrpou: returns null on non-ok HTTP response (does not throw)', async () => {
  // BFF search is a soft enrichment — failure should degrade gracefully, not break /watch.
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'oops' });
  const result = await searchTenderByEdrpou('02071091', { fetch: fakeFetch });
  assert.equal(result.name, null);
});

test('searchTenderByEdrpou: returns null on network error (does not throw)', async () => {
  const fakeFetch = async () => { throw new Error('ENOTFOUND'); };
  const result = await searchTenderByEdrpou('02071091', { fetch: fakeFetch });
  assert.equal(result.name, null);
});

test('fetchTendersChangesFeed: builds initial URL without offset, no descending', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        data: [{ tenderID: 'UA-A', dateModified: '2026-05-12T10:00:00Z' }],
        next_page: { offset: '1715000000.123.1.abc' },
      }),
    };
  };
  const result = await fetchTendersChangesFeed({ fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/public\.api\.openprocurement\.org\/api\/2\.5\/tenders\?/);
  assert.match(calls[0], /opt_fields=tenderID/);
  assert.match(calls[0], /limit=100/);
  assert.doesNotMatch(calls[0], /descending/);
  assert.doesNotMatch(calls[0], /offset=/);
  assert.equal(result.items.length, 1);
  assert.equal(result.nextOffset, '1715000000.123.1.abc');
});

test('fetchTendersChangesFeed: passes offset query when given', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: [], next_page: { offset: '1715000099.0.0.x' } }) };
  };
  await fetchTendersChangesFeed({ offset: '1715000000', fetch: fakeFetch });
  assert.match(calls[0], /offset=1715000000/);
});

test('fetchTendersChangesFeed: empty data + still returns nextOffset (checkpoint)', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: [], next_page: { offset: '1715000099.0.0.x' } }),
  });
  const result = await fetchTendersChangesFeed({ offset: '1715000099', fetch: fakeFetch });
  assert.deepEqual(result.items, []);
  assert.equal(result.nextOffset, '1715000099.0.0.x');
});

test('fetchTendersChangesFeed: throws on non-ok', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => 'busy' });
  await assert.rejects(
    () => fetchTendersChangesFeed({ fetch: fakeFetch }),
    /Prozorro changes feed 503/
  );
});

test('fetchTendersChangesFeed: includes procuringEntity in opt_fields', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: [], next_page: { offset: 'x' } }) };
  };
  await fetchTendersChangesFeed({ fetch: fakeFetch });
  // opt_fields contains comma-separated list — URLSearchParams encodes commas as %2C
  assert.match(calls[0], /opt_fields=tenderID(?:%2C|,)procuringEntity(?:%2C|,)dateModified/);
});

test('fetchTendersFeed: builds initial URL with default opts', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ data: [{ tenderID: 'UA-X', dateModified: '2026-05-08T10:00:00Z' }], next_page: { path: '/api/2.5/tenders?offset=abc' } }),
    };
  };
  const result = await fetchTendersFeed({ fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/public\.api\.openprocurement\.org\/api\/2\.5\/tenders\?/);
  assert.match(calls[0], /opt_fields=tenderID,procuringEntity,dateModified,dateCreated/);
  assert.match(calls[0], /descending=1/);
  assert.match(calls[0], /limit=100/);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].tenderID, 'UA-X');
  assert.equal(result.next, '/api/2.5/tenders?offset=abc');
});

test('fetchTendersFeed: pagination via next.path', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: [], next_page: null }) };
  };
  await fetchTendersFeed({ pageOffset: '/api/2.5/tenders?offset=xyz', fetch: fakeFetch });
  assert.equal(calls[0], 'https://public.api.openprocurement.org/api/2.5/tenders?offset=xyz');
});

test('fetchTendersFeed: throws on non-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => 'Service Unavailable' });
  await assert.rejects(
    () => fetchTendersFeed({ fetch: fakeFetch }),
    /Prozorro feed 503/
  );
});

test('fetchTendersFeed: returns empty when no next_page', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ tenderID: 'UA-Y' }] }),
  });
  const result = await fetchTendersFeed({ fetch: fakeFetch });
  assert.equal(result.next, null);
});

test('fetchTender: retries a transient failure then succeeds', async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed'); // first summary attempt: network blip
    if (url.includes('/summary')) return { ok: true, json: async () => ({ id: 'uuid-1' }) };
    return { ok: true, json: async () => ({ data: { tenderID: 'UA-X' } }) };
  };
  const res = await fetchTender('UA-2026-05-01-000001-a', { fetch: fakeFetch, retryDelayMs: 0 });
  assert.equal(res.data.tenderID, 'UA-X');
  assert.equal(calls, 3); // 1 failed summary + retried (summary + cdb)
});

test('fetchTender: does not retry a permanent 404', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: false, status: 404, text: async () => 'nf' }; };
  await assert.rejects(
    () => fetchTender('UA-X', { fetch: fakeFetch, retryDelayMs: 0 }),
    /404/,
  );
  assert.equal(calls, 1); // permanent → no retry
});

test('fetchTender: exhausts retries on persistent transient error', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; throw new TypeError('fetch failed'); };
  await assert.rejects(
    () => fetchTender('UA-X', { fetch: fakeFetch, retryDelayMs: 0, retries: 2 }),
    /fetch failed/,
  );
  assert.equal(calls, 3); // initial + 2 retries
});
