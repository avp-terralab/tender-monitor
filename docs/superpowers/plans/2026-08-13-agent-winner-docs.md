# Документи переможця (agent winner) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** За однією кнопкою в Telegram агент заповнює проєкт договору й збирає документи переможця в теку `ТЕНДЕРИ 2026\<N>. <Замовник>\Документи переможця\`, чесно повідомляючи про відсутнє й прострочене.

**Architecture:** Новий `job_type: 'winner'` на наявних рейках job-файлу `_state/agent_jobs/<tid>.json`. Бот пише job (два входи: кнопка під сповіщенням про перемогу і пункт у меню задач), локальний поллер його забирає й запускає `claude -p` з новим скілом `tender-winner-docs`. Спільний з фічею `sign` крок — розширення резолвера Drive-посилань.

**Tech Stack:** Node ESM (Cloudflare Worker + pure-модулі) у боті; Python 3.12 у агенті; Google Drive API v3 через сервісний акаунт (read-only); Claude Code CLI (`claude -p`) як виконавець.

**Спека:** `docs/superpowers/specs/2026-08-13-agent-winner-docs-design.md`

## Global Constraints

- **Два репозиторії.** Бот: `C:\Users\andre\Desktop\AI\tender-monitor`. Агент: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій`. У кожному завданні шлях указано явно.
- **Бот деплоїться сам на push у `main`** (GHA, paths: `worker/**`, `commands.mjs`, `telegram.mjs`, `prozorro.mjs`). Тому робота йде в гілці `feat/agent-winner-docs`, а не в `main`.
- **Агент CI не має** — працює з локальної теки на `main`, зміни вмикаються, щойно потраплять у `main`.
- **Назви компаній — рівно як у `AGENT_COMPANIES`**: `МАЙЛАБ`, `ТЕРРАЛАБ АЙ ТІ`, `ТЕРРАЛАБ КОНСАЛТИНГ`, `ТЕРРАЛАБ СУПРОВІД`, `ТЕРРАЛАБ ПРО`. Без «ТОВ» і без лапок — `run_agent.run()` валідує саме такі рядки.
- **ЄДРПОУ наших юросіб:** МАЙЛАБ `41087617`, ТЕРРАЛАБ АЙ ТІ `39376596`, ТЕРРАЛАБ КОНСАЛТИНГ `43308066`, ТЕРРАЛАБ СУПРОВІД `44643484`, ТЕРРАЛАБ ПРО `46104055`.
- **Тести бота:** `node --test test/*.test.mjs worker/test/*.test.mjs`. **Тести агента:** `py -m pytest tests/ -q`.
- **Права — без змін:** `canUseAgent(role)` (`admin` + `editor`).
- **`result.drive_link` не чіпати** — за ним бот визначає готовність пропозиції. Посилання на результат winner-задачі йде в окреме поле `winner_link`.
- **Чужі теки (`ТЕНДЕРИ 2021-2025`, `Бухгалтерія\Реєстраційні документи`, `Активи компаній`) — тільки читання й копіювання.** Нічого не змінювати, не перейменовувати, не видаляти.

---

## File Structure

**Агент** (`C:\Users\andre\Desktop\AI\Агент підготовки пропозицій`):
- `scripts/agent_poller.py` — Modify: резолвер `resolve_drive_item`, гілка `winner` у `process_pending`, іконки секцій.
- `scripts/job_lib.py` — Modify: `is_winner`.
- `scripts/run_agent.py` — Modify: `build_winner_prompt`, `run_winner`.
- `.claude/skills/tender-winner-docs/SKILL.md` — Create: процедура агента.
- `tests/test_agent_poller.py`, `tests/test_job_lib.py`, `tests/test_run_agent.py` — Modify.

**Бот** (`C:\Users\andre\Desktop\AI\tender-monitor`):
- `commands.mjs` — Modify: `OUR_EDRPOU`, `companyForEdrpou`, `buildAgentWinnerJob`, `buildAgentWinnerConfirmText`, кнопка в `buildAgentJobsPage`, гілка в `buildAgentAdminNotice`.
- `telegram.mjs` — Modify: кнопка під подією `award_qualified`.
- `worker/src/handler.mjs` — Modify: гілка `winner` у `handleAgentCallback` + гілка в `confirm`.
- `test/commands.test.mjs`, `test/telegram.test.mjs`, `worker/test/handler.test.mjs` — Modify.

**Обидва репо:** `CLAUDE.md` — Modify: розділ інтеграції (синхронно).

---

### Task 1: Резолвер Drive-посилань `resolve_drive_item`

Наявний `make_resolve_drive_link` шукає лише теки й повертає лише URL. Winner-задачі потрібне посилання на **підпапку всередині** теки замовника, тож потрібен Drive-id проміжної теки. Це спільний крок із фічею `sign` (там знадобиться ще й `kind="file"`).

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\agent_poller.py:523-562`
- Test: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_agent_poller.py`

**Interfaces:**
- Consumes: нічого (перше завдання).
- Produces:
  - `build_drive_query(name, parent_id=None, kind="folder") -> str` — чиста функція, будує рядок запиту Drive API.
  - `make_resolve_drive_item(cfg) -> resolve_item(name, parent_id=None, kind="folder") -> (id, url) | (None, None)`
  - `make_resolve_drive_link(cfg)` лишається як обгортка й повертає лише `url`.

- [ ] **Step 1: Написати падаючий тест на побудову запиту**

Додати в `tests/test_agent_poller.py`:

```python
def test_build_drive_query_folder_vs_file():
    q_folder = ap.build_drive_query("80. Замовник", parent_id="PARENT1", kind="folder")
    assert "mimeType = 'application/vnd.google-apps.folder'" in q_folder
    assert "name = '80. Замовник'" in q_folder
    assert "'PARENT1' in parents" in q_folder
    assert "trashed = false" in q_folder

    # kind='file' — той самий запит БЕЗ обмеження mimeType (інакше ZIP не знайдеться)
    q_file = ap.build_drive_query("Пакет.zip", parent_id="PARENT1", kind="file")
    assert "mimeType" not in q_file
    assert "name = 'Пакет.zip'" in q_file

    # апостроф у назві не має ламати запит
    q_esc = ap.build_drive_query("Лікарня д'Артаньяна", kind="folder")
    assert "\\'" in q_esc

    # без parent_id обмеження на батька не додається
    assert "in parents" not in ap.build_drive_query("X", parent_id=None)
```

- [ ] **Step 2: Запустити тест і переконатися, що падає**

Run: `py -m pytest tests/test_agent_poller.py::test_build_drive_query_folder_vs_file -q`
Expected: FAIL — `AttributeError: module 'agent_poller' has no attribute 'build_drive_query'`

- [ ] **Step 3: Винести побудову запиту в чисту функцію**

У `scripts/agent_poller.py`, перед `make_resolve_drive_link`, додати:

```python
def build_drive_query(name, parent_id=None, kind="folder"):
    """Drive API v3 query for one item by exact name.

    kind='folder' constrains mimeType to a folder (the historical behaviour);
    kind='file' drops that clause so ordinary files (e.g. a .zip) are found too.
    """
    safe = (name or "").replace("\\", "\\\\").replace("'", "\\'")
    q = "name = '%s' and trashed = false" % safe
    if kind == "folder":
        q += " and mimeType = 'application/vnd.google-apps.folder'"
    if parent_id:
        q += " and '%s' in parents" % parent_id
    return q
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `py -m pytest tests/test_agent_poller.py::test_build_drive_query_folder_vs_file -q`
Expected: PASS

- [ ] **Step 5: Написати падаючий тест на резолвер із підстановленим Drive-сервісом**

```python
class _FakeFiles:
    def __init__(self, pages):
        self._pages = list(pages)
        self.queries = []
    def list(self, q=None, fields=None, pageSize=None):
        self.queries.append(q)
        page = self._pages.pop(0) if self._pages else []
        class _Exec:
            def execute(_self):
                return {"files": page}
        return _Exec()

class _FakeSvc:
    def __init__(self, pages):
        self._files = _FakeFiles(pages)
    def files(self):
        return self._files


def test_resolve_drive_item_returns_id_and_url():
    svc = _FakeSvc([[{"id": "ID1", "webViewLink": "https://drive/ID1"}]])
    got = ap.resolve_drive_item(svc, "80. Замовник", parent_id="P", kind="folder",
                                attempts=1, sleep=lambda _s: None)
    assert got == ("ID1", "https://drive/ID1"), got


def test_resolve_drive_item_missing_returns_none_pair():
    svc = _FakeSvc([[], [], []])
    got = ap.resolve_drive_item(svc, "нема", attempts=3, sleep=lambda _s: None)
    assert got == (None, None), got
    assert len(svc.files().queries) == 3   # ретраїть, поки Drive синхронізується


def test_resolve_drive_item_falls_back_to_folder_url():
    svc = _FakeSvc([[{"id": "ID2"}]])          # webViewLink відсутній
    _id, url = ap.resolve_drive_item(svc, "X", attempts=1, sleep=lambda _s: None)
    assert _id == "ID2"
    assert url == "https://drive.google.com/drive/folders/ID2"
```

- [ ] **Step 6: Запустити тести — мають падати**

Run: `py -m pytest tests/test_agent_poller.py -q -k resolve_drive_item`
Expected: FAIL — `module 'agent_poller' has no attribute 'resolve_drive_item'`

- [ ] **Step 7: Реалізувати `resolve_drive_item` і переписати фабрики поверх нього**

Замінити тіло `make_resolve_drive_link` (рядки 523-562) на:

```python
def resolve_drive_item(svc, name, parent_id=None, kind="folder",
                       attempts=8, sleep=None):
    """Resolve ONE Drive item by exact name -> (id, url) or (None, None).

    Retries because Google Drive Desktop syncs a freshly created folder/file to
    the cloud with a short delay. ``sleep`` is injectable for tests.
    """
    if sleep is None:
        import time as _time
        sleep = _time.sleep
    q = build_drive_query(name, parent_id, kind)
    for i in range(max(1, attempts)):
        res = svc.files().list(q=q, fields="files(id,webViewLink)",
                               pageSize=1).execute()
        files = res.get("files", [])
        if files:
            fid = files[0]["id"]
            return fid, (files[0].get("webViewLink")
                         or "https://drive.google.com/drive/folders/%s" % fid)
        if i < attempts - 1:
            sleep(5)
    return None, None


def _drive_service(cfg):
    """Build a read-only Drive v3 client from the service-account key, or None."""
    if not cfg.drive_sa_key or not os.path.exists(cfg.drive_sa_key):
        return None
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        cfg.drive_sa_key,
        scopes=["https://www.googleapis.com/auth/drive.readonly"])
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def make_resolve_drive_item(cfg):
    """Return resolve_item(name, parent_id=None, kind='folder') -> (id, url).

    No SA key configured -> returns None (caller falls back), matching the
    historical make_resolve_drive_link contract.
    """
    if not cfg.drive_sa_key:
        return None

    def resolve_item(name, parent_id=None, kind="folder"):
        svc = _drive_service(cfg)
        if svc is None:
            return None, None
        return resolve_drive_item(svc, name, parent_id or cfg.drive_parent_id, kind)

    return resolve_item


def make_resolve_drive_link(cfg):
    """Back-compat wrapper: resolve_link(folder_name, parent_id=None) -> url|None.

    `prepare` and `amend` call this and want only the URL; keep them untouched.
    """
    resolve_item = make_resolve_drive_item(cfg)
    if resolve_item is None:
        return None

    def resolve_link(folder_name, parent_id=None):
        _id, url = resolve_item(folder_name, parent_id, "folder")
        return url

    return resolve_link
```

- [ ] **Step 8: Прогнати весь набір тестів агента**

Run: `py -m pytest tests/ -q`
Expected: PASS — усі, зокрема наявні тести `prepare`/`amend`, які користуються `resolve_link`.

- [ ] **Step 9: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git checkout -b feat/agent-winner-docs
git add scripts/agent_poller.py tests/test_agent_poller.py
git commit -m "feat(drive): resolve_drive_item returns (id, url) and supports files"
```

---

### Task 2: `job_lib.is_winner`

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\job_lib.py:220-225`
- Test: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_job_lib.py`

**Interfaces:**
- Consumes: нічого.
- Produces: `job_lib.is_winner(job) -> bool`.

- [ ] **Step 1: Написати падаючий тест**

```python
def test_is_winner():
    assert jl.is_winner({"job_type": "winner"}) is True
    assert jl.is_winner({"job_type": "amend"}) is False
    assert jl.is_winner({}) is False               # prepare — без job_type
    # winner і amend взаємовиключні
    assert jl.is_amend({"job_type": "winner"}) is False
```

- [ ] **Step 2: Запустити — має впасти**

Run: `py -m pytest tests/test_job_lib.py::test_is_winner -q`
Expected: FAIL — `module 'job_lib' has no attribute 'is_winner'`

- [ ] **Step 3: Реалізувати**

Після `is_amend` у `scripts/job_lib.py`:

```python
def is_winner(job):
    """True if this job asks for the winner-documents package (проєкт договору +
    документи переможця). Ordinary 'prepare' jobs have no job_type."""
    return job.get("job_type") == "winner"
```

- [ ] **Step 4: Запустити — має пройти**

Run: `py -m pytest tests/test_job_lib.py -q`
Expected: PASS

- [ ] **Step 5: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/job_lib.py tests/test_job_lib.py
git commit -m "feat(job): is_winner predicate"
```

---

### Task 3: Промпт і запуск `run_winner`

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\run_agent.py` (після `run_amend`)
- Test: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_run_agent.py`

**Interfaces:**
- Consumes: нічого з попередніх завдань.
- Produces:
  - `build_winner_prompt(link, company, winner_dir, td_requirements_path=None) -> str`
  - `run_winner(link, company, winner_dir, work_root=None, timeout=2700, claude_bin="claude", log_path=None, runner=_default_runner) -> dict` з ключами `status`, `winner_dir`, `report_path`, `log_path`, `n_docs`, `summary`.

> **Виправлено 13.08.2026 після рев'ю.** Первинна редакція цього завдання виводила
> шлях до кешу ТД із `winner_dir` (`os.path.dirname(os.path.dirname(...))`) — це
> непрацездатно: `_td_requirements.json` лежить у **робочій** датованій теці
> `Архів тендерних пропозицій\<ДД.ММ.РР Замовник>\`, а `winner_dir` — у геть іншому
> дереві, в архіві відділу `ТЕНДЕРИ 2026\`. Жодна кількість `dirname()` туди не
> веде, тож оптимізація була б мертвим кодом. Тому робоча тека передається
> ЯВНО параметром `work_root`; коли її немає (перемога в тендері, який агент не
> готував) — `work_root=None` і підказки про кеш у промпті немає.
> Так само `run_winner` мусить повторювати `decide_status()`: таймаут обгортки
> ПІСЛЯ збереження пакета — це `ok`, а не `timeout` (у headless-режимі верхній
> `claude -p` регулярно зависає вже після запису документів).

- [ ] **Step 1: Написати падаючий тест на промпт**

```python
def test_build_winner_prompt_mentions_skill_and_dirs():
    p = ra.build_winner_prompt(
        "https://prozorro.gov.ua/tender/UA-1",
        "ТЕРРАЛАБ АЙ ТІ",
        r"G:\ТЕНДЕРИ 2026\80. КНП Х\Документи переможця",
    )
    assert "tender-winner-docs" in p
    assert "UA-1" in p
    assert "ТЕРРАЛАБ АЙ ТІ" in p
    assert "Документи переможця" in p
    # headless: субагентів не запускати
    assert "do NOT dispatch a separate" in p
    # без кешу ТД підказки про нього немає
    assert "TD requirements cache" not in p


def test_build_winner_prompt_uses_td_cache(tmp_path):
    cache = tmp_path / "_td_requirements.json"
    cache.write_text("{}", encoding="utf-8")
    p = ra.build_winner_prompt("https://prozorro.gov.ua/tender/UA-1", "МАЙЛАБ",
                               str(tmp_path / "Документи переможця"),
                               td_requirements_path=str(cache))
    assert "TD requirements cache" in p
    assert str(cache) in p
```

- [ ] **Step 2: Запустити — має впасти**

Run: `py -m pytest tests/test_run_agent.py -q -k winner_prompt`
Expected: FAIL — `module 'run_agent' has no attribute 'build_winner_prompt'`

- [ ] **Step 3: Реалізувати промпт**

У `scripts/run_agent.py` після `build_amend_prompt`:

```python
def build_winner_prompt(link, company, winner_dir, td_requirements_path=None):
    """Prompt for the winner-documents package (проєкт договору + документи переможця)."""
    cache_hint = ""
    if td_requirements_path and os.path.isfile(td_requirements_path):
        cache_hint = (
            f"\nTD requirements cache available at: {td_requirements_path}"
            " — Read it instead of re-downloading and re-parsing the ТД.\n"
        )
    return (
        "Use the `tender-winner-docs` skill and follow it EXACTLY. "
        "We WON this tender; prepare the winner's document package.\n\n"
        "Do ALL the work DIRECTLY in THIS session — do NOT dispatch a separate "
        "subagent (do NOT use the Task/Agent tool). This runs headless with no stdin, "
        "so a subagent dispatch can be interrupted and then hang forever waiting for "
        "input.\n\n"
        "Brief:\n"
        f"- Prozorro link/tenderID: {link}\n"
        f"- winning company: {company}\n"
        f"- output folder (already created): {winner_dir}\n"
        f"{cache_hint}\n"
        "Write the report to «_ЗВІТ ПЕРЕМОЖЦЯ.md» INSIDE that folder. The poller "
        "inlines the whole report into a Telegram message (3500-char cap), so keep it "
        "short: «##» headings, terse bullets, and ALWAYS include the sections "
        "«Прострочене» and «Відсутнє» even when they are empty.\n"
    )
```

- [ ] **Step 4: Запустити — має пройти**

Run: `py -m pytest tests/test_run_agent.py -q -k winner_prompt`
Expected: PASS

- [ ] **Step 5: Написати падаючий тест на `run_winner`**

```python
def test_run_winner_ok_when_report_written(tmp_path):
    wdir = tmp_path / "Документи переможця"
    wdir.mkdir()

    def fake_runner(cmd, cwd, timeout):
        # агент «попрацював»: створив звіт і один документ
        (wdir / "_ЗВІТ ПЕРЕМОЖЦЯ.md").write_text("# звіт\n## Відсутнє\n—\n", encoding="utf-8")
        (wdir / "Проєкт договору.docx").write_bytes(b"x")
        return 0, "done"

    res = ra.run_winner("https://prozorro.gov.ua/tender/UA-1", "МАЙЛАБ", str(wdir),
                        runner=fake_runner, log_path=str(tmp_path / "log.txt"))
    assert res["status"] == "ok", res
    assert res["winner_dir"] == str(wdir)
    assert res["report_path"] == str(wdir / "_ЗВІТ ПЕРЕМОЖЦЯ.md")
    assert res["n_docs"] == 1                      # звіт не рахується


def test_run_winner_error_when_nothing_produced(tmp_path):
    wdir = tmp_path / "Документи переможця"
    wdir.mkdir()
    res = ra.run_winner("https://prozorro.gov.ua/tender/UA-1", "МАЙЛАБ", str(wdir),
                        runner=lambda cmd, cwd, timeout: (1, "boom"),
                        log_path=str(tmp_path / "log.txt"))
    assert res["status"] == "error", res
    assert res["log_path"].endswith("log.txt")
```

- [ ] **Step 6: Запустити — має впасти**

Run: `py -m pytest tests/test_run_agent.py -q -k run_winner`
Expected: FAIL — `module 'run_agent' has no attribute 'run_winner'`

- [ ] **Step 7: Реалізувати `run_winner`**

```python
def run_winner(link, company, winner_dir, timeout=2700, claude_bin="claude",
               log_path=None, runner=_default_runner):
    """Build the winner-documents package in ``winner_dir``.

    Mirrors run()/run_amend(): same runner injection, same log handling. Success
    is «звіт написано і є хоч один документ», which is what the poller reports.
    """
    if not winner_dir:
        raise ValueError("run_winner requires winner_dir")
    if company not in COMPANIES:
        raise ValueError("unknown company %r; expected one of %s"
                         % (company, sorted(COMPANIES)))
    os.makedirs(winner_dir, exist_ok=True)
    log_path = log_path or os.path.join(winner_dir, "_agent_winner.log")
    cache = td_cache_path(os.path.dirname(os.path.dirname(winner_dir)))
    prompt = build_winner_prompt(
        link, company, winner_dir,
        td_requirements_path=cache if os.path.isfile(cache) else None,
    )

    timed_out = False
    rc, output = -1, ""
    try:
        rc, output = runner([claude_bin, "-p", prompt], PROJECT_ROOT, timeout)
    except subprocess.TimeoutExpired as e:
        timed_out = True
        output = (e.output or "") if isinstance(e.output, str) else ""
    try:
        with open(log_path, "w", encoding="utf-8") as fh:
            fh.write(output or "")
    except OSError:
        pass

    report = os.path.join(winner_dir, "_ЗВІТ ПЕРЕМОЖЦЯ.md")
    has_report = os.path.isfile(report)
    docs = [f for f in os.listdir(winner_dir)
            if not f.startswith("_") and os.path.isfile(os.path.join(winner_dir, f))]
    if timed_out:
        status = "timeout"
    elif has_report and docs:
        status = "ok"
    else:
        status = "error"
    return {
        "status": status,
        "winner_dir": winner_dir,
        "report_path": report if has_report else None,
        "log_path": log_path,
        "n_docs": len(docs),
        "summary": {
            "ok": "Документи переможця зібрано; перевір %s." % winner_dir,
            "error": "Агент не створив документи — див. лог %s." % log_path,
            "timeout": "Перевищено таймаут %ss — див. лог %s." % (timeout, log_path),
        }.get(status, ""),
    }
```

- [ ] **Step 8: Запустити всі тести агента**

Run: `py -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 9: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/run_agent.py tests/test_run_agent.py
git commit -m "feat(agent): run_winner builds the winner-documents package"
```

---

### Task 4: Скіл `tender-winner-docs`

**Files:**
- Create: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\.claude\skills\tender-winner-docs\SKILL.md`

**Interfaces:**
- Consumes: `run_agent.build_winner_prompt` (Task 3) передає посилання, компанію й `winner_dir`.
- Produces: файли в `winner_dir` + `_ЗВІТ ПЕРЕМОЖЦЯ.md` із секціями `## Прострочене` і `## Відсутнє` (їх читає поллер у Task 6).

Скіл — це інструкція, а не код; тестів у нього немає, перевіряється реальним прогоном (Task 8).

- [ ] **Step 1: Створити файл скіла**

```markdown
---
name: tender-winner-docs
description: Зібрати пакет документів ПЕРЕМОЖЦЯ за виграним тендером — заповнити проєкт договору з ТД реквізитами компанії й сумами, зібрати документи, які ТД вимагає від переможця (підписант, несудимість, антикорупційна), перевірити строк давності. Використовувати, коли поллер передав задачу з `job_type: winner`, або на «ми виграли, готуй документи переможця». Не для підготовки пропозиції — то скіл tender-proposal-prepare.
---

# Документи переможця

Тендер **виграно**. Твоя робота — підготувати те, що подається ПІСЛЯ перемоги:
заповнений проєкт договору й документи переможця з ТД.

## Що ти отримуєш

- **теку результату** (`winner_dir`) — вона вже створена, працюй у ній;
- **посилання/tenderID** закупівлі;
- **компанію-переможця** (одна з 5 наших юросіб).

## Контекст

Прочитай `memory/bidder-companies-requisites.md` (реквізити, директор, система
оподаткування) і `memory/document-validity.md` (чинність постійних документів —
ISO 25051 бери №2423-25; ТЗІ-висновок чинний за листом Держспецзв'язку).
`memory/tender-formatting-rules.md` — якщо генеруєш `.docx` на бланку.

**Якщо є `_td_requirements.json`** (шлях дає промпт) — читай його замість того,
щоб знову качати й парсити ТД.

## Порядок дій

1. **Розбери вимоги ТД до переможця.** Знайди розділ/додаток «Документи
   переможця» і випиши: перелік документів, **вимогу до строку давності** кожного
   («не раніше ніж за 30 днів до…»), і строк подання (типово 4 робочі дні).
2. **Проєкт договору.** Знайди в ТД додаток «Проєкт договору».
   - `.doc`/`.docx` → скопіюй у `winner_dir` і заповни на копії.
   - лише PDF → прочитай PDF інструментом `Read` і збери редагований `.docx` за
     його структурою. У звіті познач: «зібрано з PDF — звірити форматування».
   - немає взагалі → напиши це у звіт, решту роботи зроби.
   Заповнюй: повну назву й реквізити компанії, директора й підставу повноважень,
   ціну договору (з ПДВ чи без — за системою оподаткування ЦІЄЇ компанії),
   специфікацію, додатки, банківські реквізити. **Порожні місця не вигадуй** —
   став `[ВІДСУТНЄ — уточнити …]` і винеси в розділ «Відсутнє».
3. **Збери документи переможця** з трьох джерел, у цьому порядку:
   1. `G:\Мій диск\AI\Активи компаній\<Компанія>\`
   2. `G:\Спільні диски\Бухгалтерія\Реєстраційні документи\<Юрособа>\`
   3. `G:\Мій диск\ТЕНДЕРИ 2021-2025\ТЕНДЕРИ <рік>\` — попередні пакети цієї ж компанії.
   Перший знайдений чинний документ — переможець; далі не шукай.
4. **Перевір строк давності** кожного знайденого проти вимоги ТД. Прострочене
   **однаково копіюй**, але з префіксом `ПРОСТРОЧЕНЕ - ` у назві файлу.
5. **Напиши `_ЗВІТ ПЕРЕМОЖЦЯ.md`** у `winner_dir`.

## Формат звіту

Поллер інлайнить звіт у повідомлення Telegram (ліміт 3500 символів), тож пиши
**коротко**: `##`-заголовки, стислі пункти. Секції `## Прострочене` і
`## Відсутнє` мають бути ЗАВЖДИ — навіть якщо в них «—».

## Hard rules

- Працюй **автономно**, підтверджень не питай.
- **Чужі теки — тільки читання.** З `ТЕНДЕРИ 2021-2025`, `Бухгалтерія`,
  `Активи компаній` можна лише КОПІЮВАТИ. Нічого там не змінюй, не перейменовуй,
  не видаляй.
- **Не роби сліпих `grep`/`find` по всьому `G:`** — тільки три перелічені корені.
  Пошук по мережевому Drive повільний і вішає задачу.
- **Нічого не вигадуй.** Немає документа — так і напиши.
- У `winner_dir` наявні файли не перезаписуй: повторний запуск додає з суфіксом ` (2)`.
- У `memory/` не пиши.
- КЕП не накладай, документи не подавай — це робить власник.

## Definition of Done

- [ ] Проєкт договору заповнено (або чесно пояснено, чому ні).
- [ ] Кожен документ із переліку ТД — або в теці, або в розділі «Відсутнє».
- [ ] Прострочене має префікс у назві файлу і рядок у розділі «Прострочене».
- [ ] `_ЗВІТ ПЕРЕМОЖЦЯ.md` написано, вкладається в 3500 символів.
```

- [ ] **Step 2: Перевірити, що скіл видно Claude Code**

Run: `cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій" && ls .claude/skills/`
Expected: у списку є `tender-winner-docs` поруч із `tender-proposal-prepare` і `tender-proposal-amend`.

- [ ] **Step 3: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add .claude/skills/tender-winner-docs/SKILL.md
git commit -m "feat(skill): tender-winner-docs procedure"
```

---

### Task 5: Гілка `winner` у поллері

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\agent_poller.py` (`process_pending`, `_SECTION_ICONS`, `main`)
- Test: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_agent_poller.py`

**Interfaces:**
- Consumes: `resolve_drive_item`/`make_resolve_drive_item` (Task 1), `job_lib.is_winner` (Task 2), `run_agent.run_winner` (Task 3).
- Produces: `process_pending(..., run_winner=None, resolve_item=None)` — два нові інжектовані параметри; job переходить у `done` з полями `winner_dir`, `winner_link`, `report_path`, `n_docs` і **збереженими** `drive_link`/`package_dir`/`published_dir` із `target`.

- [ ] **Step 1: Написати падаючий тест на гілку winner**

```python
def test_process_pending_winner_branch(tmp_path):
    job = {
        "tender_id": "UA-1",
        "link": "https://prozorro.gov.ua/tender/UA-1",
        "job_type": "winner",
        "company": "МАЙЛАБ",
        "target": {"drive_link": "https://drive/PROPOSAL",
                   "package_dir": r"G:\роб\Тендерна пропозиція",
                   "published_dir": r"G:\ТЕНДЕРИ 2026\80. КНП Х"},
        "requested_by": "555",
        "status": "pending",
    }
    saved, sent = {}, []
    called = {}

    def fake_run_winner(link, company, winner_dir, **kw):
        called["winner_dir"] = winner_dir
        return {"status": "ok", "winner_dir": winner_dir,
                "report_path": None, "log_path": "L", "n_docs": 3, "summary": ""}

    ap.process_pending(
        _cfg(tmp_path),
        list_jobs=lambda: [("UA-1.json", job)],
        set_status=lambda name, j: saved.update({name: j}),
        run_agent=lambda *a, **k: pytest.fail("prepare must not run"),
        send_telegram=lambda chat, text, reply_markup=None: sent.append((chat, text)),
        entity_name=lambda link: "КНП «Х»",
        today=datetime.date(2026, 8, 13),
        run_winner=fake_run_winner,
        resolve_item=lambda name, parent_id=None, kind="folder": ("ID", "https://drive/WIN"),
    )

    out = saved["UA-1.json"]
    assert out["status"] == "done", out
    assert out["result"]["winner_link"] == "https://drive/WIN"
    assert out["result"]["n_docs"] == 3
    # головне: посилання на пропозицію НЕ затерте
    assert out["result"]["drive_link"] == "https://drive/PROPOSAL"
    assert out["result"]["package_dir"] == r"G:\роб\Тендерна пропозиція"
    # результат пішов замовнику, а не адміну
    assert sent and sent[0][0] == "555"
    assert "Документи переможця" in called["winner_dir"]
```

(`_cfg(tmp_path)` — наявний у файлі хелпер побудови `Config`; якщо його немає, додай локальний, що ставить `drive_root=str(tmp_path)`, `publish_root=str(tmp_path / "ТЕНДЕРИ 2026")`, `admin_chat_id="1"`.)

- [ ] **Step 2: Запустити — має впасти**

Run: `py -m pytest tests/test_agent_poller.py::test_process_pending_winner_branch -q`
Expected: FAIL — `process_pending() got an unexpected keyword argument 'run_winner'`

- [ ] **Step 3: Додати гілку в `process_pending`**

У сигнатурі `process_pending` додати `run_winner=None, resolve_item=None`. Одразу після гілки `is_amend` (перед резолвом замовника для `prepare`) вставити:

```python
    if job_lib.is_winner(job):
        if run_winner is None:
            return name                      # можливості немає — лишаємо pending
        target = job.get("target") or {}
        short = job_lib.short_entity_name(entity_name(job["link"]))
        # тека замовника в архіві відділу: наявна або нова під наступним номером
        pub_root = cfg.publish_root
        os.makedirs(pub_root, exist_ok=True)
        names = [n for n in os.listdir(pub_root)
                 if os.path.isdir(os.path.join(pub_root, n))]
        folder = (job_lib.find_published_folder(names, short)
                  or job_lib.publish_folder_name(
                      job_lib.next_folder_number(names), short))
        winner_dir = os.path.join(pub_root, folder, "Документи переможця")
        os.makedirs(winner_dir, exist_ok=True)

        set_status(name, job_lib.mark(job, "running", at=at))
        # Кеш ТД лежить у РОБОЧІЙ датованій теці (батьківській до package_dir),
        # а не десь над winner_dir — тому передаємо її явно. Немає target
        # (агент цей тендер не готував) → work_root=None, кеш просто не шукаємо.
        pkg = target.get("package_dir")
        work_root = os.path.dirname(pkg.rstrip("/\\")) if pkg else None
        result = run_winner(job["link"], job["company"], winner_dir,
                            work_root=work_root)

        recipient = job.get("requested_by") or cfg.admin_chat_id
        if result.get("status") == "ok":
            win_url = None
            if resolve_item:
                try:
                    fid, _ = resolve_item(folder, cfg.publish_parent_id, "folder")
                    if fid:
                        _wid, win_url = resolve_item("Документи переможця", fid, "folder")
                except Exception as e:                       # noqa: BLE001
                    print("worker: winner link resolve failed:", e)
            body = _report_body(result.get("report_path"))
            lines = ["<b>📄 Документи переможця готові</b>", ""]
            lines.append("📋 %s · %s" % (html.escape(job.get("tender_id", "")),
                                         html.escape(job_lib.abbrev_entity_name(
                                             entity_name(job["link"])))))
            if job.get("company"):
                lines.append("🏢 %s" % html.escape(job["company"]))
            if body:
                lines.extend(["", _md_to_html(body)])
            if not win_url:
                lines.extend(["", "📁 %s" % html.escape(winner_dir)])
            send_telegram(recipient, "\n".join(lines),
                          reply_markup=_done_keyboard(win_url))
            set_status(name, job_lib.mark(
                job, "done",
                winner_dir=winner_dir,
                winner_link=win_url,
                report_path=result.get("report_path"),
                n_docs=result.get("n_docs"),
                # НЕ переозначуємо — переносимо з target, щоб не зламати amend/sign
                drive_link=target.get("drive_link"),
                package_dir=target.get("package_dir"),
                published_dir=target.get("published_dir"),
                at=at,
            ))
        else:
            detail = result.get("detail") or result.get("summary") or "невідома помилка"
            send_telegram(recipient, "⚠️ Документи переможця не вдались: %s"
                          % html.escape(detail),
                          reply_markup=_retry_keyboard(job.get("tender_id", "")))
            set_status(name, job_lib.mark(
                job, "error", detail=detail, log_path=result.get("log_path"),
                status_from_agent=result.get("status"), at=at,
            ))
        return name
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `py -m pytest tests/test_agent_poller.py::test_process_pending_winner_branch -q`
Expected: PASS

- [ ] **Step 5: Додати іконки секцій звіту**

У `_SECTION_ICONS` (рядки 85-93) додати два записи перед фінальним:

```python
    ("прострочен", "⏰"),
    ("переможц", "📄"),
```

- [ ] **Step 6: Написати й прогнати тест на іконки**

```python
def test_heading_icons_for_winner_sections():
    assert ap._heading_icon("прострочене") == "⏰"
    assert ap._heading_icon("документи переможця") == "📄"
    assert ap._heading_icon("відсутнє") == "❗"      # регресія: наявне не з'їхало
```

Run: `py -m pytest tests/test_agent_poller.py::test_heading_icons_for_winner_sections -q`
Expected: PASS

- [ ] **Step 7: Під'єднати нові залежності в `main`**

У `main()` (рядок ~600) додати в виклик `process_pending`:

```python
        run_winner=run_agent_mod.run_winner,
        resolve_item=make_resolve_drive_item(cfg),
```

(іменем модуля користуйся тим, під яким `run_agent` уже імпортовано у файлі).

- [ ] **Step 8: Прогнати всі тести агента**

Run: `py -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 9: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/agent_poller.py tests/test_agent_poller.py
git commit -m "feat(poller): winner job branch, keeps proposal drive_link intact"
```

---

### Task 6: Бот — константи, job-білдер і кнопка в списку задач

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\commands.mjs` (біля `AGENT_COMPANIES:1766`, `buildAgentJobsPage:1899`, `buildAgentAdminNotice`)
- Test: `C:\Users\andre\Desktop\AI\tender-monitor\test\commands.test.mjs`

**Interfaces:**
- Consumes: нічого з попередніх завдань (інший репозиторій).
- Produces:
  - `OUR_EDRPOU` — обʼєкт `{ '<едрпоу>': '<назва як в AGENT_COMPANIES>' }`
  - `companyForEdrpou(edrpou) -> string | null`
  - `buildAgentWinnerJob({ tenderId, company, target, requestedBy, createdAt }) -> object`
  - `buildAgentWinnerConfirmText({ tenderId, company, entityName }) -> string`

- [ ] **Step 1: Написати падаючі тести**

Додати в `test/commands.test.mjs` (і дописати нові імена в блок імпорту зверху):

```javascript
test('OUR_EDRPOU maps our codes to AGENT_COMPANIES names', () => {
  assert.equal(companyForEdrpou('39376596'), 'ТЕРРАЛАБ АЙ ТІ');
  assert.equal(companyForEdrpou('41087617'), 'МАЙЛАБ');
  assert.equal(companyForEdrpou('00000000'), null);
  assert.equal(companyForEdrpou(undefined), null);
  // числовий ЄДРПОУ з API теж має резолвитись
  assert.equal(companyForEdrpou(39376596), 'ТЕРРАЛАБ АЙ ТІ');
  // списки не мають розʼїхатись
  const known = new Set(Object.values(AGENT_COMPANIES));
  for (const name of Object.values(OUR_EDRPOU)) assert.ok(known.has(name), name);
  assert.equal(Object.keys(OUR_EDRPOU).length, 5);
});

test('buildAgentWinnerJob has no price and carries target', () => {
  const job = buildAgentWinnerJob({
    tenderId: 'UA-1',
    company: 'МАЙЛАБ',
    target: { drive_link: 'https://d/1', package_dir: 'P', published_dir: 'PUB' },
    requestedBy: '555',
    createdAt: '2026-08-13T10:00:00.000Z',
  });
  assert.equal(job.job_type, 'winner');
  assert.equal(job.status, 'pending');
  assert.equal(job.link, 'https://prozorro.gov.ua/tender/UA-1');
  assert.equal(job.price, undefined);
  assert.equal(job.target.published_dir, 'PUB');
  assert.equal(job.requested_by, '555');
});

test('buildAgentWinnerJob omits target when there is no prior job', () => {
  const job = buildAgentWinnerJob({
    tenderId: 'UA-2', company: 'МАЙЛАБ', target: null,
    requestedBy: '555', createdAt: '2026-08-13T10:00:00.000Z',
  });
  assert.equal(job.target, undefined);
});

test('jobs page shows the winner button on a done proposal', () => {
  const jobs = [{
    tender_id: 'UA-1', status: 'done', company: 'МАЙЛАБ',
    result: { drive_link: 'https://d/1' },
  }];
  const view = buildAgentJobsPage({ jobs });
  const flat = view.keyboard.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === 'agent:winner:UA-1'));
  // наявна кнопка доробки лишилась
  assert.ok(flat.some((b) => b.callback_data === 'agent:amend:UA-1'));
});

test('jobs page marks winner jobs with an icon', () => {
  const view = buildAgentJobsPage({
    jobs: [{ tender_id: 'UA-9', status: 'running', job_type: 'winner' }],
  });
  assert.ok(view.text.includes('📄'));
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/commands.test.mjs`
Expected: FAIL — `companyForEdrpou is not defined`

- [ ] **Step 3: Реалізувати в `commands.mjs`**

Одразу після `slugForCompany` (рядок ~1783):

```javascript
// Наші юрособи за ЄДРПОУ. Значення — РІВНО ті рядки, що в AGENT_COMPANIES:
// агент валідує назву компанії проти свого COMPANIES і за нею ж знаходить теку
// активів. Використовується, щоб показати кнопку «Документи переможця» лише
// тоді, коли переможцем визнано НАС.
export const OUR_EDRPOU = {
  41087617: 'МАЙЛАБ',
  39376596: 'ТЕРРАЛАБ АЙ ТІ',
  43308066: 'ТЕРРАЛАБ КОНСАЛТИНГ',
  44643484: 'ТЕРРАЛАБ СУПРОВІД',
  46104055: 'ТЕРРАЛАБ ПРО',
};

export function companyForEdrpou(edrpou) {
  if (edrpou === null || edrpou === undefined) return null;
  const key = String(edrpou).trim();
  return Object.prototype.hasOwnProperty.call(OUR_EDRPOU, key)
    ? OUR_EDRPOU[key]
    : null;
}
```

Після `buildAgentAmendJob`:

```javascript
// Winner job: заповнити проєкт договору й зібрати документи переможця.
// Без `price`. `target` переноситься з попереднього job-а, коли він є; якщо
// агент цей тендер не готував — поля немає взагалі.
export function buildAgentWinnerJob({ tenderId, company, target, requestedBy, createdAt }) {
  const job = {
    tender_id: tenderId,
    link: `https://prozorro.gov.ua/tender/${tenderId}`,
    job_type: 'winner',
    company,
    requested_by: requestedBy,
    status: 'pending',
    created_at: createdAt,
  };
  if (target) job.target = target;
  return job;
}

export function buildAgentWinnerConfirmText({ tenderId, company, entityName }) {
  const ent = entityName ? `\nЗамовник: ${escapeHtml(entityName)}` : '';
  return `📄 Документи переможця\nТендер: ${escapeHtml(tenderId)}${ent}\nКомпанія: ${escapeHtml(company)}`;
}
```

У `buildAgentJobsPage` замінити рядок маркера й блок кнопок:

```javascript
    const mark = j.job_type === 'amend' ? '✏️ ' : (j.job_type === 'winner' ? '📄 ' : '');
```

```javascript
  for (const j of slice) {
    if (j.status === 'done' && j.result?.drive_link && j.tender_id) {
      rows.push([
        { text: `📁 ${j.tender_id}`, url: j.result.drive_link },
        { text: '✏️ Доробити', callback_data: `agent:amend:${j.tender_id}` },
      ]);
      rows.push([
        { text: '📄 Документи переможця', callback_data: `agent:winner:${j.tender_id}` },
      ]);
    }
  }
```

- [ ] **Step 4: Запустити тести — мають пройти**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/commands.test.mjs`
Expected: PASS

- [ ] **Step 5: Додати гілку в сповіщення адміну**

У `buildAgentAdminNotice`, перед гілкою `amend`:

```javascript
  if (kind === 'winner') {
    return `🤖 ${who} запустив документи переможця по ${escapeHtml(tenderId)}`;
  }
```

- [ ] **Step 6: Тест на сповіщення адміну**

```javascript
test('admin notice mentions winner runs', () => {
  const s = buildAgentAdminNotice({
    kind: 'winner', actorName: 'Оксана', chatId: 555, tenderId: 'UA-1',
  });
  assert.ok(s.includes('документи переможця'));
  assert.ok(s.includes('UA-1'));
});
```

Run: `node --test test/commands.test.mjs`
Expected: PASS

- [ ] **Step 7: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git checkout -b feat/agent-winner-docs
git add commands.mjs test/commands.test.mjs
git commit -m "feat(bot): OUR_EDRPOU, winner job builder and jobs-page button"
```

---

### Task 7: Кнопка під сповіщенням про перемогу

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\telegram.mjs` (рендер події `award_qualified`, ~рядок 229, і місце, де збирається клавіатура дайджесту)
- Test: `C:\Users\andre\Desktop\AI\tender-monitor\test\telegram.test.mjs`

**Interfaces:**
- Consumes: `companyForEdrpou`, `canUseAgent` з `commands.mjs` (Task 6).
- Produces: `winnerButtonRow(tenderId, supplierEdrpou, role) -> [{text, callback_data}] | null`.

- [ ] **Step 1: Написати падаючі тести**

```javascript
test('winner button appears only for our EDRPOU and privileged roles', () => {
  assert.deepEqual(
    winnerButtonRow('UA-1', '39376596', 'admin'),
    [{ text: '📄 Документи переможця', callback_data: 'agent:winner:UA-1' }],
  );
  assert.ok(winnerButtonRow('UA-1', '39376596', 'editor'));
  // чужий переможець — кнопки немає
  assert.equal(winnerButtonRow('UA-1', '12345678', 'admin'), null);
  // viewer не запускає агента
  assert.equal(winnerButtonRow('UA-1', '39376596', 'viewer'), null);
  // ЄДРПОУ не приїхав
  assert.equal(winnerButtonRow('UA-1', null, 'admin'), null);
});
```

- [ ] **Step 2: Запустити — має впасти**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/telegram.test.mjs`
Expected: FAIL — `winnerButtonRow is not defined`

- [ ] **Step 3: Реалізувати в `telegram.mjs`**

Додати імпорт (поруч із наявними імпортами з `commands.mjs`) і функцію:

```javascript
// Кнопка під «🏆 Учасника визнано переможцем» — лише коли переможець МИ і лише
// для тих, хто взагалі може запускати агента. Повертає готовий ряд кнопок або
// null, щоб виклик просто його не додавав.
export function winnerButtonRow(tenderId, supplierEdrpou, role) {
  if (!canUseAgent(role)) return null;
  if (!companyForEdrpou(supplierEdrpou)) return null;
  return [{ text: '📄 Документи переможця', callback_data: `agent:winner:${tenderId}` }];
}
```

- [ ] **Step 4: Запустити — має пройти**

Run: `node --test test/telegram.test.mjs`
Expected: PASS

- [ ] **Step 5: Під'єднати кнопку в `sendDigest`**

Знайти місце, де для події будується `reply_markup` (там уже вживається `agentTriggerButtonRow`), і додати поруч:

```javascript
      if (e.type === 'award_qualified') {
        const winRow = winnerButtonRow(e.tender_id ?? tenderId, e.supplier_edrpou, role);
        if (winRow) rows.push(winRow);
      }
```

- [ ] **Step 6: Тест на інтеграцію в дайджест**

```javascript
test('digest for award_qualified carries the winner button', async () => {
  const sent = [];
  await sendDigest({
    token: 'T', chatId: 1, role: 'admin',
    events: [{ type: 'award_qualified', tender_id: 'UA-1',
               supplier_name: 'ТОВ «ТЕРРАЛАБ АЙ ТІ»', supplier_edrpou: '39376596' }],
    _fetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; },
  });
  const flat = (sent[0].reply_markup?.inline_keyboard ?? []).flat();
  assert.ok(flat.some((b) => b.callback_data === 'agent:winner:UA-1'));
});
```

Підлаштуй виклик `sendDigest` під його фактичну сигнатуру в цьому файлі (подивись сусідній тест дайджесту й повтори його форму — параметри та спосіб підстановки `fetch` мають бути такі самі).

Run: `node --test test/telegram.test.mjs`
Expected: PASS

- [ ] **Step 7: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add telegram.mjs test/telegram.test.mjs
git commit -m "feat(bot): winner button under the award_qualified notification"
```

---

### Task 8: Обробка колбека `agent:winner` у Worker

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\worker\src\handler.mjs` (`handleAgentCallback`, гілка `confirm`)
- Test: `C:\Users\andre\Desktop\AI\tender-monitor\worker\test\handler.test.mjs`

**Interfaces:**
- Consumes: `buildAgentWinnerJob`, `buildAgentWinnerConfirmText`, `companyForEdrpou`, `buildAgentConfirmKeyboard`, `buildAgentCompanyKeyboard` (Task 6).
- Produces: колбек `agent:winner:<tid>` → екран підтвердження; `agent:confirm:<tid>` з `entry.kind === 'winner'` → запис job-а з аудитом `agent_winner`.

- [ ] **Step 1: Написати падаючий тест на постановку задачі**

```javascript
test('agent:winner queues a winner job carrying the prior target', async () => {
  const saved = [];
  const pending = { 555: { tid: 'UA-1', kind: 'winner', step: 'confirm', company: 'МАЙЛАБ' } };
  await handleCallback({
    ...baseDeps,                       // повтори форму сусіднього amend-тесту
    data: 'agent:confirm:UA-1',
    chatId: 555,
    role: 'editor',
    _loadAgentPending: async () => ({ pending, sha: 'S' }),
    _saveAgentPending: async () => {},
    _loadAgentJob: async () => ({
      company: 'МАЙЛАБ',
      result: { drive_link: 'https://d/1', package_dir: 'P', published_dir: 'PUB' },
    }),
    _saveAgentJob: async (env, job, opts) => { saved.push({ job, opts }); },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].job.job_type, 'winner');
  assert.equal(saved[0].job.company, 'МАЙЛАБ');
  assert.equal(saved[0].job.target.published_dir, 'PUB');
  assert.equal(saved[0].job.price, undefined);
  assert.ok(saved[0].opts.message.includes('agent_winner'));
});
```

- [ ] **Step 2: Запустити — має впасти**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test worker/test/handler.test.mjs`
Expected: FAIL — job не збережено (гілки `winner` ще немає).

- [ ] **Step 3: Додати гілку `winner` у `handleAgentCallback`**

Одразу після гілки `if (action === 'amend') { … }`:

```javascript
  if (action === 'winner') {
    let prior = null;
    try {
      prior = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent winner load job failed:', err.message);
      // Попереднього job-а може не бути взагалі (запуск зі сповіщення про
      // перемогу на тендері, який агент не готував) — це нормально, йдемо далі.
    }
    const company = prior?.company ?? null;
    if (!company) {
      // Компанію не знаємо — питаємо тим самим списком, що й prepare.
      try {
        const { pending, sha } = await _loadAgentPending(env);
        pending[chatId] = { tid, kind: 'winner', step: 'await_company', at: _now().toISOString() };
        await _saveAgentPending(env, pending, sha);
        await sendNew('Оберіть компанію-переможця:', buildAgentCompanyKeyboard(tid));
      } catch (err) {
        console.error('worker: agent winner company prompt failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      await ack();
      return;
    }
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, kind: 'winner', step: 'confirm', company, at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
      await sendNew(
        buildAgentWinnerConfirmText({ tenderId: tid, company }),
        buildAgentConfirmKeyboard(tid),
      );
    } catch (err) {
      console.error('worker: agent winner confirm prompt failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }
```

- [ ] **Step 4: Додати гілку `winner` у `confirm`**

У гілці `if (action === 'confirm')`, одразу перед `if (entry.kind === 'amend')`:

```javascript
    if (entry.kind === 'winner') {
      let prior = null;
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent winner confirm load job failed:', err.message);
      }
      const target = prior?.result
        ? {
            drive_link: prior.result.drive_link ?? null,
            package_dir: prior.result.package_dir ?? null,
            published_dir: prior.result.published_dir ?? null,
          }
        : null;
      const job = buildAgentWinnerJob({
        tenderId: tid,
        company: entry.company ?? prior?.company ?? null,
        target,
        requestedBy: String(chatId),
        createdAt: _now().toISOString(),
      });
      try {
        await _saveAgentJob(env, job, {
          message: formatAuditMessage({ action: 'agent_winner', target: tid, actor: actorName, chatId, role }),
        });
      } catch (err) {
        console.error('worker: saveAgentJob (winner) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await sendNew('✅ Документи переможця поставлено в чергу. Сповіщу, коли буде готово.');
      } catch (err) {
        console.error('worker: agent winner confirm reply failed:', err.message);
      }
      await notifyAdminAgentRun({
        env, isAdmin, adminChatId, _sendReply,
        kind: 'winner', actorName, chatId, tenderId: tid, company: job.company,
      });
      await ack('✅ В черзі');
      return;
    }
```

- [ ] **Step 5: Обробити вибір компанії для winner у гілці `co`**

У гілці `if (action === 'co')` замінити запис pending так, щоб для winner не питалась ціна:

```javascript
    let priorKind = null;
    try {
      const loaded = await _loadAgentPending(env);
      priorKind = loaded.pending?.[chatId]?.kind ?? null;
    } catch { /* нема стану — поводимось як prepare */ }

    if (priorKind === 'winner') {
      try {
        const { pending, sha } = await _loadAgentPending(env);
        pending[chatId] = { tid, kind: 'winner', company, step: 'confirm', at: _now().toISOString() };
        await _saveAgentPending(env, pending, sha);
        await sendNew(
          buildAgentWinnerConfirmText({ tenderId: tid, company }),
          buildAgentConfirmKeyboard(tid),
        );
      } catch (err) {
        console.error('worker: agent winner co save pending failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      await ack();
      return;
    }
```

(наявна prepare-гілка з `step: 'await_price'` лишається нижче без змін)

- [ ] **Step 6: Прогнати всі тести бота**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: PASS

- [ ] **Step 7: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(worker): agent:winner callback and confirm branch"
```

---

### Task 9: Синхронізація `CLAUDE.md` обох репозиторіїв

Правило проєкту: зміна контракту job-файлу з одного боку зобовʼязує оновити інший репозиторій і однойменний розділ у ОБОХ `CLAUDE.md`.

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\CLAUDE.md` (розділ «🔗 Повʼязаний інструмент та інтеграція»)
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\CLAUDE.md` (той самий розділ)

**Interfaces:**
- Consumes: фактичні поля з Task 5 (`result`) і Task 6 (job).
- Produces: документація, від якої залежить фіча `sign`.

- [ ] **Step 1: Оновити перелік типів задач в обох файлах**

У блоці «Два типи задач (за полем `job_type`)» замінити заголовок на «**Три типи задач**» і додати:

```markdown
- **`winner`** (`job_type:'winner'`) — документи переможця:
  `{ tender_id, link, job_type:'winner', company, target?:{drive_link, package_dir,
     published_dir}, requested_by, status:'pending', created_at }`
  (БЕЗ `price`; `target` відсутній, якщо агент цей тендер не готував)
  → агент `run_agent.run_winner(...)` заповнює проєкт договору й збирає документи
  переможця в `ТЕНДЕРИ 2026\<N>. <Замовник>\Документи переможця\`.
```

- [ ] **Step 2: Оновити опис статусів в обох файлах**

Дописати після наявного опису `done`:

```markdown
Для `winner` у `result` додаються `winner_dir`, `winner_link`, `n_docs`,
`contract_status`, `missing`, `expired`. **`drive_link`, `package_dir` і
`published_dir` winner НЕ переозначує** — переносить із попереднього результату,
бо саме за `drive_link` бот визначає готовність пропозиції.
```

- [ ] **Step 3: Оновити «Вхід у боті» і «Ключові місця» в обох файлах**

У «Вхід у боті» дописати: `📄 Документи переможця — кнопка під сповіщенням «🏆 Учасника визнано переможцем» (лише коли ЄДРПОУ переможця наш) і в «📊 Останні задачі».`

У «Ключові місця» дописати: бот — `OUR_EDRPOU`, `companyForEdrpou`, `buildAgentWinnerJob` (`commands.mjs`), `winnerButtonRow` (`telegram.mjs`); агент — `run_winner`, `build_winner_prompt` (`run_agent.py`), `is_winner` (`job_lib.py`), скіл `tender-winner-docs`.

- [ ] **Step 4: Звірити, що обидва файли описують контракт однаково**

Run:
```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor" && grep -c "winner" CLAUDE.md
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій" && grep -c "winner" CLAUDE.md
```
Expected: обидва > 0, і опис полів job-а й `result` збігається дослівно.

- [ ] **Step 5: Коміт в обох репозиторіях**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add CLAUDE.md && git commit -m "docs: winner job type in the integration contract"
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add CLAUDE.md && git commit -m "docs: winner job type in the integration contract"
```

---

### Task 10: Ручна перевірка на живому тендері

Автотести не покривають головного: чи справді агент знаходить вимоги ТД, чи не сходить із розуму на PDF-договорі, чи резолвиться посилання. Це перевіряється одним реальним прогоном перед мерджем у `main`.

**Files:** зміни не вносяться — тільки спостереження.

- [ ] **Step 1: Переконатися, що тека архіву розшарена на сервісний акаунт**

Тека `ТЕНДЕРИ 2026` має бути розшарена (Читач) на
`tender-poller@unified-canyon-500114-b5.iam.gserviceaccount.com`. Без цього
посилання не зарезолвиться і кнопки в повідомленні не буде.

- [ ] **Step 2: Прогнати всі тести обох репозиторіїв востаннє**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/*.test.mjs worker/test/*.test.mjs
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій" && py -m pytest tests/ -q
```
Expected: PASS в обох.

- [ ] **Step 3: Показати власнику результат і дочекатися рішення**

Прогін робиться на реальному виграному тендері. Власник перевіряє:
заповнений проєкт договору, склад теки, коректність блоків «Прострочене» і
«Відсутнє», роботу кнопки в Telegram. **Мердж у `main` — тільки після його «ок»**:
у бота push у `main` одразу тягне деплой Worker-а, а агент підхоплює `main` без CI.

---

## Self-Review

**Spec coverage:**

| Вимога спеки | Завдання |
|---|---|
| `OUR_EDRPOU` + кнопка під сповіщенням | Task 6, Task 7 |
| Пункт у меню «Останні задачі» | Task 6 |
| Крок підтвердження, вибір компанії коли невідома | Task 8 |
| Контракт job-а `winner`, без `price`, з `target` | Task 6, Task 8 |
| `winner_link` окремо від `drive_link` | Task 5 (агент), Task 6 (тест) |
| Створення/пошук теки замовника в `ТЕНДЕРИ 2026` | Task 5 |
| Підпапка `Документи переможця` | Task 5 |
| Розбір ТД, строки давності, три джерела | Task 4 (скіл) |
| Проєкт договору з `.docx` і з PDF | Task 4 (скіл) |
| Префікс `ПРОСТРОЧЕНЕ - ` | Task 4 (скіл) |
| Розширення резолвера `(id, url)` + `kind` | Task 1 |
| Повідомлення з інлайном звіту, іконки секцій | Task 5 |
| Аудит `agent_winner` + сповіщення адміну | Task 6, Task 8 |
| Обробка помилок (немає ТД, лінк не зарезолвився) | Task 5 |
| Синхронний `CLAUDE.md` | Task 9 |

**Placeholder scan:** порожніх кроків немає; кожен крок із кодом містить код. Два місця свідомо описані як «повтори форму сусіднього тесту» — у Task 7 Step 6 (сигнатура `sendDigest`) і Task 8 Step 1 (`baseDeps`): це наявні в репозиторії фікстури, копіювати їх сюди означало б дублювати чужий код, який може вже змінитись.

**Type consistency:** `winner_dir`/`winner_link` вживаються однаково в Task 3, 5, 9. `companyForEdrpou` — Task 6 (визначення), Task 7 і 8 (виклики). `resolve_item(name, parent_id, kind) -> (id, url)` — Task 1 (визначення), Task 5 (виклик, двокроковий спуск у підпапку). `run_winner(link, company, winner_dir)` — Task 3 (визначення), Task 5 (виклик), сигнатура збігається.
