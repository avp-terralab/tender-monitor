# tender-monitor

Monitors Prozorro tenders and pushes a Telegram digest of changes. A GitHub Actions cron checks **hourly**; a Cloudflare Worker handles bot commands with sub-second latency. Quiet hours (00:00–05:59 Київ) are buffered into a morning digest, and a heartbeat is sent around 09:00.

## Architecture

- `compare.mjs` — pure diff function: `diff(prev, curr) → events[]`
- `prozorro.mjs` — Prozorro public API client (`extractSnapshot`, `fetchTender`, feeds)
- `entity_watch.mjs` — watched-entity (ЄДРПОУ) discovery pipeline (forward feed + backfill + BFF search)
- `telegram.mjs` — digest formatter + Bot API sender (send / edit / answerCallback)
- `commands.mjs` — pure command parsers + handlers (shared by the monitor and the Worker)
- `monitor.mjs` — orchestrator: `runOnce(deps)`
- `ci.mjs` — GitHub Actions entrypoint (env-based secrets, state at repo root)
- `main.mjs` — local development entrypoint (filesystem state in `.local-state/`)
- `worker/` — Cloudflare Worker (Telegram webhook → command dispatch)

State (committed to the repo):

- `watchlist.json` — tenders monitored by ID
- `watched_entities.json` — procuring entities (ЄДРПОУ) watched for new tenders
- `_state/UA-XXXX.json` — per-tender snapshots, auto-committed by GitHub Actions after each run
- `_state/{allowed_users,invites,archived_tenders}.json` — auth, invites, archive of completed tenders

## GitHub Actions deployment

`.github/workflows/monitor.yml` runs on cron `0 * * * *` (hourly) and on manual dispatch. GitHub's free-tier scheduled cron is unreliable, so an external cron-job.org pinger also triggers the workflow every 30 minutes.

### Required secrets

Set in repo Settings → Secrets and variables → Actions:

| Name | Value |
|------|-------|
| `TELEGRAM_BOT_TOKEN` | from `@BotFather` |
| `TELEGRAM_CHAT_ID` | admin numeric chat id |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | for `worker-deploy.yml` |

The Cloudflare Worker has its own secrets (set via `cd worker && npx wrangler secret put <NAME>`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_PAT` (fine-grained, Contents R+W), `ADMIN_CHAT_ID`.

### Bot commands

**All allowed users:**
- `/info` — список або деталі тендерів (`/info` групує за фазою — Приймання / Розгляд / Очікування договору — кожна окремим повідомленням; `/info UA-…` — деталі одного).
- `/watched` — замовники під стеженням. Для editor/admin: кнопка «🗑 Прибрати замовника» → режим видалення (тап по замовнику видаляє, «← Готово» — назад).
- `/archive` — завершені закупівлі з посиланням на договір; `/archive UA-…` — деталі.
- `/notify` — увімкнути/вимкнути сповіщення. `/whoami` — роль і стан. `/help` — повний список.

**Editor / admin:**
- `/add UA-YYYY-MM-DD-NNNNNN-x` — додати тендер (опційно: `/add UA-… мої нотатки`). `/remove UA-…` — прибрати.
- `/watch <ЄДРПОУ>` — стежити за новими тендерами замовника (прибрати — кнопкою 🗑 у `/watched`).
- `/unarchive UA-…` — прибрати з архіву.

**Admin only:**
- `/status` — здоровʼя бота (розширена статистика).
- `/invite [editor|viewer] [імʼя]` — invite-посилання (TTL 24 год). `/invites`, `/users`, `/revoke [chat_id]`, `/role [editor|viewer] [chat_id]`.
- `/log [N]` — журнал дій користувачів (хто додав/видалив/змінив). Читає історію комітів; дефолт N=20.

Auth: admin is gated by the `ADMIN_CHAT_ID` env var (single id, independent of GitHub); other users live in `_state/allowed_users.json` (populated via `/invite` redeem), with roles admin / editor / viewer. Invites are stored in `_state/invites.json` (status pending/redeemed). Watchlist/allowlist changes commit to the repo immediately after the bot replies.

**Manual edit (for bulk operations):**

Edit `watchlist.json` on `main`. Each row:

```json
{ "tender_id": "UA-YYYY-MM-DD-NNNNNN-x", "enabled": true, "notes": "free text" }
```

Set `enabled: false` to pause. Rows auto-disabled by a 404 from Prozorro get `auto-disabled: …` appended to `notes`.

### Workflows

- `.github/workflows/monitor.yml` — hourly cron + manual/external dispatch. Sends the change digest + morning heartbeat; commits state changes back to the repo.
- `.github/workflows/worker-deploy.yml` — on push to `main` touching `worker/**`, `commands.mjs`, `telegram.mjs`, or `prozorro.mjs` → runs the test suite, then deploys the Cloudflare Worker. Doc-only changes do not deploy.

## Local development

1. Install Node.js 20+ (project uses only built-ins, no `npm install` needed for the monitor).
2. `mkdir -p .local-state/_state`
3. Create `.local-state/watchlist.json`:
   ```json
   [{ "tender_id": "UA-YYYY-MM-DD-NNNNNN-x", "enabled": true }]
   ```
4. Create `.local-state/.secrets.json`:
   ```json
   { "telegram_bot_token": "...", "telegram_chat_id": "..." }
   ```
5. `node main.mjs` — first run sends a `monitoring_started` digest; subsequent runs are silent unless something changed.

## Tests

```
node --test test/*.test.mjs worker/test/*.test.mjs
```

720+ tests across all suites.

## Specs

Design documents live in `docs/superpowers/specs/` (one per feature; start with `2026-05-06-tender-monitor-design.md`).
