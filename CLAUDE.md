# Tender Monitor — Telegram-бот моніторингу закупівель Prozorro

Cloudflare Worker + спільні pure-модулі. Стежить за тендерами та замовниками на Prozorro,
шле сповіщення про важливі зміни, веде архів завершених закупівель і **ставить завдання
агенту підготовки тендерних пропозицій** (див. розділ інтеграції нижче).

## Стек і робота
- Node ESM. Pure-модулі в корені: `commands.mjs` (логіка команд/inline-меню), `telegram.mjs`,
  `prozorro.mjs`, `monitor.mjs`. Worker (Telegram webhook): `worker/src/{index,handler,github}.mjs`.
- Тести: `node --test test/*.test.mjs worker/test/*.test.mjs`.
- Деплой: GHA `.github/workflows/worker-deploy.yml` — **авто на push у `main`**
  (paths: `worker/**`, `commands.mjs`, `telegram.mjs`, `prozorro.mjs`) → `wrangler deploy`.
  Без KV — навігація меню працює stateless (re-fetch).
- Деталі: `README.md`, `worker/README.md`. Специфікації/плани: `docs/superpowers/`.

## Два моніторинги і перехід між ними

- **Моніторинг тендерів** (`watchlist.json`) — конкретні закупівлі за `UA-…`.
- **Моніторинг замовників** (`watched_entities.json`) — ЄДРПОУ, від яких чекаємо
  оголошення; на подію `new_tender_announced` бот шле сповіщення з кнопкою
  «➕ Додати в моніторинг UA-…» (`telegram.mjs`, `sendDigest`).
- **З 11.08.2026 ця кнопка ще й ЗНІМАЄ замовника зі стеження** (`delete_entity`,
  аудит `unwatch`, повідомлення користувачу): його закупівля вже в моніторингу
  тендерів, тримати ЄДРПОУ у стеженні немає сенсу. Робить це
  `dropWatchedEntityAfterAdd` у `worker/src/handler.mjs`, ТІЛЬКИ в гілці колбека
  `add:` (ця кнопка існує лише під оголошенням) і ТІЛЬКИ коли додавання справді
  відбулось. Ручний `/add UA-…` стеження НЕ чіпає. ЄДРПОУ приїжджає з
  `handleAdd` полем `edrpou`. Збій запису не ламає додавання тендера.

## 🔗 Повʼязаний інструмент та інтеграція

Це один із **двох повʼязаних інструментів**. Працюючи в будь-якому — памʼятай про обидва:

| Інструмент | Роль | Тека |
|---|---|---|
| 📡 Tender Monitor (бот) | моніторить Prozorro, шле сповіщення, **ставить задачі агенту** | `C:\Users\andre\Desktop\AI\tender-monitor` |
| 🤖 Агент підготовки пропозицій | **готує/доробляє** пакети пропозицій за задачами | `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій` |

**Стик — один job-файл** `tender-monitor/_state/agent_jobs/<tender_id>.json`
(один файл на тендер; повторний запит перезаписує):
- **Пише бот** (Worker, GitHub Contents API) на крок «✅ Підтвердити».
- **Читає агент** — поллер `scripts/agent_poller.py` (Windows Task Scheduler, ~2 хв):
  бере `pending`, виконує роботу, **пише статус назад** (`running` → `done`/`error`),
  коміт `agent job <tid>: <status>`.

**Три типи задач (за полем `job_type`):**
- **`prepare`** (поле `job_type` ВІДСУТНЄ) — підготовка з нуля:
  `{ tender_id, link, company, price, requested_by, status:'pending', created_at }`
  → агент `run_agent.run(...)` будує пакет у нову теку Drive.
- **`amend`** (`job_type:'amend'`) — доробка готового пакету:
  `{ tender_id, link, job_type:'amend', instruction, company,
     target:{drive_link, package_dir}, requested_by, status:'pending', created_at }`
  (БЕЗ `price`) → агент `run_agent.run_amend(...)` відкриває `target` і застосовує `instruction`.
