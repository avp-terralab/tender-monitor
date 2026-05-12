import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDigest, chunkMessage, formatHeartbeat, truncate, stripDkCode, fmtStatus, fmtDeadline, fmtTimeLeft, getUpdates, sendReply } from '../telegram.mjs';

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

// ─── Change 4: days-to-deadline ───────────────────────────────────────────────
test('fmtTimeLeft via formatDigest: future deadline shows days + hours', () => {
  // runIso = 2026-05-06T09:00, deadline = 2026-05-08T09:00 → 2 days 0 hours
  const text = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    status: 'active.tendering',
    deadline: '2026-05-08T09:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'monitoring_started', status: 'active.tendering', title: 'X',
               deadline: '2026-05-08T09:00:00+03:00',
               docs_count: 0, questions_count: 0, complaints_count: 0 }],
  }]);
  assert.match(text, /Залишилось: 2 (день|дні|днів)/);
});

test('fmtTimeLeft via formatDigest: past deadline shows friendly text', () => {
  // runIso after deadline
  const text = formatDigest('2026-05-20T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    status: 'active.tendering',
    deadline: '2026-05-15T14:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'monitoring_started', status: 'active.tendering', title: 'X',
               deadline: '2026-05-15T14:00:00+03:00',
               docs_count: 0, questions_count: 0, complaints_count: 0 }],
  }]);
  assert.match(text, /Залишилось: минув на/);
});

test('fmtTimeLeft via formatDigest: near-zero deadline shows закінчується зараз', () => {
  // deadline within 60 seconds
  const text = formatDigest('2026-05-08T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    status: 'active.tendering',
    deadline: '2026-05-08T09:00:30+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'monitoring_started', status: 'active.tendering', title: 'X',
               deadline: '2026-05-08T09:00:30+03:00',
               docs_count: 0, questions_count: 0, complaints_count: 0 }],
  }]);
  assert.match(text, /Залишилось: закінчується зараз/);
});

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

test('formatDigest: context block (ℹ️ Статус + ⏰ Залишилось) appears for ongoing runs (no monitoring_started event)', () => {
  const text = formatDigest('2026-05-06T09:00:00+03:00', [{
    tender_id: 'UA-X', title: 'X',
    status: 'active.tendering',
    deadline: '2026-05-08T09:00:00+03:00',
    prozorro_url: 'https://prozorro.gov.ua/tender/UA-X',
    events: [{ type: 'new_question', title: 'q' }],
  }]);
  assert.match(text, /ℹ️ Статус: Приймання пропозицій/);
  assert.match(text, /⏰ Залишилось:/);
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
