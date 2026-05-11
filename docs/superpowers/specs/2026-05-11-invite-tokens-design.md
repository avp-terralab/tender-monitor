# Invite tokens for tender-monitor bot

**Date:** 2026-05-11
**Status:** Approved (brainstorming)
**Predecessor:** `worker/src/handler.mjs` allowlist via `ALLOWED_CHAT_ID` env (comma-separated chat_ids, manually rotated in Cloudflare dashboard).

## Problem

Adding a new user to `@terralab_tenders_bot` today requires:
1. User taps `/start`, copies chat_id from reply, sends to admin.
2. Admin opens Cloudflare dashboard → Workers → Settings → Variables → Rotate `ALLOWED_CHAT_ID` → paste full list with new id → save.

The friction is high enough that admin tends to delay onboarding. Goal: admin sends a Telegram deep-link, recipient taps once, access granted.

## Goals

- Admin runs `/invite <label>` and receives a one-tap deep-link.
- Recipient opens the link → bot grants access automatically and notifies admin.
- Tokens are single-use per person (one tap consumes them).
- Soft expiry: 7 days for unused tokens.
- Admin can list active invites, list current users, and revoke any user.
- Admin's own access never depends on GitHub availability.

## Non-goals

- Multiple admin levels / roles. Admin is a single chat_id.
- Self-service signup (no public link).
- Audit log retention policy / cleanup of old redeemed invites (kept indefinitely; storage trivially small).
- Migration of legacy users without contact (re-onboarding them with proper labels is a manual one-off).

## User-facing commands

| Command | Who | Behavior |
|---|---|---|
| `/invite <label>` | admin only | Generate token, return `https://t.me/terralab_tenders_bot?start=<token>` + message "Перешли цій людині. Дійсне 7 днів." |
| `/start <token>` | anyone | Validate token → add caller's chat_id to allowlist → reply "✅ Доступ надано. /help". Admin gets DM: "🆕 \<label\> приєднався (chat_id: ...)". |
| `/start` (no token) | anyone | Existing behavior: reply with caller's chat_id. |
| `/invites` | admin only | List active (status=pending) invites: label, created_at, expires_at, token (last 6 chars for reference). |
| `/users` | admin only | List allowlist: chat_id, label, added_at, invited_via (label of the invite they came from, or `(migrated)` / `(admin)`). |
| `/revoke <chat_id>` | admin only | Remove user from `_state/allowed_users.json`. Refuses if `chat_id == ADMIN_CHAT_ID`. |

All other existing commands (`/add`, `/list`, `/info`, `/watch`, etc.) keep current allowlist semantics — they work for `ADMIN_CHAT_ID` and for any chat_id in `_state/allowed_users.json`.

`HELP_TEXT` gets new section "Адмін-команди" (visible to all but harmless for non-admins since the commands tiho-fail).

BotFather `/setcommands` updated to add `invite`, `invites`, `users`, `revoke`.

## Token format

- 16 random bytes → 32-char lowercase hex via `crypto.getRandomValues`.
- Fits within Telegram `/start` payload limit (64 chars, `[A-Za-z0-9_-]`).
- Lookup keyed on full token string (no truncation).

## Storage

Single source of truth for allowlist moves from CF Worker secret to GitHub repo, consistent with existing state pattern (`watchlist.json`, `watched_entities.json`).

### `_state/allowed_users.json`

```json
{
  "users": [
    {
      "chat_id": "786078813",
      "label": "(migrated)",
      "invited_via": null,
      "added_at": "2026-05-11T00:00:00Z"
    }
  ]
}
```

- Created during migration (Step 2 below).
- Admin (`ADMIN_CHAT_ID`) is **not** stored here — admin auth is via env var only, ensuring admin works even if GitHub or this file is broken.
- New entries appended on successful `/start <token>` redemption.
- Entries removed on `/revoke`.

### `_state/invites.json`

```json
{
  "invites": [
    {
      "token": "a1b2c3d4e5f6...",
      "label": "Olha",
      "created_at": "2026-05-11T12:00:00Z",
      "expires_at": "2026-05-18T12:00:00Z",
      "status": "pending",
      "redeemed_by": null,
      "redeemed_at": null
    }
  ]
}
```

