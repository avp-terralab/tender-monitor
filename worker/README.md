# tender-monitor-bot — Cloudflare Worker

Telegram webhook handler для команд бота (`/add`, `/list`, `/info`, `/watch`, `/help`, ... + адмін-команди `/invite`, `/invites`, `/users`, `/revoke`). Замінює GHA cron polling sub-second response.

## Архітектура

- `src/index.mjs` — entrypoint: secret verify + dispatch
- `src/handler.mjs` — orchestrator (`runHandler({ update, env, deps })`); auth gate (ADMIN_CHAT_ID env + `_state/allowed_users.json` file)
- `src/github.mjs` — load/save для `watchlist.json`, `watched_entities.json`, `_state/_watched_seen.json`, `_state/invites.json`, `_state/allowed_users.json` через GitHub Contents API

Імпортує існуючі pure модулі з `../`: `commands.mjs`, `telegram.mjs`, `prozorro.mjs`.

## Local tests

```
node --test test/*.test.mjs
```

(Тести використовують Node 20+ globals: `fetch`, `Request`, `Response`, `atob`, `btoa`.)

## Deployment

GHA workflow `.github/workflows/worker-deploy.yml` деплоїть на push у main (з paths filter).

Required GitHub Secrets:
- `CLOUDFLARE_API_TOKEN` — Workers Scripts:Edit token
- `CLOUDFLARE_ACCOUNT_ID` — твій CF account ID

## Worker secrets

Після першого deploy через `wrangler secret put`:

```bash
cd worker
npx wrangler secret put TELEGRAM_BOT_TOKEN     # bot token from BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # random 32-char string
npx wrangler secret put GITHUB_PAT              # fine-grained PAT, Contents:R+W on this repo
npx wrangler secret put ADMIN_CHAT_ID           # admin chat_id (e.g. 1744078008); all others onboarded via /invite
```

## Setup webhook (one-time)

Після першого deploy:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://tender-monitor-bot.<account>.workers.dev" \
  -d "secret_token=<webhook_secret>"
```

Перевірка:
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Очікувано: `"url":"https://...","has_custom_certificate":false`.

## Видалити webhook (rollback)

```bash
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

## Real-time logs

```bash
cd worker
npx wrangler tail
```

Стрімить production logs з deployed Worker.
