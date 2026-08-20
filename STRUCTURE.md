# Структура репозиторію — путівник

Що є що в цій теці, простими словами. Для job-контракту з агентом — дивись
`CLAUDE.md`, розділ інтеграції. Тут — тільки "що лежить де і навіщо".

## Два різні виконавці одного коду

Цей репозиторій живить ДВІ окремі речі, які виконуються по-різному:

1. **Cloudflare Worker** (`worker/`) — інтерактивний бот: відповідає на Telegram-команди
   миттєво, коли хтось тисне кнопку. Деплоїться сам на push у `main` (`worker-deploy.yml`).
2. **GitHub Actions cron** (`ci.mjs` + `monitor.yml`) — щогодинний моніторинг Prozorro:
   перевіряє зміни, шле сповіщення, комітить стан назад у репо. Це НЕ Worker — окремий
   процес, що просто раз на годину запускається на чужому сервері GitHub і завершується.

Спільні `.mjs`-модулі в корені (`monitor.mjs`, `prozorro.mjs`, `telegram.mjs` тощо)
використовують обидва виконавці — логіка одна, входи різні.

## Спільні модулі (корінь репо)

| Файл | За що відповідає |
|---|---|
| `ci.mjs` | Вхідна точка щогодинного cron (`monitor.yml`) — повний прогін: моніторинг + перевірка здоров'я агента + watched-entities |
| `main.mjs` | Простіший вхід — один прогін моніторингу (ручний запуск/дебаг) |
| `monitor.mjs` | Ядро моніторингу: тягне зміни, формує дайджест |
| `prozorro.mjs` | Обгортка над Prozorro API — фетч тендеру, фід змін |
| `entity_watch.mjs` | Стеження за замовниками (ЄДРПОУ), а не за конкретними тендерами |
| `compare.mjs` | Діффінг двох знімків тендеру — що саме змінилось |
| `commands.mjs` | Спільна логіка Telegram-команд (парсинг, побудова відповідей) — використовує і Worker, і `ci.mjs` |
| `telegram.mjs` | Форматування повідомлень, іконки статусів, скорочення назв |

## Бот (`worker/`)

| Файл | За що відповідає |
|---|---|
| `src/index.mjs` | Точка входу Worker — приймає Telegram-вебхук |
| `src/handler.mjs` | Маршрутизація команд і callback-кнопок |
| `src/state.mjs` | Диспетчер стану — вибирає `github.mjs` чи `gitlab.mjs` за `env.STATE_BACKEND` (`handler.mjs` імпортує лише звідси, самі бекенди не напряму) |
| `src/github.mjs` | Читання/запис `watchlist.json`, `watched_entities.json`, черги `_state/agent_jobs/` — усе через **GitHub Contents API**, не git. Типовий бекенд (production) |
| `src/gitlab.mjs` | Той самий набір read/save, але через **GitLab Repository Files API**. Бекенд для staging (`STATE_BACKEND=gitlab` у `wrangler.toml`) |
| `src/ephemeral.mjs` | Видаляє попереднє повідомлення-перегляд перед показом нового (Cloudflare KV) |
| `wrangler.toml` | Конфігурація деплою Cloudflare — тут і живе `STATE_BACKEND` для кожного `env.*` |

## Розгортання (`.github/workflows/` і `.gitlab-ci.yml`)

- `worker-deploy.yml` — деплой Worker на push у `main` (тільки якщо змінились `worker/**`, `commands.mjs`, `telegram.mjs`, `prozorro.mjs`)
- `monitor.yml` — щогодинний cron, викликає `ci.mjs`, комітить стан
- `test.yml` — тести на кожен push/PR
- `.gitlab-ci.yml` — дзеркальний GitLab-бік (`test`, `monitor-staging` cron, `deploy-staging`/`deploy-production`
  через `wrangler`) для staging/production-шляху деплою з GitLab-бекендом стану; поки не жива
  дорога — production і далі типово на `STATE_BACKEND=github` через GHA

## Стан і черга (`_state/`)

⚠️ Дві категорії файлів з однаковим ім'ям тендеру, різне призначення:

- **`_state/agent_jobs/<tender_id>.json`** — черга завдань для агента (`prepare`/`amend`/`winner`/`sign`). Контракт описано в `CLAUDE.md`.
- **`_state/<tender_id>.json`** (без підтеки `agent_jobs`) — знімок стану тендеру для порівняння між прогонами моніторингу (публічні дані з Prozorro, не пов'язано з чергою задач)

Плюс службові: `_agent_health_alerted.json`, `_heartbeat.json`, `_watched_feed_cursor.json`,
`_watched_seen.json`, `allowed_users.json`, `archived_tenders.json`, `invites.json`,
`notification_history.json`.

⚠️ **`agent_pending.json` (стан діалогу `/agent`) тут БІЛЬШЕ НЕМАЄ** — переїхав у
Cloudflare KV 2026-08-19 (`worker/src/ephemeral.mjs`), бо це єдиний файл із цієї
теки, який чіпає ТІЛЬКИ Worker (не `ci.mjs`, не Python-поллер). Решта файлів вище
лишається в git саме тому, що до них потрібен доступ більш ніж з одного середовища
виконання. Деталі — `docs/superpowers/plans/2026-08-19-agent-pending-to-kv.md`.

## Конфіг стеження (корінь репо)

- `watchlist.json` — конкретні тендери за `UA-…`
- `watched_entities.json` — замовники за ЄДРПОУ

## Тести (`test/` і `worker/test/`)

`node --test test/*.test.mjs worker/test/*.test.mjs`. Фікстури в `test/fixtures/` —
приклади відповідей Prozorro API, не реальні клієнтські дані.

## Історія (`docs/`)

- `docs/history/` — інженерна історія (UX-рішення, баги й фікси), не потрібна боту в роботі
- `docs/superpowers/plans/` + `specs/` — план/дизайн кожної фічі, датовано

## Notes

`notes/prozorro-api.md` — накопичені спостереження про поведінку Prozorro API.
