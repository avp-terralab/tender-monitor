import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDigest, chunkMessage, formatHeartbeat, formatNightDigest, truncate, stripDkCode, fmtStatus, fmtDeadline, fmtTimeLeft, getUpdates, sendReply, sendDigest, editMessageReplyMarkup, editMessageText, answerCallbackQuery, setMyCommands, broadcastDigest, deleteMessage, formatDeadlineReminder, summarizeDigest } from '../telegram.mjs';

test('formatDigest: deadline_changed + new_question', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-2026-04-30-010542-a',
    title: 'Психіатрична лікарня — реактиви',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-04-30-010542-a',
    events: [
      { type: 'deadline_changed', old: '2026-05-15T14:00:00+03:00', new: '2026-05-20T14:00:00+03:00' },
      { type: 'new_question', id: 'q1', title: 'Чи можна подавати ФОП?' },
    ],
  }]);
  assert.match(text, /🔔/);
  assert.match(text, /UA-2026-04-30-010542-a/);
  assert.match(text, /Психіатрична лікарня/);
  assert.match(text, /Дедлайн/);
  assert.match(text, /15\.05.*20\.05/);
  assert.match(text, /питання/i);
  assert.match(text, /ФОП/);
  assert.match(text, /prozorro\.gov\.ua\/tender\/UA-2026/);
});

test('formatDigest: heading shows HH:MM from runIso', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', []);
  assert.match(text, /\(13:00, \d{2}\.\d{2}\.\d{4}\)/);
});

test('formatDigest: award_qualified shows supplier with EDRPOU', () => {
  const text = formatDigest('2026-06-01T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'Tender X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{
      type: 'award_qualified', id: 'a1',
      supplier_name: 'ТОВ ТерраЛаб', supplier_edrpou: '12345678',
      old: 'pending', new: 'active',
    }],
  }]);
  assert.match(text, /переможц/i);
  assert.match(text, /ТерраЛаб/);
  assert.match(text, /12345678/);
});

test('formatDigest: contract_signed and contract_terminated produce distinct messages', () => {
  const signed = formatDigest('2026-06-01T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'contract_signed', id: 'c1' }],
  }]);
  const terminated = formatDigest('2026-06-01T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'contract_terminated', id: 'c1' }],
  }]);
  assert.match(signed, /[Дд]оговір.*підпис/i);
  assert.match(terminated, /[Дд]оговір.*розірв/i);
  assert.notEqual(signed, terminated);
});

test('formatDigest: monitoring_started shows status and deadline', () => {
  const text = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'Tender X',
    status: 'active.tendering',
    deadline: '2026-05-15T14:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'monitoring_started', status: 'active.tendering', title: 'Tender X', deadline: '2026-05-15T14:00:00+03:00' }],
  }]);
  assert.match(text, /ℹ️ Статус: Приймання пропозицій/);
  assert.match(text, /15\.05/);
});

test('formatDigest: each group contains prozorro_url as href link', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-A', title: 'A', prozorro_url: 'https://prozorro.gov.ua/tender/UA-A',
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }, {
    tender_id: 'UA-B', title: 'B', prozorro_url: 'https://prozorro.gov.ua/tender/UA-B',
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  // URL appears in href attribute before the link text (UA-A / UA-B)
  assert.match(text, /prozorro\.gov\.ua\/tender\/UA-A[\s\S]*UA-B/);
  assert.match(text, /prozorro\.gov\.ua\/tender\/UA-B/);
});

test('formatDigest: empty groups produces just a heading', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', []);
  assert.match(text, /🔔/);
  assert.match(text, /\(13:00, \d{2}\.\d{2}\.\d{4}\)/);
  // No bullet points / tender lines
  assert.doesNotMatch(text, /🆔/);
});

// ─── Change 3: title truncation ───────────────────────────────────────────────
test('formatDigest: title longer than 200 chars is truncated to 199+ellipsis', () => {
  const longTitle = 'А'.repeat(201);
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: longTitle,
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  // Title line: "Предмет закупівлі: <truncated 199 + …>" with no leading indent
  const match = text.match(/^ {2}📦 Предмет закупівлі: (А+…?)$/m);
  assert.ok(match, `Expected to find title line, got:\n${text}`);
  assert.equal(match[1].length, 200); // 199 + '…'
  assert.ok(match[1].endsWith('…'));
});

test('formatDigest: title exactly 200 chars is not truncated', () => {
  const exactTitle = 'Б'.repeat(200);
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: exactTitle,
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  const match = text.match(/^ {2}📦 Предмет закупівлі: (Б+)$/m);
  assert.ok(match);
  assert.equal(match[1].length, 200);
  assert.ok(!match[1].endsWith('…'));
});

test('formatDigest: title strips trailing ДК code suffix', () => {
  const title = 'Консалтингові послуги з підготовки лабораторії, код ДК 021:2015 – 71620000-0 - Аналітичні послуги';
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title,
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  assert.match(text, /📦 Предмет закупівлі: Консалтингові послуги з підготовки лабораторії$/m);
  assert.doesNotMatch(text, /код ДК/i);
});