- Created lazily by Worker on first `/invite` (file path doesn't exist yet → `saveFile` with `sha=null` creates it).
- `status: "pending" | "redeemed" | "revoked"`. Redeemed entries are retained for audit ("which invite did user X come from").
- No background cleanup; expiry is enforced at redeem time (`expires_at < now` → reject).

### `ADMIN_CHAT_ID` (new env secret)

- Single chat_id string, e.g. `1744078008`.
- Only chat allowed to run `/invite`, `/invites`, `/users`, `/revoke`.
- Always passes `isAllowed` (independent of GitHub state).

### `ALLOWED_CHAT_ID` (existing env secret) → REMOVED

Migrated chat_ids move into `_state/allowed_users.json`. Secret deleted in Step 6 of migration.

## Handler flow

### Auth check (replaces existing allowlist parse in `handler.mjs`)

```
isAdmin = chatId === env.ADMIN_CHAT_ID
isInvited = (loadAllowedUsers().users contains chatId)  // only loaded when needed
isAllowed = isAdmin || isInvited
```

For commands that don't need to know `isInvited` (e.g., `/start`, admin-only commands), skip the GitHub load.

### `/start <token>` branch (added before existing `/start` branch)

1. Parse: regex `/^\/start(?:@\w+)?\s+([a-f0-9]{32})\s*$/i`.
2. `loadInvites(env)` → find entry by token.
3. Validate:
   - Token exists → else reply "❌ Невалідне посилання".
   - `status === 'pending'` → else "❌ Посилання вже використане або відкликане".
   - `expires_at > now` → else "❌ Посилання застаріло (>7 днів)".
4. If user already in allowlist (or is admin): reply "✅ Ти вже маєш доступ. /help". Token not consumed (avoids burning a fresh invite that was accidentally tapped by an existing user).
5. Otherwise, two-mutation transaction:
   - Mutation A: update invites.json — set `status=redeemed`, `redeemed_by=chatId`, `redeemed_at=now`.
   - Mutation B: append `{chat_id: chatId, label: invite.label, invited_via: invite.label, added_at: now}` to allowed_users.json.
   - Each uses `applyMutationWithRetry` independently (SHA-optimistic, one retry on 409).
   - If Mutation A succeeds but B fails: token is consumed but user not in allowlist. Reply "⚠️ Помилка, напиши адміну посилання й chat_id". Admin manually adds via `/users` audit or future `/grant` (out of scope).
6. Reply user: "✅ Доступ надано: \<label\>. /help — список команд."
7. Notify admin: `sendReply({token: ..., chatId: env.ADMIN_CHAT_ID, text: "🆕 <label> приєднався (chat_id: <code>...</code>)"})`. Best-effort; failure logged but doesn't fail redemption.

### `/invite <label>` (admin-only)

1. If `chatId !== ADMIN_CHAT_ID` → silent ignore (same UX as non-allowlist commands today).
2. Parse label. Empty → "❌ Вкажи назву: /invite Olha".
3. Generate 32-hex token.
4. `applyMutationWithRetry`: append `{token, label, created_at: now, expires_at: now+7d, status: 'pending', redeemed_by: null, redeemed_at: null}` to invites.json.
5. Reply: `https://t.me/terralab_tenders_bot?start=<token>\n\nПерешли <label>. Дійсне 7 днів.`

### `/invites` (admin-only)

Read-only `loadInvites`. Format active (`status=pending`, `expires_at > now`) entries: label, created_at, expires_at, token-suffix-6.

### `/users` (admin-only)

Read-only `loadAllowedUsers`. Format users + virtual admin row.

### `/revoke <chat_id>` (admin-only)

1. Validate chat_id is numeric. Empty/invalid → error.
2. If `chat_id === ADMIN_CHAT_ID` → "❌ Не можу видалити адміна".
3. `applyMutationWithRetry`: remove from allowed_users.json. Not found → "❓ chat_id не у allowlist".
4. Reply: "✅ \<label\> видалено (chat_id: ...)".

## Race conditions

- **Two people tap same invite link concurrently:** Mutation A (invite status update) runs through SHA-optimistic retry. First wins → status=redeemed. Second sees `status !== 'pending'` after retry → "Посилання вже використане". Mutation B for the loser never runs.
- **Admin issues two invites in parallel:** Each is `append` to invites.json with retry. Worst case: second one re-reads, re-applies, succeeds. No data loss.
- **`/revoke` racing with `/start <token>`:** Independent files. If admin revokes a user mid-redemption of a fresh invite, the redemption still succeeds (different file). Outcome: user briefly in allowlist after admin removed them. Acceptable; admin can `/revoke` again.

## Module boundaries

### Pure (testable without mocks)

`commands.mjs` gains:
- `handleInvite({ invites, generateToken, now }, cmd) → { mutation, reply }`
- `handleRedeem({ invites, allowedUsers, now, chatId }, cmd) → { inviteMutation, userMutation, reply, adminNotice }`
- `handleRevoke({ allowedUsers, adminChatId }, cmd) → { mutation, reply }`
- `handleUsersList({ allowedUsers, adminChatId })` → formatted reply
- `handleInvitesList({ invites, now })` → formatted reply
- `applyInviteMutation`, `applyAllowedUsersMutation` (analogous to existing `applyMutation` / `applyEntityMutation`)
- `parseCommand` extended for new cmd names; `/start <token>` handled as a separate code path (it's not a generic command — token in payload position).

### I/O (DI'd)

`worker/src/github.mjs`:
- `loadInvites(env)`, `saveInvites(env, invites, sha)`
- `loadAllowedUsers(env)`, `saveAllowedUsers(env, users, sha)`

(Both follow existing `loadFile`/`saveFile` helpers — no new GitHub plumbing.)

### Test strategy

`node --test` covering:
- `commands.mjs` — all redeem edge cases (token not found, expired, already redeemed, already in allowlist, admin tries to redeem own invite), `/invite` empty label, `/revoke` admin-protection, `/revoke` not-found.
- `worker/test/handler.test.mjs` — DI'd I/O, asserts mutation sequences and replies.
- Existing tests stay green (allowlist semantics change is backward-compat for invited users; `ADMIN_CHAT_ID` is new env, easy to inject).

## Migration plan

Order matters: code first (knows new env + file), then state file, then secrets, then merge → deploy, then verify, then remove legacy secret.

1. **Implement code on feature branch.** All new files, tests pass locally.
2. **Commit `_state/allowed_users.json` on main with the two migrated chat_ids:**
   - `786078813` and `7321709183` as `(migrated)`.
   - `1744078008` (admin) is NOT included — handled via `ADMIN_CHAT_ID` env.
3. **Set CF secret `ADMIN_CHAT_ID`:** `cd worker && npx wrangler secret put ADMIN_CHAT_ID` → `1744078008`. Old `ALLOWED_CHAT_ID` left untouched for now.
4. **Merge feature branch → main.** `worker-deploy.yml` auto-deploys. New code reads `ADMIN_CHAT_ID` + `_state/allowed_users.json`; ignores `ALLOWED_CHAT_ID`.
5. **Smoke test** (admin's Telegram + a second test Telegram account):
   - admin: `/help` → ok, `/users` → shows 2 migrated + admin virtual row, `/invite TestUser` → returns link.
   - second account: tap link → "Доступ надано". admin gets "🆕 TestUser приєднався".
   - admin: `/revoke <test chat_id>` → "видалено". Second account: `/list` → no reply (allowlist gate). `/start` → "приватний бот".
   - Existing user (786078813 or 7321709183) verifies access still works.
6. **Delete legacy secret:** `npx wrangler secret delete ALLOWED_CHAT_ID`.
7. **BotFather `/setcommands`:** add `invite`, `invites`, `users`, `revoke` to flat list.

### Lockout recovery

Admin is hard-gated by `ADMIN_CHAT_ID` env. If `_state/allowed_users.json` is corrupt or GitHub is down:
- Admin commands still work (`/invite`, `/revoke` — though they'll fail on the GitHub write, they don't fail on auth).
- Invited users lose access until GitHub recovers — same blast radius as today's `/list` outage.
- Worst case: rotate `ADMIN_CHAT_ID` to a new chat_id via CF dashboard (single secret, single value).

## Out of scope

- `/grant <chat_id> <label>` for admin to manually add users without an invite link. Could be added later if Mutation B failure recovery becomes common; for now, manual repo edit suffices.
- Invite revocation (`/cancel-invite <token-suffix>`). Pending invites expire in 7 days anyway; not worth the extra command surface.
- Email/SMS delivery — Telegram-only.
- Rate-limiting `/invite` — admin is the only caller, trusted.
