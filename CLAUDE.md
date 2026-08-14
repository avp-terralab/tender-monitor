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

**Чотири типи задач (за полем `job_type`):**
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
- **`sign`** (`job_type:'sign'`) — підписання й архів, з 14.08.2026:
  `{ tender_id, link, job_type:'sign', company, letter_date:'ДД.ММ.РРРР',
     target:{drive_link, package_dir, published_dir}, requested_by, status:'pending',
     created_at }`
  (БЕЗ `price`; `target.package_dir` ОБОВ'ЯЗКОВИЙ — саме його підписують, тому кнопка й
  з'являється лише на готовій пропозиції; `target.published_dir` теж передається завжди,
  коли пропозицію вже опубліковано — поллер віддає йому пріоритет над пошуком теки
  замовника ЗА НАЗВОЮ, бо відділ перейменовує теки вручну) → поллер сам, синхронно, викликає
  `sign_lib.sign_package(...)` — **звичайний детермінований Python, БЕЗ `claude -p`**.
  Це свідоме рішення власника: у цій задачі немає жодного кроку, що потребує судження
  моделі (заміна дати за регексом, вставка картинки, рендер Word-ом, zip — усе механічне),
  тож майбутнє «вирівнювання» sign з рештою типів через обгортання в модель — РЕГРЕС,
  а не наведення порядку. Датує (лише дату самого листа — «вих. № … від …», дати
  договорів/актів у пакеті не чіпає) й підписує КОПІЇ документів пакета (оригінали
  `package_dir` не змінюються ніколи), рендерить PDF через Word COM, збирає ZIP.

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

Для `sign` у `result` додаються `zip_path`, `zip_link`, `signed_dir`, `letter_date`,
`n_signed`, `n_pdf_total`/`n_pdf_expected`, `unsigned` + `unsigned_detail` (файли без
підпису і ПРИЧИНА), `undated` (файли, що лишились зі СТАРОЮ датою — немає поля
«Вих … від …»), `missing_pdf`/`fallback_pdf`, `superseded_zip`/`older_zip`. Усе це НЕ
помилки, а звіт власнику — робота все одно `done`, і кожен із цих списків іде в
Telegram-повідомлення нарівні з `unsigned`. **`drive_link`,
`package_dir` і `published_dir` sign теж НЕ переозначує** — переносить їх з `target`
без змін, тим самим принципом, що й `winner`.

