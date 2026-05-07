# tender-monitor

Scheduled monitor for Prozorro tenders → Telegram digest 3×/day (09:00, 13:00, 18:00 Europe/Kyiv).

## Architecture

- `compare.mjs` — pure diff function: `diff(prev, curr) → events[]`
- `prozorro.mjs` — Prozorro public API client (`extractSnapshot`, `fetchTender`)
- `telegram.mjs` — digest formatter + Bot API sender
- `monitor.mjs` — orchestrator: `runOnce(deps)`
- `ci.mjs` — GitHub Actions entrypoint (env-based secrets, state at repo root)
- `main.mjs` — local development entrypoint (filesystem state in `.local-state/`)

State and watchlist:

- `watchlist.json` — list of tenders to monitor (commit changes via PR or direct edit)
- `_state/UA-XXXX.json` — per-tender snapshot, auto-committed by GitHub Actions after each run

## GitHub Actions deployment

Workflow lives at `.github/workflows/monitor.yml`. It runs on cron `0 6,10,15 * * *` UTC and on manual dispatch.

### Required secrets

Set in repo Settings → Secrets and variables → Actions:

| Name | Value |
|------|-------|
| `TELEGRAM_BOT_TOKEN` | from `@BotFather` |
| `TELEGRAM_CHAT_ID` | your numeric chat id (or negative for channel) |

### Manage tenders

**Telegram (recommended):**
- `/add UA-YYYY-MM-DD-NNNNNN-x` — додати тендер. Опційно: `/add UA-... мої нотатки`.
- `/list` — побачити повний watchlist.
- `/help` — список команд.

Bot реагує тільки на повідомлення з `TELEGRAM_CHAT_ID` (інші ігноруються мовчки). Polling — кожні 5 хв через GHA workflow `bot.yml`. Зміна вступає в силу на найближчому monitor-тіку (09/13/18 Київ).

**Manual edit (для bulk-операцій або видалення):**

Edit `watchlist.json` on the repo's main branch. Each row:

```json
{ "tender_id": "UA-YYYY-MM-DD-NNNNNN-x", "enabled": true, "notes": "free text" }
```

Set `enabled: false` to pause. Auto-disabled rows (404 from Prozorro) get `auto-disabled: ...` appended to `notes`.

### Workflows

- `.github/workflows/monitor.yml` — cron `0 6,10,15 * * *` UTC (09/13/18 Київ). Шле дайджест змін.
- `.github/workflows/bot.yml` — cron `*/5 * * * *`. Обробляє Telegram-команди.

Обидва використовують `concurrency: tender-monitor` → серіалізуються при пушах.

## Local development

1. Install Node.js 20+ (project uses only built-ins, no `npm install` needed).
2. `mkdir -p .local-state/_state`
3. Create `.local-state/watchlist.json`:
   ```json
   [{ "tender_id": "UA-YYYY-MM-DD-NNNNNN-x", "enabled": true }]
   ```
4. Create `.local-state/.secrets.json`:
   ```json
   { "telegram_bot_token": "...", "telegram_chat_id": "..." }
   ```
5. `node main.mjs` — first run sends `monitoring_started` digest; subsequent runs are silent unless something changed.

## Tests

```
node --test test/*.test.mjs
```

Should report 140+ tests passing across compare, prozorro, telegram, monitor, commands, and bot suites.

## Spec

Full design: `../docs/superpowers/specs/2026-05-06-tender-monitor-design.md`
