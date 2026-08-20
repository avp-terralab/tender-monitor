# Task 8: GitLab CI для `tender-monitor` — звіт

## Крок 1: CI-змінні

Пропущено за вказівкою — `CLOUDFLARE_API_TOKEN` і `CLOUDFLARE_ACCOUNT_ID` вже додані
контролером на рівні проєкту (masked/protected) до початку цієї роботи.

## Крок 2: `.gitlab-ci.yml`

Спочатку записаний рівно за YAML з брифу. Перший пуш (комміт `8829141`) провалив
джобу `test` з помилкою `node: command not found` — shared-раннер (`cl-gl`,
shell executor) не мав `node` у `PATH` для non-login shell. Діагностика
(тимчасовий комміт `115a096`, потім видалений зі стану гілки наступним фіксом)
виявила робочий Node за шляхом `/home/gitlab-runner/.local/node-v22.23.2-linux-x64/bin/node`
— просто не доданий у `PATH` типового shell-виконання джоби.

Фінальний, робочий `.gitlab-ci.yml` (комміт `e2a41ae`) — точно ті самі джоби з
брифу, плюс мінімальний глобальний `default.before_script` з фіксом `PATH`:

```yaml
stages:
  - test
  - deploy

default:
  before_script:
    - export PATH="$HOME/.local/node-v22.23.2-linux-x64/bin:$PATH"

test:
  stage: test
  script:
    - node --test test/*.test.mjs worker/test/*.test.mjs

deploy-staging:
  stage: deploy
  when: manual
  script:
    - cd worker && npm install --no-save wrangler@^3 && npx wrangler deploy --env staging

monitor-staging:
  stage: test
  script:
    - node ci.mjs
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $SCHEDULE_TARGET == "staging"'

deploy-production:
  stage: deploy
  script:
    - cd worker && npm install --no-save wrangler@^3 && npx wrangler deploy --env production
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: manual
```

## Крок 3: Scheduled Pipeline (staging cron)

Створено через `POST /api/v4/projects/14/pipeline_schedules`:

```json
{
  "id": 1,
  "description": "staging monitor cron",
  "ref": "refs/heads/staging-state",
  "cron": "*/15 * * * *",
  "cron_timezone": "UTC",
  "next_run_at": "2026-08-19T21:53:00.000Z",
  "active": true
}
```

Примітка: параметр `variables[][key]`/`variables[][value]` у тілі `POST
.../pipeline_schedules` GitLab **ігнорує** — змінна не додається цим викликом.
Довелось окремо викликати `POST /api/v4/projects/14/pipeline_schedules/1/variables`
з `key=SCHEDULE_TARGET&value=staging`. Перевірка `GET
.../pipeline_schedules/1` підтвердила:

```json
{
  "id": 1,
  "ref": "refs/heads/staging-state",
  "cron": "*/15 * * * *",
  "active": true,
  "variables": [
    {"variable_type": "env_var", "key": "SCHEDULE_TARGET", "value": "staging", "raw": false}
  ]
}
```

## Крок 4: Валідація YAML (`ci/lint`)

Фінальна версія (з фіксом `PATH`) провалідована **перед** пушем:

```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "includes": []
}
```

(Початкова версія без фіксу PATH теж пройшла lint з `valid: true` — це очікувано,
lint перевіряє синтаксис/структуру, а не виконання скриптів у `script:`.)

## Крок 5: Push і перевірка пайплайна

Гілка: `feat/gitlab-state-backend` (за прямою вказівкою — не нова гілка
`ci/gitlab-pipeline` з брифу).

Три пуші під час діагностики:

| Комміт | Опис | Пайплайн | Джоба `test` |
|---|---|---|---|
| `8829141` | `.gitlab-ci.yml` рівно за брифом | #329 — `failed` | `node: command not found` |
| `115a096` | тимчасова діагностика PATH (тимчасовий) | #330 — `failed` | те саме (як і очікувалось, діагностика лише додала вивід) |
| `e2a41ae` | фікс `PATH` через `default.before_script` | **#331 — `success`** | **`success`**, 1055/1055 тестів пройшли |

Фінальний пайплайн: https://cl-gl.listerralab.com/terralab-manual/tender-monitor/-/pipelines/331
(id `331`, sha `e2a41ae9aea2fc00c8e016ae33c353dbc39f0009`).

Джоби пайплайна #331:
- `test` (job id 638) — **`success`**. Хвіст логу: `# tests 1055`, `# pass 1055`,
  `# fail 0`, `Job succeeded`.
- `deploy-staging` (job id 639) — `manual`, як і очікувалось (`when: manual`,
  не запускається автоматично).
- `monitor-staging` і `deploy-production` у пайплайні відсутні — це очікувано:
  правила (`schedule`-джерело для першої, гілка `main` для другої) не збіглись
  на звичайному пуші гілки фічі.

Останній комміт на гілці: **`e2a41ae9aea2fc00c8e016ae33c353dbc39f0009`**
(`ci: fix PATH for node on shared shell-executor runner`).

## Підсумок

- `.gitlab-ci.yml` створено, провалідовано, запушено — робочий, тести проходять.
- Scheduled Pipeline для `monitor-staging` заведено на гілку `staging-state`,
  cron `*/15 * * * *`, зі змінною `SCHEDULE_TARGET=staging`.
- Виявлено і задокументовано інфраструктурну ваду спільного раннера cl-gl:
  `node` встановлено в `$HOME/.local/node-v22.23.2-linux-x64/bin`, але не в
  `PATH` для non-login shell-джоб. Виправлено локально (в `.gitlab-ci.yml`
  цього проєкту через `default.before_script`); варто розглянути системний
  фікс на самому раннері (symlink у `/usr/local/bin` або системний PATH), щоб
  іншим проєктам не доводилось повторювати цей самий обхід — але це вже поза
  межами Task 8 (інфраструктура раннера, не цього репозиторію).
