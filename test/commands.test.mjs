import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, buildAutoNotes, formatAddReply } from '../commands.mjs';

test('parseCommand: /list', () => {
  assert.deepEqual(parseCommand('/list'), { cmd: 'list' });
});

test('parseCommand: /list with bot suffix', () => {
  assert.deepEqual(parseCommand('/list@my_bot'), { cmd: 'list' });
});

test('parseCommand: /list and /help reject trailing text (strict)', () => {
  assert.deepEqual(parseCommand('/list extra'), { cmd: 'unknown' });
  assert.deepEqual(parseCommand('/help please'), { cmd: 'unknown' });
});

test('parseCommand: /help', () => {
  assert.deepEqual(parseCommand('/help'), { cmd: 'help' });
});

test('parseCommand: /add with valid id, no notes', () => {
  assert.deepEqual(
    parseCommand('/add UA-2026-04-30-010542-a'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: null }
  );
});

test('parseCommand: /add with id and notes', () => {
  assert.deepEqual(
    parseCommand('/add UA-2026-04-30-010542-a Рівне ОКЛ — ISO 15189'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: 'Рівне ОКЛ — ISO 15189' }
  );
});

test('parseCommand: /add normalizes uppercase suffix to lowercase', () => {
  assert.deepEqual(
    parseCommand('/add UA-2026-04-30-010542-A'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: null }
  );
});

test('parseCommand: /add with bot suffix', () => {
  assert.deepEqual(
    parseCommand('/add@my_bot UA-2026-04-30-010542-a'),
    { cmd: 'add', tender_id: 'UA-2026-04-30-010542-a', notes: null }
  );
});

test('parseCommand: /add with garbage id → error', () => {
  assert.deepEqual(
    parseCommand('/add not-a-valid-id'),
    { cmd: 'add', error: 'invalid_id' }
  );
});

test('parseCommand: /add without args → error', () => {
  assert.deepEqual(
    parseCommand('/add'),
    { cmd: 'add', error: 'missing_id' }
  );
});

test('parseCommand: unknown slash command', () => {
  assert.deepEqual(parseCommand('/foo'), { cmd: 'unknown' });
  assert.deepEqual(parseCommand('/remove UA-...'), { cmd: 'unknown' });
});

test('parseCommand: free text — null', () => {
  assert.deepEqual(parseCommand('привіт'), { cmd: null });
  assert.deepEqual(parseCommand(''), { cmd: null });
});

test('parseCommand: non-string input — null', () => {
  assert.deepEqual(parseCommand(null), { cmd: null });
  assert.deepEqual(parseCommand(undefined), { cmd: null });
  assert.deepEqual(parseCommand(123), { cmd: null });
});

test('parseCommand: leading/trailing whitespace tolerated', () => {
  assert.deepEqual(parseCommand('  /list  '), { cmd: 'list' });
});

const SAMPLE_SNAP = {
  tender_id: 'UA-2026-04-30-010542-a',
  title: 'Реактиви для лабораторії, код ДК 33696500-0',
  procuringEntity: { name: 'КНП «Рівненська ОКЛ»', edrpou: '12345678' },
};

test('buildAutoNotes: combines entity name and stripped title', () => {
  assert.equal(
    buildAutoNotes(SAMPLE_SNAP),
    'КНП «Рівненська ОКЛ» — Реактиви для лабораторії'
  );
});

test('buildAutoNotes: missing procuringEntity → just title', () => {
  assert.equal(
    buildAutoNotes({ ...SAMPLE_SNAP, procuringEntity: null }),
    'Реактиви для лабораторії'
  );
});

test('buildAutoNotes: missing title → just entity name', () => {
  assert.equal(
    buildAutoNotes({ ...SAMPLE_SNAP, title: null }),
    'КНП «Рівненська ОКЛ»'
  );
});

test('buildAutoNotes: empty snapshot → empty string', () => {
  assert.equal(buildAutoNotes({}), '');
});

test('buildAutoNotes: truncates at 200 chars', () => {
  const longTitle = 'А'.repeat(300);
  const result = buildAutoNotes({ title: longTitle });
  assert.ok(result.length <= 200);
  assert.ok(result.endsWith('…'));
});

const FULL_SNAP = {
  tender_id: 'UA-2026-04-30-010542-a',
  title: 'Реактиви для лабораторії',
  status: 'active.tendering',
  tenderPeriod: { endDate: '2026-05-15T14:30:00+03:00' },
  procuringEntity: { name: 'КНП «Рівненська ОКЛ»', edrpou: '12345678' },
};

test('formatAddReply: new tender — full template', () => {
  const reply = formatAddReply(FULL_SNAP, { reEnable: false });
  assert.match(reply, /✅ Додано UA-2026-04-30-010542-a/);
  assert.match(reply, /📦 Реактиви для лабораторії/);
  assert.match(reply, /👥 КНП «Рівненська ОКЛ»/);
  assert.match(reply, /Статус: Приймання пропозицій/);
  assert.match(reply, /дедлайн 15\.05\.2026 до 14:30/);
  assert.match(reply, /Перший snapshot/);
});

test('formatAddReply: re-enable shows "Поновив" prefix', () => {
  const reply = formatAddReply(FULL_SNAP, { reEnable: true });
  assert.match(reply, /✅ Поновив моніторинг UA-/);
  assert.doesNotMatch(reply, /✅ Додано/);
});

test('formatAddReply: omits 👥 when procuringEntity null', () => {
  const reply = formatAddReply({ ...FULL_SNAP, procuringEntity: null }, { reEnable: false });
  assert.doesNotMatch(reply, /👥/);
  assert.match(reply, /📦 Реактиви/);
});

test('formatAddReply: omits "дедлайн" when tenderPeriod.endDate null', () => {
  const reply = formatAddReply({ ...FULL_SNAP, tenderPeriod: null }, { reEnable: false });
  assert.match(reply, /Статус: Приймання пропозицій/);
  assert.doesNotMatch(reply, /дедлайн/);
});

test('formatAddReply: drops DK code from title', () => {
  const reply = formatAddReply(
    { ...FULL_SNAP, title: 'Реактиви, код ДК 33696500-0' },
    { reEnable: false }
  );
  assert.match(reply, /📦 Реактиви\n/);
  assert.doesNotMatch(reply, /код ДК/);
});
