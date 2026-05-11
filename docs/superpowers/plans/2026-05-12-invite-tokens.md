# Invite tokens — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual `ALLOWED_CHAT_ID` rotation with admin-issued single-use deep-link invites for `@terralab_tenders_bot`.

**Architecture:** Pure command handlers in `commands.mjs` (DI'd for testing), I/O helpers added to `worker/src/github.mjs` (reusing existing `loadFile`/`saveFile`), wiring + auth refactor in `worker/src/handler.mjs`. Allowlist moves from CF env secret to `_state/allowed_users.json`; admin auth gated only by new `ADMIN_CHAT_ID` env (so admin survives GitHub outages). Invite tokens stored in `_state/invites.json` with status field (pending/redeemed/revoked) for audit.

**Tech Stack:** Node.js 20+ built-ins, `node:test`, Cloudflare Workers, GitHub Contents API.

**Spec:** `docs/superpowers/specs/2026-05-11-invite-tokens-design.md`

---

## File map

**Modified:**
- `commands.mjs` — add `parseCommand` branches, `handleInvite`, `handleRedeem`, `handleRevoke`, `handleUsersList`, `handleInvitesList`, `applyInviteMutation`, `applyAllowedUsersMutation`. Update `HELP_TEXT`.
- `worker/src/github.mjs` — add `loadInvites`/`saveInvites`/`loadAllowedUsers`/`saveAllowedUsers` (use existing `loadFile`/`saveFile`).
- `worker/src/handler.mjs` — replace `isAllowed` check; add `/start <token>` branch; wire 4 new commands; inject new deps.
- `test/commands.test.mjs` — extend with new tests (≈25 new).
- `worker/test/handler.test.mjs` — migrate env from `ALLOWED_CHAT_ID` to `ADMIN_CHAT_ID` + new `loadAllowedUsers` dep; add tests for new commands.
- `worker/test/github.test.mjs` — add tests for new I/O helpers.

**Created:**
- `_state/allowed_users.json` — migration state with the 2 existing non-admin chat_ids.

**Not changed:** `monitor.mjs`, `ci.mjs`, `entity_watch.mjs`, `prozorro.mjs`, `telegram.mjs`. Monitor cycle doesn't care about allowlist; only Worker uses it.

---

## Task 1: parseCommand — new commands

**Files:**
- Modify: `commands.mjs` (parseCommand function around line 6-68)
- Test: `test/commands.test.mjs`

Tokens are 32-char lowercase hex. Labels can contain Cyrillic, spaces, dashes — limit to 64 chars.

- [ ] **Step 1: Write failing tests**

Append to `test/commands.test.mjs`:

```js
test('parseCommand: /invite with label', () => {
  assert.deepEqual(parseCommand('/invite Olha'), { cmd: 'invite', label: 'Olha' });
});

test('parseCommand: /invite with multi-word label', () => {
  assert.deepEqual(parseCommand('/invite Olha Petrenko'), { cmd: 'invite', label: 'Olha Petrenko' });
});

test('parseCommand: /invite with Cyrillic label', () => {
  assert.deepEqual(parseCommand('/invite Ольга'), { cmd: 'invite', label: 'Ольга' });
});

test('parseCommand: /invite without label → error', () => {
  assert.deepEqual(parseCommand('/invite'), { cmd: 'invite', error: 'missing_label' });
});

test('parseCommand: /invite with bot suffix', () => {
  assert.deepEqual(parseCommand('/invite@my_bot Olha'), { cmd: 'invite', label: 'Olha' });
});

test('parseCommand: /invite trims label whitespace', () => {
  assert.deepEqual(parseCommand('/invite   Olha   '), { cmd: 'invite', label: 'Olha' });
});

test('parseCommand: /invites', () => {
  assert.deepEqual(parseCommand('/invites'), { cmd: 'invites' });
});

test('parseCommand: /users', () => {
  assert.deepEqual(parseCommand('/users'), { cmd: 'users' });
});

test('parseCommand: /revoke with numeric chat_id', () => {
  assert.deepEqual(parseCommand('/revoke 123456789'), { cmd: 'revoke', chat_id: '123456789' });
});

test('parseCommand: /revoke without arg → error', () => {
  assert.deepEqual(parseCommand('/revoke'), { cmd: 'revoke', error: 'missing_chat_id' });
});

test('parseCommand: /revoke with non-numeric → error', () => {
  assert.deepEqual(parseCommand('/revoke abc'), { cmd: 'revoke', error: 'invalid_chat_id' });
});

test('parseCommand: /start without payload', () => {
  assert.deepEqual(parseCommand('/start'), { cmd: 'start' });
});

test('parseCommand: /start with token payload', () => {
  const tok = 'a'.repeat(32);
  assert.deepEqual(parseCommand(`/start ${tok}`), { cmd: 'start', token: tok });
});

test('parseCommand: /start with invalid token (wrong length)', () => {
  assert.deepEqual(parseCommand('/start abc'), { cmd: 'start', error: 'invalid_token' });
});

test('parseCommand: /start with bot suffix and token', () => {
  const tok = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(parseCommand(`/start@my_bot ${tok}`), { cmd: 'start', token: tok });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```
cd C:\Users\andre\Desktop\AI\tenders\tender-monitor
node --test test/commands.test.mjs
```
Expected: 15 new tests fail (assertion mismatches on `{ cmd: 'unknown' }` or `{ cmd: null }`).

- [ ] **Step 3: Implement parseCommand branches**

In `commands.mjs`, immediately after the existing `EDRPOU_RE` constant (line 4), add:

```js
const TOKEN_RE = /^[a-f0-9]{32}$/i;
const NUMERIC_RE = /^\d+$/;
```

Inside `parseCommand`, BEFORE the final `if (trimmed.startsWith('/'))` line (~line 66), add these branches:

```js
  const startMatch = trimmed.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (startMatch) {
    const arg = (startMatch[1] || '').trim();
    if (!arg) return { cmd: 'start' };
    if (!TOKEN_RE.test(arg)) return { cmd: 'start', error: 'invalid_token' };
    return { cmd: 'start', token: arg.toLowerCase() };
  }

  const inviteMatch = trimmed.match(/^\/invite(?:@\w+)?(?:\s+(.+))?$/i);
  if (inviteMatch) {
    const label = (inviteMatch[1] || '').trim();
    if (!label) return { cmd: 'invite', error: 'missing_label' };
    return { cmd: 'invite', label };
  }

  if (/^\/invites(?:@\w+)?$/i.test(trimmed)) return { cmd: 'invites' };
  if (/^\/users(?:@\w+)?$/i.test(trimmed)) return { cmd: 'users' };

  const revokeMatch = trimmed.match(/^\/revoke(?:@\w+)?(?:\s+(.+))?$/i);
  if (revokeMatch) {
    const arg = (revokeMatch[1] || '').trim();
    if (!arg) return { cmd: 'revoke', error: 'missing_chat_id' };
    if (!NUMERIC_RE.test(arg)) return { cmd: 'revoke', error: 'invalid_chat_id' };
    return { cmd: 'revoke', chat_id: arg };
  }
```

- [ ] **Step 4: Run tests, verify all pass**

```
node --test test/commands.test.mjs
```
Expected: all tests pass (including pre-existing).

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: parse /invite, /invites, /users, /revoke, /start <token>"
```

---

## Task 2: handleInvite (pure)

**Files:**
- Modify: `commands.mjs`
- Test: `test/commands.test.mjs`

Generates a 32-hex token, returns mutation to append invite + reply with deep-link. Uses injected `generateToken` and `now` for determinism in tests.

- [ ] **Step 1: Write failing tests**

Append to `test/commands.test.mjs`:

```js
test('handleInvite: creates invite with given label, 7-day expiry, returns deep-link', () => {
  const result = handleInvite({
    invites: [],
    generateToken: () => 'a'.repeat(32),
    now: () => new Date('2026-05-12T10:00:00Z'),
    botUsername: 'terralab_tenders_bot',
  }, { label: 'Olha' });
  assert.equal(result.mutation.type, 'append_invite');
  assert.equal(result.mutation.row.token, 'a'.repeat(32));
  assert.equal(result.mutation.row.label, 'Olha');
  assert.equal(result.mutation.row.status, 'pending');
  assert.equal(result.mutation.row.created_at, '2026-05-12T10:00:00.000Z');
  assert.equal(result.mutation.row.expires_at, '2026-05-19T10:00:00.000Z');
  assert.equal(result.mutation.row.redeemed_by, null);
  assert.equal(result.mutation.row.redeemed_at, null);
  assert.match(result.reply, /t\.me\/terralab_tenders_bot\?start=a{32}/);
  assert.match(result.reply, /Olha/);
  assert.match(result.reply, /7 днів/);
});
```

Update the import block at the top to include `handleInvite`.

- [ ] **Step 2: Run, verify fail**

```
node --test test/commands.test.mjs
```
Expected: 1 fail "handleInvite is not a function".

- [ ] **Step 3: Implement**

Append to `commands.mjs` (before HELP_TEXT export):

```js
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function handleInvite(deps, { label }) {
  const token = deps.generateToken();
  const now = deps.now();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const row = {
    token,
    label,
    created_at: createdAt,
    expires_at: expiresAt,
    status: 'pending',
    redeemed_by: null,
    redeemed_at: null,
  };
  const link = `https://t.me/${deps.botUsername}?start=${token}`;
  const reply = `🔗 Invite для <b>${escapeHtml(label)}</b>\n\n${link}\n\nПерешли цій людині. Дійсне 7 днів.`;
  return {
    mutation: { type: 'append_invite', row },
    reply,
  };
}
```

- [ ] **Step 4: Run, verify pass**

```
node --test test/commands.test.mjs
```

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleInvite generates 7-day token + deep-link"
```

