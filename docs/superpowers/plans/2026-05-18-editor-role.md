# Editor Role + Role-Based Command Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Розщепити authorization бота на admin/editor/viewer; ролі зберігаються per-user у `_state/allowed_users.json`; адмін керує ролями через `/invite [editor|viewer] [name]` та `/role [editor|viewer] [chat_id]`. Команди ховаються в `/help` і Telegram autocomplete за роллю.

**Architecture:** Чисто-функціональні handlers у `commands.mjs` (parser, role check, mutation builder, formatters). Worker handler (`worker/src/handler.mjs`) — orchestration: завантажує allowed_users, обчислює роль, guard для mutating-команд, виклик `setMyCommands` per-chat. Storage міграція lazy: записи без `role` читаються як viewer.

**Tech Stack:** Node.js 20+, ESM modules, node:test, Cloudflare Worker, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-05-18-editor-role-design.md`

---

## File Map

**Modify:**
- `commands.mjs` — parsers (/invite, /role), handlers (handleInvite, handleRedeem, handleRole, handleUsersList, handleInvitesList, applyAllowedUsersMutation), buildHelpText, BOT_COMMANDS_BY_ROLE
- `telegram.mjs` — додати `setMyCommands`
- `worker/src/handler.mjs` — role parsing, MUTATING guard, /invite & /role wiring, syncBotCommands, callback editor check
- `test/commands.test.mjs` — нові тести для всіх pure helpers
- `worker/test/handler.test.mjs` — нові тести для guard, /invite, /role, syncBotCommands
- `_state/allowed_users.json` — pre-seed Оксани (Task 13)

**No new files.**

**Test runner:** `node --test test/*.test.mjs worker/test/*.test.mjs` (from repo root). Single test: `node --test --test-name-pattern='pattern' test/commands.test.mjs`.

---

### Task 1: parseCommand /invite з role-first форматом

**Files:**
- Modify: `commands.mjs:126-131`
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

Append у `test/commands.test.mjs`:

```js
test('parseCommand: /invite editor Andrii → role+label', () => {
  assert.deepEqual(parseCommand('/invite editor Andrii'), {
    cmd: 'invite', role: 'editor', label: 'Andrii',
  });
});

test('parseCommand: /invite viewer Olha → role+label', () => {
  assert.deepEqual(parseCommand('/invite viewer Olha'), {
    cmd: 'invite', role: 'viewer', label: 'Olha',
  });
});

test('parseCommand: /invite viewer Olha Test → label with spaces', () => {
  assert.deepEqual(parseCommand('/invite viewer Olha Test'), {
    cmd: 'invite', role: 'viewer', label: 'Olha Test',
  });
});

test('parseCommand: /invite (no args) → missing_role', () => {
  assert.deepEqual(parseCommand('/invite'), { cmd: 'invite', error: 'missing_role' });
});

test('parseCommand: /invite Andrii (no role keyword) → invalid_role', () => {
  // "Andrii" в позиції role не співпадає з editor|viewer → invalid_role
  assert.deepEqual(parseCommand('/invite Andrii'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite admin Test → invalid_role', () => {
  assert.deepEqual(parseCommand('/invite admin Test'), { cmd: 'invite', error: 'invalid_role' });
});

test('parseCommand: /invite editor (no label) → missing_label', () => {
  assert.deepEqual(parseCommand('/invite editor'), { cmd: 'invite', error: 'missing_label' });
});

test('parseCommand: /invite viewer (no label) → missing_label', () => {
  assert.deepEqual(parseCommand('/invite viewer'), { cmd: 'invite', error: 'missing_label' });
});

test('parseCommand: /invite@botname editor Andrii → still parses', () => {
  assert.deepEqual(parseCommand('/invite@terralab_tenders_bot editor Andrii'), {
    cmd: 'invite', role: 'editor', label: 'Andrii',
  });
});
```

- [ ] **Step 2: Запустити тести — мають впасти**

Run: `node --test --test-name-pattern='parseCommand: /invite' test/commands.test.mjs`
Expected: FAIL (старий парсер повертає `{ cmd: 'invite', label: 'editor Andrii' }`).

- [ ] **Step 3: Замінити парсер у `commands.mjs:126-131`**

Знайти існуючий блок:
```js
  const inviteMatch = trimmed.match(/^\/invite(?:@\w+)?(?:\s+(.+))?$/i);
  if (inviteMatch) {
    const label = (inviteMatch[1] || '').trim();
    if (!label) return { cmd: 'invite', error: 'missing_label' };
    return { cmd: 'invite', label };
  }
```

Замінити на:
```js
  const inviteMatch = trimmed.match(/^\/invite(?:@\w+)?(?:\s+(.+))?$/i);
  if (inviteMatch) {
    const args = (inviteMatch[1] || '').trim();
    if (!args) return { cmd: 'invite', error: 'missing_role' };
    const parts = args.split(/\s+/);
    const role = parts[0].toLowerCase();
    if (role !== 'editor' && role !== 'viewer') {
      return { cmd: 'invite', error: 'invalid_role' };
    }
    const label = parts.slice(1).join(' ').trim();
    if (!label) return { cmd: 'invite', error: 'missing_label' };
    return { cmd: 'invite', role, label };
  }
```

- [ ] **Step 4: Запустити тести — мають пройти**

Run: `node --test --test-name-pattern='parseCommand: /invite' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Запустити весь набір — переконатись що нічого не зламали**

Run: `node --test test/commands.test.mjs`
Expected: всі попередні тести проходять. Може зламатись існуючий тест на `/invite` без аргумента (раніше `missing_label`, тепер `missing_role`) — оновити його повідомлення в test file inline.

Якщо знайшовся існуючий тест з `error: 'missing_label'` для `/invite` без аргументів, оновити на `missing_role`.

- [ ] **Step 6: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: /invite expects [editor|viewer] [name] (role-first)"
```

---

### Task 2: parseCommand /role

**Files:**
- Modify: `commands.mjs:133-134` (insert new parser block перед `/invites`)
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('parseCommand: /role editor 12345 → role+chat_id', () => {
  assert.deepEqual(parseCommand('/role editor 12345'), {
    cmd: 'role', role: 'editor', chat_id: '12345',
  });
});

test('parseCommand: /role viewer 7321709183 → role+chat_id', () => {
  assert.deepEqual(parseCommand('/role viewer 7321709183'), {
    cmd: 'role', role: 'viewer', chat_id: '7321709183',
  });
});

test('parseCommand: /role (no args) → missing_args', () => {
  assert.deepEqual(parseCommand('/role'), { cmd: 'role', error: 'missing_args' });
});

test('parseCommand: /role editor (no chat_id) → missing_chat_id', () => {
  assert.deepEqual(parseCommand('/role editor'), { cmd: 'role', error: 'missing_chat_id' });
});

test('parseCommand: /role admin 12345 → invalid_role', () => {
  assert.deepEqual(parseCommand('/role admin 12345'), { cmd: 'role', error: 'invalid_role' });
});

test('parseCommand: /role 12345 editor (старий порядок) → invalid_role', () => {
  assert.deepEqual(parseCommand('/role 12345 editor'), { cmd: 'role', error: 'invalid_role' });
});

test('parseCommand: /role editor abc → invalid_chat_id', () => {
  assert.deepEqual(parseCommand('/role editor abc'), { cmd: 'role', error: 'invalid_chat_id' });
});

test('parseCommand: /role@botname editor 12345 → still parses', () => {
  assert.deepEqual(parseCommand('/role@terralab_tenders_bot editor 12345'), {
    cmd: 'role', role: 'editor', chat_id: '12345',
  });
});
```

- [ ] **Step 2: Запустити тести — мають впасти**

Run: `node --test --test-name-pattern='parseCommand: /role' test/commands.test.mjs`
Expected: FAIL з `cmd: 'unknown'` (бо `/role` зараз не розпізнається).

- [ ] **Step 3: Додати парсер**

У `commands.mjs` перед рядком `if (/^\/invites(?:@\w+)?$/i.test(trimmed)) return { cmd: 'invites' };` вставити:

```js
  const roleMatch = trimmed.match(/^\/role(?:@\w+)?(?:\s+(.+))?$/i);
  if (roleMatch) {
    const args = (roleMatch[1] || '').trim();
    if (!args) return { cmd: 'role', error: 'missing_args' };
    const parts = args.split(/\s+/);
    const role = parts[0].toLowerCase();
    if (role !== 'editor' && role !== 'viewer') {
      return { cmd: 'role', error: 'invalid_role' };
    }
    const chat_id = parts[1];
    if (!chat_id) return { cmd: 'role', error: 'missing_chat_id' };
    if (!NUMERIC_RE.test(chat_id)) return { cmd: 'role', error: 'invalid_chat_id' };
    return { cmd: 'role', role, chat_id };
  }
```

- [ ] **Step 4: Запустити тести**

Run: `node --test --test-name-pattern='parseCommand: /role' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Регресія**

Run: `node --test test/commands.test.mjs`
Expected: всі тести проходять.

- [ ] **Step 6: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: parseCommand /role [editor|viewer] [chat_id]"
```

---

### Task 3: handleInvite приймає role

**Files:**
- Modify: `commands.mjs:454-474`
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('handleInvite: writes role into invite record', () => {
  const result = handleInvite(
    {
      invites: [],
      generateToken: () => 'a'.repeat(32),
      now: () => new Date('2026-05-18T10:00:00.000Z'),
      botUsername: 'bot',
    },
    { role: 'editor', label: 'Andrii' },
  );
  assert.equal(result.mutation.type, 'append_invite');
  assert.equal(result.mutation.row.role, 'editor');
  assert.equal(result.mutation.row.label, 'Andrii');
  assert.match(result.reply, /Andrii/);
});

test('handleInvite: viewer role propagates', () => {
  const result = handleInvite(
    {
      invites: [],
      generateToken: () => 'b'.repeat(32),
      now: () => new Date('2026-05-18T10:00:00.000Z'),
      botUsername: 'bot',
    },
    { role: 'viewer', label: 'Olha' },
  );
  assert.equal(result.mutation.row.role, 'viewer');
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='handleInvite' test/commands.test.mjs`
Expected: FAIL (`row.role` undefined).

- [ ] **Step 3: Оновити `handleInvite` у `commands.mjs`**

Знайти існуючий `handleInvite` (рядок 454) і оновити сигнатуру + об'єкт `row`:

```js
export function handleInvite(deps, { role, label }) {
  const token = deps.generateToken();
  const now = deps.now();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const row = {
    token,
    label,
    role,
    created_at: createdAt,
    expires_at: expiresAt,
    status: 'pending',
    redeemed_by: null,
    redeemed_at: null,
  };
  const link = `https://t.me/${deps.botUsername}?start=${token}`;
  const reply = `🔗 Invite для <b>${escapeHtml(label)}</b> (${role})\n\n${link}\n\nПерешли цій людині. Дійсне 7 днів.`;
  return {
    reply,
    mutation: { type: 'append_invite', row },
  };
}
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='handleInvite' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Регресія**

Run: `node --test test/commands.test.mjs`
Expected: pass. Може зламатись існуючий тест на `handleInvite({ label })` без role — оновити викликами `{ role: 'viewer', label }`.

- [ ] **Step 6: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleInvite stores role in invite record"
```

---

### Task 4: handleRedeem копіює role з invite у user

**Files:**
- Modify: `commands.mjs:684-701` (userMutation row)
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('handleRedeem: user inherits role from invite (editor)', () => {
  const result = handleRedeem(
    {
      invites: [{
        token: 't'.repeat(32),
        label: 'A',
        role: 'editor',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-18T10:00:00.000Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(result.userMutation.row.role, 'editor');
});

test('handleRedeem: user inherits role viewer', () => {
  const result = handleRedeem(
    {
      invites: [{
        token: 't'.repeat(32),
        label: 'A',
        role: 'viewer',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-18T10:00:00.000Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(result.userMutation.row.role, 'viewer');
});

test('handleRedeem: legacy invite without role → user.role defaults to viewer', () => {
  const result = handleRedeem(
    {
      invites: [{
        token: 't'.repeat(32),
        label: 'A',
        // no role field
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      }],
      allowedUsers: [],
      adminChatId: '111',
      chatId: '222',
      now: () => new Date('2026-05-18T10:00:00.000Z'),
    },
    { token: 't'.repeat(32) },
  );
  assert.equal(result.userMutation.row.role, 'viewer');
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='handleRedeem: user inherits' test/commands.test.mjs`
Expected: FAIL (`row.role` undefined).

- [ ] **Step 3: Оновити row у `handleRedeem` (`commands.mjs`)**

Знайти `userMutation: { type: 'append_user', row: { ... } }` (приблизно рядок 690-697) і додати `role`:

```js
    userMutation: {
      type: 'append_user',
      row: {
        chat_id: chatId,
        label: invite.label,
        invited_via: invite.label,
        role: invite.role ?? 'viewer',
        added_at: nowIso,
      },
    },
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='handleRedeem' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Регресія**

Run: `node --test test/commands.test.mjs`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleRedeem copies role from invite to user"
```

---

### Task 5: applyAllowedUsersMutation підтримує set_role

**Files:**
- Modify: `commands.mjs:488-496`
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('applyAllowedUsersMutation: set_role updates role in-place', () => {
  const users = [
    { chat_id: '111', label: 'A', role: 'viewer' },
    { chat_id: '222', label: 'B', role: 'viewer' },
  ];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_role', chat_id: '222', role: 'editor',
  });
  assert.equal(result[0].role, 'viewer');
  assert.equal(result[1].role, 'editor');
  assert.equal(result[1].chat_id, '222');
  assert.equal(result[1].label, 'B'); // інші поля недоторкані
});

test('applyAllowedUsersMutation: set_role на legacy entry без поля role додає його', () => {
  const users = [{ chat_id: '111', label: 'A' }];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_role', chat_id: '111', role: 'editor',
  });
  assert.equal(result[0].role, 'editor');
});

test('applyAllowedUsersMutation: set_role на неіснуючого chat_id залишає масив незмінним', () => {
  const users = [{ chat_id: '111', label: 'A', role: 'viewer' }];
  const result = applyAllowedUsersMutation(users, {
    type: 'set_role', chat_id: '999', role: 'editor',
  });
  assert.deepEqual(result, users);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='applyAllowedUsersMutation: set_role' test/commands.test.mjs`
Expected: FAIL (set_role case не існує, повертає invariant).

- [ ] **Step 3: Додати case у `applyAllowedUsersMutation`**

У `commands.mjs:488`:

```js
export function applyAllowedUsersMutation(users, mutation) {
  if (mutation.type === 'append_user') {
    return [...users, mutation.row];
  }
  if (mutation.type === 'remove_user') {
    return users.filter(u => u.chat_id !== mutation.chat_id);
  }
  if (mutation.type === 'set_role') {
    return users.map(u =>
      u.chat_id === mutation.chat_id ? { ...u, role: mutation.role } : u
    );
  }
  return users;
}
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='applyAllowedUsersMutation' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: applyAllowedUsersMutation supports set_role"
```

---

### Task 6: handleRole

**Files:**
- Modify: `commands.mjs` (додати після `handleRevoke`, ~рядок 745)
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('handleRole: viewer → editor для existing user повертає mutation', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'Andrii', role: 'viewer' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '222' },
  );
  assert.deepEqual(result.mutation, { type: 'set_role', chat_id: '222', role: 'editor' });
  assert.match(result.reply, /Andrii/);
  assert.match(result.reply, /editor/);
});

test('handleRole: editor → viewer', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X', role: 'editor' }],
      adminChatId: '111',
    },
    { role: 'viewer', chat_id: '222' },
  );
  assert.equal(result.mutation.role, 'viewer');
  assert.match(result.reply, /viewer/);
});

test('handleRole: target == admin → refuse with reply, no mutation', () => {
  const result = handleRole(
    {
      allowedUsers: [],
      adminChatId: '111',
    },
    { role: 'viewer', chat_id: '111' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /адмін/i);
});

test('handleRole: target not found → reply, no mutation', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X', role: 'viewer' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '999' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /не знайдено/i);
});

test('handleRole: target already has this role → no mutation, info reply', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X', role: 'editor' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '222' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /вже editor/i);
});

test('handleRole: legacy user без поля role; setting editor → mutation issued', () => {
  // Legacy без role == viewer; setting editor — change → mutation
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X' }],
      adminChatId: '111',
    },
    { role: 'editor', chat_id: '222' },
  );
  assert.equal(result.mutation.role, 'editor');
});

test('handleRole: legacy user без role; setting viewer → no mutation (фактично той самий)', () => {
  const result = handleRole(
    {
      allowedUsers: [{ chat_id: '222', label: 'X' }],
      adminChatId: '111',
    },
    { role: 'viewer', chat_id: '222' },
  );
  assert.equal(result.mutation, null);
  assert.match(result.reply, /вже viewer/i);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='handleRole' test/commands.test.mjs`
Expected: FAIL (`handleRole is not a function`).

- [ ] **Step 3: Додати export у `commands.mjs`**

Після `handleRevoke` (приблизно рядок 745):

```js
export function handleRole({ allowedUsers, adminChatId }, { role, chat_id }) {
  if (chat_id === adminChatId) {
    return { reply: '❌ Не можна змінити роль адміна', mutation: null };
  }
  const user = allowedUsers.find(u => u.chat_id === chat_id);
  if (!user) {
    return {
      reply: `❓ Користувача <code>${chat_id}</code> не знайдено. /users — список`,
      mutation: null,
    };
  }
  const currentRole = user.role ?? 'viewer';
  if (currentRole === role) {
    return {
      reply: `ℹ️ <b>${escapeHtml(user.label)}</b> вже ${role}`,
      mutation: null,
    };
  }
  return {
    reply: `✅ <b>${escapeHtml(user.label)}</b> (<code>${chat_id}</code>) → ${role}`,
    mutation: { type: 'set_role', chat_id, role },
  };
}
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='handleRole' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleRole — change role of existing user"
```

---

### Task 7: handleUsersList показує role

**Files:**
- Modify: `commands.mjs:704-713`
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('handleUsersList: shows role for each non-admin user', () => {
  const result = handleUsersList({
    allowedUsers: [
      { chat_id: '222', label: 'Andrii', role: 'editor' },
      { chat_id: '333', label: 'Olha', role: 'viewer' },
    ],
    adminChatId: '111',
  });
  assert.match(result, /1\. <code>111<\/code> — admin/);
  assert.match(result, /Andrii.*editor/);
  assert.match(result, /Olha.*viewer/);
});

test('handleUsersList: legacy user без role показується як viewer', () => {
  const result = handleUsersList({
    allowedUsers: [{ chat_id: '222', label: 'Legacy' }],
    adminChatId: '111',
  });
  assert.match(result, /Legacy.*viewer/);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='handleUsersList: shows role' test/commands.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Оновити `handleUsersList`**

Замінити `commands.mjs:704-713`:

```js
export function handleUsersList({ allowedUsers, adminChatId }) {
  const lines = [`👥 Користувачі бота:`, ''];
  lines.push(`1. <code>${adminChatId}</code> — admin`);
  allowedUsers.forEach((u, i) => {
    const role = u.role ?? 'viewer';
    const via = u.invited_via ? ` (від: ${escapeHtml(u.invited_via)})` : '';
    lines.push(`${i + 2}. <code>${u.chat_id}</code> — ${escapeHtml(u.label)} — ${role}${via}`);
  });
  lines.push('', `Всього: ${allowedUsers.length + 1}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='handleUsersList' test/commands.test.mjs`
Expected: PASS (включаючи попередній тест на `Всього:`).

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleUsersList shows role per user"
```

---

### Task 8: handleInvitesList показує role

**Files:**
- Modify: `commands.mjs:715-731`
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('handleInvitesList: shows planned role per active invite', () => {
  const result = handleInvitesList({
    invites: [
      {
        token: 'a'.repeat(32),
        label: 'Andrii',
        role: 'editor',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      {
        token: 'b'.repeat(32),
        label: 'Olha',
        role: 'viewer',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ],
    now: () => new Date('2026-05-18T00:00:00.000Z'),
  });
  assert.match(result, /Andrii.*editor/);
  assert.match(result, /Olha.*viewer/);
});

test('handleInvitesList: legacy invite без role → viewer', () => {
  const result = handleInvitesList({
    invites: [
      {
        token: 'a'.repeat(32),
        label: 'Legacy',
        status: 'pending',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ],
    now: () => new Date('2026-05-18T00:00:00.000Z'),
  });
  assert.match(result, /Legacy.*viewer/);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='handleInvitesList' test/commands.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Оновити `handleInvitesList`**

Замінити `commands.mjs:715-731`:

```js
export function handleInvitesList({ invites, now }) {
  const nowDate = now();
  const active = invites.filter(i =>
    i.status === 'pending' && new Date(i.expires_at) > nowDate
  );
  if (active.length === 0) {
    return '📭 Немає активних invite-посилань.';
  }
  const lines = [`🔗 Активні invite-посилання:`, ''];
  active.forEach((inv, i) => {
    const suffix = inv.token.slice(-6);
    const exp = inv.expires_at.slice(0, 10);
    const role = inv.role ?? 'viewer';
    lines.push(`${i + 1}. <b>${escapeHtml(inv.label)}</b> — ${role} — …${suffix} (до ${exp})`);
  });
  lines.push('', `Всього: ${active.length}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='handleInvitesList' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleInvitesList shows role per invite"
```

---

### Task 9: buildHelpText(role) + back-compat HELP_TEXT

**Files:**
- Modify: `commands.mjs:773-799`
- Test: `test/commands.test.mjs` (append + перевірити існуючі)

- [ ] **Step 1: Написати failing tests**

```js
import { buildHelpText } from '../commands.mjs';

test('buildHelpText("viewer") не містить mutating та admin команд', () => {
  const t = buildHelpText('viewer');
  assert.doesNotMatch(t, /\/add\b/);
  assert.doesNotMatch(t, /\/remove\b/);
  assert.doesNotMatch(t, /\/watch\b/);
  assert.doesNotMatch(t, /\/unwatch\b/);
  assert.doesNotMatch(t, /\/unarchive\b/);
  assert.doesNotMatch(t, /\/invite\b/);
  assert.doesNotMatch(t, /\/role\b/);
  assert.doesNotMatch(t, /\/users\b/);
  assert.doesNotMatch(t, /\/revoke\b/);
});

test('buildHelpText("viewer") містить view команди', () => {
  const t = buildHelpText('viewer');
  assert.match(t, /\/info/);
  assert.match(t, /\/watched/);
  assert.match(t, /\/archive/);
  assert.match(t, /\/help/);
  assert.match(t, /\/status/);
});

test('buildHelpText("editor") містить mutating, не admin', () => {
  const t = buildHelpText('editor');
  assert.match(t, /\/add/);
  assert.match(t, /\/remove/);
  assert.match(t, /\/watch/);
  assert.match(t, /\/unwatch/);
  assert.match(t, /\/unarchive/);
  assert.doesNotMatch(t, /\/invite\b/);
  assert.doesNotMatch(t, /\/role\b/);
  assert.doesNotMatch(t, /\/users\b/);
  assert.doesNotMatch(t, /\/revoke\b/);
});

test('buildHelpText("admin") містить усе включно з /role', () => {
  const t = buildHelpText('admin');
  assert.match(t, /\/add/);
  assert.match(t, /\/invite/);
  assert.match(t, /\/role/);
  assert.match(t, /\/users/);
  assert.match(t, /\/revoke/);
});

test('HELP_TEXT (export) === buildHelpText("admin") — back-compat', () => {
  assert.equal(HELP_TEXT, buildHelpText('admin'));
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='buildHelpText' test/commands.test.mjs`
Expected: FAIL (`buildHelpText is not a function`).

- [ ] **Step 3: Замінити `HELP_TEXT` блок у `commands.mjs:773-799`**

```js
const HELP_GENERAL = [
  'Загальні команди:',
  '/help — список команд',
  '/menu — показати швидкі кнопки',
  '/status — здоровʼя бота',
].join('\n');

const HELP_VIEW_TENDERS = [
  'Моніторинг закупівель за ID:',
  '/info [UA-...] — список усіх або деталі одного тендера',
];

const HELP_VIEW_ENTITIES = [
  'Моніторинг замовників за EDRPOU:',
  '/watched — список замовників',
];

const HELP_VIEW_ARCHIVE = [
  'Архів завершених закупівель:',
  '/archive — список архіву (з посиланнями на договори)',
  '/archive [UA-...] — деталі + договір',
];

const HELP_EDIT_TENDERS = [
  '/add UA-YYYY-MM-DD-NNNNNN-x — додати тендер',
  '/remove UA-YYYY-MM-DD-NNNNNN-x — видалити тендер',
];

const HELP_EDIT_ENTITIES = [
  '/watch EDRPOU — стежити за замовником',
  '/unwatch EDRPOU — припинити стежити',
];

const HELP_EDIT_ARCHIVE = [
  '/unarchive [UA-...] — повернути в моніторинг',
];

const HELP_ADMIN = [
  'Адмін-команди:',
  '/invite [editor|viewer] [імʼя] — створити invite-посилання',
  '/role [editor|viewer] [chat_id] — змінити роль користувача',
  '/invites — активні invite-посилання',
  '/users — список користувачів',
  '/revoke [chat_id] — видалити користувача',
].join('\n');

export function buildHelpText(role) {
  const parts = [HELP_GENERAL];

  const tenders = [...HELP_VIEW_TENDERS];
  if (role === 'editor' || role === 'admin') {
    // Insert edit lines before the view line so order is: add, remove, info
    tenders.splice(1, 0, ...HELP_EDIT_TENDERS);
  }
  parts.push(tenders.join('\n'));

  const entities = [...HELP_VIEW_ENTITIES];
  if (role === 'editor' || role === 'admin') {
    entities.splice(1, 0, ...HELP_EDIT_ENTITIES);
  }
  parts.push(entities.join('\n'));

  const archive = [...HELP_VIEW_ARCHIVE];
  if (role === 'editor' || role === 'admin') {
    archive.push(...HELP_EDIT_ARCHIVE);
  }
  parts.push(archive.join('\n'));

  if (role === 'admin') parts.push(HELP_ADMIN);

  return parts.join('\n\n');
}

export const HELP_TEXT = buildHelpText('admin');
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='buildHelpText' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Регресія — існуючі асерти на `HELP_TEXT mentions admin`**

Run: `node --test test/commands.test.mjs`
Expected: pass (тест `HELP_TEXT mentions admin commands` лишається — він перевіряє `/invite`, `/users`, `/revoke` присутність; всі є в admin block. Якщо тест шукає `/role` теж — він ще не там; додати у тест).

Якщо існуючий тест `HELP_TEXT mentions admin commands` падає на `/role` — додати асерт:
```js
assert.match(HELP_TEXT, /\/role/);
```

- [ ] **Step 6: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: buildHelpText(role) replaces flat HELP_TEXT"
```

---

### Task 10: BOT_COMMANDS_BY_ROLE export

**Files:**
- Modify: `commands.mjs` (додати після `buildHelpText`)
- Test: `test/commands.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
import { BOT_COMMANDS_BY_ROLE } from '../commands.mjs';

test('BOT_COMMANDS_BY_ROLE.viewer не містить editor/admin команд', () => {
  const names = BOT_COMMANDS_BY_ROLE.viewer.map(c => c.command);
  assert.ok(names.includes('info'));
  assert.ok(names.includes('archive'));
  assert.ok(!names.includes('add'));
  assert.ok(!names.includes('invite'));
  assert.ok(!names.includes('role'));
});

test('BOT_COMMANDS_BY_ROLE.editor містить mutating, не admin', () => {
  const names = BOT_COMMANDS_BY_ROLE.editor.map(c => c.command);
  assert.ok(names.includes('add'));
  assert.ok(names.includes('remove'));
  assert.ok(names.includes('watch'));
  assert.ok(names.includes('unwatch'));
  assert.ok(names.includes('unarchive'));
  assert.ok(!names.includes('invite'));
  assert.ok(!names.includes('role'));
});

test('BOT_COMMANDS_BY_ROLE.admin містить /role та інші admin commands', () => {
  const names = BOT_COMMANDS_BY_ROLE.admin.map(c => c.command);
  assert.ok(names.includes('role'));
  assert.ok(names.includes('invite'));
  assert.ok(names.includes('users'));
  assert.ok(names.includes('revoke'));
});

test('BOT_COMMANDS_BY_ROLE: усі command names ≤32 chars, descriptions ≤256', () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    for (const c of BOT_COMMANDS_BY_ROLE[role]) {
      assert.ok(c.command.length <= 32, `command ${c.command} too long`);
      assert.ok(c.description.length <= 256, `description ${c.description} too long`);
      assert.match(c.command, /^[a-z][a-z0-9_]*$/, `invalid command name ${c.command}`);
    }
  }
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='BOT_COMMANDS_BY_ROLE' test/commands.test.mjs`
Expected: FAIL (undefined import).

- [ ] **Step 3: Додати у `commands.mjs` після `buildHelpText`**

```js
const VIEW_COMMANDS = [
  { command: 'help',    description: 'Список команд' },
  { command: 'menu',    description: 'Швидкі кнопки' },
  { command: 'status',  description: 'Здоровʼя бота' },
  { command: 'info',    description: 'Список або деталі тендерів' },
  { command: 'watched', description: 'Список замовників' },
  { command: 'archive', description: 'Архів завершених закупівель' },
];
const EDIT_COMMANDS = [
  { command: 'add',       description: 'Додати тендер у моніторинг' },
  { command: 'remove',    description: 'Видалити тендер' },
  { command: 'watch',     description: 'Стежити за замовником (EDRPOU)' },
  { command: 'unwatch',   description: 'Припинити стежити за замовником' },
  { command: 'unarchive', description: 'Повернути тендер з архіву' },
];
const ADMIN_COMMANDS = [
  { command: 'invite',  description: 'Створити invite-посилання' },
  { command: 'role',    description: 'Змінити роль користувача' },
  { command: 'invites', description: 'Активні invite-посилання' },
  { command: 'users',   description: 'Список користувачів' },
  { command: 'revoke',  description: 'Видалити користувача' },
];

export const BOT_COMMANDS_BY_ROLE = {
  viewer: VIEW_COMMANDS,
  editor: [...VIEW_COMMANDS, ...EDIT_COMMANDS],
  admin:  [...VIEW_COMMANDS, ...EDIT_COMMANDS, ...ADMIN_COMMANDS],
};
```

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='BOT_COMMANDS_BY_ROLE' test/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands.mjs test/commands.test.mjs
git commit -m "commands: BOT_COMMANDS_BY_ROLE for Telegram setMyCommands"
```

---

### Task 11: telegram.setMyCommands

**Files:**
- Modify: `telegram.mjs` (append after `answerCallbackQuery`)
- Test: новий блок у `test/commands.test.mjs` (або створити `test/telegram.test.mjs` якщо не існує — перевір glob)

- [ ] **Step 1: Перевірити чи існує `test/telegram.test.mjs`**

Run (PowerShell): `Test-Path test/telegram.test.mjs`
Якщо немає — створити з імпортами:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setMyCommands } from '../telegram.mjs';
```

- [ ] **Step 2: Написати failing tests**

Append у `test/telegram.test.mjs` (створити якщо не існує):

```js
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
```

- [ ] **Step 3: Запустити — мають впасти**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL (`setMyCommands` undefined import).

- [ ] **Step 4: Додати у `telegram.mjs`**

Append після `answerCallbackQuery` (приблизно після рядка 443):

```js
export async function setMyCommands({ token, commands, chatId, fetch: fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const body = {
    commands,
    scope: { type: 'chat', chat_id: Number(chatId) },
    language_code: '',
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`setMyCommands ${res.status}`);
  }
}
```

- [ ] **Step 5: Тести**

Run: `node --test test/telegram.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add telegram.mjs test/telegram.test.mjs
git commit -m "telegram: setMyCommands wrapper for chat-scope command list"
```

---

### Task 12: handler — обчислення role + MUTATING guard

**Files:**
- Modify: `worker/src/handler.mjs` (рядки 61–102 та далі)
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

Append у `worker/test/handler.test.mjs`:

```js
test('runHandler: viewer (no role field, legacy) — /add → refusal, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V' }], sha: 's' }),
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer (role:viewer) — /remove → refusal', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchlist: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/remove ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer — /watch → refusal', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchedEntities: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/watch 12345678', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer — /unwatch → refusal', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchedEntities: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/unwatch 12345678', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: viewer — /unarchive → refusal', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/unarchive ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /редакторів/);
});

test('runHandler: editor (role:editor) — /add → success (saveWatchlist called)', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
    saveWatchlist: async (env, wl) => { saved.push(wl); },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.match(sent[0].text, /✅/);
});

test('runHandler: admin (chat_id == ADMIN_CHAT_ID) — /add → success', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
    saveWatchlist: async (env, wl) => { saved.push(wl); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: `/add ${ID}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
});

test('runHandler: viewer — /info still works (view command)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/info', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Немає активних тендерів/);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='viewer|editor' worker/test/handler.test.mjs`
Expected: FAIL — viewer виконує `/add` і отримує success замість refusal.

- [ ] **Step 3: Оновити `worker/src/handler.mjs`**

Знайти блок (рядки 61-102) і модифікувати після обчислення `isInvited`:

Замінити фрагмент від `const chatId = String(...)` до `if (typeof msg.text !== 'string') return;`:

```js
  const chatId = String(msg.chat?.id ?? '');
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const isAdmin = chatId !== '' && chatId === adminChatId;

  // /start works for everyone — reveals chat_id so non-allowed users can request access.
  if (typeof msg.text === 'string' && /^\/start(?:@\w+)?\s*$/i.test(msg.text)) {
    const startReply = isAdmin
      ? `👋 Привіт!\n\nТвій chat_id: <code>${chatId}</code>\n\n/help — список команд.`
      : `👋 Привіт!\n\nЦе приватний бот. Твій chat_id: <code>${chatId}</code>\n\nНадішли цей id адміну, щоб отримати доступ.`;
    try {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: startReply,
        replyToMessageId: msg.message_id,
        replyMarkup: isAdmin ? MAIN_KEYBOARD : undefined,
      });
    } catch (err) {
      console.error('worker: sendReply /start failed:', err.message);
    }
    return;
  }

  // For non-admin chat, check allowlist file. Admin skips this.
  let userRecord = null;
  if (!isAdmin) {
    try {
      const { users } = await _loadAllowedUsers(env);
      userRecord = users.find(u => u.chat_id === chatId) ?? null;
    } catch (err) {
      console.error('worker: loadAllowedUsers failed:', err.message);
      // Fail closed — non-admin sees nothing if we can't verify.
    }
  }
  const isInvited = userRecord !== null;
  const userRole = userRecord?.role ?? 'viewer';
  const isEditor = isAdmin || userRole === 'editor';
  const isAllowed = isAdmin || isInvited;
  const role = isAdmin ? 'admin' : (isEditor ? 'editor' : 'viewer');

  // /start <token> handled below regardless of allowlist (it grants access).
  const isStartWithToken = typeof msg.text === 'string' && /^\/start(?:@\w+)?\s+\S/i.test(msg.text);
  if (!isAllowed && !isStartWithToken) return;
  if (typeof msg.text !== 'string') return;

  const cmd = parseCommand(msg.text);
  let reply;

  const MUTATING = new Set(['add', 'remove', 'watch', 'unwatch', 'unarchive']);
  if (MUTATING.has(cmd.cmd) && !isEditor) {
    reply = '🚫 Це команда для редакторів. У тебе доступ лише для перегляду.';
  } else if (cmd.cmd === 'start') {
```

(Решта if/else if лишається — `else if (cmd.cmd === 'start')` тепер інлайнер ланцюжка.)

- [ ] **Step 4: Тести**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS. Існуючі тести які використовують `chat_id: 123` (admin) — лишаються зеленими, бо admin тепер editor.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: compute user role + MUTATING command guard"
```

---

### Task 13: handler — inline `add:` callback editor check

**Files:**
- Modify: `worker/src/handler.mjs` (function `handleCallbackQuery` near line 419-447)
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('callback add: viewer → ack with refusal, no watchlist save', async () => {
  const acks = [];
  let saveCalled = false;
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    saveWatchlist: async () => { saveCalled = true; },
    answerCallbackQuery: async (args) => { acks.push(args); },
  });
  await runHandler({
    update: {
      callback_query: {
        id: 'cb1',
        data: `add:${ID}`,
        message: { chat: { id: 456 }, message_id: 99 },
      },
    },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.equal(acks.length, 1);
  assert.match(acks[0].text, /редакторів/);
  assert.equal(acks[0].showAlert, true);
});

test('callback add: editor → success (watchlist saved, ack OK)', async () => {
  const saved = [];
  const acks = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
    loadWatchlist: async () => ({ watchlist: [], sha: 'wl' }),
    saveWatchlist: async (env, wl) => { saved.push(wl); },
    answerCallbackQuery: async (args) => { acks.push(args); },
    editMessageReplyMarkup: async () => {},
  });
  await runHandler({
    update: {
      callback_query: {
        id: 'cb2',
        data: `add:${ID}`,
        message: { chat: { id: 456 }, message_id: 99 },
      },
    },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.match(acks[0].text, /✅/);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='callback add' worker/test/handler.test.mjs`
Expected: FAIL — viewer додає тендер успішно.

- [ ] **Step 3: Оновити `handleCallbackQuery` у `worker/src/handler.mjs`**

Знайти функцію `handleCallbackQuery` (рядок 419). Після обчислення `isAllowed` (рядок 438), і перед `if (!isAllowed)`:

```js
async function handleCallbackQuery({
  cq, env, _editMessageReplyMarkup, _answerCallbackQuery,
  _loadAllowedUsers, _loadWatchlist, _saveWatchlist, _loadArchivedTenders,
  _fetchTender, _extractSnapshot,
}) {
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const chatId = String(cq.message?.chat?.id ?? '');
  const messageId = cq.message?.message_id;
  const isAdmin = chatId !== '' && chatId === adminChatId;

  let userRecord = null;
  if (!isAdmin) {
    try {
      const { users } = await _loadAllowedUsers(env);
      userRecord = users.find(u => u.chat_id === chatId) ?? null;
    } catch (err) {
      console.error('worker: callback loadAllowedUsers failed:', err.message);
    }
  }
  const isInvited = userRecord !== null;
  const isAllowed = isAdmin || isInvited;
  const isEditor = isAdmin || (userRecord?.role === 'editor');

  const ack = (text, showAlert = false) => _answerCallbackQuery({
    token: env.TELEGRAM_BOT_TOKEN, callbackQueryId: cq.id, text, showAlert,
  });

  if (!isAllowed) {
    await ack('🚫 Доступ заборонено', true);
    return;
  }

  const data = String(cq.data ?? '');
  if (data === 'noop') { await ack(); return; }

  if (data.startsWith('add:')) {
    if (!isEditor) {
      await ack('🚫 Це команда для редакторів', true);
      return;
    }
    // ... існуюча логіка
```

(Решта функції — без змін, лише вставити `if (!isEditor)` перевірку всередині гілки `data.startsWith('add:')` одразу після `if (!TENDER_ID_RE.test(...))`.)

- [ ] **Step 4: Тести**

Run: `node --test --test-name-pattern='callback add' worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Регресія**

Run: `node --test worker/test/handler.test.mjs`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: inline add: callback restricted to editors"
```

---

### Task 14: handler — /invite role-first wiring + /role

**Files:**
- Modify: `worker/src/handler.mjs` (import block + `/invite` branch + new `/role` branch)
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('runHandler: admin /invite editor Andrii → invite saved with role:editor', async () => {
  const savedInvites = [];
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 'inv' }),
    saveInvites: async (env, inv) => { savedInvites.push(inv); },
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-18T10:00:00.000Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite editor Andrii', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites.length, 1);
  assert.equal(savedInvites[0][0].role, 'editor');
  assert.match(sent[0].text, /Andrii/);
});

test('runHandler: admin /invite viewer Olha → invite saved with role:viewer', async () => {
  const savedInvites = [];
  const { deps } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 'inv' }),
    saveInvites: async (env, inv) => { savedInvites.push(inv); },
    generateToken: () => 'b'.repeat(32),
    now: () => new Date('2026-05-18T10:00:00.000Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite viewer Olha', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites[0][0].role, 'viewer');
});

test('runHandler: admin /invite Andrii (no role) → error reply, no save', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    saveInvites: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite Andrii', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /Невалідна роль|роль/i);
});

test('runHandler: admin /role editor 456 (user is viewer) → role flipped', async () => {
  const saved = [];
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '456', label: 'Andrii', role: 'viewer' }],
      sha: 'au',
    }),
    saveAllowedUsers: async (env, users) => { saved.push(users); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 456', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].role, 'editor');
  assert.match(sent[0].text, /✅/);
  assert.match(sent[0].text, /Andrii/);
});

test('runHandler: admin /role viewer (self admin chat_id) → refusal', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [], sha: 'au' }),
    saveAllowedUsers: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role viewer 123', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /адмін/i);
});

test('runHandler: admin /role editor 999 (user not found) → error reply', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [], sha: 'au' }),
    saveAllowedUsers: async () => { saveCalled = true; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 999', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.match(sent[0].text, /не знайдено/);
});

test('runHandler: viewer /role editor 999 → silent return (admin-only)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/role editor 999', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: editor /invite editor X → silent return (admin-only)', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/invite editor X', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='/role|/invite editor|/invite viewer|/invite Andrii' worker/test/handler.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Оновити worker/src/handler.mjs**

**3a.** Додати імпорт `handleRole` у блок з `commands.mjs`:

```js
import {
  parseCommand, handleAdd, handleStatus, handleRemove,
  handleWatch, handleUnwatch, handleWatched,
  handleInvite, handleRedeem, handleRevoke, handleRole, handleUsersList, handleInvitesList,
  handleArchive, handleArchiveDetail, handleUnarchive,
  applyMutation, applyEntityMutation, applyInviteMutation, applyAllowedUsersMutation,
  applyArchiveMutation,
  formatInfo, buildHelpText, BOT_COMMANDS_BY_ROLE, MAIN_KEYBOARD,
} from '../../commands.mjs';
```

(Зверни увагу — також додано `buildHelpText`, `BOT_COMMANDS_BY_ROLE`; HELP_TEXT не потрібен у worker.)

**3b.** Оновити гілку `/invite` (рядки 314-326):

```js
  } else if (cmd.cmd === 'invite') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_role') {
      reply = '❌ Вкажи роль першим: /invite editor [імʼя] або /invite viewer [імʼя]';
    } else if (cmd.error === 'invalid_role') {
      reply = '❌ Невалідна роль. Тільки editor або viewer.';
    } else if (cmd.error === 'missing_label') {
      reply = '❌ Вкажи імʼя: /invite editor [імʼя]';
    } else {
      reply = await applyInviteMutationWithRetry({
        env,
        loadInvites: _loadInvites,
        saveInvites: _saveInvites,
        computeMutation: ({ invites }) =>
          handleInvite({ invites, generateToken: _generateToken, now: _now, botUsername: BOT_USERNAME }, cmd),
      });
    }
  }
```

**3c.** Додати гілку `/role` після `/revoke` (приблизно після рядка 359):

```js
  } else if (cmd.cmd === 'role') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_args') {
      reply = '❌ Формат: /role [editor|viewer] [chat_id]';
    } else if (cmd.error === 'invalid_role') {
      reply = '❌ Невалідна роль. Тільки editor або viewer.';
    } else if (cmd.error === 'missing_chat_id') {
      reply = '❌ Не вказано chat_id. /role editor 12345';
    } else if (cmd.error === 'invalid_chat_id') {
      reply = '❌ chat_id має бути числом';
    } else {
      reply = await applyAllowedUsersMutationWithRetry({
        env,
        loadAllowedUsers: _loadAllowedUsers,
        saveAllowedUsers: _saveAllowedUsers,
        computeMutation: ({ users }) =>
          handleRole({ allowedUsers: users, adminChatId }, cmd),
      });
    }
  }
```

- [ ] **Step 4: Тести**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS (всі нові тести + жодного регрессу).

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: wire /invite role-first and /role commands"
```

---

### Task 15: handler — /help використовує buildHelpText(role)

**Files:**
- Modify: `worker/src/handler.mjs:390-391`
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('runHandler: viewer /help → response missing /add and /invite', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.doesNotMatch(sent[0].text, /\/add\b/);
  assert.doesNotMatch(sent[0].text, /\/invite\b/);
  assert.match(sent[0].text, /\/info/);
});

test('runHandler: editor /help → response has /add but no /invite', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /\/add/);
  assert.doesNotMatch(sent[0].text, /\/invite\b/);
});

test('runHandler: admin /help → response has /role and /invite', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /\/role/);
  assert.match(sent[0].text, /\/invite/);
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='/help → response' worker/test/handler.test.mjs`
Expected: FAIL — viewer бачить admin commands.

- [ ] **Step 3: Замінити у `worker/src/handler.mjs`**

Знайти рядки:
```js
  } else if (cmd.cmd === 'help') {
    reply = HELP_TEXT;
  }
```

Замінити на:
```js
  } else if (cmd.cmd === 'help') {
    reply = buildHelpText(role);
  }
```

Також: оновити існуючий тест `runHandler: /help → sendReply HELP_TEXT` (рядки ~225-239) — він тепер невірний у назві (admin отримує `buildHelpText('admin')` що дорівнює `HELP_TEXT`, тож існуючий асерт `sent[0].text === HELP_TEXT` лишається валідним для admin chat 123). Без змін у тесті потрібно — admin === HELP_TEXT.

- [ ] **Step 4: Тести**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: /help text per-role via buildHelpText"
```

---

### Task 16: handler — syncBotCommands на /start, /role та redeem

**Files:**
- Modify: `worker/src/handler.mjs` (deps injection + 3 call sites)
- Test: `worker/test/handler.test.mjs` (append)

- [ ] **Step 1: Написати failing tests**

```js
test('runHandler: /start (no token), viewer → setMyCommands called with viewer set', async () => {
  const calls = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'V', role: 'viewer' }], sha: 's' }),
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, '456');
  const names = calls[0].commands.map(c => c.command);
  assert.ok(names.includes('info'));
  assert.ok(!names.includes('add'));
  assert.ok(!names.includes('invite'));
});

test('runHandler: /start (no token), editor → setMyCommands with editor set', async () => {
  const calls = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'E', role: 'editor' }], sha: 's' }),
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 1);
  const names = calls[0].commands.map(c => c.command);
  assert.ok(names.includes('add'));
  assert.ok(!names.includes('invite'));
});

test('runHandler: /start (no token), admin → setMyCommands with admin set', async () => {
  const calls = [];
  const { deps } = makeDeps({
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 1);
  const names = calls[0].commands.map(c => c.command);
  assert.ok(names.includes('invite'));
  assert.ok(names.includes('role'));
});

test('runHandler: /start from non-allowed → setMyCommands NOT called', async () => {
  const calls = [];
  const { deps } = makeDeps({
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 999 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(calls.length, 0);
});

test('runHandler: /role editor 456 success → setMyCommands for target chat 456', async () => {
  const calls = [];
  const { deps } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '456', label: 'A', role: 'viewer' }], sha: 's',
    }),
    saveAllowedUsers: async () => {},
    setMyCommands: async (args) => { calls.push(args); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/role editor 456', message_id: 1 } },
    env: ENV,
    deps,
  });
  // Очікуємо принаймні один виклик з chatId 456 та editor commands
  const targetCall = calls.find(c => c.chatId === '456');
  assert.ok(targetCall, 'expected setMyCommands for target chat 456');
  const names = targetCall.commands.map(c => c.command);
  assert.ok(names.includes('add'));
});

test('runHandler: setMyCommands failure does not block reply', async () => {
  const { deps, sent } = makeDeps({
    setMyCommands: async () => { throw new Error('boom'); },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/start', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1); // reply still went through
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `node --test --test-name-pattern='setMyCommands|syncBotCommands' worker/test/handler.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Оновити `worker/src/handler.mjs`**

**3a.** Додати імпорт у блок `import { sendReply, ... } from '../../telegram.mjs';`:

```js
import { sendReply, editMessageReplyMarkup, answerCallbackQuery, setMyCommands } from '../../telegram.mjs';
```

**3b.** Додати у deps destructuring (на початку `runHandler`):

```js
  const _setMyCommands = deps.setMyCommands ?? setMyCommands;
```

**3c.** Додати helper-функцію у файл (поза `runHandler`, наприкінці file or as a top-level helper):

```js
async function syncBotCommands(_setMyCommands, token, chatId, role) {
  const commands = BOT_COMMANDS_BY_ROLE[role] ?? BOT_COMMANDS_BY_ROLE.viewer;
  try {
    await _setMyCommands({ token, commands, chatId });
  } catch (err) {
    console.error('worker: setMyCommands failed:', err.message);
  }
}
```

**3d.** Викликати з `/start` (без token) — у branch що обробляє `/^\/start(?:@\w+)?\s*$/i`, після `sendReply`, якщо `isAdmin` обчислений (раніше блок не обчислював `role`, бо `isAllowed` був не порахований). Спрощено — викликати лише якщо `isAdmin`:

Поки `isAllowed` обчислюється після цього `/start` блока, треба зробити одне з:
- (a) перемістити `/start` обробку нижче — після обчислення `isAllowed`/`role`;
- (b) запровадити окрему swallow логіку.

Вибрати (a): обчислити role до `/start` блока. Файл уже почали реструктурувати у Task 12 — там `userRole`/`role` обчислюється до парсингу. Перемістити `/start` блок ПІСЛЯ обчислення `role`:

У `worker/src/handler.mjs`, перенести блок `/start` (рядки 67-85) на нижче — одразу перед існуючим `if (!isAllowed && !isStartWithToken) return;`. Замінити умову та additional виклик:

```js
  // /start works for everyone — reveals chat_id; for allowed users, also seeds chat-scope command list.
  if (typeof msg.text === 'string' && /^\/start(?:@\w+)?\s*$/i.test(msg.text)) {
    const startReply = isAdmin
      ? `👋 Привіт!\n\nТвій chat_id: <code>${chatId}</code>\n\n/help — список команд.`
      : `👋 Привіт!\n\nЦе приватний бот. Твій chat_id: <code>${chatId}</code>\n\nНадішли цей id адміну, щоб отримати доступ.`;
    try {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: msg.chat.id,
        text: startReply,
        replyToMessageId: msg.message_id,
        replyMarkup: isAllowed ? MAIN_KEYBOARD : undefined,
      });
    } catch (err) {
      console.error('worker: sendReply /start failed:', err.message);
    }
    if (isAllowed) {
      // Fire-and-forget; logs but doesn't block.
      syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, chatId, role);
    }
    return;
  }
```

(Це означає: переніс `/start` ПІСЛЯ обчислення `role`, але ДО парсингу команди. Раніше тести очікували `replyMarkup: isAdmin ? ...` — тепер `isAllowed ? ...` — це міняє існуючий тест? Перевіримо.)

**3e.** Викликати з `handleRedeem` after both mutations succeed (мутації успіх → новий viewer). Знайти у `runHandler` після `notify admin` блока (приблизно рядок 145-155). Після `try { await _sendReply ... }` для admin notice, додати:

```js
// Sync command menu for the freshly-redeemed viewer
syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, chatId, 'viewer');
```

(Якщо invite.role був editor, треба `'editor'`. Цей знає `handleRedeem`, який не передає роль наверх. Спрощено: завжди передати `userRecord` — але після save його ще немає. Альтернатива — повернути `mutation.row.role` у `handleRedeem` result. Простіше: дістати з `result.userMutation.row.role` у місці виклику.)

Краще: після того як обидві мутації успіх, отримати:
```js
const newUserRole = result.userMutation.row.role ?? 'viewer';
syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, chatId, newUserRole);
```

Поставити це одразу після `if (mutationBSucceeded && result.adminNotice ...)` блока.

**3f.** Викликати з `/role` success. У гілці `/role` після `applyAllowedUsersMutationWithRetry` (рядок 359 area) — потрібно знати target chat_id і new role. Простіше: у `handleRole`, додати `target_chat_id` і `target_role` у return, далі прокинути в `applyAllowedUsersMutationWithRetry`. Або — викликати лише якщо reply починається з `✅`. Прагматичний вибір — викликати завжди (idempotent) використовуючи `cmd.chat_id` і `cmd.role`:

```js
    } else {
      reply = await applyAllowedUsersMutationWithRetry({...});
      // Sync target's command menu (idempotent — if mutation failed, this is harmless)
      if (typeof reply === 'string' && /^✅/.test(reply)) {
        syncBotCommands(_setMyCommands, env.TELEGRAM_BOT_TOKEN, cmd.chat_id, cmd.role);
      }
    }
```

- [ ] **Step 4: Оновити `makeDeps` у `worker/test/handler.test.mjs`**

Додати default fake:

```js
const makeDeps = (overrides = {}) => {
  const sent = [];
  return {
    sent,
    deps: {
      // ... існуючі ...
      setMyCommands: async () => {},
      ...overrides,
    },
  };
};
```

- [ ] **Step 5: Тести**

Run: `node --test worker/test/handler.test.mjs`
Expected: PASS.

Може зламатись існуючий `runHandler: /start for non-allowed user does NOT carry keyboard` — він очікує `replyMarkup === undefined` для chat 999. Після зміни `replyMarkup: isAllowed ? ... : undefined` — для chat 999 `isAllowed` = false → `undefined`. Все одно проходить.

Може зламатись `runHandler: /start from non-allowed → reply with their chat_id...` — той самий аналіз: chat 999 → `isAllowed` = false → `replyMarkup` undefined, reply text "приватний бот" — без змін, проходить.

- [ ] **Step 6: Commit**

```bash
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker: syncBotCommands on /start, redeem, /role"
```

---

### Task 17: Pre-seed Оксана з роллю editor у allowed_users.json

**Files:**
- Modify: `_state/allowed_users.json`

- [ ] **Step 1: Прочитати поточний файл**

Run: `cat _state/allowed_users.json` (або Read tool).
Очікувано: знайти запис `{ "chat_id": "7321709183", "label": "Оксана Каніцька", ... }` без поля `role`.

- [ ] **Step 2: Додати поле `role: "editor"` у запис Оксани**

Файл стає:
```json
[
  {
    "chat_id": "1725058653",
    "label": "Ліля Цісар",
    "invited_via": "Ліля Цісар",
    "added_at": "2026-05-12T08:22:32.666Z"
  },
  {
    "chat_id": "1197609556",
    "label": "Андрій Підкова",
    "invited_via": "Андрій Підкова",
    "added_at": "2026-05-12T19:04:41.629Z"
  },
  {
    "chat_id": "1402480451",
    "label": "Тетяна Косинська",
    "invited_via": "Тетяна Косинська",
    "added_at": "2026-05-13T08:30:21.629Z"
  },
  {
    "chat_id": "7321709183",
    "label": "Оксана Каніцька",
    "invited_via": "Оксана Каніцька",
    "added_at": "2026-05-14T07:14:45.140Z",
    "role": "editor"
  },
  {
    "chat_id": "786078813",
    "label": "Андрій Парасина 1511",
    "invited_via": "Андрій Парасина 1511",
    "added_at": "2026-05-14T14:43:16.018Z"
  }
]
```

- [ ] **Step 3: Перевірити JSON валідність**

Run: `node -e "JSON.parse(require('fs').readFileSync('_state/allowed_users.json'))" && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add _state/allowed_users.json
git commit -m "state: seed Оксана (7321709183) as editor"
```

---

### Task 18: Full test run + pre-deploy verification

**Files:** жодних змін — це verification.

- [ ] **Step 1: Запустити повний test suite**

Run: `node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: всі тести проходять (близько 440+, залежно від кількості нових).

- [ ] **Step 2: Перевірити що нічого не зламано у monitor flow**

Run: `node --test test/monitor.test.mjs` (якщо існує) або відповідні monitor тести.
Expected: pass.

- [ ] **Step 3: Лінт-перевірка JSON**

Run: `node -e "['_state/allowed_users.json','_state/watched_entities.json','watchlist.json'].forEach(f => JSON.parse(require('fs').readFileSync(f)))" && echo "JSON OK"`
Expected: `JSON OK` (підтверджує що seed не зламав структуру).

- [ ] **Step 4: (Опційно) — локальний smoke test парсера**

Run:
```
node -e "import('./commands.mjs').then(m => { console.log(m.parseCommand('/invite editor Andrii')); console.log(m.parseCommand('/role editor 12345')); console.log(m.parseCommand('/role admin X')); })"
```
Expected: bash побачить три об'єкти з очікуваною структурою (як у тестах Task 1, 2).

- [ ] **Step 5: Push гілки**

```bash
git push origin main
```
Push trigger'не `worker-deploy.yml` (бо змінилися `worker/src/handler.mjs`, `commands.mjs`, `telegram.mjs`) — CF Worker задеплоїться автоматично.

- [ ] **Step 6: Перевірити GHA Actions tab**

Перейти на https://github.com/avp-terralab/tender-monitor/actions → перевірити що `worker-deploy.yml` пройшов зелений (~2-3 хв).

- [ ] **Step 7: Manual verification через Telegram**

З admin акаунту (1744078008):
- `/start` → отримати reply, перевірити що `/` (autocomplete) одразу не оновився (Telegram кешує) — нормально, оновлення завантажиться у фоновому процесі
- `/help` → побачити блок "Адмін-команди" з `/role`
- `/users` → побачити список з ролями (Оксана = editor, решта = viewer)

З Оксаниного акаунту (7321709183) — попросити її:
- Надіслати `/start`
- Надіслати `/add UA-...` → перевірити що проходить (бо вона editor після seed)
- Перевірити `/help` → побачити `/add`, `/remove`, але БЕЗ `/invite` чи `/role`

З Лілі або іншого viewer'а — попросити (опційно):
- `/add UA-...` → отримати `🚫 Це команда для редакторів`
- `/help` → не побачити `/add`

- [ ] **Step 8: Якщо щось не так — rollback**

Якщо production-баги: `git revert <commit-sha-range>` і push. Worker зробить redeploy на попередню версію.

---

## Self-Review Notes

- **Spec coverage:** усі секції spec'а покриті задачами (схема storage — Task 13; команди — Tasks 1, 2, 14; форматування виходу — Tasks 7, 8; guard mutating — Task 12; callback — Task 13; help filter — Tasks 9, 15; setMyCommands — Tasks 11, 16; deployment — Task 17, 18).
- **Type consistency:** `set_role` mutation type вживається однаково у Task 5 (apply) і Task 6 (handle); `handleRole` signature `({allowedUsers, adminChatId}, {role, chat_id})` ідентична Task 6 і Task 14.
- **Placeholder scan:** жодних TODO/TBD. Усі тести з кодом, усі steps з commands.
- **Граничні випадки:** legacy без `role` field — окремі тести у Tasks 4, 5, 6, 7, 8, 9 та 10.

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-18-editor-role.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — я диспатчу fresh subagent per task, review між тасками, швидші ітерації.

**2. Inline Execution** — виконую таски в цій сесії через executing-plans, batch execution з checkpoint'ами для review.

**Який підхід?**
