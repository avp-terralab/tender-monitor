import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDigest, chunkMessage, formatHeartbeat, truncate, stripDkCode, fmtStatus, fmtDeadline, fmtTimeLeft, getUpdates, sendReply, sendDigest, editMessageReplyMarkup, answerCallbackQuery, setMyCommands, broadcastDigest } from '../telegram.mjs';

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
  assert.match(text, /Приймання пропозицій/);
  assert.match(text, /Розгляд пропозицій/);
});

test('formatHeartbeat: passed deadline rendered as "подача пропозицій була до …" without time-left', () => {
  // 2026-05-19 09:00 Kyiv; deadline 2026-05-15 08:00 Kyiv already passed
  const text = formatHeartbeat('2026-05-19T06:00:00.000Z', [
    { tender_id: 'UA-Z', title: 'Z', status: 'active.qualification', deadline: '2026-05-15T08:00:00+03:00' },
  ]);
  assert.match(text, /UA-Z<\/a> — Розгляд пропозицій \(подача пропозицій була до 15\.05\.2026 до 08:00\)/);
  assert.doesNotMatch(text, /минув на/);
  assert.doesNotMatch(text, /год тому/);
});

test('formatHeartbeat: future deadline still rendered with time-left', () => {
  const text = formatHeartbeat('2026-05-08T06:00:00.000Z', [
    { tender_id: 'UA-A', title: 'A', status: 'active.tendering', deadline: '2026-05-15T14:00:00+03:00' },
  ]);
  assert.match(text, /UA-A<\/a> — Приймання пропозицій \(до 15\.05\.2026 до 14:00, ⏰ /);
});

test('formatHeartbeat: empty snapshots produces still-alive line without deadlines section', () => {
  const text = formatHeartbeat('2026-05-08T06:00:00.000Z', []);
  assert.match(text, /🟢 Heartbeat/);
  assert.match(text, /Моніторю 0 тендерів/);
  assert.doesNotMatch(text, /Поточні дедлайни/);
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

test('formatDigest: renders deadline_approaching event with hour label', () => {
  const text24 = formatDigest('2026-05-16T12:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'deadline_approaching', threshold: '24h', deadline: '2026-05-17T10:00:00+03:00' }],
  }]);
  assert.match(text24, /⏰ До дедлайну подачі менше 24 годин/);

  const text3 = formatDigest('2026-05-16T12:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X', prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'deadline_approaching', threshold: '3h', deadline: '2026-05-16T14:00:00+03:00' }],
  }]);
  assert.match(text3, /⏰ До дедлайну подачі менше 3 годин/);
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