---

## Task 3: applyInviteMutation + applyAllowedUsersMutation (pure)

**Files:**
- Modify: `commands.mjs`
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write failing tests**

Append to `test/commands.test.mjs`:

```js
test('applyInviteMutation: append_invite adds row', () => {
  const row = { token: 'a'.repeat(32), label: 'X', status: 'pending' };
  assert.deepEqual(
    applyInviteMutation([], { type: 'append_invite', row }),
    [row]
  );
});

test('applyInviteMutation: update_invite_status changes status', () => {
  const existing = [
    { token: 't1', label: 'A', status: 'pending', redeemed_by: null, redeemed_at: null },
    { token: 't2', label: 'B', status: 'pending', redeemed_by: null, redeemed_at: null },
  ];
  const result = applyInviteMutation(existing, {
    type: 'update_invite_status',
    token: 't1',
    fields: { status: 'redeemed', redeemed_by: '999', redeemed_at: '2026-05-12T10:00:00Z' },
  });
  assert.equal(result[0].status, 'redeemed');
  assert.equal(result[0].redeemed_by, '999');
  assert.equal(result[1].status, 'pending'); // unchanged
});

test('applyAllowedUsersMutation: append_user adds row', () => {
  const row = { chat_id: '123', label: 'X', invited_via: 'X', added_at: '2026-05-12T10:00:00Z' };
  assert.deepEqual(
    applyAllowedUsersMutation([], { type: 'append_user', row }),
    [row]
  );
});

test('applyAllowedUsersMutation: remove_user filters by chat_id', () => {
  const users = [
    { chat_id: '1', label: 'A' },
    { chat_id: '2', label: 'B' },
  ];
  const result = applyAllowedUsersMutation(users, { type: 'remove_user', chat_id: '1' });
  assert.deepEqual(result, [{ chat_id: '2', label: 'B' }]);
});
```

Update import to include `applyInviteMutation`, `applyAllowedUsersMutation`.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

Append to `commands.mjs`:

```js
export function applyInviteMutation(invites, mutation) {
  if (mutation.type === 'append_invite') {
    return [...invites, mutation.row];
  }
  if (mutation.type === 'update_invite_status') {
    return invites.map(inv =>
      inv.token === mutation.token ? { ...inv, ...mutation.fields } : inv
    );
  }
  return invites;
}

export function applyAllowedUsersMutation(users, mutation) {
  if (mutation.type === 'append_user') {
    return [...users, mutation.row];
  }
  if (mutation.type === 'remove_user') {
    return users.filter(u => u.chat_id !== mutation.chat_id);
  }
  return users;
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: applyInviteMutation + applyAllowedUsersMutation"
```

---

## Task 4: handleRedeem (pure)

**Files:**
- Modify: `commands.mjs`
- Test: `test/commands.test.mjs`

Validates token, returns two mutations (or null if no-op) plus reply + adminNotice text.

- [ ] **Step 1: Write failing tests**