// fmtTimeLeft is still exported (used by formatHeartbeat) and has its own pure
// test below. Its appearance INSIDE formatDigest was removed when the digest
// status/deadline block was unified with /info style.

// ─── Change 5: new fields in formatDigest ─────────────────────────────────────
test('formatDigest: renders procurement_method_type label', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    procurement_method_type: 'aboveThreshold',
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  assert.match(text, /Відкриті торги з особливостями/);
});

test('formatDigest: renders classification DK code and description', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    classification: { id: '71620000-0', description: 'Аналітичні послуги', scheme: 'ДК021' },
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  assert.match(text, /🔖 ДК: 71620000-0 — Аналітичні послуги/);
});

test('formatDigest: renders contact name, telephone, email on two lines', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    contact: { name: 'Людмила Романчук', telephone: '+380362643715', email: 'skprokl@gmail.com' },
    events: [{ type: 'deadline_changed', old: 'a', new: 'b' }],
  }]);
  assert.match(text, /📞 Людмила Романчук: \+380 36 264-37-15\n {2}✉ skprokl@gmail\.com/);
});

test('formatDigest: monitoring_started shows docs/questions/complaints counts', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'monitoring_started', status: 'active.tendering', title: 'X',
               deadline: '2026-05-20T14:00:00+03:00',
               docs_count: 8, questions_count: 1, complaints_count: 0 }],
  }]);
  assert.match(text, /📎 Документів: 8 · Питань: 1 · Скарг: 0/);
});

// ─── Change 9: Telegram message length cap ────────────────────────────────────
test('chunkMessage: short text returns single chunk', () => {
  const text = 'Hello world';
  const chunks = chunkMessage(text, 4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test('chunkMessage: long text splits at double-newline boundaries, each chunk <= max', () => {
  // Build a text > 4000 chars with double-newline boundaries
  const part = 'А'.repeat(1500);
  const text = `${part}\n\n${part}\n\n${part}`;
  assert.ok(text.length > 4000);
  const chunks = chunkMessage(text, 4000);
  assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= 4000, `Chunk length ${c.length} exceeds 4000`);
  }
});

test('chunkMessage: splits at double-newline not mid-line', () => {
  // 3 groups of 1800 chars each, total > 4000
  const g1 = 'Group1: ' + 'X'.repeat(1792);
  const g2 = 'Group2: ' + 'Y'.repeat(1792);
  const g3 = 'Group3: ' + 'Z'.repeat(1792);
  const text = [g1, g2, g3].join('\n\n');
  const chunks = chunkMessage(text, 4000);
  // Each group is 1800 chars; g1+g2 = 3602 chars which fits; g3 goes to next chunk
  assert.ok(chunks.length >= 2);
  // No chunk should contain a partial group — each group is a solid block
  for (const c of chunks) {
    assert.ok(!c.includes('Group1') || c.includes('Group1: '), 'Group1 intact');
    assert.ok(!c.includes('Group2') || c.includes('Group2: '), 'Group2 intact');
  }
});

// ─── New tests for 5 enhancements ────────────────────────────────────────────

test('formatDigest: status renders as separate line without inline deadline', () => {
  const text = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    status: 'active.tendering',
    deadline: '2026-05-08T09:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  // Status line carries only the status (no comma+deadline tail like before)
  assert.match(text, /ℹ️ Статус: Приймання пропозицій(?!,)/);
  assert.doesNotMatch(text, /Статус: Приймання пропозицій,/);
});

test('formatDigest: submission deadline as "Подача пропозиції до" only for active.tendering', () => {
  const active = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', status: 'active.tendering',
    deadline: '2026-05-15T14:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.match(active, /⏰ Подача пропозиції до: 15\.05\.2026 до 14:00/);

  // Other statuses must NOT render the deadline (it's in the past anyway)
  const awarded = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-Y', title: 'Y', status: 'active.awarded',
    deadline: '2026-05-15T14:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-Y',
    events: [{ type: 'contract_signed', id: 'c1' }],
  }]);
  assert.doesNotMatch(awarded, /Подача пропозиції до/);
  assert.doesNotMatch(awarded, /⏰/);
});

test('formatDigest: no "Залишилось" countdown anywhere', () => {
  const text = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', status: 'active.tendering',
    deadline: '2026-05-15T14:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.doesNotMatch(text, /Залишилось/);
});

test('formatDigest: procuringEntity name abbreviated via legal-form shortening', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    procuring_entity: {
      name: 'Комунальне некомерційне підприємство «Тест»',
      edrpou: '12345678',
    },
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.match(text, /Замовник: КНП «Тест»/);
  assert.doesNotMatch(text, /Комунальне некомерційне підприємство/);
});

test('formatDigest: stripDkCode removes "за кодом ДК ..." pattern from title', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X',
    title: 'Послуги ЛІС за кодом ДК 021:2015 - 72260000-5 Послуги, пов’язані з ПЗ',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.doesNotMatch(text, /за кодом ДК/);
  assert.match(text, /Предмет закупівлі: Послуги ЛІС/);
});