**Куди лягає підписаний результат:** модель (точніше, `sign_lib`) підписує в РОБОЧІЙ
теці агента (стейджинг-підтека `Підписаний пакет\`, поруч із `Тендерна пропозиція\`).
Лише ПІСЛЯ успіху окремий крок поллера (`make_publish_signed`) копіює готове в теку
замовника архіву відділу «ТЕНДЕРИ 2026\<N>. <Замовник>\»: ZIP лягає ПЛОСКО в саму
теку (як і сама пропозиція), відрендеровані PDF — у підтеку `Підписані PDF\` поруч.
**Модель у цей архів НІКОЛИ не пише — копіює лише поллер**, той самий принцип, що й
для `winner`; це свідома вимога власника, а не випадковий збіг реалізації.

**Пошук скана підпису:** ОДНА спільна тека на всі компанії —
`Активи компаній\Підписи з печатками\` (НЕ підтека кожної компанії) — файл впізнається
за КЛЮЧОВИМ СЛОВОМ у назві (напр. «ай ті», «супровід»), як ціле слово, а не підрядок
(«про» — підрядок у «суПРОвід», наївний пошук підставив би чужий підпис ТЕРРАЛАБ ПРО).
Потрібен РІВНО один збіг: нуль або кілька кандидатів — чесна `error` з поясненням, а не
здогадка чи перший-ліпший файл (підписати документ ЧУЖИМ підписом — найгірше, що може
статись). Станом на 14.08.2026 скан є лише для ТЕРРАЛАБ АЙ ТІ та ТЕРРАЛАБ СУПРОВІД —
підписання по МАЙЛАБ, ТЕРРАЛАБ КОНСАЛТИНГ і ТЕРРАЛАБ ПРО завершується чистою,
повторюваною `error`, поки власник не покладе PNG.

**Геометрія відбитка** (`sign_lib.py`): ширина (`SIGNATURE_WIDTH_CM=6.5`) і
горизонтальний зсув (`SIGNATURE_OFFSET_X_CM=7.0`) — фіксовані константи, ЗАТВЕРДЖЕНІ
власником 14.08.2026 на реальному відрендереному листі. Вертикаль НЕ константа —
`signature_offset_y_cm` виводить її з ПРОПОРЦІЙ конкретного PNG-скана (ширина/висота),
центруючи зображення на текстовому рядку підпису; саме тому скан СУПРОВІД лягає з
іншим вертикальним зсувом, ніж скан АЙ ТІ, без ручного підбору під кожну компанію.

**Вхід у боті:** `/agent` (або кнопка 🤖 Агент) → 🚀 prepare (тендер → компанія → ціна →
підтвердження); 📊 Останні задачі → ✏️ Доробити на готовій пропозиції → amend (інструкція →
підтвердження), поруч там же — 📄 Документи переможця → winner (компанія, якщо ще
невідома, → підтвердження) і 🖊 Підписати й запакувати → sign (дата: сьогодні (Київ) чи
ввести свою вручну → підтвердження). Другий вхід у winner — кнопка під сповіщенням
«🏆 Учасника визнано переможцем»: показується лише коли ЄДРПОУ переможця наш
(`companyForEdrpou`, звіряється у `monitor.mjs` ДО виклику `sendDigest`) і роль дозволяє
агента.

**Хто може запускати (з 11.08.2026): `admin` + `editor`** — єдине джерело правди
`canUseAgent(role)` у `commands.mjs`; право видається роллю: `/role editor <chat_id>`.
Усі чотири типи задач доступні редактору повністю (prepare, amend, winner і sign).
Результат агент шле тому, хто замовив (`requested_by`), а НЕ адміну. Щоб адмін усе одно
бачив чужі запуски: на крок «✅ Підтвердити» бот (а) шле адміну коротке сповіщення
`buildAgentAdminNotice` (не шле, якщо запустив сам адмін) і (б) пише job-файл комітом у
форматі `audit: agent|agent_amend|agent_winner|agent_sign <tid> · <хто> [<chat_id>/<роль>]`,
тож запуск видно в `/log`.

**Ключові місця:**
- Бот: `commands.mjs` (`buildAgentJob`, `buildAgentAmendJob`, `buildAgentWinnerJob`,
  `buildAgentWinnerConfirmText`, `buildAgentJobsPage`, `OUR_EDRPOU`, `companyForEdrpou`,
  `validateInstruction`, `handleAgentMenuNav`, `validateLetterDate`, `formatLetterDate`
  — Київський час, не UTC, — `buildAgentSignJob`, `buildAgentSignDateKeyboard`,
  `buildAgentSignConfirmText`), `telegram.mjs` (`winnerButtonRow(tenderId, role)`
  — БЕЗ параметра ЄДРПОУ: компанію звіряє викликач `monitor.mjs` (`winnerTendersFor`) ще ДО
  виклику `sendDigest`; роль перевіряється тут-таки інлайн, а не через `canUseAgent` з
  `commands.mjs`, щоб не створювати цикл імпортів `telegram.mjs` ↔ `commands.mjs` — його в
  коді НЕМАЄ), `worker/src/handler.mjs` (`handleAgentCallback` — гілки `winner`/`co`/`confirm`;
  гілка `co` продовжує winner-діалог лише коли pending-запис має `kind:'winner'` **і** той
  самий `tid`, інакше падає в звичайний prepare; гілки `sign`/`signdate`/`signother` та
  `SIGN_CONTINUE_STEPS` для sign-діалогу, гілка `entry.kind === 'sign'` у `confirm`, крок
  `await_letter_date` у `handleAgentTextReply`), `worker/src/github.mjs` (`saveAgentJob`,
  `loadAgentJob`, `listAgentJobs`).
- Агент: `scripts/agent_poller.py` (`process_pending` — гілкує `prepare`/`amend`/`winner`/`sign`;
  `resolve_drive_item`/`make_resolve_drive_item` резолвлять `winner_link` через Drive API;
  гілка `is_sign` — стейджинг у `SIGN_STAGING_SUBDIR`, `_sign_failed`, потім
  `make_publish_signed` копіює в архів відділу; `_sign_keyboard`; `Config.assets_root`),
  `scripts/sign_lib.py` (`replace_letter_date`, `find_signature_index`, `signature_png_for`,
  `stamp_docx`, `signature_offset_y_cm`, `sign_package`, `pack_zip`),
  `scripts/run_agent.py` (`run`, `run_amend`, `run_winner`, `build_prompt`, `build_amend_prompt`,
  `build_winner_prompt`; `run_winner` приймає `work_root` — робочу датовану теку з кешем
  `_td_requirements.json`, `None`, коли агент цей тендер не готував; якщо headless `claude`
  зависає ВЖЕ ПІСЛЯ того, як пакет і звіт записані, статус все одно `ok` з приміткою `note`,
  а не `timeout`), `scripts/job_lib.py` (`is_pending`, `is_amend`, `is_winner`, `is_sign`, `mark`).
- Скіл агента для winner: `.claude/skills/tender-winner-docs/SKILL.md`. Для `sign` скіла
  НЕМАЄ і не буде — уся логіка в `sign_lib.py`, звичайний Python.
- Спека контракту доробки: `docs/superpowers/specs/2026-06-24-agent-amend-proposal-design.md`.
- План `sign`: `docs/superpowers/plans/2026-08-13-agent-sign-and-zip.md` — писаний ДО
  реалізації; де розійшовся з кодом, у самому файлі є датовані примітки-корекції.

> **Правило:** зміниш контракт job-файлу з одного боку — **онови інший репозиторій**
> (поля, статуси, `job_type`) і цей розділ у ОБОХ `CLAUDE.md`.