```js
test('handleRedeem: valid pending token → both mutations + reply + adminNotice', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    created_at: '2026-05-10T10:00:00Z',
    expires_at: '2026-05-17T10:00:00Z',
    redeemed_by: null,
    redeemed_at: null,
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });

  assert.equal(result.inviteMutation.type, 'update_invite_status');
  assert.equal(result.inviteMutation.token, 'a'.repeat(32));
  assert.equal(result.inviteMutation.fields.status, 'redeemed');
  assert.equal(result.inviteMutation.fields.redeemed_by, '555');
  assert.equal(result.inviteMutation.fields.redeemed_at, '2026-05-12T10:00:00.000Z');

  assert.equal(result.userMutation.type, 'append_user');
  assert.equal(result.userMutation.row.chat_id, '555');
  assert.equal(result.userMutation.row.label, 'Olha');
  assert.equal(result.userMutation.row.invited_via, 'Olha');
  assert.equal(result.userMutation.row.added_at, '2026-05-12T10:00:00.000Z');

  assert.match(result.reply, /✅/);
  assert.match(result.reply, /Olha/);
  assert.match(result.adminNotice, /🆕/);
  assert.match(result.adminNotice, /Olha/);
  assert.match(result.adminNotice, /555/);
});

test('handleRedeem: token not found', () => {
  const result = handleRedeem({
    invites: [],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.equal(result.adminNotice, null);
  assert.match(result.reply, /Невалідне посилання/);
});

test('handleRedeem: token already redeemed', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'redeemed',
    expires_at: '2026-05-17T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.match(result.reply, /вже використане/);
});

test('handleRedeem: token expired', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    expires_at: '2026-05-01T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.match(result.reply, /застаріло/);
});

test('handleRedeem: user already in allowlist → no consume, "вже маєш доступ"', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    expires_at: '2026-05-17T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [{ chat_id: '555', label: 'Already' }],
    adminChatId: '1744078008',
    chatId: '555',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.match(result.reply, /вже маєш доступ/);
});

test('handleRedeem: admin redeems own token → "вже маєш доступ", no consume', () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Self',
    status: 'pending',
    expires_at: '2026-05-17T10:00:00Z',
  };
  const result = handleRedeem({
    invites: [invite],
    allowedUsers: [],
    adminChatId: '1744078008',
    chatId: '1744078008',
    now: () => new Date('2026-05-12T10:00:00Z'),
  }, { token: 'a'.repeat(32) });
  assert.equal(result.inviteMutation, null);
  assert.equal(result.userMutation, null);
  assert.match(result.reply, /вже маєш доступ/);
});
```

Update import to include `handleRedeem`.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

Append to `commands.mjs`:

```js
export function handleRedeem(deps, { token }) {
  const { invites, allowedUsers, adminChatId, chatId } = deps;
  const now = deps.now();
  const nowIso = now.toISOString();

  const invite = invites.find(i => i.token === token);
  if (!invite) {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '❌ Невалідне посилання',
    };
  }
  if (invite.status !== 'pending') {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '❌ Посилання вже використане або відкликане',
    };
  }
  if (new Date(invite.expires_at) <= now) {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '❌ Посилання застаріло (>7 днів)',
    };
  }
  const alreadyAllowed =
    chatId === adminChatId ||
    allowedUsers.some(u => u.chat_id === chatId);
  if (alreadyAllowed) {
    return {
      inviteMutation: null,
      userMutation: null,
      adminNotice: null,
      reply: '✅ Ти вже маєш доступ. /help',
    };
  }
  return {
    inviteMutation: {
      type: 'update_invite_status',
      token,
      fields: { status: 'redeemed', redeemed_by: chatId, redeemed_at: nowIso },
    },
    userMutation: {
      type: 'append_user',
      row: {
        chat_id: chatId,
        label: invite.label,
        invited_via: invite.label,
        added_at: nowIso,
      },
    },
    reply: `✅ Доступ надано: <b>${escapeHtml(invite.label)}</b>.\n\n/help — список команд.`,
    adminNotice: `🆕 <b>${escapeHtml(invite.label)}</b> приєднався (chat_id: <code>${chatId}</code>)`,
  };
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleRedeem with token validation + dual mutation"
```

---

## Task 5: handleRevoke (pure)

**Files:**
- Modify: `commands.mjs`
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test('handleRevoke: removes user', () => {
  const users = [
    { chat_id: '1', label: 'A' },
    { chat_id: '2', label: 'B' },
  ];
  const result = handleRevoke({ allowedUsers: users, adminChatId: '99' }, { chat_id: '1' });
  assert.deepEqual(result.mutation, { type: 'remove_user', chat_id: '1' });
  assert.match(result.reply, /✅/);
  assert.match(result.reply, /A/);
});

test('handleRevoke: refuses to remove admin', () => {
  const result = handleRevoke({ allowedUsers: [], adminChatId: '99' }, { chat_id: '99' });
  assert.equal(result.mutation, null);
  assert.match(result.reply, /Не можу видалити адміна/);
});