test('formatDigest: escapes HTML special chars in title', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'Закупівля <script>alert(1)</script> & таке',
    status: 'active.tendering', deadline: '2026-05-15',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'a' }],
  }]);
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /&amp;/);
});

test('formatDigest: formats Ukrainian phones', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    status: 'active.tendering', deadline: '2026-05-15',
    contact: { name: 'Test', telephone: '+380362643715, +380362281692', email: null },
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.match(text, /\+380 36 264-37-15/);
  assert.match(text, /\+380 36 228-16-92/);
});

test('formatDigest: inserts ━ separator between multiple groups', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [
    { tender_id: 'UA-A', title: 'A', status: 'active.tendering', deadline: '2026-05-15',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-A',
      events: [{ type: 'new_question', title: 'q' }] },
    { tender_id: 'UA-B', title: 'B', status: 'active.tendering', deadline: '2026-05-15',
      prozorro_url: 'https://prozorro.gov.ua/tender/UA-B',
      events: [{ type: 'new_question', title: 'q' }] },
  ]);
  assert.match(text, /━{20,}/);
});

test('formatDigest: no separator with single group', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-A', title: 'A', status: 'active.tendering', deadline: '2026-05-15',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-A',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.doesNotMatch(text, /━/);
});

test('formatDigest: tender_id rendered as HTML <a href> link', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-2026-04-30-010542-a', title: 'X',
    status: 'active.tendering', deadline: '2026-05-15',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-04-30-010542-a',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.match(text, /<a href="https:\/\/prozorro\.gov\.ua\/tender\/UA-2026-04-30-010542-a">UA-2026-04-30-010542-a<\/a>/);
  // Bottom 🔗 line removed:
  assert.doesNotMatch(text, /🔗 https/);
});

// ─── Change C: formatHeartbeat ────────────────────────────────────────────────
test('formatHeartbeat: includes heading, count, and tenders with deadlines', () => {
  const text = formatHeartbeat('2026-05-08T06:00:00.000Z', [
    { tender_id: 'UA-X', title: 'X', status: 'active.tendering', deadline: '2026-05-15T14:00:00+03:00' },
    { tender_id: 'UA-Y', title: 'Y', status: 'active.qualification', deadline: null },
  ]);
  assert.match(text, /🟢 Heartbeat/);
  assert.match(text, /Моніторю 2 тендери/);
  assert.match(text, /UA-X/);
  assert.match(text, /UA-Y/);
  // UA-X has future deadline → active section without status
  assert.match(text, /🎯 Активні дедлайни/);
  // UA-Y has no deadline → waiting section with status
  assert.match(text, /⏸ Очікують замовника/);
  assert.match(text, /Розгляд пропозицій/);
});

test('formatHeartbeat: passed deadline rendered in waiting section with "з DD.MM"', () => {
  // 2026-05-19 09:00 Kyiv; deadline 2026-05-15 08:00 Kyiv already passed
  const text = formatHeartbeat('2026-05-19T06:00:00.000Z', [
    { tender_id: 'UA-Z', title: 'Z', status: 'active.qualification', deadline: '2026-05-15T08:00:00+03:00' },
  ]);
  assert.match(text, /⏸ Очікують замовника/);
  assert.match(text, /UA-Z<\/a> — Розгляд пропозицій \(з 15\.05\)/);
  assert.doesNotMatch(text, /подача пропозицій була/);
  assert.doesNotMatch(text, /🎯/);
});

