# Переїзд стану бота з GitHub на GitLab

Дата: 2026-08-19
Гілка: (буде створена окремо для реалізації)

## Мета

Зараз Cloudflare Worker (`worker/`) читає й пише весь робочий стан бота
(`watchlist.json`, `watched_entities.json`, чергу задач агента, архів, інвайти
тощо) напряму через **GitHub Contents API** (`worker/src/github.mjs`), а
GitHub Actions крутить погодинний моніторинг (`monitor.yml`) і деплой Worker
(`worker-deploy.yml`). Мета — перевести цей стан і всю автоматику на **GitLab**
(інстанс `cl-gl.listerralab.com`, той самий флот TerraLab), з реальним
одноразовим перемиканням у визначений момент, а не постійним співіснуванням
двох хостів.

Другий, менший наслідок: `agent_poller.py` у проєкті `tender-agent`
(`terralab-manual/tender-agent`, уже в GitLab) теж ходить у GitHub Contents API
за чергою завдань — перемикається синхронно з ботом.

## Затверджені рішення (brainstorm 2026-08-19)

- **Не двобічний sync, а одноразовий переїзд.** Двобічна синхронізація
  GitLab↔GitHub (з CI-job'ом на merge-конфлікти) розглядалась і відкинута:
  вона потрібна лише для постійного співіснування двох хостів, а тут мета —
  реальне перемикання в певний момент. Замість цього: код одноразово
  переноситься в GitLab, уся нова робота йде тільки там, GitHub лишається
  живим і незайманим (стара версія коду) до моменту cutover.
- **`handler.mjs` (107 КБ) не переписується.** Обидва бекенди (`github.mjs`,
  майбутній `gitlab.mjs`) експортують однаковий набір із 19 функцій
  (`load*`/`save*`), тож перемикання — це прошарка-диспетчер, а не рефакторинг
  бізнес-логіки.
- **Перемикач — одна env-змінна Cloudflare Worker'а**, `STATE_BACKEND`
  (`"github"` | `"gitlab"`), окремо на `[env.staging]` і `[env.production]` у
  `wrangler.toml`. Той самий код Worker'а деплоїться в обидва середовища.
- **`ci.mjs`/`monitor.mjs` (cron) не мають жодної залежності від GitHub API** —
  це чиста робота з локальними файлами; коміт/пуш робить bash у самому
  workflow. Перенесення cron — це переклад YAML-логіки, без змін у JS.
- **Staging — окремий Telegram-бот, окремий Cloudflare Worker, окремий KV
  namespace, окрема гілка `staging-state`.** Жодна перевірка не торкається
  реальних користувачів чи продакшн-даних.
- **GitHub Actions лишаються в репозиторії вимкненими, не видаленими,
  тиждень-два після cutover** — дешевий шлях відкату, поки не буде впевненості,
  що GitLab-бекенд стабільний.
- **Токен GitHub новий не потрібен** — GitHub-бік не змінюється до моменту
  cutover, читання/запис там ніхто не додає.

## Архітектура перемикання

### Спільний інтерфейс бекендів

`worker/src/state-errors.mjs` — виносить `ConflictError` в окремий модуль, щоб
обидва бекенди кидали **той самий клас** (інакше `instanceof ConflictError` у
`handler.mjs` мовчки перестане працювати для одного з них).

`worker/src/github.mjs` — без змін по суті, окрім імпорту `ConflictError` зі
спільного модуля.

`worker/src/gitlab.mjs` — новий, дзеркалить усі 19 функцій `github.mjs`, під
GitLab API:

| GitHub | GitLab-еквівалент |
|---|---|
| `GET /repos/{repo}/contents/{path}?ref=main` | `GET /projects/:id/repository/files/:file_path?ref=main` |
| `PUT /repos/{repo}/contents/{path}` (sha, 409) | `PUT`/`POST /projects/:id/repository/files/:file_path` (`last_commit_id`, **400**, не 409 — інша семантика конфлікту) |
| `GET /repos/{repo}/contents/_state/agent_jobs?ref=main` (список) | `GET /projects/:id/repository/tree?path=_state/agent_jobs&ref=main` |
| `GET /repos/{repo}/commits?per_page=N` | `GET /projects/:id/repository/commits?ref_name=main&per_page=N` |
| `Authorization: Bearer <PAT>` | `PRIVATE-TOKEN: <project access token>` |

⚠️ **Головний ризик — не обсяг коду, а різниця в конфлікт-семантиці**
(GitHub: 409 по `sha`; GitLab: помилка про застарілий `last_commit_id`, інший
код і форма відповіді). Тут не можна просто скопіювати логіку `ConflictError`
— перевіряється навмисним конфлікт-тестом на staging (нижче).

`worker/src/state.mjs` — тонка прошарка-диспетчер:

```js
import * as gh from './github.mjs';
import * as gl from './gitlab.mjs';

function backend(env) {
  return env.STATE_BACKEND === 'gitlab' ? gl : gh;
}

export async function loadWatchlist(env, opts) { return backend(env).loadWatchlist(env, opts); }
export async function saveWatchlist(env, w, sha, opts) { return backend(env).saveWatchlist(env, w, sha, opts); }
// ... по всіх 19 функціях — механічна обгортка, без логіки
export { ConflictError } from './state-errors.mjs';
```

**Єдина зміна в `handler.mjs`** — рядок імпорту `from './github.mjs'` →
`from './state.mjs'`. Решта файлу (і 4506 рядків тестів на нього) не
чіпається.

### `wrangler.toml`

```toml
[env.staging]
vars = { STATE_BACKEND = "gitlab" }
kv_namespaces = [{ binding = "EPHEMERAL_KV", id = "<staging-kv-id>" }]

[env.production]
vars = { STATE_BACKEND = "github" }   # на момент підготовки; на "gitlab" — при cutover
```

### `agent_poller.py`

Той самий принцип, дешевше: `make_list_jobs(cfg)`/`make_set_status(cfg)` уже є
фабриками, прив'язаними до `cfg`. Додається поле `cfg.backend`
(`"github"`/`"gitlab"`), і фабрика всередині обирає, яке замикання повернути.
Нова GitLab-версія `_gl_request`/`make_list_jobs`/`make_set_status` — той самий
обсяг коду, що й нинішня GitHub-версія (~120 рядків).

## Staging-схема

| Компонент | Продакшн (без змін) | Staging (новий) |
|---|---|---|
| Джерело стану | `main` у GitHub | гілка `staging-state` у `terralab-manual/tender-monitor`, насіяна копією поточних `watchlist.json`/`_state` (публічні дані закупівель, конфіденційності нема) |
| Cloudflare Worker | `tender-monitor-bot` | `tender-monitor-bot-staging`, окремий деплой |
| KV namespace | продовий | окремий — щоб ефемерний діалоговий стан (`ephemeral.mjs`) не перетинався з продом |
| Telegram-бот | реальний, реальні користувачі | окремий тестовий бот через BotFather |
| Cron | `monitor.yml`, погодинно | GitLab CI Scheduled Pipeline, частіше (напр. кожні 15 хв) під час активного тестування |
| Agent-поллер | `agent_poller.py` → GitHub | той самий скрипт, `cfg.backend = "gitlab"`, `staging-state` |

### Що перевіряється на staging

Перелік виведений із того, які функції `handler.mjs` бере з бекенду —
вичерпний, не довільний:

| Дія в Telegram | Функція(ї) | Що дивимось |
|---|---|---|
| Додати/зняти тендер зі спостереження | `loadWatchlist`/`saveWatchlist` | запис/читання round-trip |
| Додати/зняти замовника (ЄДРПОУ) | `loadWatchedEntities`/`saveWatchedEntities` | те саме |
| Дедуп алертів | `loadWatchedSeen`/`saveWatchedSeen` | повторний cron-цикл не дублює сповіщення |
| Invite-токен | `loadInvites`/`saveInvites` | видача й погашення |
| Роль користувача | `loadAllowedUsers`/`saveAllowedUsers` | |
| Архів завершених тендерів | `loadArchivedTenders`/`saveArchivedTenders` | |
| **«✅ Підтвердити» → задача агенту** | `saveAgentJob`, `loadAgentJob`, `listAgentJobs` | **найважливіше**: staging-поллер (окремо на GitLab) бере job, пише статус назад, бот бачить `done` |
| `/status` | `fetchLastCommit`, `fetchLatestDeployCommit` | |
| `/log` | `fetchAuditLog` | |
| «📜 Історія» | `loadNotificationHistory` | |
| Проактивний дайджест | `loadPendingDigest` | cron і бот бачать один файл |

**Окремо — конфлікт-тест:** навмисне подвійне швидке натискання тієї самої
кнопки (напр. двічі поспіль «додати тендер»), щоб перевірити, що на GitLab
конфлікт ловиться коректно (інша механіка за GitHub), а не тихо губить дані.

**Критерій готовності:** уся таблиця вище проходить, конфлікт-тест ловить
конфлікт, і кілька повних погодинних циклів проходять без помилок — не один
зелений прогін, а спостереження за час.

## Процедура cutover

1. Одноразовий перенос актуального `watchlist.json`/`_state/*` з GitHub `main`
   у GitLab `main` (не в `staging-state` — та лишається тестовою назавжди чи
   до наступної фічі).
2. Прод-Worker: `STATE_BACKEND: "github" → "gitlab"` (правка змінної,
   без нового білда коду — сам код уже задеплоєний раніше з прапорцем
   `"github"`, щоб перевірити, що сама прошарка нічого не зламала).
3. Одночасно: вимкнути schedule в GitHub Actions (`monitor.yml`), увімкнути
   GitLab CI Scheduled Pipeline.
4. `agent_poller.json` на робочій станції: `backend: "github" → "gitlab"`.
5. Спостерігати кілька перших циклів наживо.

### Відкат

Той самий прапорець назад (`"gitlab" → "github"`), GitHub Actions знову
увімкнено. Чесне застереження: якщо відкат станеться не одразу, а через
годину-дві, GitHub-стан за цей час трохи відстане (втрачені зміни watchlist за
вікно) — не втрата даних (усе є в GitLab), невеликий розрив, який доведеться
підтягнути вручну.

### Grace period

GitHub Actions (`monitor.yml`, `worker-deploy.yml`) лишаються в репозиторії
**вимкненими, не видаленими**, тиждень-два після cutover. Після спокійного
періоду — видалити остаточно або лишити мертвим вантажем (дешево тримати).

## Хто що робить

**Робить Claude (фази 0-1, 3 технічна частина):**
- Створення GitLab-проєкту, перенесення коду, гілка `staging-state`.
- `state-errors.mjs`, `gitlab.mjs`, `gitlab.test.mjs`, `state.mjs`, правка
  імпорту в `handler.mjs`, правка `wrangler.toml`.
- Порт `agent_poller.py` (поле `backend`, GitLab-функції, тести).
- `.gitlab-ci.yml`: тести, staging-розклад, staging/prod деплой (manual
  trigger).
- Прогін тестового набору локально перед показом.
- Технічна частина staging-перевірки (API-виклики, де можливо), конфлікт-тест.

**Потребує оператора напряму:**
- **Тестовий бот у BotFather** — чужий Telegram-акаунт, Claude туди доступу не
  має. Токен віддається в чаті → одразу в `.env`/masked CI-змінну, нікуди
  більше.
- **Cloudflare**: або токен API (Workers + KV) для Claude, або оператор сам
  створює staging KV namespace й називає id.
- **Реальні клікі в тестовому Telegram-боті** — живий UI-досвід, не
  симулюється заочі.
- Момент cutover і рішення про відкат — завжди за оператором.

## Тестування

**Worker** (`node --test`): новий `worker/test/gitlab.test.mjs` дзеркалить
`github.test.mjs` (мокає `fetch`, ~457 рядків аналогічного обсягу).
`handler.test.mjs` (4506 рядків) не змінюється — він тестує бізнес-логіку
проти інтерфейсу, не проти конкретного бекенду.

**Agent-поллер** (`pytest`): нові тести на GitLab-версію `make_list_jobs`/
`make_set_status`, дзеркалять наявні 33 тести на GitHub-версію.

**Ручна перевірка перед cutover:** повна таблиця staging-перевірок вище +
кілька днів спостереження за живими cron-циклами — за принципом флоту
«перевіряється прогоном, а не оглядом конфіга».

## Зміни в документації

- `CLAUDE.md` обох проєктів (`tender-monitor`, `tender-agent`) — синхронно,
  новий бекенд і `STATE_BACKEND`/`cfg.backend`.
- `docs/infrastructure.md` репозиторію `terralab-ai-bootstrap` — новий проєкт
  `terralab-manual/tender-monitor`, за прикладом запису про `tender-agent`.

## Поза межами

- Переклад `ci.mjs`/`monitor.mjs` на GitLab API — **не потрібен**, вони й так
  не торкаються GitHub/GitLab API напряму.
- Видалення GitHub-репозиторію чи GitHub-акаунта — не розглядається; після
  grace period репозиторій лишається архівом історії.
- Перенесення старих feature-гілок GitHub (`feat/bot-ux-cleanup` тощо) — не
  переносяться, лишаються на GitHub за потреби.
- Постійне двобічне співіснування GitHub/GitLab — свідомо відкинуте рішення
  (див. «Затверджені рішення» вище); якщо колись знадобиться tidiness-переїзд
  без функціональної мети, це окреме, менш вимогливе рішення.