test('handleRevoke: chat_id not in allowlist', () => {
  const result = handleRevoke({ allowedUsers: [{ chat_id: '1' }], adminChatId: '99' }, { chat_id: '7' });
  assert.equal(result.mutation, null);
  assert.match(result.reply, /не у allowlist/);
});
```

Update import.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

Append to `commands.mjs`:

```js
export function handleRevoke({ allowedUsers, adminChatId }, { chat_id }) {
  if (chat_id === adminChatId) {
    return { mutation: null, reply: '❌ Не можу видалити адміна' };
  }
  const user = allowedUsers.find(u => u.chat_id === chat_id);
  if (!user) {
    return { mutation: null, reply: `❓ chat_id <code>${chat_id}</code> не у allowlist` };
  }
  return {
    mutation: { type: 'remove_user', chat_id },
    reply: `✅ <b>${escapeHtml(user.label)}</b> видалено (chat_id: <code>${chat_id}</code>)`,
  };
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleRevoke with admin protection"
```

---

## Task 6: handleUsersList + handleInvitesList (pure)

**Files:**
- Modify: `commands.mjs`
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test('handleUsersList: empty → only admin row', () => {
  const reply = handleUsersList({
    allowedUsers: [],
    adminChatId: '1744078008',
  });
  assert.match(reply, /1744078008/);
  assert.match(reply, /admin/i);
  assert.match(reply, /Всього: 1/);
});

test('handleUsersList: with users', () => {
  const reply = handleUsersList({
    allowedUsers: [
      { chat_id: '111', label: 'Olha', invited_via: 'Olha', added_at: '2026-05-10T10:00:00Z' },
      { chat_id: '222', label: '(migrated)', invited_via: null, added_at: '2026-05-11T10:00:00Z' },
    ],
    adminChatId: '999',
  });
  assert.match(reply, /999/);
  assert.match(reply, /111/);
  assert.match(reply, /Olha/);
  assert.match(reply, /222/);
  assert.match(reply, /Всього: 3/);
});

test('handleInvitesList: empty', () => {
  const reply = handleInvitesList({
    invites: [],
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  assert.match(reply, /Немає активних invite/);
});

test('handleInvitesList: shows only pending non-expired', () => {
  const invites = [
    { token: 'a'.repeat(32), label: 'Pending1', status: 'pending', created_at: '2026-05-11T10:00:00Z', expires_at: '2026-05-18T10:00:00Z' },
    { token: 'b'.repeat(32), label: 'Redeemed', status: 'redeemed', created_at: '2026-05-10T10:00:00Z', expires_at: '2026-05-17T10:00:00Z' },
    { token: 'c'.repeat(32), label: 'Expired',  status: 'pending', created_at: '2026-04-01T10:00:00Z', expires_at: '2026-04-08T10:00:00Z' },
  ];
  const reply = handleInvitesList({
    invites,
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  assert.match(reply, /Pending1/);
  assert.doesNotMatch(reply, /Redeemed/);
  assert.doesNotMatch(reply, /Expired/);
  // Last 6 chars of token visible
  assert.match(reply, new RegExp('a'.repeat(6)));
});
```

Update import.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

Append to `commands.mjs`:

```js
export function handleUsersList({ allowedUsers, adminChatId }) {
  const lines = [`👥 Користувачі бота:`, ''];
  lines.push(`1. <code>${adminChatId}</code> — admin`);
  allowedUsers.forEach((u, i) => {
    const via = u.invited_via ? ` (від: ${escapeHtml(u.invited_via)})` : '';
    lines.push(`${i + 2}. <code>${u.chat_id}</code> — ${escapeHtml(u.label)}${via}`);
  });
  lines.push('', `Всього: ${allowedUsers.length + 1}`);
  return lines.join('\n');
}

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
    lines.push(`${i + 1}. <b>${escapeHtml(inv.label)}</b> — …${suffix} (до ${exp})`);
  });
  lines.push('', `Всього: ${active.length}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: handleUsersList + handleInvitesList read-only formatters"
```

---

## Task 7: Update HELP_TEXT

**Files:**
- Modify: `commands.mjs` (HELP_TEXT constant, around line 405)
- Test: `test/commands.test.mjs`

- [ ] **Step 1: Write failing test**

```js
test('HELP_TEXT mentions admin commands', () => {
  assert.match(HELP_TEXT, /\/invite/);
  assert.match(HELP_TEXT, /\/users/);
  assert.match(HELP_TEXT, /\/revoke/);
});
```

Add `HELP_TEXT` to the test import if not already present.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Update HELP_TEXT**

Replace the existing `HELP_TEXT` block in `commands.mjs` with:

```js
export const HELP_TEXT = [
  'Загальні команди:',
  '/help — список команд',
  '/status — здоровʼя бота',
  '',
  'Моніторинг закупівель за ID:',
  '/add UA-YYYY-MM-DD-NNNNNN-x — додати тендер',
  '/remove UA-YYYY-MM-DD-NNNNNN-x — видалити тендер',
  '/list — короткий список (id + Замовник)',
  '/info [UA-...] — детально (всі або один)',
  '',
  'Моніторинг замовників за EDRPOU:',
  '/watch EDRPOU — стежити за замовником',
  '/unwatch EDRPOU — припинити стежити',
  '/watched — список замовників',
  '',
  'Адмін-команди:',
  '/invite <ім\'я> — створити invite-посилання',
  '/invites — активні invite-посилання',
  '/users — список користувачів',
  '/revoke <chat_id> — видалити користувача',
].join('\n');
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add commands.mjs test/commands.test.mjs
git commit -m "commands: extend HELP_TEXT with admin-commands section"
```

---

## Task 8: github.mjs — loadInvites / saveInvites

**Files:**
- Modify: `worker/src/github.mjs`
- Test: `worker/test/github.test.mjs`

Reuses existing `loadFile`/`saveFile` helpers. Lazy-create on first save (sha=null tolerated).

- [ ] **Step 1: Inspect existing test pattern**

Read `worker/test/github.test.mjs` to see how `loadWatchedEntities` is tested. Mirror that.

- [ ] **Step 2: Write failing tests**

Append to `worker/test/github.test.mjs`:

```js
test('loadInvites: missing file returns empty list + null sha', async () => {
  const fetchImpl = async () => new Response('', { status: 404 });
  const env = { GITHUB_PAT: 'tok' };
  const { invites, sha } = await loadInvites(env, { fetch: fetchImpl });
  assert.deepEqual(invites, []);
  assert.equal(sha, null);
});

test('loadInvites: file with invites returns parsed list', async () => {
  const content = JSON.stringify({ invites: [{ token: 't', label: 'X' }] });
  const b64 = btoa(content);
  const fetchImpl = async () => new Response(JSON.stringify({ content: b64, sha: 'abc' }), { status: 200 });
  const env = { GITHUB_PAT: 'tok' };
  const { invites, sha } = await loadInvites(env, { fetch: fetchImpl });
  assert.deepEqual(invites, [{ token: 't', label: 'X' }]);
  assert.equal(sha, 'abc');
});

test('saveInvites: PUTs JSON body with sha', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response('{}', { status: 200 });
  };
  const env = { GITHUB_PAT: 'tok' };
  await saveInvites(env, [{ token: 't', label: 'X' }], 'abc', { fetch: fetchImpl });
  assert.equal(captured.init.method, 'PUT');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.sha, 'abc');
  const decoded = atob(body.content);
  assert.deepEqual(JSON.parse(decoded), [{ token: 't', label: 'X' }]);
});

test('loadAllowedUsers: 404 returns empty', async () => {
  const fetchImpl = async () => new Response('', { status: 404 });
  const { users, sha } = await loadAllowedUsers({ GITHUB_PAT: 'tok' }, { fetch: fetchImpl });
  assert.deepEqual(users, []);
  assert.equal(sha, null);
});

test('loadAllowedUsers: parses users array', async () => {
  const content = JSON.stringify({ users: [{ chat_id: '1', label: 'A' }] });
  const b64 = btoa(content);
  const fetchImpl = async () => new Response(JSON.stringify({ content: b64, sha: 'def' }), { status: 200 });
  const { users, sha } = await loadAllowedUsers({ GITHUB_PAT: 'tok' }, { fetch: fetchImpl });
  assert.deepEqual(users, [{ chat_id: '1', label: 'A' }]);
  assert.equal(sha, 'def');
});