test('formatHeartbeat: future deadline in active section without status, with time-left', () => {
  const text = formatHeartbeat('2026-05-08T06:00:00.000Z', [
    { tender_id: 'UA-A', title: 'A', status: 'active.tendering', deadline: '2026-05-15T14:00:00+03:00' },
  ]);
  assert.match(text, /🎯 Активні дедлайни/);
  assert.match(text, /UA-A<\/a> — до 15\.05\.2026 до 14:00, ⏰ /);
  // Status label should NOT appear in active section
  assert.doesNotMatch(text, /Приймання пропозицій \(до/);
});

test('formatHeartbeat: empty snapshots produces still-alive line without deadlines section', () => {
  const text = formatHeartbeat('2026-05-08T06:00:00.000Z', []);
  assert.match(text, /🟢 Heartbeat/);
  assert.match(text, /Моніторю 0 тендерів/);
  assert.doesNotMatch(text, /🎯/);
  assert.doesNotMatch(text, /⏸/);
});

test('formatHeartbeat: groups into 🎯 Активні дедлайни and ⏸ Очікують замовника', () => {
  const runIso = '2026-05-22T06:25:00Z'; // 09:25 Kyiv
  const snaps = [
    { tender_id: 'UA-PAST-1', status: 'active.qualification', deadline: '2026-05-08T20:00:00Z' },
    { tender_id: 'UA-FUTURE-1', status: 'active.tendering', deadline: '2026-05-25T21:00:00Z' },
    { tender_id: 'UA-PAST-2', status: 'active.awarded', deadline: '2026-05-15T05:00:00Z' },
    { tender_id: 'UA-FUTURE-2', status: 'active.tendering', deadline: '2026-05-27T09:00:00Z' },
  ];
  const text = formatHeartbeat(runIso, snaps);
  assert.match(text, /🎯 Активні дедлайни \(2\):/);
  assert.match(text, /⏸ Очікують замовника \(2\):/);
  // Active comes before waiting in output.
  assert.ok(text.indexOf('🎯') < text.indexOf('⏸'), 'active section before waiting');
  // Active sorted by deadline asc: 25.05 before 27.05
  assert.ok(text.indexOf('UA-FUTURE-1') < text.indexOf('UA-FUTURE-2'));
  // Waiting sorted by deadline asc: 08.05 before 15.05 (longest waiting first)
  assert.ok(text.indexOf('UA-PAST-1') < text.indexOf('UA-PAST-2'));
});

test('formatHeartbeat: only active deadlines → no waiting section rendered', () => {
  const runIso = '2026-05-22T06:25:00Z';
  const snaps = [
    { tender_id: 'UA-FUTURE', status: 'active.tendering', deadline: '2026-05-25T21:00:00Z' },
  ];
  const text = formatHeartbeat(runIso, snaps);
  assert.match(text, /🎯 Активні дедлайни \(1\):/);
  assert.doesNotMatch(text, /⏸ Очікують/);
});

test('formatHeartbeat: only waiting → no active section rendered', () => {
  const runIso = '2026-05-22T06:25:00Z';
  const snaps = [
    { tender_id: 'UA-PAST', status: 'active.qualification', deadline: '2026-05-08T20:00:00Z' },
  ];
  const text = formatHeartbeat(runIso, snaps);
  assert.doesNotMatch(text, /🎯 Активні/);
  assert.match(text, /⏸ Очікують замовника \(1\):/);
  // Compact "з DD.MM" form, not full "(подача пропозицій була до...)"
  assert.match(text, /\(з \d{2}\.\d{2}\)/);
});

test('truncate: returns string unchanged when shorter than max', () => {
  assert.equal(truncate('hello', 10), 'hello');
});

test('truncate: shortens with ellipsis when longer', () => {
  assert.equal(truncate('hello world', 8), 'hello w…');
});

test('truncate: handles null/undefined', () => {
  assert.equal(truncate(null, 5), '');
  assert.equal(truncate(undefined, 5), '');
});

test('stripDkCode: removes DK suffix', () => {
  assert.equal(
    stripDkCode('Реактиви для лабораторії, код ДК 33696500-0'),
    'Реактиви для лабораторії'
  );
});

test('stripDkCode: leaves title without DK unchanged', () => {
  assert.equal(stripDkCode('Просто реактиви'), 'Просто реактиви');
});

test('fmtStatus: maps known status to label', () => {
  assert.equal(fmtStatus('active.tendering'), 'Приймання пропозицій');
  assert.equal(fmtStatus('complete'), 'Завершено');
});

test('fmtStatus: returns raw key for unknown status', () => {
  assert.equal(fmtStatus('weird.status'), 'weird.status');
});

test('fmtStatus: returns empty string for null/undefined', () => {
  assert.equal(fmtStatus(null), '');
  assert.equal(fmtStatus(undefined), '');
});

test('fmtDeadline: ISO datetime to "DD.MM.YYYY до HH:MM"', () => {
  assert.equal(
    fmtDeadline('2026-05-15T14:30:00+03:00'),
    '15.05.2026 до 14:30'
  );
});

test('fmtDeadline: returns empty for null', () => {
  assert.equal(fmtDeadline(null), '');
});

test('getUpdates: builds correct URL with offset and timeout=0', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 42 }] }) };
  };
  const updates = await getUpdates({ token: 'TOK', offset: 100, fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/botTOK\/getUpdates/);
  assert.match(calls[0], /offset=100/);
  assert.match(calls[0], /timeout=0/);
  assert.match(calls[0], /limit=100/);
  assert.deepEqual(updates, [{ update_id: 42 }]);
});

test('getUpdates: throws on non-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  await assert.rejects(
    () => getUpdates({ token: 'BAD', offset: 0, fetch: fakeFetch }),
    /401/
  );
});

test('getUpdates: throws on telegram-level not-ok', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ ok: false, description: 'Bad Request' }),
  });
  await assert.rejects(
    () => getUpdates({ token: 'TOK', offset: 0, fetch: fakeFetch }),
    /Bad Request/
  );
});

test('sendReply: posts to sendMessage with reply_to_message_id', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: Object.fromEntries(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  };
  await sendReply({
    token: 'TOK', chatId: '12345', text: 'hi',
    replyToMessageId: 10, fetch: fakeFetch,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/sendMessage/);
  assert.equal(calls[0].body.chat_id, '12345');
  assert.equal(calls[0].body.text, 'hi');
  assert.equal(calls[0].body.reply_to_message_id, '10');
});