- **`winner`** (`job_type:'winner'`) — документи переможця:
  `{ tender_id, link, job_type:'winner', company, target?:{drive_link, package_dir,
     published_dir}, requested_by, status:'pending', created_at }`
  (БЕЗ `price`; поля `target` немає ВЗАГАЛІ, якщо агент цей тендер не готував — виграти
  можна й пакет, підготовлений вручну) → агент `run_agent.run_winner(...)` заповнює
  проєкт договору й збирає документи переможця в
  `ТЕНДЕРИ 2026\<N>. <Замовник>\Документи переможця\`.

**Статуси (пише агент назад):** `pending` → `running` (+`updated_at`) →
`done` (+`result:{package_dir, published_dir, drive_link, report_path, n_docx}`;
`package_dir` — робоча тека агента, `published_dir` — тека в архіві тендерного відділу
«ТЕНДЕРИ 2026\<N>. Замовник», куди агент копіює готову пропозицію ПЛОСКО; `drive_link`
веде саме на `published_dir`) |
`error` (+`result.detail`/`log_path`). «Готова пропозиція» = `done` + `result.drive_link`.

Для `winner` у `result` додаються `winner_dir`, `winner_link`, `report_path`, `n_docs`.
**`drive_link`, `package_dir` і `published_dir` winner НЕ переозначує** — переносить їх
з `target` без змін (лишає порожніми, якщо `target` не приїхав), бо саме за `drive_link`
бот визначає, що пропозиція готова, і малює кнопки `✏️ Доробити`/підписання. Перелік
знайдених/прострочених/відсутніх документів переможця — НЕ окремі поля `result` (на
відміну від початкового задуму), а вільний текст у звіті `_ЗВІТ ПЕРЕМОЖЦЯ.md` (секції
`## Прострочене` і `## Відсутнє`), який поллер інлайнить у Telegram-повідомлення.

**Вхід у боті:** `/agent` (або кнопка 🤖 Агент) → 🚀 prepare (тендер → компанія → ціна →
підтвердження); 📊 Останні задачі → ✏️ Доробити на готовій пропозиції → amend (інструкція →
підтвердження), поруч там же — 📄 Документи переможця → winner (компанія, якщо ще
невідома, → підтвердження). Другий вхід у winner — кнопка під сповіщенням
«🏆 Учасника визнано переможцем»: показується лише коли ЄДРПОУ переможця наш
(`companyForEdrpou`, звіряється у `monitor.mjs` ДО виклику `sendDigest`) і роль дозволяє
агента.

**Хто може запускати (з 11.08.2026): `admin` + `editor`** — єдине джерело правди
`canUseAgent(role)` у `commands.mjs`; право видається роллю: `/role editor <chat_id>`.
Усі три типи задач доступні редактору повністю (prepare, amend і winner). Результат агент шле
тому, хто замовив (`requested_by`), а НЕ адміну. Щоб адмін усе одно бачив чужі запуски:
на крок «✅ Підтвердити» бот (а) шле адміну коротке сповіщення `buildAgentAdminNotice`
(не шле, якщо запустив сам адмін) і (б) пише job-файл комітом у форматі
`audit: agent|agent_amend|agent_winner <tid> · <хто> [<chat_id>/<роль>]`, тож запуск видно в `/log`.

**Ключові місця:**
- Бот: `commands.mjs` (`buildAgentJob`, `buildAgentAmendJob`, `buildAgentWinnerJob`,
  `buildAgentWinnerConfirmText`, `buildAgentJobsPage`, `OUR_EDRPOU`, `companyForEdrpou`,
  `validateInstruction`, `handleAgentMenuNav`), `telegram.mjs` (`winnerButtonRow(tenderId, role)`
  — БЕЗ параметра ЄДРПОУ: компанію звіряє викликач `monitor.mjs` (`winnerTendersFor`) ще ДО
  виклику `sendDigest`; роль перевіряється тут-таки інлайн, а не через `canUseAgent` з
  `commands.mjs`, щоб не створювати цикл імпортів `telegram.mjs` ↔ `commands.mjs` — його в
  коді НЕМАЄ), `worker/src/handler.mjs` (`handleAgentCallback` — гілки `winner`/`co`/`confirm`;
  гілка `co` продовжує winner-діалог лише коли pending-запис має `kind:'winner'` **і** той
  самий `tid`, інакше падає в звичайний prepare), `worker/src/github.mjs` (`saveAgentJob`,
  `loadAgentJob`, `listAgentJobs`).
- Агент: `scripts/agent_poller.py` (`process_pending` — гілкує `prepare`/`amend`/`winner`;
  `resolve_drive_item`/`make_resolve_drive_item` резолвлять `winner_link` через Drive API),
  `scripts/run_agent.py` (`run`, `run_amend`, `run_winner`, `build_prompt`, `build_amend_prompt`,
  `build_winner_prompt`; `run_winner` приймає `work_root` — робочу датовану теку з кешем
  `_td_requirements.json`, `None`, коли агент цей тендер не готував; якщо headless `claude`
  зависає ВЖЕ ПІСЛЯ того, як пакет і звіт записані, статус все одно `ok` з приміткою `note`,
  а не `timeout`), `scripts/job_lib.py` (`is_pending`, `is_amend`, `is_winner`, `mark`).
- Скіл агента для winner: `.claude/skills/tender-winner-docs/SKILL.md`.
- Спека контракту доробки: `docs/superpowers/specs/2026-06-24-agent-amend-proposal-design.md`.

> **Правило:** зміниш контракт job-файлу з одного боку — **онови інший репозиторій**
> (поля, статуси, `job_type`) і цей розділ у ОБОХ `CLAUDE.md`.