test('saveAllowedUsers: PUTs with sha', async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return new Response('{}', { status: 200 }); };
  await saveAllowedUsers({ GITHUB_PAT: 'tok' }, [{ chat_id: '1' }], 'def', { fetch: fetchImpl });
  const body = JSON.parse(captured.init.body);
  assert.equal(body.sha, 'def');
});
```

Update imports at top of test file:

```js
import { loadInvites, saveInvites, loadAllowedUsers, saveAllowedUsers } from '../src/github.mjs';
```

(Merge with existing imports — don't duplicate `import`.)

Note about data shape: the JSON file has `{ "invites": [...] }` and `{ "users": [...] }` (top-level object with array property), but `loadInvites` returns the array directly. Same pattern as `loadWatchedSeen` and `loadWatchedEntities` (file stores object/array, loader returns just the relevant data).

Wait — actually the existing `loadWatchedEntities` stores the array directly: `return { entities: JSON.parse(content), sha };`. So content is JSON `[...]`, not `{ entities: [...] }`.

Decision: match the existing convention. Store invites.json as a JSON array (`[...]`), users file as `[...]`. Update spec / test fixtures accordingly. **Override the spec's nested-object example** — the file just contains the array.

Rewrite test fixtures for `loadInvites` / `loadAllowedUsers`:

```js
test('loadInvites: file with invites returns parsed list', async () => {
  const content = JSON.stringify([{ token: 't', label: 'X' }]);
  // ... rest same
});

test('loadAllowedUsers: parses users array', async () => {
  const content = JSON.stringify([{ chat_id: '1', label: 'A' }]);
  // ... rest same
});
```

- [ ] **Step 3: Run, verify fail**

```
node --test worker/test/github.test.mjs
```

- [ ] **Step 4: Implement**

Append to `worker/src/github.mjs` (at the bottom):

```js
const INVITES_FILE = '_state/invites.json';
const ALLOWED_USERS_FILE = '_state/allowed_users.json';

export async function loadInvites(env, opts = {}) {
  const { content, sha } = await loadFile(env, INVITES_FILE, opts);
  if (content === null) return { invites: [], sha: null };
  return { invites: JSON.parse(content), sha };
}

export async function saveInvites(env, invites, sha, opts = {}) {
  const text = JSON.stringify(invites, null, 2) + '\n';
  return saveFile(env, INVITES_FILE, text, sha, opts);
}

export async function loadAllowedUsers(env, opts = {}) {
  const { content, sha } = await loadFile(env, ALLOWED_USERS_FILE, opts);
  if (content === null) return { users: [], sha: null };
  return { users: JSON.parse(content), sha };
}

export async function saveAllowedUsers(env, users, sha, opts = {}) {
  const text = JSON.stringify(users, null, 2) + '\n';
  return saveFile(env, ALLOWED_USERS_FILE, text, sha, opts);
}
```

- [ ] **Step 5: Run, verify pass**

```
node --test worker/test/github.test.mjs
```

- [ ] **Step 6: Commit**

```
git add worker/src/github.mjs worker/test/github.test.mjs
git commit -m "worker/github: load/save invites + allowed_users"
```

---

## Task 9: handler.mjs — auth refactor + migrate existing tests

**Files:**
- Modify: `worker/src/handler.mjs` (auth block, lines 27-54)
- Test: `worker/test/handler.test.mjs`

Replace `ALLOWED_CHAT_ID` comma-parsing with: admin via `env.ADMIN_CHAT_ID` + non-admin via `loadAllowedUsers(env)`. The check is short-circuit — admin doesn't need GitHub.

- [ ] **Step 1: Update existing tests to new env shape**

In `worker/test/handler.test.mjs`:

a) Change the top-level `ENV` constant:
```js
const ENV = {
  TELEGRAM_BOT_TOKEN: 'TOK',
  ADMIN_CHAT_ID: '123',
};
```

b) Add `loadAllowedUsers: async () => ({ users: [], sha: null })` to the `makeDeps` defaults block (alongside the existing `loadWatchedSeen` etc).

c) The test **'runHandler: comma-separated ALLOWED_CHAT_ID → both ids allowed'** — rewrite as:

```js
test('runHandler: invited user from allowed_users.json is allowed', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'Olha' }], sha: 'sha' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/help', message_id: 9 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 456);
});
```

d) Replace **'runHandler: comma-separated ALLOWED_CHAT_ID → unlisted id still rejected'** similarly — unlisted user is rejected when not admin and not in users.

- [ ] **Step 2: Add failing test for admin path**

```js
test('runHandler: ADMIN_CHAT_ID always allowed without GitHub load', async () => {
  let loadCalled = false;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => { loadCalled = true; return { users: [], sha: null }; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/help', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(loadCalled, false);
});
```

- [ ] **Step 3: Run, expect existing tests to fail too (env changed)**

```
node --test worker/test/handler.test.mjs
```
Expected: several tests fail because env switched from ALLOWED to ADMIN.

- [ ] **Step 4: Refactor handler.mjs auth block**

Replace lines 27-54 of `worker/src/handler.mjs` (the existing `const msg = update.message;` through `if (!isAllowed) return;` block) with:

```js
  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat?.id ?? '');
  const adminChatId = String(env.ADMIN_CHAT_ID ?? '');
  const isAdmin = chatId !== '' && chatId === adminChatId;

  // /start works for everyone — reveals chat_id so non-allowed users can request access.
  // /start <token> is handled in a later branch.
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
      });
    } catch (err) {
      console.error('worker: sendReply /start failed:', err.message);
    }
    return;
  }

  // For non-admin chat, check allowlist file. Admin skips this (works during GH outages).
  let isInvited = false;
  if (!isAdmin) {
    try {
      const { users } = await _loadAllowedUsers(env);
      isInvited = users.some(u => u.chat_id === chatId);
    } catch (err) {
      console.error('worker: loadAllowedUsers failed:', err.message);
      // Fail closed — non-admin sees nothing if we can't verify.
    }
  }
  const isAllowed = isAdmin || isInvited;
  // /start <token> handled below regardless of allowlist (it grants access).
  const isStartWithToken = typeof msg.text === 'string' && /^\/start(?:@\w+)?\s+\S/i.test(msg.text);
  if (!isAllowed && !isStartWithToken) return;
  if (typeof msg.text !== 'string') return;