test('sendReply: omits reply_to_message_id when not provided', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: Object.fromEntries(opts.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendReply({ token: 'TOK', chatId: '12345', text: 'hi', fetch: fakeFetch });
  assert.equal(calls[0].body.reply_to_message_id, undefined);
});

test('sendReply: retries on transient 5xx then succeeds', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 503, text: async () => 'temporary' };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const result = await sendReply({ token: 'TOK', chatId: '12345', text: 'hi', fetch: fakeFetch });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test('sendReply: replyMarkup serialised as JSON in reply_markup field', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: Object.fromEntries(opts.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const keyboard = {
    keyboard: [[{ text: '📋 Активні' }]],
    resize_keyboard: true,
    is_persistent: true,
  };
  await sendReply({ token: 'TOK', chatId: '12345', text: 'hi', replyMarkup: keyboard, fetch: fakeFetch });
  assert.equal(calls[0].body.reply_markup, JSON.stringify(keyboard));
});

test('sendReply: omits reply_markup when not provided', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: Object.fromEntries(opts.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendReply({ token: 'TOK', chatId: '12345', text: 'hi', fetch: fakeFetch });
  assert.equal(calls[0].body.reply_markup, undefined);
});

test('sendReply: splits a message over the Telegram limit into multiple sends', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(Object.fromEntries(opts.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };
  // ~6000 chars across paragraph boundaries → must split (e.g. /info with many tenders).
  const text = Array.from({ length: 12 }, (_, i) => `Параграф ${i} ` + 'x'.repeat(480)).join('\n\n');
  const keyboard = { keyboard: [[{ text: 'A' }]], is_persistent: true };
  await sendReply({
    token: 'TOK', chatId: '5', text,
    replyToMessageId: 7, replyMarkup: keyboard, fetch: fakeFetch,
  });
  assert.ok(calls.length >= 2, `expected multiple sends, got ${calls.length}`);
  for (const c of calls) assert.ok(c.text.length <= 4096, `chunk too long: ${c.text.length}`);
  // reply anchors to the user's message only on the first chunk
  assert.equal(calls[0].reply_to_message_id, '7');
  assert.equal(calls[1].reply_to_message_id, undefined);
  // keyboard attaches to the last chunk only
  assert.equal(calls[calls.length - 1].reply_markup, JSON.stringify(keyboard));
  assert.equal(calls[0].reply_markup, undefined);
});

test('sendReply: throws on telegram-level not-ok', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ ok: false, description: 'chat not found' }),
  });
  await assert.rejects(
    () => sendReply({ token: 'TOK', chatId: '999', text: 'hi', fetch: fakeFetch }),
    /chat not found/
  );
});

test('formatDigest: renders new_tender_announced event with 🆕 icon', () => {
  const text = formatDigest('2026-05-08T13:00:00+03:00', [{
    tender_id: 'UA-2026-04-30-010542-a',
    title: 'Реактиви',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-2026-04-30-010542-a',
    procuring_entity: { name: 'КНП', edrpou: '12345678' },
    classification: { id: '72260000-5', description: 'Послуги' },
    value: { amount: 100000, currency: 'UAH', valueAddedTaxIncluded: true },
    events: [{ type: 'new_tender_announced' }],
  }]);
  assert.match(text, /🆕 Нове оголошення замовника/);
});

test('fmtTimeLeft: exported and renders future delta', () => {
  const out = fmtTimeLeft('2026-05-16T14:00:00Z', '2026-05-16T11:00:00Z');
  assert.match(out, /3 год/);
});

test('formatDigest: renders deadline_approaching event with 24h label', () => {
  const text24 = formatDigest('2026-05-16T12:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'deadline_approaching', threshold: '24h', deadline: '2026-05-17T10:00:00+03:00' }],
  }]);
  assert.match(text24, /⏰ До дедлайну подачі менше 24 годин/);
});

test('sendDigest: passes text + chat_id to fetch with parse_mode=HTML', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await sendDigest({ token: 'TOK', chatId: '12345', fetch: fakeFetch }, 'hello');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/sendMessage$/);
  assert.match(calls[0].body, /chat_id=12345/);
  assert.match(calls[0].body, /text=hello/);
  assert.match(calls[0].body, /parse_mode=HTML/);
});

test('sendDigest: addButtonsForTenders attaches inline_keyboard to chunk containing the id', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    'before\n\nUA-2026-05-14-008910-a in here\n\nafter',
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'] },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /reply_markup=/);
  const body = decodeURIComponent(calls[0].replace(/\+/g, ' '));
  assert.match(body, /"callback_data":"add:UA-2026-05-14-008910-a"/);
  assert.match(body, /Додати в моніторинг/);
});