```

Also add to the imports at top of file:

```js
import {
  loadWatchlist, saveWatchlist,
  loadWatchedEntities, saveWatchedEntities,
  loadWatchedSeen, saveWatchedSeen,
  loadAllowedUsers, saveAllowedUsers,
  loadInvites, saveInvites,
  ConflictError,
} from './github.mjs';
```

And add to the deps block at top of runHandler:

```js
  const _loadAllowedUsers = deps.loadAllowedUsers ?? loadAllowedUsers;
  const _saveAllowedUsers = deps.saveAllowedUsers ?? saveAllowedUsers;
  const _loadInvites = deps.loadInvites ?? loadInvites;
  const _saveInvites = deps.saveInvites ?? saveInvites;
  const _generateToken = deps.generateToken ?? (() => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  });
  const _now = deps.now ?? (() => new Date());
```

Also update the `parseCommand`/`handleX` import line to include the new pure handlers and `BOT_USERNAME`:

```js
import {
  parseCommand, handleAdd, handleList, handleStatus, handleRemove,
  handleWatch, handleUnwatch, handleWatched,
  handleInvite, handleRedeem, handleRevoke, handleUsersList, handleInvitesList,
  applyMutation, applyEntityMutation, applyInviteMutation, applyAllowedUsersMutation,
  formatInfo, HELP_TEXT,
} from '../../commands.mjs';
```

Bot username is hard-coded — declare a constant near top of handler.mjs:

```js
const BOT_USERNAME = 'terralab_tenders_bot';
```

- [ ] **Step 5: Run, verify all tests pass**

```
node --test worker/test/handler.test.mjs
```

- [ ] **Step 6: Commit**

```
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker/handler: auth via ADMIN_CHAT_ID + allowed_users.json"
```

---

## Task 10: handler.mjs — /start <token> branch

**Files:**
- Modify: `worker/src/handler.mjs`
- Test: `worker/test/handler.test.mjs`

Wires `handleRedeem` + two SHA-optimistic GitHub writes + admin notification.

- [ ] **Step 1: Write failing tests**

```js
test('runHandler: /start <token> valid → mutates both files, replies, notifies admin', async () => {
  const invite = {
    token: 'a'.repeat(32),
    label: 'Olha',
    status: 'pending',
    expires_at: '2099-01-01T00:00:00Z',
    redeemed_by: null,
    redeemed_at: null,
  };
  let savedInvites = null;
  let savedUsers = null;
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [invite], sha: 'inv-sha' }),
    saveInvites: async (env, next, sha) => { savedInvites = { next, sha }; return {}; },
    loadAllowedUsers: async () => ({ users: [], sha: 'usr-sha' }),
    saveAllowedUsers: async (env, next, sha) => { savedUsers = { next, sha }; return {}; },
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 555 }, text: `/start ${'a'.repeat(32)}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites.sha, 'inv-sha');
  assert.equal(savedInvites.next[0].status, 'redeemed');
  assert.equal(savedInvites.next[0].redeemed_by, '555');
  assert.equal(savedUsers.sha, 'usr-sha');
  assert.equal(savedUsers.next[0].chat_id, '555');
  assert.equal(savedUsers.next[0].label, 'Olha');

  // Two replies sent: one to redeemer, one to admin
  assert.equal(sent.length, 2);
  const toUser = sent.find(s => s.chatId === 555);
  const toAdmin = sent.find(s => String(s.chatId) === '123');
  assert.ok(toUser);
  assert.ok(toAdmin);
  assert.match(toUser.text, /Доступ надано/);
  assert.match(toAdmin.text, /приєднався/);
});

test('runHandler: /start <token> invalid → reply, no mutations', async () => {
  let saveCalled = false;
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: null }),
    saveInvites: async () => { saveCalled = true; return {}; },
  });
  await runHandler({
    update: { message: { chat: { id: 555 }, text: `/start ${'b'.repeat(32)}`, message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(saveCalled, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Невалідне посилання/);
});

test('runHandler: /start with malformed token (bad regex) → invalid_token reply', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 555 }, text: '/start xyz', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Невалідне посилання/);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement /start <token> branch**

In `worker/src/handler.mjs`, in `runHandler`, in the `parseCommand` switch (the `if (cmd.cmd === 'add')` chain), add a new branch BEFORE the existing `add` branch:

```js
  if (cmd.cmd === 'start') {
    // /start without payload was handled earlier; here we only see /start <token>.
    if (cmd.error === 'invalid_token') {
      reply = '❌ Невалідне посилання';
    } else if (cmd.token) {
      try {
        const { invites, sha: inviteSha } = await _loadInvites(env);
        const { users, sha: usersSha } = await _loadAllowedUsers(env);
        const result = handleRedeem(
          { invites, allowedUsers: users, adminChatId, chatId, now: _now },
          { token: cmd.token },
        );
        reply = result.reply;
        if (result.inviteMutation && result.userMutation) {
          // Mutation A: invites.json — consume token
          try {
            const newInvites = applyInviteMutation(invites, result.inviteMutation);
            await _saveInvites(env, newInvites, inviteSha);
          } catch (err) {
            console.error('worker: saveInvites in redeem failed:', err.message);
            reply = '⚠️ Помилка збереження. Спробуй ще раз.';
            // Fall through — outer sendReply at bottom handles the reply.
            // No partial state created since Mutation A failed before Mutation B.
          }
          // Mutation B only if A succeeded (reply not overwritten above).
          if (reply === result.reply) {
            try {
              const newUsers = applyAllowedUsersMutation(users, result.userMutation);
              await _saveAllowedUsers(env, newUsers, usersSha);
            } catch (err) {
              console.error('worker: saveAllowedUsers in redeem failed:', err.message);
              reply = '⚠️ Токен спалено, але доступ не додано. Напиши адміну chat_id.';
            }
          }
          // Notify admin if both mutations succeeded.
          if (reply === result.reply && result.adminNotice && adminChatId) {
            try {
              await _sendReply({
                token: env.TELEGRAM_BOT_TOKEN,
                chatId: Number(adminChatId),
                text: result.adminNotice,
              });
            } catch (err) {
              console.error('worker: admin notification failed:', err.message);
            }
          }
        }
      } catch (err) {
        console.error('worker: redeem load failed:', err.message);
        reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
      }
    } else {
      // /start without payload was supposed to be handled earlier — defensive only
      return;
    }
  } else if (cmd.cmd === 'add') {
```

Note: ConflictError handling for the dual mutation is NOT retried here on purpose. A 409 on Mutation A means another redeemer won the race — we just report the resulting state via the next /start. For now, surface 409 as "Помилка збереження" and let admin investigate; rare in practice for invite tokens.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker/handler: /start <token> redeem with dual mutation + admin notice"
```

---

## Task 11: handler.mjs — /invite command

**Files:**
- Modify: `worker/src/handler.mjs`
- Test: `worker/test/handler.test.mjs`

Admin-only. Reuses `applyMutationWithRetry` pattern but on invites.json.

- [ ] **Step 1: Write failing tests**

```js
test('runHandler: /invite as admin → appends invite, replies with link', async () => {
  let savedInvites = null;
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({ invites: [], sha: 'i-sha' }),
    saveInvites: async (env, next, sha) => { savedInvites = next; return {}; },
    generateToken: () => 'c'.repeat(32),
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite Olha', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(savedInvites.length, 1);
  assert.equal(savedInvites[0].label, 'Olha');
  assert.equal(savedInvites[0].token, 'c'.repeat(32));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /t\.me\/terralab_tenders_bot\?start=c{32}/);
});

test('runHandler: /invite as non-admin → silently ignored', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/invite Y', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /invite without label → error reply (admin)', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invite', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Вкажи назву/);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

In `worker/src/handler.mjs`, add helper `applyInviteMutationWithRetry` (sibling to `applyMutationWithRetry`):

```js
async function applyInviteMutationWithRetry({ env, loadInvites, saveInvites, computeMutation }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { invites, sha } = await loadInvites(env);
      const result = computeMutation({ invites });
      if (!result.mutation) return result.reply;
      const next = applyInviteMutation(invites, result.mutation);
      await saveInvites(env, next, sha);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: applyInviteMutationWithRetry failed:', err.message);
      return err.message.includes('GitHub')
        ? '⚠️ GitHub тимчасово недоступний, спробуй за хвилину'
        : '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}
```

Add command branch (admin-gated) in the main if/else chain:

```js
  } else if (cmd.cmd === 'invite') {
    if (!isAdmin) return;  // silent ignore
    if (cmd.error === 'missing_label') {
      reply = '❌ Вкажи назву: /invite Olha';
    } else {
      reply = await applyInviteMutationWithRetry({
        env,
        loadInvites: _loadInvites,
        saveInvites: _saveInvites,
        computeMutation: ({ invites }) =>
          handleInvite({ invites, generateToken: _generateToken, now: _now, botUsername: BOT_USERNAME }, cmd),
      });
    }
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker/handler: /invite admin-only command"
```

---

## Task 12: handler.mjs — /invites, /users, /revoke

**Files:**
- Modify: `worker/src/handler.mjs`
- Test: `worker/test/handler.test.mjs`

Read-only `/invites` and `/users` need GitHub load but no mutation. `/revoke` mirrors `applyMutationWithRetry` for allowed_users.

- [ ] **Step 1: Write failing tests**

```js
test('runHandler: /invites as admin → lists active invites', async () => {
  const { deps, sent } = makeDeps({
    loadInvites: async () => ({
      invites: [{
        token: 'd'.repeat(32), label: 'Olha', status: 'pending',
        created_at: '2026-05-11T10:00:00Z', expires_at: '2099-01-01T00:00:00Z',
      }],
      sha: 's',
    }),
    now: () => new Date('2026-05-12T10:00:00Z'),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/invites', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Olha/);
});

test('runHandler: /invites as non-admin → silent', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '456', label: 'X' }], sha: 's' }),
  });
  await runHandler({
    update: { message: { chat: { id: 456 }, text: '/invites', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.equal(sent.length, 0);
});

test('runHandler: /users as admin → shows admin + invited', async () => {
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({
      users: [{ chat_id: '789', label: 'Olha', invited_via: 'Olha', added_at: '2026-05-11T10:00:00Z' }],
      sha: 's',
    }),
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/users', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /123/);
  assert.match(sent[0].text, /789/);
  assert.match(sent[0].text, /Olha/);
});

test('runHandler: /revoke as admin → removes user', async () => {
  let savedUsers = null;
  const { deps, sent } = makeDeps({
    loadAllowedUsers: async () => ({ users: [{ chat_id: '789', label: 'Olha' }], sha: 's' }),
    saveAllowedUsers: async (env, next) => { savedUsers = next; return {}; },
  });
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/revoke 789', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.deepEqual(savedUsers, []);
  assert.match(sent[0].text, /видалено/);
});

test('runHandler: /revoke admin chat_id → refused', async () => {
  const { deps, sent } = makeDeps();
  await runHandler({
    update: { message: { chat: { id: 123 }, text: '/revoke 123', message_id: 1 } },
    env: ENV,
    deps,
  });
  assert.match(sent[0].text, /Не можу видалити адміна/);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

Add helper `applyAllowedUsersMutationWithRetry` in `worker/src/handler.mjs`:

```js
async function applyAllowedUsersMutationWithRetry({ env, loadAllowedUsers, saveAllowedUsers, computeMutation }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { users, sha } = await loadAllowedUsers(env);
      const result = computeMutation({ users });
      if (!result.mutation) return result.reply;
      const next = applyAllowedUsersMutation(users, result.mutation);
      await saveAllowedUsers(env, next, sha);
      return result.reply;
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      if (err instanceof ConflictError) break;
      console.error('worker: applyAllowedUsersMutationWithRetry failed:', err.message);
      return err.message.includes('GitHub')
        ? '⚠️ GitHub тимчасово недоступний, спробуй за хвилину'
        : '⚠️ Сталася помилка на стороні бота';
    }
  }
  return '⚠️ Не зміг зберегти, спробуй за хвилину';
}
```

Add command branches in the if/else chain:

```js
  } else if (cmd.cmd === 'invites') {
    if (!isAdmin) return;
    try {
      const { invites } = await _loadInvites(env);
      reply = handleInvitesList({ invites, now: _now });
    } catch (err) {
      console.error('worker: /invites failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'users') {
    if (!isAdmin) return;
    try {
      const { users } = await _loadAllowedUsers(env);
      reply = handleUsersList({ allowedUsers: users, adminChatId });
    } catch (err) {
      console.error('worker: /users failed:', err.message);
      reply = '⚠️ GitHub тимчасово недоступний, спробуй за хвилину';
    }
  } else if (cmd.cmd === 'revoke') {
    if (!isAdmin) return;
    if (cmd.error === 'missing_chat_id') {
      reply = '❌ Не вказано chat_id. /revoke 12345';
    } else if (cmd.error === 'invalid_chat_id') {
      reply = '❌ chat_id має бути числом';
    } else {
      reply = await applyAllowedUsersMutationWithRetry({
        env,
        loadAllowedUsers: _loadAllowedUsers,
        saveAllowedUsers: _saveAllowedUsers,
        computeMutation: ({ users }) =>
          handleRevoke({ allowedUsers: users, adminChatId }, cmd),
      });
    }
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "worker/handler: /invites, /users, /revoke admin commands"
```

---

## Task 13: Migration — create _state/allowed_users.json

**Files:**
- Create: `_state/allowed_users.json`

The two existing non-admin chat_ids from current `ALLOWED_CHAT_ID` (`786078813`, `7321709183`) are seeded as `(migrated)` so they keep access after `ALLOWED_CHAT_ID` is removed.

- [ ] **Step 1: Verify current allowlist via Telegram → CF dashboard**

Open CF dashboard → Workers → `tender-monitor-bot` → Settings → Variables → confirm `ALLOWED_CHAT_ID` still contains `1744078008,786078813,7321709183`. (If list changed since spec was written, use the current list minus admin.)

- [ ] **Step 2: Create the file**

Create `_state/allowed_users.json` with content:

```json
[
  {
    "chat_id": "786078813",
    "label": "(migrated)",
    "invited_via": null,
    "added_at": "2026-05-12T00:00:00Z"
  },
  {
    "chat_id": "7321709183",
    "label": "(migrated)",
    "invited_via": null,
    "added_at": "2026-05-12T00:00:00Z"
  }
]
```

(Top-level array — matches what `loadAllowedUsers` expects.)

- [ ] **Step 3: Commit**

```
git add _state/allowed_users.json
git commit -m "_state: seed allowed_users.json with migrated users"
```

---

## Task 14: Set ADMIN_CHAT_ID secret in Cloudflare

**Files:** none (operational)

- [ ] **Step 1: Set secret via wrangler**

```powershell
cd C:\Users\andre\Desktop\AI\tenders\tender-monitor\worker
npx wrangler secret put ADMIN_CHAT_ID
# When prompted, paste: 1744078008
```

Do NOT delete `ALLOWED_CHAT_ID` yet — leave it as fallback (new code ignores it, but cleanup happens after smoke test).

- [ ] **Step 2: Verify secret listed**

```powershell
npx wrangler secret list
```
Expected: shows `ADMIN_CHAT_ID`, `ALLOWED_CHAT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_PAT`.

---

## Task 15: Push & auto-deploy

- [ ] **Step 1: Push main**

```
git push origin main
```

`worker-deploy.yml` triggers on push touching `worker/**`. Confirm green build at https://github.com/avp-terralab/tender-monitor/actions.

- [ ] **Step 2: Confirm Worker deploy**

CF dashboard → Workers → `tender-monitor-bot` → check latest deploy timestamp matches the push.

---

## Task 16: Smoke test

- [ ] **Step 1: Admin self-checks**

In Telegram, as admin (chat_id 1744078008), send to `@terralab_tenders_bot`:

```
/help            → expect new "Адмін-команди" section
/users           → expect "1. 1744078008 — admin", "2. 786078813 — (migrated)", "3. 7321709183 — (migrated)", "Всього: 3"
/invites         → expect "📭 Немає активних invite-посилань."
/invite TestUser → expect "🔗 Invite для TestUser" with https://t.me/terralab_tenders_bot?start=<32hex>
/invites         → now shows TestUser
```

- [ ] **Step 2: Other allowlisted user check**

From the chat_id `786078813` Telegram account, send `/help` → expect normal help (no "Адмін-команди" hidden — it's visible in HELP_TEXT for all). Send `/list` → expect normal response. Send `/invite Foo` → expect silence (non-admin).

- [ ] **Step 3: Redeem test from fresh account**

Tap the link from `/invite TestUser` from a Telegram account NOT in the allowlist (use a phone or alt account). Expect:
- New chat: "✅ Доступ надано: TestUser. /help"
- Admin chat: "🆕 TestUser приєднався (chat_id: <new_id>)"
- `/list` works from new account.
- Tapping the same link again from any account: "❌ Посилання вже використане або відкликане"

- [ ] **Step 4: Revoke test**

From admin: `/revoke <new_id>` → expect "✅ TestUser видалено (chat_id: ...)".
From the just-revoked account: send `/list` → expect no response.

- [ ] **Step 5: If anything fails, rollback**

CF dashboard → Workers → `tender-monitor-bot` → Deployments → Rollback to previous. Restore `ALLOWED_CHAT_ID` behavior (no code changes needed since it's still set). Diagnose locally before retry.

---

## Task 17: Cleanup ALLOWED_CHAT_ID + BotFather

- [ ] **Step 1: Delete legacy secret**

```powershell
cd C:\Users\andre\Desktop\AI\tenders\tender-monitor\worker
npx wrangler secret delete ALLOWED_CHAT_ID
# Confirm with y
```

- [ ] **Step 2: Smoke re-test**

Repeat Task 16 Step 1 once after deleting `ALLOWED_CHAT_ID` to confirm nothing relied on it.

- [ ] **Step 3: BotFather setcommands**

In Telegram, go to @BotFather → `/mybots` → `@terralab_tenders_bot` → Edit Bot → Edit Commands → paste:

```
help - список команд
status - здоровʼя бота
add - додати тендер за UA-ID
remove - видалити тендер
list - короткий список
info - детальна інформація
watch - стежити за замовником (EDRPOU)
unwatch - припинити стежити
watched - список замовників
invite - створити invite-посилання (адмін)
invites - активні invite-посилання (адмін)
users - список користувачів (адмін)
revoke - видалити користувача (адмін)
```

- [ ] **Step 4: Final commit on memory**

This task affects no repo files; the change is in CF secrets and Telegram metadata. No commit.

---

## Self-review notes (verified before handoff)

- **Spec coverage:** All commands in spec table are implemented (Tasks 1, 2, 4, 5, 6 + wiring in 10, 11, 12). Storage in `_state/allowed_users.json` + `_state/invites.json` (Tasks 8, 13). Admin via `ADMIN_CHAT_ID` env (Task 9, 14). Migration steps (Tasks 13-17). Lockout safety: admin auth doesn't load file (Task 9 short-circuit).
- **File format consistency:** Spec showed nested object (`{ "users": [...] }`); plan stores top-level array to match existing `loadWatchedEntities` convention. Noted explicitly in Task 8.
- **Token regex:** Defined `[a-f0-9]{32}` consistently — Task 1 parseCommand, Task 8 (not needed there). Generator pads to lowercase hex (Task 9 deps block).
- **Bot username:** Hardcoded `terralab_tenders_bot` as constant in Task 9, used in Tasks 2 (test) and 11 (impl).
- **No placeholders:** Every step has either exact code, exact command, or exact CF/Telegram action.
- **Frequent commits:** 12 of 17 tasks end with a commit; the 5 operational tasks (14, 15, 16, 17) don't touch repo.