test('sendDigest: addButtonsForTenders only attaches button to chunks containing the id', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  // Force chunking by exceeding 4000 chars; tender_id is in second chunk only.
  const filler = 'X'.repeat(4001);
  const text = `${filler}\n\nplain group\n\nUA-2026-05-14-008910-a here`;
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    text,
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'] },
  );
  assert.ok(calls.length >= 2, `expected at least 2 chunks, got ${calls.length}`);
  // First chunk has no tender_id → no reply_markup
  assert.doesNotMatch(calls[0], /reply_markup/);
  // Last chunk has tender_id → has reply_markup with the button
  const last = decodeURIComponent(calls[calls.length - 1].replace(/\+/g, ' '));
  assert.match(last, /"callback_data":"add:UA-2026-05-14-008910-a"/);
});

test('sendDigest: role admin adds 🤖 agent button under the add button', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    'UA-2026-05-14-008910-a here',
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'], role: 'admin' },
  );
  const body = decodeURIComponent(calls[0].replace(/\+/g, ' '));
  assert.match(body, /"callback_data":"add:UA-2026-05-14-008910-a"/);
  assert.match(body, /"callback_data":"agent:start:UA-2026-05-14-008910-a"/);
  assert.match(body, /Надіслати агенту/);
});

test('sendDigest: non-admin role keeps add button only (no agent button)', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    'UA-2026-05-14-008910-a here',
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'], role: 'editor' },
  );
  const body = decodeURIComponent(calls[0].replace(/\+/g, ' '));
  assert.match(body, /"callback_data":"add:UA-2026-05-14-008910-a"/);
  assert.doesNotMatch(body, /agent:start/);
});

test('broadcastDigest: admin recipient gets agent button, editor does not', async () => {
  const captured = [];
  const fakeFetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body.toString());
    captured.push({ chat_id: params.get('chat_id'), reply_markup: params.get('reply_markup') });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await broadcastDigest(
    { token: 'TOK', chatIds: [
      { chatId: '111', role: 'editor' },
      { chatId: '333', role: 'admin' },
    ], fetch: fakeFetch },
    '🔔 UA-2026-05-19-002203-a — new',
    { addButtonsForTenders: ['UA-2026-05-19-002203-a'] },
  );
  const byChat = Object.fromEntries(captured.map(c => [c.chat_id, c.reply_markup]));
  assert.match(byChat['333'], /agent:start:UA-2026-05-19-002203-a/);
  assert.ok(!/agent:start/.test(byChat['111']), 'editor must not get agent button');
  assert.match(byChat['111'], /Додати в моніторинг/);
});

test('sendDigest: no options → no reply_markup (backward compat)', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest({ token: 'TOK', chatId: '1', fetch: fakeFetch }, 'plain text');
  assert.doesNotMatch(calls[0], /reply_markup/);
});

test('sendDigest: addButtonsForTenders entries that do NOT appear in any chunk are silently skipped', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendDigest(
    { token: 'TOK', chatId: '1', fetch: fakeFetch },
    'no tender ids in this body at all',
    { addButtonsForTenders: ['UA-2026-05-14-008910-a'] },
  );
  assert.doesNotMatch(calls[0], /reply_markup/);
});

test('editMessageReplyMarkup: posts to editMessageReplyMarkup endpoint with chat_id, message_id, reply_markup', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const kb = { inline_keyboard: [[{ text: '✅ Додано', callback_data: 'noop' }]] };
  await editMessageReplyMarkup({
    token: 'TOK', chatId: '111', messageId: 222, replyMarkup: kb, fetch: fakeFetch,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/editMessageReplyMarkup$/);
  const body = decodeURIComponent(calls[0].body.replace(/\+/g, ' '));
  assert.match(body, /chat_id=111/);
  assert.match(body, /message_id=222/);
  assert.match(body, /reply_markup=.*✅ Додано/);
  assert.match(body, /"callback_data":"noop"/);
});

test('editMessageReplyMarkup: throws on Telegram error response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  await assert.rejects(
    () => editMessageReplyMarkup({
      token: 'T', chatId: '1', messageId: 1,
      replyMarkup: { inline_keyboard: [] }, fetch: fakeFetch,
    }),
    /Telegram editMessageReplyMarkup 400/,
  );
});

test('answerCallbackQuery: posts callback_query_id, text, show_alert', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts.body.toString() });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await answerCallbackQuery({
    token: 'TOK', callbackQueryId: 'cbq1', text: '✅ Готово', showAlert: true, fetch: fakeFetch,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTOK\/answerCallbackQuery$/);
  const body = decodeURIComponent(calls[0].body.replace(/\+/g, ' '));
  assert.match(body, /callback_query_id=cbq1/);
  assert.match(body, /text=✅ Готово/);
  assert.match(body, /show_alert=true/);
});

test('answerCallbackQuery: omits text and show_alert when not provided', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await answerCallbackQuery({ token: 'T', callbackQueryId: 'cbq1', fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /text=/);
  assert.doesNotMatch(calls[0], /show_alert=/);
});

test('setMyCommands: POSTs to Telegram API with chat scope', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return new Response('{"ok":true}', { status: 200 });
  };
  await setMyCommands({
    token: 'TOK',
    chatId: '123',
    commands: [{ command: 'help', description: 'h' }],
    fetch: fakeFetch,
  });
  assert.equal(captured.url, 'https://api.telegram.org/botTOK/setMyCommands');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['content-type'], 'application/json');
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body.commands, [{ command: 'help', description: 'h' }]);
  assert.deepEqual(body.scope, { type: 'chat', chat_id: 123 });
});

test('setMyCommands: throws on non-OK response', async () => {
  const fakeFetch = async () => new Response('bad', { status: 400 });
  await assert.rejects(
    setMyCommands({
      token: 'TOK',
      chatId: '123',
      commands: [],
      fetch: fakeFetch,
    }),
    /setMyCommands 400/,
  );
});

test('setMyCommands: chat_id coerced to number even if passed as string', async () => {
  let body = null;
  const fakeFetch = async (url, opts) => {
    body = JSON.parse(opts.body);
    return new Response('{"ok":true}', { status: 200 });
  };
  await setMyCommands({
    token: 'TOK',
    chatId: '456',
    commands: [],
    fetch: fakeFetch,
  });
  assert.strictEqual(body.scope.chat_id, 456); // number, not '456'
});

test('broadcastDigest: sends to each recipient in chatIds', async () => {
  const sent = [];
  const fakeFetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body.toString());
    sent.push(params.get('chat_id'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await broadcastDigest({ token: 'TOK', chatIds: ['111', '222', '333'], fetch: fakeFetch }, 'hello');
  assert.deepEqual(sent, ['111', '222', '333']);
});

test('broadcastDigest: per-recipient failure does not abort remaining sends', async () => {
  const sent = [];
  const fakeFetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body.toString());
    const cid = params.get('chat_id');
    sent.push(cid);
    if (cid === '222') {
      return { ok: false, status: 403, text: async () => 'Forbidden: bot was blocked by the user' };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await broadcastDigest({ token: 'TOK', chatIds: ['111', '222', '333'], fetch: fakeFetch }, 'hello');
  // Two attempts to 222 (sendOne retries once on failure), but all three recipients reached
  assert.ok(sent.includes('111'));
  assert.ok(sent.includes('222'));
  assert.ok(sent.includes('333'));
});

test('broadcastDigest: object recipients — viewers do NOT receive inline buttons', async () => {
  // Mention a tender id whose button would otherwise be added.
  const text = '🔔 UA-2026-05-19-002203-a — new';
  const captured = [];
  const fakeFetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body.toString());
    captured.push({
      chat_id: params.get('chat_id'),
      reply_markup: params.get('reply_markup'),
    });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await broadcastDigest(
    { token: 'TOK', chatIds: [
      { chatId: '111', role: 'editor' },
      { chatId: '222', role: 'viewer' },
      { chatId: '333', role: 'admin' },
    ], fetch: fakeFetch },
    text,
    { addButtonsForTenders: ['UA-2026-05-19-002203-a'] },
  );
  const byChat = Object.fromEntries(captured.map(c => [c.chat_id, c.reply_markup]));
  assert.match(byChat['111'], /Додати в моніторинг/);
  assert.match(byChat['333'], /Додати в моніторинг/);
  assert.ok(!byChat['222'] || !/Додати в моніторинг/.test(byChat['222']),
    'viewer must not receive inline button');
});

test('broadcastDigest: string recipients still get buttons (backward compat)', async () => {
  const text = '🔔 UA-2026-05-19-002203-a — new';
  const captured = [];
  const fakeFetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body.toString());
    captured.push({
      chat_id: params.get('chat_id'),
      reply_markup: params.get('reply_markup'),
    });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await broadcastDigest(
    { token: 'TOK', chatIds: ['111', '222'], fetch: fakeFetch },
    text,
    { addButtonsForTenders: ['UA-2026-05-19-002203-a'] },
  );
  for (const c of captured) {
    assert.match(c.reply_markup, /Додати в моніторинг/);
  }
});

test('broadcastDigest: empty chatIds → no-op, no fetch call', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  await broadcastDigest({ token: 'TOK', chatIds: [], fetch: fakeFetch }, 'hello');
  assert.equal(called, false);
});

test('formatNightDigest: header + delegates items to formatDigest', () => {
  const pending = {
    items: {
      'UA-X': {
        tender_id: 'UA-X', title: 'Лабораторні реактиви', status: 'active.tendering',
        deadline: '2026-05-23T17:00:00+03:00',
        prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
        events: [{ type: 'td_amended', title: 'Доповнення №1' }],
      },
    },
    archived: [],
    errors: [],
  };
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /🌙 Нічний дайджест/);
  assert.match(text, /Лабораторні реактиви/);
  assert.match(text, /Виправлення\/новий документ ТД/);
});

test('formatNightDigest: appends archived block when present', () => {
  const pending = {
    items: {},
    archived: [{ tender_id: 'UA-A', status: 'complete', fired_at: '2026-05-22T02:00:00Z' }],
    errors: [],
  };
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /📦 Архівовано \(вночі\)/);
  assert.match(text, /UA-A — complete/);
});

test('formatNightDigest: appends errors block when present', () => {
  const pending = {
    items: {},
    archived: [],
    errors: [{ tender_id: 'UA-B', error: 'fetch 500', is_invalid: false, fired_at: '2026-05-22T03:00:00Z' }],
  };
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /⚠️ не вдалось перевірити \(вночі\)/);
  assert.match(text, /UA-B — fetch 500/);
});

test('formatNightDigest: header includes Kyiv date of the night', () => {
  const pending = { items: {}, archived: [], errors: [] };
  // runIso 2026-05-22T06:00:00Z = 09:00 Kyiv on 22.05.2026
  const text = formatNightDigest('2026-05-22T06:00:00Z', pending);
  assert.match(text, /🌙 Нічний дайджест за 22\.05\.2026/);
});

test('editMessageText: posts text + reply_markup to editMessageText endpoint', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  await editMessageText({
    token: 'T', chatId: 42, messageId: 7,
    text: 'hello', replyMarkup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] },
    fetch: fakeFetch,
  });
  assert.match(captured.url, /\/botT\/editMessageText$/);
  const params = captured.body; // URLSearchParams
  assert.equal(params.get('chat_id'), '42');
  assert.equal(params.get('message_id'), '7');
  assert.equal(params.get('text'), 'hello');
  assert.match(params.get('reply_markup'), /inline_keyboard/);
});

test('editMessageText: omits reply_markup when not provided', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = opts.body;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await editMessageText({ token: 'T', chatId: 1, messageId: 2, text: 'hi', fetch: fakeFetch });
  assert.equal(captured.get('reply_markup'), null);
});

test('editMessageText: throws on non-ok HTTP', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  await assert.rejects(
    () => editMessageText({ token: 'T', chatId: 1, messageId: 2, text: 'x', fetch: fakeFetch }),
    /400/,
  );
});


test('editMessageText: disables web page preview (no misleading link-preview card)', async () => {
  let params;
  const fakeFetch = async (url, opts) => {
    params = new URLSearchParams(opts.body.toString());
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await editMessageText({ token: 'TOK', chatId: '1', messageId: 2, text: 'hi', fetch: fakeFetch });
  assert.equal(params.get('disable_web_page_preview'), 'true');
});

test('deleteMessage: POST /deleteMessage with chat_id+message_id, true on ok', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  const ok = await deleteMessage({ token: 'TOK', chatId: 123, messageId: 55, fetch: fakeFetch });
  assert.equal(ok, true);
  assert.match(captured.url, /botTOK\/deleteMessage$/);
  assert.equal(captured.body.get('chat_id'), '123');
  assert.equal(captured.body.get('message_id'), '55');
});

test('deleteMessage: non-ok HTTP → false, no throw', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'message to delete not found' });
  assert.equal(await deleteMessage({ token: 'T', chatId: 1, messageId: 2, fetch: fakeFetch }), false);
});

test('deleteMessage: fetch throws → false, no throw', async () => {
  const fakeFetch = async () => { throw new Error('network'); };
  assert.equal(await deleteMessage({ token: 'T', chatId: 1, messageId: 2, fetch: fakeFetch }), false);
});

test('broadcastDigest: returns [{chat_id, message_id}] from each sent message', async () => {
  let mid = 500;
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: mid++ } }) });
  const r = await broadcastDigest({ token: 'T', chatIds: ['11', { chatId: '22', role: 'viewer' }], fetch: fakeFetch }, 'hi');
  assert.deepEqual(r, [{ chat_id: '11', message_id: 500 }, { chat_id: '22', message_id: 501 }]);
});

test('broadcastDigest: a failing chat is skipped (not in result)', async () => {
  // sendOne retries once, so chat '11' makes 2 fetch calls — both must throw for
  // broadcastDigest to catch and skip it.  Chat '22' then succeeds on call 3.
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls <= 2) throw new Error('blocked');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  const r = await broadcastDigest({ token: 'T', chatIds: ['11', '22'], fetch: fakeFetch }, 'hi');
  assert.deepEqual(r, [{ chat_id: '22', message_id: 9 }]);
});

test('formatDeadlineReminder: header + a line per tender', () => {
  const t = formatDeadlineReminder([
    { tender_id: 'UA-2026-06-19-008800-a', entity: 'КНП МКЛ №1', deadline: '27.06 17:00' },
  ]);
  assert.match(t, /24 год/);
  assert.match(t, /UA-2026-06-19-008800-a/);
  assert.match(t, /КНП МКЛ №1/);
});

test('summarizeDigest: compact emoji·count per headline type', () => {
  const groups = [
    { events: [{ type: 'new_tender_announced' }] },
    { events: [{ type: 'new_tender_announced' }, { type: 'status_changed' }] },
  ];
  assert.equal(summarizeDigest(groups), '📥 2 · 🔄 1');
  assert.equal(summarizeDigest([]), '🔔 оновлення');
});
