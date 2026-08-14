# Підписання та архів (agent sign) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** За однією кнопкою в Telegram проставити дату в документах готової пропозиції, накласти скан підпису з печаткою, відрендерити PDF, зібрати ZIP у теці замовника й надіслати посилання на завантаження.

**Architecture:** Новий `job_type: 'sign'` на наявних рейках job-файлу. **Вся робота — детермінований Python, без запуску `claude -p`** (див. «Відхилення від спеки» нижче). Логіка docx-операцій живе в новому чистому модулі `scripts/sign_lib.py`, рендер — наявний `word_export.docx_to_pdf_batch` (справжній MS Word COM), оркестрація — гілка в `agent_poller.process_pending`.

**Tech Stack:** Node ESM у боті; Python 3.12 + `python-docx` + Word COM у агенті; `zipfile` зі стандартної бібліотеки.

**Спека:** `docs/superpowers/specs/2026-08-13-agent-sign-and-zip-design.md`

## ⚠️ Відхилення від затвердженої спеки — потребує рішення власника

Спека передбачає скіл `tender-proposal-sign` і запуск через `claude -p`, як у `prepare`/`amend`. **План свідомо цього не робить**, бо під час опрацювання стало видно: у цій задачі немає жодного кроку, що вимагає судження моделі. Копіювання файлів, заміна дати за регулярним виразом, вставка картинки в абзац, рендер Word-ом, `zipfile` — усе детерміноване.

Наслідки заміни LLM-прогону на звичайний код:

| | `claude -p` (спека) | Чистий Python (цей план) |
|---|---|---|
| Час виконання | ~10-40 хв | секунди + холодний старт Word |
| Повторюваність | не гарантована | побайтово однакова |
| Тестованість | лише ручна | юніт-тести на кожну функцію |
| Вартість | токени на кожен запуск | нуль |

Ризик: якщо в якомусь документі рядок підпису чи дата оформлені нетипово, код їх просто не знайде й чесно повідомить (`unsigned`), тоді як модель могла б здогадатися. Для цього в плані є `result.unsigned` і рядок у повідомленні — власник бачить, що лишилось без підпису.

**Якщо власник хоче саме варіант зі спеки** — Tasks 4-6 замінюються на скіл + `run_sign` за зразком `run_winner` із плану winner. Решта завдань не змінюється.

## Global Constraints

- **Передумова:** Task 1 плану `2026-08-13-agent-winner-docs.md` (`resolve_drive_item` з підтримкою `kind="file"`) має бути виконаний — без нього не буде прямого посилання на ZIP. Якщо winner ще не робився, виконай спершу те завдання.
- **Передумова від власника:** PNG підпису з печаткою в `G:\Мій диск\AI\Активи компаній\<Компанія>\Підпис і печатка\`. Без файлу задача коректно падає в `error` — це передбачено, але прогнати фічу до кінця без сканів неможливо.
- **Два репозиторії.** Бот: `C:\Users\andre\Desktop\AI\tender-monitor`. Агент: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій`. Гілка `feat/agent-sign-and-zip` в обох.
- **Бот деплоїться сам на push у `main`**; агент підхоплює `main` без CI. Мердж — лише після ручної перевірки власником.
- **Назви компаній — рівно як у `AGENT_COMPANIES`:** `МАЙЛАБ`, `ТЕРРАЛАБ АЙ ТІ`, `ТЕРРАЛАБ КОНСАЛТИНГ`, `ТЕРРАЛАБ СУПРОВІД`, `ТЕРРАЛАБ ПРО`.
- **Оригінальні `.docx` пакета не змінюються ніколи** — уся робота на копіях.
- **Тести бота:** `node --test test/*.test.mjs worker/test/*.test.mjs`. **Тести агента:** `py -m pytest tests/ -q`.
- **Формат дати всюди `ДД.ММ.РРРР`** (`13.08.2026`).
- Накладений скан — це вигляд документа, **не КЕП**. КЕП накладає власник у Prozorro.

---

## File Structure

**Агент** (`C:\Users\andre\Desktop\AI\Агент підготовки пропозицій`):
- `scripts/sign_lib.py` — Create: чисті docx-операції (заміна дати, пошук абзацу підпису, вставка картинки, збір ZIP).
- `scripts/agent_poller.py` — Modify: гілка `sign`, `_sign_keyboard`.
- `scripts/job_lib.py` — Modify: `is_sign`.
- `tests/test_sign_lib.py` — Create.
- `tests/test_agent_poller.py`, `tests/test_job_lib.py` — Modify.

**Бот** (`C:\Users\andre\Desktop\AI\tender-monitor`):
- `commands.mjs` — Modify: `validateLetterDate`, `buildAgentSignJob`, `buildAgentSignDateKeyboard`, `buildAgentSignConfirmText`, кнопка в `buildAgentJobsPage`, гілка в `buildAgentAdminNotice`.
- `worker/src/handler.mjs` — Modify: гілка `sign`, крок дати, гілка в `confirm` і в `handleAgentTextReply`.
- `test/commands.test.mjs`, `worker/test/handler.test.mjs` — Modify.

**Обидва репо:** `CLAUDE.md` — Modify синхронно.

---

### Task 1: `job_lib.is_sign`

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\job_lib.py`
- Test: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_job_lib.py`

**Interfaces:**
- Consumes: нічого.
- Produces: `job_lib.is_sign(job) -> bool`.

- [ ] **Step 1: Написати падаючий тест**

```python
def test_is_sign():
    assert jl.is_sign({"job_type": "sign"}) is True
    assert jl.is_sign({"job_type": "amend"}) is False
    assert jl.is_sign({}) is False
    assert jl.is_amend({"job_type": "sign"}) is False
```

- [ ] **Step 2: Запустити — має впасти**

Run: `py -m pytest tests/test_job_lib.py::test_is_sign -q`
Expected: FAIL — `module 'job_lib' has no attribute 'is_sign'`

- [ ] **Step 3: Реалізувати**

```python
def is_sign(job):
    """True if this job asks to date + sign the package and pack it into a ZIP."""
    return job.get("job_type") == "sign"
```

- [ ] **Step 4: Запустити — має пройти**

Run: `py -m pytest tests/test_job_lib.py -q`
Expected: PASS

- [ ] **Step 5: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git checkout -b feat/agent-sign-and-zip
git add scripts/job_lib.py tests/test_job_lib.py
git commit -m "feat(job): is_sign predicate"
```

---

### Task 2: Заміна дати листа — найризикованіша частина

У пакеті повно дат, які чіпати НЕ можна: дати договорів досвіду, дати актів, строки дії сертифікатів. Змінюється **лише дата самого листа**. Тому завдання окреме й починається з тестів на те, чого чіпати не можна.

**Files:**
- Create: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\sign_lib.py`
- Create: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_sign_lib.py`

**Interfaces:**
- Consumes: нічого.
- Produces:
  - `LETTER_DATE_RE` — скомпільований регекс дати `ДД.ММ.РРРР` (та варіанти з підкресленнями).
  - `replace_letter_date(paragraph_texts, new_date, scan_paragraphs=8) -> (list_of_new_texts, replaced_index_or_None)` — чиста функція над списком рядків.

> **Виправлено 14.08.2026 після реалізації.** Шипнутий `replace_letter_date` НЕ шукає
> «перший рядок, схожий на дату» — саме такий наївний підхід у попередній версії коду
> реально переписав «Протоколу Загальних зборів учасників №24/10/2024» на нову дату
> листа, тобто зробив документ, що йде замовнику, неправдивим. Натомість дата
> заміняється ТІЛЬКИ коли в тому самому блоці є якір «Вих[ідний]. №…» одразу перед
> нею (`_VYKH_RE` + `_FROM_DATE_RE`, дата саме після слова «від»). Крім того, шапка
> листа в наших шаблонах — це TABLE, а `doc.paragraphs` у python-docx текст із таблиць
> НЕ повертає взагалі; тому шиплено функція `_header_blocks` спершу сканує перший
> рядок(и) першої таблиці (`DEFAULT_SCAN_TABLES=1`, `DEFAULT_SCAN_TABLE_ROWS=2`) і лише
> потім абзаци як fallback — версія плану, яка дивилась тільки в `doc.paragraphs`,
> на реальному шаблоні не знайшла б дату НІКОЛИ. `LETTER_DATE_RE` як окремий
> публічний символ не існує — є `letter_date_in`/`_FROM_DATE_RE`/`_VYKH_RE`.

- [ ] **Step 1: Написати падаючі тести — спершу на те, що НЕ можна змінювати**

Створити `tests/test_sign_lib.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import sign_lib as sl


def test_replaces_the_letter_date_in_the_header_block():
    paras = [
        "ТОВ «МАЙЛАБ»",
        "вих. № 12 від 01.07.2026",
        "Довідка про досвід виконання аналогічного договору",
        "Договір №18/10-01 від 23.10.2023, акт від 15.12.2023",
    ]
    out, idx = sl.replace_letter_date(paras, "13.08.2026")
    assert idx == 1, idx
    assert out[1] == "вих. № 12 від 13.08.2026"
    # дати договору й акта — недоторкані
    assert out[3] == "Договір №18/10-01 від 23.10.2023, акт від 15.12.2023"


def test_does_not_touch_dates_below_the_scan_window():
    paras = ["шапка"] * 8 + ["Договір №1 від 05.05.2024"]
    out, idx = sl.replace_letter_date(paras, "13.08.2026", scan_paragraphs=8)
    assert idx is None
    assert out == paras


def test_replaces_only_the_first_date_found():
    paras = ["01.01.2026", "02.02.2026"]
    out, idx = sl.replace_letter_date(paras, "13.08.2026")
    assert idx == 0
    assert out[0] == "13.08.2026"
    assert out[1] == "02.02.2026"


def test_fills_a_blank_date_placeholder():
    paras = ["м. Хмельницький", "«___» ____________ 2026 р."]
    out, idx = sl.replace_letter_date(paras, "13.08.2026")
    assert idx == 1
    assert out[1] == "13.08.2026"


def test_returns_none_when_there_is_no_date_at_all():
    paras = ["Специфікація", "Позиція 1", "Позиція 2"]
    out, idx = sl.replace_letter_date(paras, "13.08.2026")
    assert idx is None
    assert out == paras
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `py -m pytest tests/test_sign_lib.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'sign_lib'`

- [ ] **Step 3: Реалізувати `replace_letter_date`**

Створити `scripts/sign_lib.py`:

```python
"""Pure helpers for dating and signing a finished proposal package.

Single responsibility: deterministic .docx surgery that is safe to unit-test —
find the letter's own date, find the signature paragraph, place the signature
image, and pack the finished PDFs. No Word COM here (that lives in
word_export.py) and no Claude — every decision in this module is mechanical.
"""

from __future__ import annotations

import re

# Дата листа: 13.08.2026 (крапки або слеші), або порожній бланк «___» ___ 2026 р.
_REAL_DATE = re.compile(r"\b(\d{2})[.\/](\d{2})[.\/](\d{4})\b")
_BLANK_DATE = re.compile(r"[«\"']?_{2,}[»\"']?\s*_{2,}\s*\d{4}\s*(?:р\.?|року)?")

# Скільки абзаців від початку документа вважати «шапкою». Дата листа завжди
# стоїть угорі; усе нижче — це вже тіло, де трапляються дати договорів і актів,
# які чіпати НЕ можна.
DEFAULT_SCAN_PARAGRAPHS = 8


def replace_letter_date(paragraph_texts, new_date, scan_paragraphs=DEFAULT_SCAN_PARAGRAPHS):
    """Replace ONLY the letter's own date in the header block.

    Returns ``(new_texts, replaced_index)``; ``replaced_index`` is None when no
    date was found in the scan window — the caller reports that, it is not an
    error (a specification table legitimately has no date).
    """
    texts = list(paragraph_texts or [])
    limit = min(len(texts), max(0, scan_paragraphs))
    for i in range(limit):
        t = texts[i]
        if not t:
            continue
        if _REAL_DATE.search(t):
            texts[i] = _REAL_DATE.sub(new_date, t, count=1)
            return texts, i
        if _BLANK_DATE.search(t):
            texts[i] = _BLANK_DATE.sub(new_date, t, count=1)
            return texts, i
    return texts, None
```

- [ ] **Step 4: Запустити — мають пройти**

Run: `py -m pytest tests/test_sign_lib.py -q`
Expected: PASS (5 тестів)

- [ ] **Step 5: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/sign_lib.py tests/test_sign_lib.py
git commit -m "feat(sign): replace only the letter's own date, never body dates"
```

---

### Task 3: Пошук абзацу підпису й накладання картинки

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\sign_lib.py`
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_sign_lib.py`

**Interfaces:**
- Consumes: нічого з Task 2 (незалежна функція в тому ж модулі).
- Produces:
  - `find_signature_index(paragraph_texts) -> int | None`
  - `signature_png_for(company, assets_root) -> str | None`
  - `stamp_docx(docx_path, out_path, new_date, png_path) -> dict` з ключами `dated` (bool), `signed` (bool), `old_date` (str|None), `new_date`.

> **Виправлено 14.08.2026 після реалізації.** `signature_png_for` шипнута геть інакше,
> ніж описано вище й нижче в кроках. План очікував ПІДТЕКУ на кожну компанію
> (`assets_root/<company>/Підпис і печатка/`) і повертав перший-ліпший PNG звідти.
> Реальна структура «Активи компаній» — ОДНА спільна тека на всі компанії,
> `Підписи з печатками\`, з нерегулярними назвами файлів («Ай Ті Парасина підпис та
> печатка.png»), тож шипнутий код шукає файл за КЛЮЧОВИМ СЛОВОМ компанії
> (`COMPANY_SIGNATURE_KEYWORDS`, ціле слово, не підрядок — «про» в «суПРОвід» інакше
> підставило б чужий підпис) і повертає `(path, detail)`, а не голий `str | None`:
> нуль збігів і кілька збігів — це РІЗНІ, окремо пояснені помилки (а не мовчазний
> `None`), бо підписати документ ЧУЖИМ підписом — найгірший можливий наслідок
> здогадки. Геометрія відбитка (крок 11 нижче й Task 10) теж не збіглася з фінальними
> числами — див. примітку в Task 5.

- [ ] **Step 1: Написати падаючі тести на пошук абзацу підпису**

```python
def test_finds_the_signature_paragraph():
    paras = ["Шапка", "Текст листа", "", "Директор                    Тетяна КОСИНСЬКА"]
    assert sl.find_signature_index(paras) == 3


def test_finds_signature_with_lowercase_and_extra_words():
    paras = ["текст", "В.о. директора ТОВ «МАЙЛАБ»            Тетяна КОСИНСЬКА"]
    assert sl.find_signature_index(paras) == 1


def test_returns_none_when_there_is_no_signature_line():
    paras = ["Специфікація", "Позиція 1", "Разом: 100 грн"]
    assert sl.find_signature_index(paras) is None


def test_picks_the_LAST_signature_line_when_several():
    # у двосторонніх формах буває блок підписів обох сторін
    paras = ["Директор Замовника ______", "текст", "Директор Учасника ______"]
    assert sl.find_signature_index(paras) == 2
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `py -m pytest tests/test_sign_lib.py -q -k signature`
Expected: FAIL — `module 'sign_lib' has no attribute 'find_signature_index'`

- [ ] **Step 3: Реалізувати пошук**

Додати в `scripts/sign_lib.py`:

```python
# Рядок підпису в наших бланках: «Директор …», «В.о. директора …».
_SIGNATURE_RE = re.compile(r"\b(директор[ауи]?|в\.?\s*о\.?\s+директора)\b", re.IGNORECASE)


def find_signature_index(paragraph_texts):
    """Index of the paragraph carrying the signature line, or None.

    Takes the LAST match: two-party forms list the customer's signature block
    first and ours last, and it is ours that gets stamped.
    """
    found = None
    for i, t in enumerate(paragraph_texts or []):
        if t and _SIGNATURE_RE.search(t):
            found = i
    return found
```

- [ ] **Step 4: Запустити — мають пройти**

Run: `py -m pytest tests/test_sign_lib.py -q -k signature`
Expected: PASS

- [ ] **Step 5: Написати падаючий тест на пошук PNG компанії**

```python
def test_signature_png_lookup(tmp_path):
    root = tmp_path / "Активи компаній"
    d = root / "МАЙЛАБ" / "Підпис і печатка"
    d.mkdir(parents=True)
    (d / "підпис.png").write_bytes(b"\x89PNG")
    assert sl.signature_png_for("МАЙЛАБ", str(root)) == str(d / "підпис.png")
    # немає теки — None, а не виняток
    assert sl.signature_png_for("ТЕРРАЛАБ ПРО", str(root)) is None
```

- [ ] **Step 6: Запустити — має впасти**

Run: `py -m pytest tests/test_sign_lib.py -q -k png_lookup`
Expected: FAIL — `module 'sign_lib' has no attribute 'signature_png_for'`

- [ ] **Step 7: Реалізувати пошук PNG**

```python
import os

SIGNATURE_SUBDIR = "Підпис і печатка"


def signature_png_for(company, assets_root):
    """Path to the company's signature+seal PNG, or None when absent."""
    d = os.path.join(assets_root, company, SIGNATURE_SUBDIR)
    if not os.path.isdir(d):
        return None
    for f in sorted(os.listdir(d)):
        if f.lower().endswith(".png"):
            return os.path.join(d, f)
    return None
```

- [ ] **Step 8: Запустити — має пройти**

Run: `py -m pytest tests/test_sign_lib.py -q -k png_lookup`
Expected: PASS

- [ ] **Step 9: Написати падаючий тест на `stamp_docx` (реальний .docx)**

```python
import docx   # python-docx


def _make_docx(path, paras):
    d = docx.Document()
    for p in paras:
        d.add_paragraph(p)
    d.save(str(path))


def test_stamp_docx_dates_and_signs(tmp_path):
    src = tmp_path / "лист.docx"
    out = tmp_path / "out" / "лист.docx"
    out.parent.mkdir()
    _make_docx(src, ["ТОВ «МАЙЛАБ»", "вих. № 5 від 01.07.2026",
                     "Текст", "Директор            Тетяна КОСИНСЬКА"])
    png = tmp_path / "sig.png"
    png.write_bytes(_ONE_PIXEL_PNG)          # мінімальний валідний PNG, див. нижче

    res = sl.stamp_docx(str(src), str(out), "13.08.2026", str(png))
    assert res["dated"] is True
    assert res["old_date"] == "01.07.2026"
    assert res["signed"] is True

    got = docx.Document(str(out))
    texts = [p.text for p in got.paragraphs]
    assert texts[1] == "вих. № 5 від 13.08.2026"
    # картинка лежить САМЕ в абзаці підпису
    assert got.paragraphs[3]._element.findall(
        ".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}anchor")
    # оригінал не змінено
    assert [p.text for p in docx.Document(str(src)).paragraphs][1] == "вих. № 5 від 01.07.2026"


def test_stamp_docx_reports_missing_signature_line(tmp_path):
    src = tmp_path / "спец.docx"
    out = tmp_path / "out2" / "спец.docx"
    out.parent.mkdir()
    _make_docx(src, ["Специфікація", "Позиція 1"])
    png = tmp_path / "sig.png"
    png.write_bytes(_ONE_PIXEL_PNG)

    res = sl.stamp_docx(str(src), str(out), "13.08.2026", str(png))
    assert res["signed"] is False
    assert res["dated"] is False
    assert os.path.isfile(str(out))          # файл усе одно скопійовано
```

Константу `_ONE_PIXEL_PNG` додати вгорі тестового файлу:

```python
import base64
_ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
```

- [ ] **Step 10: Запустити — мають впасти**

Run: `py -m pytest tests/test_sign_lib.py -q -k stamp_docx`
Expected: FAIL — `module 'sign_lib' has no attribute 'stamp_docx'`

- [ ] **Step 11: Реалізувати `stamp_docx`**

```python
import shutil

import docx
from docx.shared import Cm

# Розмір і зсув відбитка. Ці три числа — єдине, що доведеться крутити, якщо
# власник скаже «підпис лягає не туди»; решта логіки від них не залежить.
SIGNATURE_WIDTH_CM = 5.0
SIGNATURE_OFFSET_X_CM = 4.5     # від лівого краю абзацу підпису
SIGNATURE_OFFSET_Y_CM = -1.2    # вгору, щоб лягло НА рядок підпису


def _to_floating(inline, offset_x_cm, offset_y_cm):
    """Convert an inline picture into a floating one that overlaps the text.

    python-docx only knows how to add inline pictures; an inline picture would
    push the signature line down and reflow the page. Rewriting the element as
    <wp:anchor> keeps the layout byte-identical and lets the stamp sit ON the
    signature line, which is what a real signature looks like.
    """
    from docx.oxml.ns import qn
    from copy import deepcopy

    anchor = inline.makeelement(qn('wp:anchor'), {
        'distT': '0', 'distB': '0', 'distL': '0', 'distR': '0',
        'simplePos': '0', 'relativeHeight': '2', 'behindDoc': '0',
        'locked': '0', 'layoutInCell': '1', 'allowOverlap': '1',
    })
    for child in list(inline):
        anchor.append(deepcopy(child))

    simple_pos = anchor.makeelement(qn('wp:simplePos'), {'x': '0', 'y': '0'})
    pos_h = anchor.makeelement(qn('wp:positionH'), {'relativeFrom': 'column'})
    off_h = anchor.makeelement(qn('wp:posOffset'), {})
    off_h.text = str(int(Cm(offset_x_cm)))
    pos_h.append(off_h)
    pos_v = anchor.makeelement(qn('wp:positionV'), {'relativeFrom': 'paragraph'})
    off_v = anchor.makeelement(qn('wp:posOffset'), {})
    off_v.text = str(int(Cm(offset_y_cm)))
    pos_v.append(off_v)
    wrap = anchor.makeelement(qn('wp:wrapNone'), {})

    anchor.insert(0, wrap)
    anchor.insert(0, pos_v)
    anchor.insert(0, pos_h)
    anchor.insert(0, simple_pos)

    parent = inline.getparent()
    parent.replace(inline, anchor)


def stamp_docx(docx_path, out_path, new_date, png_path):
    """Copy a .docx, set the letter date and stamp the signature onto it.

    The ORIGINAL is never modified — everything happens on the copy at
    ``out_path``. Returns what actually happened so the caller can report it.
    """
    shutil.copyfile(docx_path, out_path)
    doc = docx.Document(out_path)

    texts = [p.text for p in doc.paragraphs]
    new_texts, date_idx = replace_letter_date(texts, new_date)
    old_date = None
    if date_idx is not None:
        old_date = texts[date_idx]
        para = doc.paragraphs[date_idx]
        # Пишемо в ПЕРШИЙ ран і чистимо решту — так шрифт/кегль абзацу
        # зберігаються, а текст стає новим.
        if para.runs:
            para.runs[0].text = new_texts[date_idx]
            for r in para.runs[1:]:
                r.text = ""
        else:
            para.text = new_texts[date_idx]

    sig_idx = find_signature_index(texts)
    signed = False
    if sig_idx is not None and png_path and os.path.isfile(png_path):
        run = doc.paragraphs[sig_idx].add_run()
        run.add_picture(png_path, width=Cm(SIGNATURE_WIDTH_CM))
        from docx.oxml.ns import qn
        inline = doc.paragraphs[sig_idx]._element.findall('.//' + qn('wp:inline'))[-1]
        _to_floating(inline, SIGNATURE_OFFSET_X_CM, SIGNATURE_OFFSET_Y_CM)
        signed = True

    doc.save(out_path)
    return {"dated": date_idx is not None, "old_date": old_date,
            "new_date": new_date, "signed": signed}
```

- [ ] **Step 12: Запустити всі тести модуля**

Run: `py -m pytest tests/test_sign_lib.py -q`
Expected: PASS

- [ ] **Step 13: Переконатися, що `python-docx` є в оточенні**

Run: `py -c "import docx; print(docx.__version__ if hasattr(docx,'__version__') else 'ok')"`
Expected: без помилки. Якщо модуля немає: `py -m pip install python-docx`.

- [ ] **Step 14: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/sign_lib.py tests/test_sign_lib.py
git commit -m "feat(sign): stamp signature as a floating picture without reflowing the page"
```

---

### Task 4: Збір ZIP

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\sign_lib.py`
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_sign_lib.py`

**Interfaces:**
- Consumes: нічого.
- Produces:
  - `zip_name(short_entity, letter_date) -> str`
  - `pack_zip(pdf_paths, zip_path) -> int` — кількість покладених файлів.

- [ ] **Step 1: Написати падаючі тести**

```python
import zipfile


def test_zip_name_is_built_from_customer_and_date():
    assert sl.zip_name("КНП Одеської МР Міська клінічна лікарня №1", "13.08.2026") \
        == "КНП Одеської МР Міська клінічна лікарня №1 ТП 13.08.2026.zip"


def test_pack_zip_is_flat(tmp_path):
    src = tmp_path / "sub"
    src.mkdir()
    a, b = src / "01. Лист.pdf", src / "02. Довідка.pdf"
    a.write_bytes(b"A"); b.write_bytes(b"B")
    zp = tmp_path / "out.zip"

    n = sl.pack_zip([str(a), str(b)], str(zp))
    assert n == 2
    with zipfile.ZipFile(str(zp)) as z:
        names = z.namelist()
    # плоско: без підпапок усередині архіву
    assert sorted(names) == ["01. Лист.pdf", "02. Довідка.pdf"], names


def test_pack_zip_skips_missing_files(tmp_path):
    a = tmp_path / "є.pdf"
    a.write_bytes(b"A")
    zp = tmp_path / "out2.zip"
    n = sl.pack_zip([str(a), str(tmp_path / "нема.pdf")], str(zp))
    assert n == 1
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `py -m pytest tests/test_sign_lib.py -q -k zip`
Expected: FAIL — `module 'sign_lib' has no attribute 'zip_name'`

- [ ] **Step 3: Реалізувати**

```python
import zipfile


def zip_name(short_entity, letter_date):
    """«КНП … ТП 13.08.2026.zip» — так відділ упізнає архів для подачі."""
    return "%s ТП %s.zip" % (short_entity, letter_date)


def pack_zip(pdf_paths, zip_path):
    """Pack the given PDFs FLAT (basename only) and return how many went in.

    Missing files are skipped rather than raising: the caller has already
    reported what could not be rendered, and a half-built archive beats none.
    """
    n = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in pdf_paths or []:
            if os.path.isfile(p):
                z.write(p, os.path.basename(p))
                n += 1
    return n
```

- [ ] **Step 4: Запустити всі тести модуля**

Run: `py -m pytest tests/test_sign_lib.py -q`
Expected: PASS

- [ ] **Step 5: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/sign_lib.py tests/test_sign_lib.py
git commit -m "feat(sign): flat zip packing with a department-friendly name"
```

---

### Task 5: Оркестрація `sign_package`

Зводить Tasks 2-4 разом: копії → дати й підписи → PDF одним заходом Word → `Підписані PDF\` → ZIP.

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\sign_lib.py`
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_sign_lib.py`

**Interfaces:**
- Consumes: `stamp_docx`, `signature_png_for`, `zip_name`, `pack_zip` (Tasks 2-4); `word_export.docx_to_pdf_batch`.
- Produces: `sign_package(package_dir, out_dir, company, letter_date, short_entity, assets_root, render=None) -> dict` із ключами `status`, `zip_path`, `signed_dir`, `n_signed`, `n_pdf_total`, `unsigned`, `dates`, `detail`.

> **Виправлено 14.08.2026 після реалізації.** Три речі відрізняються від плану:
> (1) `result` шипнутого `sign_package` має ще й ключ `undated` — список docx, де НЕ
> знайшлось поля «Вих. № … від …» (окремо від `unsigned`, бо один документ може бути
> без дати, але з підписом, і навпаки); (2) `_package_files`/`pack_zip` пропускають
> `job_lib.is_junk_file` (`desktop.ini`, `Thumbs.db`, `.DS_Store`…) — Google Drive
> Desktop кладе їх у кожну синхронізовану теку сам, і без фільтра вони поїхали б у ZIP
> замовнику; (3) геометрія відбитка НЕ ті три хардкод-числа з кроку 11 нижче
> (`WIDTH=5.0`, `OFFSET_X=4.5`, `OFFSET_Y=-1.2`) — фінальні, ЗАТВЕРДЖЕНІ власником
> 14.08.2026 на реальному листі значення: `SIGNATURE_WIDTH_CM=6.5`,
> `SIGNATURE_OFFSET_X_CM=7.0` (обидва — константи), а вертикальний зсув
> ВИВОДИТЬСЯ з пропорцій конкретного PNG-скана (`signature_offset_y_cm`), а не є
> третьою константою — Task 10 передбачав підбір «на око», а не формулу.

- [ ] **Step 1: Написати падаючі тести**

```python
def test_sign_package_end_to_end(tmp_path):
    pkg = tmp_path / "роб" / "Тендерна пропозиція"
    pkg.mkdir(parents=True)
    _make_docx(pkg / "01. Лист.docx",
               ["ТОВ «МАЙЛАБ»", "від 01.07.2026", "Директор   Тетяна КОСИНСЬКА"])
    _make_docx(pkg / "02. Специфікація.docx", ["Специфікація", "Позиція 1"])
    (pkg / "03. Статут.pdf").write_bytes(b"%PDF-1.4 постійний скан")

    assets = tmp_path / "Активи компаній"
    sig = assets / "МАЙЛАБ" / "Підпис і печатка"
    sig.mkdir(parents=True)
    (sig / "s.png").write_bytes(_ONE_PIXEL_PNG)

    out = tmp_path / "ТЕНДЕРИ 2026" / "80. КНП Х"
    out.mkdir(parents=True)

    rendered = []
    def fake_render(pairs):                       # замість Word COM
        for src, dst in pairs:
            open(dst, "wb").write(b"%PDF rendered")
            rendered.append(os.path.basename(dst))

    res = sl.sign_package(str(pkg), str(out), "МАЙЛАБ", "13.08.2026",
                          "КНП Х", str(assets), render=fake_render)

    assert res["status"] == "ok", res
    assert res["n_signed"] == 1                   # підписався лише лист
    assert res["unsigned"] == ["02. Специфікація.docx"]
    assert res["n_pdf_total"] == 3                # 2 відрендерені + 1 постійний
    assert os.path.isfile(res["zip_path"])
    assert res["zip_path"].endswith("КНП Х ТП 13.08.2026.zip")
    with zipfile.ZipFile(res["zip_path"]) as z:
        assert len(z.namelist()) == 3
    # оригінали пакета не змінені
    assert sorted(os.listdir(str(pkg))) == ["01. Лист.docx", "02. Специфікація.docx", "03. Статут.pdf"]


def test_sign_package_errors_without_signature_scan(tmp_path):
    pkg = tmp_path / "Тендерна пропозиція"
    pkg.mkdir()
    _make_docx(pkg / "01. Лист.docx", ["Директор   Іван"])
    out = tmp_path / "вих"
    out.mkdir()

    res = sl.sign_package(str(pkg), str(out), "МАЙЛАБ", "13.08.2026", "КНП Х",
                          str(tmp_path / "порожньо"), render=lambda pairs: None)
    assert res["status"] == "error"
    assert "скан" in res["detail"].lower()
    assert not os.listdir(str(out))                # нічого не створено
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `py -m pytest tests/test_sign_lib.py -q -k sign_package`
Expected: FAIL — `module 'sign_lib' has no attribute 'sign_package'`

- [ ] **Step 3: Реалізувати**

```python
SIGNED_SUBDIR = "Підписані PDF"


def sign_package(package_dir, out_dir, company, letter_date, short_entity,
                 assets_root, render=None):
    """Date + sign every .docx of a finished package, render, collect, zip.

    ``render(pairs)`` takes [(docx, pdf), ...] and is injectable so tests do not
    need Word; production passes word_export.docx_to_pdf_batch.
    Returns a result dict; ``status`` is 'ok' or 'error' (+ ``detail``).
    """
    png = signature_png_for(company, assets_root)
    if not png:
        return {"status": "error",
                "detail": "немає скана підпису для «%s» — поклади PNG у «%s/%s»"
                          % (company, company, SIGNATURE_SUBDIR)}

    if render is None:
        from word_export import docx_to_pdf_batch as render   # noqa: N813

    names = sorted(os.listdir(package_dir))
    docxs = [n for n in names if n.lower().endswith(".docx") and not n.startswith("~$")]
    static_pdfs = [n for n in names if n.lower().endswith(".pdf")]

    work = os.path.join(out_dir, "_work_sign")
    signed_dir = os.path.join(out_dir, SIGNED_SUBDIR)
    # Повторний запуск повністю замінює попередній результат, щоб у теці не
    # лишилося двох версій з різними датами.
    for d in (work, signed_dir):
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d)

    unsigned, dates, pairs = [], {}, []
    for n in docxs:
        stamped = os.path.join(work, n)
        info = stamp_docx(os.path.join(package_dir, n), stamped, letter_date, png)
        if not info["signed"]:
            unsigned.append(n)
        if info["dated"]:
            dates[n] = (info["old_date"], letter_date)
        pairs.append((stamped, os.path.join(signed_dir, n[:-5] + ".pdf")))

    render(pairs)

    for n in static_pdfs:
        shutil.copyfile(os.path.join(package_dir, n), os.path.join(signed_dir, n))

    pdfs = sorted(os.path.join(signed_dir, f) for f in os.listdir(signed_dir)
                  if f.lower().endswith(".pdf"))
    zip_path = os.path.join(out_dir, zip_name(short_entity, letter_date))
    n_zipped = pack_zip(pdfs, zip_path)
    shutil.rmtree(work, ignore_errors=True)

    return {"status": "ok", "zip_path": zip_path, "signed_dir": signed_dir,
            "n_signed": len(docxs) - len(unsigned), "n_pdf_total": n_zipped,
            "unsigned": unsigned, "dates": dates, "detail": ""}
```

- [ ] **Step 4: Запустити всі тести модуля**

Run: `py -m pytest tests/test_sign_lib.py -q`
Expected: PASS

- [ ] **Step 5: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/sign_lib.py tests/test_sign_lib.py
git commit -m "feat(sign): sign_package orchestration, originals untouched"
```

---

### Task 6: Гілка `sign` у поллері

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\agent_poller.py`
- Test: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_agent_poller.py`

**Interfaces:**
- Consumes: `job_lib.is_sign` (Task 1), `sign_lib.sign_package` (Task 5), `resolve_drive_item`/`make_resolve_drive_item` (Task 1 плану winner).
- Produces: `_sign_keyboard(zip_url, folder_url) -> dict | None`; гілка в `process_pending` з новим інжектованим параметром `sign_package=None`.

> **Виправлено 14.08.2026 після реалізації — найбільша розбіжність у цьому плані.**
> Псевдокод кроку 7 нижче викликає `sign_package(package_dir, out_dir, ...)` де
> `out_dir` — тека замовника ПРЯМО В АРХІВІ ВІДДІЛУ (`cfg.publish_root/<folder>`), тобто
> план дає моделі право писати прямо в «ТЕНДЕРИ 2026». Шипнутий код цього НІКОЛИ не
> робить: `sign_package` пише у ВЛАСНУ робочу теку агента —
> `<drive_root>\...\Підписаний пакет\` (`SIGN_STAGING_SUBDIR`), і лише ОКРЕМИЙ крок
> ПІСЛЯ успіху (новий `make_publish_signed`, якого в плані немає взагалі) копіює готове
> у `publish_root`: ZIP плоско в теку замовника, PDF — у підтеку `Підписані PDF\`. Той
> самий поділ «стейджинг агента / публікація поллера», що й для `winner` — свідома
> вимога власника (13.08.2026): дозволити моделі шаблонний доступ до `ТЕНДЕРИ 2026`
> означало б дати їй право правити будь-який із ~80 давно завершених тендерів.
> Також гілка `is_sign` у шипнутому `process_pending` значно повніша за псевдокод
> нижче: `sign_package=None` дає `error`, а не тихий `return name`; OSError (Drive не
> змонтовано) і будь-яка інша помилка Word COM ловляться ОКРЕМО й обидві прибирають
> порожні теки, які встигли створитись (`_prune_if_empty`); `_sign_failed` завжди
> переносить `drive_link`/`package_dir`/`published_dir` з `target` у результат
> помилки — без цього невдале підписання стирало б кнопки готової пропозиції
> (`buildAgentJobsPage` гейтить рядок на `result.drive_link`); відсутність
> `letter_date` — окрема рання помилка, бо `None` поїхав би в назву кожного файлу й
> архіву. `_sign_keyboard` і базова структура гілки — як у плані.

- [ ] **Step 1: Написати падаючі тести на клавіатуру**

```python
def test_sign_keyboard_shows_both_buttons():
    kb = ap._sign_keyboard("https://d/zip", "https://d/folder")
    flat = [b for row in kb["inline_keyboard"] for b in row]
    assert [b["url"] for b in flat] == ["https://d/zip", "https://d/folder"]


def test_sign_keyboard_drops_missing_links():
    kb = ap._sign_keyboard(None, "https://d/folder")
    flat = [b for row in kb["inline_keyboard"] for b in row]
    assert len(flat) == 1 and flat[0]["url"] == "https://d/folder"
    assert ap._sign_keyboard(None, None) is None
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `py -m pytest tests/test_agent_poller.py -q -k sign_keyboard`
Expected: FAIL — `module 'agent_poller' has no attribute '_sign_keyboard'`

- [ ] **Step 3: Реалізувати клавіатуру**

Поруч із `_done_keyboard` у `scripts/agent_poller.py`:

```python
def _sign_keyboard(zip_url, folder_url):
    """Two buttons: download the archive, or open the folder to eyeball the PDFs.

    A link that failed to resolve simply loses its button (the poller writes the
    path into the message text instead). No links at all -> no keyboard.
    """
    row = []
    if zip_url:
        row.append({"text": "⬇️ Завантажити архів", "url": zip_url})
    if folder_url:
        row.append({"text": "📁 Відкрити в Drive", "url": folder_url})
    return {"inline_keyboard": [row]} if row else None
```

- [ ] **Step 4: Запустити — мають пройти**

Run: `py -m pytest tests/test_agent_poller.py -q -k sign_keyboard`
Expected: PASS

- [ ] **Step 5: Написати падаючий тест на гілку `sign`**

```python
def test_process_pending_sign_branch(tmp_path):
    pkg = tmp_path / "роб" / "Тендерна пропозиція"
    pkg.mkdir(parents=True)
    pub = tmp_path / "ТЕНДЕРИ 2026" / "80. КНП Х"
    pub.mkdir(parents=True)

    job = {
        "tender_id": "UA-1",
        "link": "https://prozorro.gov.ua/tender/UA-1",
        "job_type": "sign",
        "company": "МАЙЛАБ",
        "letter_date": "13.08.2026",
        "target": {"drive_link": "https://drive/PROPOSAL", "package_dir": str(pkg)},
        "requested_by": "555",
        "status": "pending",
    }
    saved, sent = {}, []

    def fake_sign_package(package_dir, out_dir, company, letter_date, short_entity,
                          assets_root, render=None):
        return {"status": "ok", "zip_path": os.path.join(out_dir, "a.zip"),
                "signed_dir": os.path.join(out_dir, "Підписані PDF"),
                "n_signed": 12, "n_pdf_total": 19,
                "unsigned": ["05. Специфікація.docx"], "dates": {}, "detail": ""}

    ap.process_pending(
        _cfg(tmp_path),
        list_jobs=lambda: [("UA-1.json", job)],
        set_status=lambda name, j: saved.update({name: j}),
        run_agent=lambda *a, **k: pytest.fail("prepare must not run"),
        send_telegram=lambda chat, text, reply_markup=None: sent.append((chat, text, reply_markup)),
        entity_name=lambda link: "КНП «Х»",
        today=datetime.date(2026, 8, 13),
        sign_package=fake_sign_package,
        resolve_item=lambda name, parent_id=None, kind="folder": ("ID", "https://d/%s" % kind),
    )

    out = saved["UA-1.json"]
    assert out["status"] == "done", out
    assert out["result"]["n_signed"] == 12
    assert out["result"]["letter_date"] == "13.08.2026"
    # посилання на пропозицію не затерте
    assert out["result"]["drive_link"] == "https://drive/PROPOSAL"
    chat, text, kb = sent[0]
    assert chat == "555"
    assert "05. Специфікація" in text          # непідписане видно власнику
    assert kb is not None


def test_process_pending_sign_error_reports_detail(tmp_path):
    pkg = tmp_path / "Тендерна пропозиція"; pkg.mkdir()
    job = {"tender_id": "UA-2", "link": "https://prozorro.gov.ua/tender/UA-2",
           "job_type": "sign", "company": "МАЙЛАБ", "letter_date": "13.08.2026",
           "target": {"package_dir": str(pkg)}, "requested_by": "555", "status": "pending"}
    saved, sent = {}, []
    ap.process_pending(
        _cfg(tmp_path),
        list_jobs=lambda: [("UA-2.json", job)],
        set_status=lambda name, j: saved.update({name: j}),
        run_agent=lambda *a, **k: None,
        send_telegram=lambda chat, text, reply_markup=None: sent.append(text),
        entity_name=lambda link: "КНП «Х»",
        today=datetime.date(2026, 8, 13),
        sign_package=lambda *a, **k: {"status": "error", "detail": "немає скана підпису"},
    )
    assert saved["UA-2.json"]["status"] == "error"
    assert "скана підпису" in sent[0]
```

- [ ] **Step 6: Запустити — мають впасти**

Run: `py -m pytest tests/test_agent_poller.py -q -k process_pending_sign`
Expected: FAIL — `process_pending() got an unexpected keyword argument 'sign_package'`

- [ ] **Step 7: Додати гілку в `process_pending`**

У сигнатуру додати `sign_package=None`. Після гілки `is_winner` (або після `is_amend`, якщо winner ще не робився) вставити:

```python
    if job_lib.is_sign(job):
        if sign_package is None:
            return name
        target = job.get("target") or {}
        package_dir = target.get("package_dir")
        if not package_dir or not os.path.isdir(package_dir):
            set_status(name, job_lib.mark(
                job, "error", detail="немає теки пакета — підписувати нічого", at=at))
            send_telegram(job.get("requested_by") or cfg.admin_chat_id,
                          "⚠️ Підписання не вдалось: немає теки пакета")
            return name

        full = entity_name(job["link"])
        short = job_lib.short_entity_name(full)
        pub_root = cfg.publish_root
        os.makedirs(pub_root, exist_ok=True)
        names = [n for n in os.listdir(pub_root)
                 if os.path.isdir(os.path.join(pub_root, n))]
        folder = (job_lib.find_published_folder(names, short)
                  or job_lib.publish_folder_name(
                      job_lib.next_folder_number(names), short))
        out_dir = os.path.join(pub_root, folder)
        os.makedirs(out_dir, exist_ok=True)

        set_status(name, job_lib.mark(job, "running", at=at))
        result = sign_package(package_dir, out_dir, job["company"],
                              job["letter_date"], short, cfg.assets_root)

        recipient = job.get("requested_by") or cfg.admin_chat_id
        if result.get("status") == "ok":
            zip_url = folder_url = None
            if resolve_item:
                try:
                    fid, folder_url = resolve_item(folder, cfg.publish_parent_id, "folder")
                    if fid:
                        _zid, zip_url = resolve_item(
                            os.path.basename(result["zip_path"]), fid, "file")
                except Exception as e:                      # noqa: BLE001
                    print("worker: sign link resolve failed:", e)
            lines = ["<b>🖊 Пропозицію підписано й запаковано</b>", ""]
            lines.append("📋 %s · %s" % (html.escape(job.get("tender_id", "")),
                                         html.escape(job_lib.abbrev_entity_name(full))))
            lines.append("🏢 %s · дата %s" % (html.escape(job["company"]),
                                              html.escape(job["letter_date"])))
            lines.append("")
            lines.append("✅ Підписано документів: %s" % result.get("n_signed"))
            lines.append("✅ У архіві PDF: %s" % result.get("n_pdf_total"))
            if result.get("unsigned"):
                lines.append("")
                lines.append("⚠️ Без підпису (немає рядка підпису):")
                for u in result["unsigned"]:
                    lines.append(" • %s" % html.escape(u))
            if not zip_url:
                lines.extend(["", "📦 %s" % html.escape(result["zip_path"])])
            send_telegram(recipient, "\n".join(lines),
                          reply_markup=_sign_keyboard(zip_url, folder_url))
            set_status(name, job_lib.mark(
                job, "done",
                zip_path=result["zip_path"], zip_link=zip_url,
                signed_dir=result["signed_dir"],
                letter_date=job["letter_date"],
                n_signed=result.get("n_signed"),
                n_pdf_total=result.get("n_pdf_total"),
                unsigned=result.get("unsigned"),
                drive_link=target.get("drive_link"),
                package_dir=package_dir,
                at=at,
            ))
        else:
            detail = result.get("detail") or "невідома помилка"
            send_telegram(recipient, "⚠️ Підписання не вдалось: %s" % html.escape(detail),
                          reply_markup=_retry_keyboard(job.get("tender_id", "")))
            set_status(name, job_lib.mark(job, "error", detail=detail, at=at))
        return name
```

- [ ] **Step 8: Додати `assets_root` у `Config` і під'єднати залежності в `main`**

У датаклас `Config` (рядки ~48-57) додати поле:

```python
    assets_root: str = r"G:\Мій диск\AI\Активи компаній"
```

У `main()` дописати у виклик `process_pending`:

```python
        sign_package=sign_lib.sign_package,
```

і імпорт `import sign_lib` поруч із наявними імпортами модулів `scripts/`.

- [ ] **Step 9: Прогнати всі тести агента**

Run: `py -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 10: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/agent_poller.py tests/test_agent_poller.py
git commit -m "feat(poller): sign job branch with zip + folder buttons"
```

---

### Task 7: Бот — валідація дати, job-білдер, кнопка

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\commands.mjs`
- Test: `C:\Users\andre\Desktop\AI\tender-monitor\test\commands.test.mjs`

**Interfaces:**
- Consumes: нічого (інший репозиторій).
- Produces:
  - `validateLetterDate(text, today) -> string | null`
  - `buildAgentSignJob({ tenderId, company, letterDate, target, requestedBy, createdAt }) -> object`
  - `buildAgentSignDateKeyboard(tenderId, todayStr) -> object`
  - `buildAgentSignConfirmText({ tenderId, company, letterDate }) -> string`

> **Виправлено 14.08.2026 після реалізації.** Три відхилення від коду кроку 3 нижче:
> (1) `validateLetterDate` шипнута з ДВОМА додатковими перевірками, яких немає в
> псевдокоді — `isNaN(d)` і `d.getUTCFullYear() !== Number(yyyy)` — без другої
> `31.02.2026` міг би непомітно пройти через нормалізацію `Date`; (2) `formatLetterDate`
> НЕ форматує UTC-компоненти переданої дати вручну — використовує
> `Intl.DateTimeFormat` із зафіксованим `timeZone: 'Europe/Kyiv'`, бо власник ставить
> задачі пізно ввечері, коли в Києві вже наступна доба, і кнопка «Сьогодні» з UTC-датою
> підписала б пакет заднім числом; (3) кнопка `🖊 Підписати й запакувати` в
> `buildAgentJobsPage` (крок нижче) несе в тексті СВІЙ `tender_id`
> (`` `🖊 Підписати й запакувати ${j.tender_id}` ``), а не статичний підпис із плану —
> на сторінці до шести задач одразу, і без ідентифікатора в підписі помилковий дотик
> мовчки підписав би ЧУЖИЙ пакет (той самий урок, що вже застосований до кнопки
> `📄 Документи переможця`).

- [ ] **Step 1: Написати падаючі тести**

```javascript
test('validateLetterDate accepts a sane ДД.ММ.РРРР and rejects the rest', () => {
  const today = new Date('2026-08-13T09:00:00Z');
  assert.equal(validateLetterDate('13.08.2026', today), '13.08.2026');
  assert.equal(validateLetterDate('  01.08.2026 ', today), '01.08.2026');
  assert.equal(validateLetterDate('32.08.2026', today), null);   // немає такого дня
  assert.equal(validateLetterDate('13/08/2026', today), null);   // не той роздільник
  assert.equal(validateLetterDate('13.08.2126', today), null);   // одрук у році
  assert.equal(validateLetterDate('01.01.2026', today), null);   // >30 днів у минулому
  assert.equal(validateLetterDate('31.12.2026', today), null);   // >30 днів у майбутньому
  assert.equal(validateLetterDate('', today), null);
  assert.equal(validateLetterDate(null, today), null);
});

test('buildAgentSignJob carries the date and the package dir', () => {
  const job = buildAgentSignJob({
    tenderId: 'UA-1', company: 'МАЙЛАБ', letterDate: '13.08.2026',
    target: { drive_link: 'https://d/1', package_dir: 'P' },
    requestedBy: '555', createdAt: '2026-08-13T10:00:00.000Z',
  });
  assert.equal(job.job_type, 'sign');
  assert.equal(job.letter_date, '13.08.2026');
  assert.equal(job.target.package_dir, 'P');
  assert.equal(job.price, undefined);
  assert.equal(job.status, 'pending');
});

test('jobs page offers the sign button on a done proposal', () => {
  const view = buildAgentJobsPage({
    jobs: [{ tender_id: 'UA-1', status: 'done', result: { drive_link: 'https://d/1' } }],
  });
  const flat = view.keyboard.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === 'agent:sign:UA-1'));
});

test('sign date keyboard offers today and a manual entry', () => {
  const kb = buildAgentSignDateKeyboard('UA-1', '13.08.2026');
  const flat = kb.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === 'agent:signdate:UA-1:13.08.2026'));
  assert.ok(flat.some((b) => b.callback_data === 'agent:signother:UA-1'));
  assert.ok(flat.some((b) => b.callback_data === 'agent:cancel:UA-1'));
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/commands.test.mjs`
Expected: FAIL — `validateLetterDate is not defined`

- [ ] **Step 3: Реалізувати в `commands.mjs`**

Після `buildAgentWinnerJob` (або після `buildAgentAmendJob`, якщо winner ще не робився):

```javascript
// Дата листа для підписання. Формат рівно ДД.ММ.РРРР; вікно ±30 днів ловить
// одруки в році («2126»), які інакше поїхали б у кожен документ пакета.
const LETTER_DATE_WINDOW_DAYS = 30;

export function validateLetterDate(text, today = new Date()) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  // відсіює 31.02 та інші неіснуючі дати — Date їх «нормалізує»
  if (d.getUTCDate() !== Number(dd) || d.getUTCMonth() !== Number(mm) - 1) return null;
  const diffDays = Math.abs((d - today) / 86400000);
  if (diffDays > LETTER_DATE_WINDOW_DAYS) return null;
  return `${dd}.${mm}.${yyyy}`;
}

export function formatLetterDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getUTCDate())}.${p(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

export function buildAgentSignDateKeyboard(tenderId, todayStr) {
  return {
    inline_keyboard: [
      [{ text: `📅 Сьогодні — ${todayStr}`, callback_data: `agent:signdate:${tenderId}:${todayStr}` }],
      [{ text: '✏️ Ввести іншу', callback_data: `agent:signother:${tenderId}` }],
      [{ text: '✖ Скасувати', callback_data: `agent:cancel:${tenderId}` }],
    ],
  };
}

export function buildAgentSignConfirmText({ tenderId, company, letterDate }) {
  return `🖊 Підписати й запакувати\nТендер: ${escapeHtml(tenderId)}\nКомпанія: ${escapeHtml(company)}\nДата: ${escapeHtml(letterDate)}`;
}

// Sign job: date + stamp the finished package, render PDFs, pack a ZIP.
// No `price`. `target.package_dir` is REQUIRED — that is what gets signed.
export function buildAgentSignJob({ tenderId, company, letterDate, target, requestedBy, createdAt }) {
  return {
    tender_id: tenderId,
    link: `https://prozorro.gov.ua/tender/${tenderId}`,
    job_type: 'sign',
    company,
    letter_date: letterDate,
    target,
    requested_by: requestedBy,
    status: 'pending',
    created_at: createdAt,
  };
}
```

У `buildAgentJobsPage` розширити ряд кнопок готової пропозиції:

```javascript
      rows.push([
        { text: '🖊 Підписати й запакувати', callback_data: `agent:sign:${j.tender_id}` },
      ]);
```

і додати маркер `🖊 ` для `j.job_type === 'sign'` у тому ж тернарнику, де вже є `amend` і `winner`.

- [ ] **Step 4: Запустити — мають пройти**

Run: `node --test test/commands.test.mjs`
Expected: PASS

- [ ] **Step 5: Додати гілку в `buildAgentAdminNotice` + тест**

```javascript
  if (kind === 'sign') {
    return `🤖 ${who} запустив підписання по ${escapeHtml(tenderId)}`;
  }
```

```javascript
test('admin notice mentions sign runs', () => {
  const s = buildAgentAdminNotice({ kind: 'sign', actorName: 'Оксана', chatId: 555, tenderId: 'UA-1' });
  assert.ok(s.includes('підписання'));
});
```

Run: `node --test test/commands.test.mjs`
Expected: PASS

- [ ] **Step 6: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git checkout -b feat/agent-sign-and-zip
git add commands.mjs test/commands.test.mjs
git commit -m "feat(bot): letter-date validation, sign job builder and button"
```

---

### Task 8: Діалог підписання у Worker

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\worker\src\handler.mjs`
- Test: `C:\Users\andre\Desktop\AI\tender-monitor\worker\test\handler.test.mjs`

**Interfaces:**
- Consumes: `validateLetterDate`, `formatLetterDate`, `buildAgentSignJob`, `buildAgentSignDateKeyboard`, `buildAgentSignConfirmText`, `buildAgentConfirmKeyboard` (Task 7).
- Produces: колбеки `agent:sign:<tid>` → вибір дати; `agent:signdate:<tid>:<ДД.ММ.РРРР>` → підтвердження; `agent:signother:<tid>` → очікування тексту; гілка `confirm` із `entry.kind === 'sign'`; крок `await_letter_date` у `handleAgentTextReply`.

> **Виправлено 14.08.2026 після реалізації.** Гілки `signdate`/`signother` шипнуто зі
> строгішою перевіркою pending-запису, ніж у кроці 3 нижче: замість
> `!entry || entry.tid !== tid || entry.kind !== 'sign'` код звіряє ще й КРОК
> (`SIGN_CONTINUE_STEPS = new Set(['await_date', 'await_letter_date', 'confirm'])`)
> — урок із гілки `co` winner-флоу: коли перевіряється лише `kind`+`tid`, покинутий
> діалог на невідповідному кроці перехоплює пізніший дотик по застарілій кнопці
> («дотик по старій кнопці дати вписав би `letterDate` у чужий pending-запис» —
> коментар у коді). Крім того, `notifyAdminAgentRun` у гілці `confirm` (крок 4)
> передає ще й `letterDate: job.letter_date`, а `buildAgentAdminNotice` для
> `kind: 'sign'` (Task 7 факту, не плану) відповідно показує дату в сповіщенні
> адміну — цього немає в псевдокоді Task 7 плану.

- [ ] **Step 1: Написати падаючий тест на постановку задачі**

```javascript
test('agent:sign confirm queues a sign job with the chosen date', async () => {
  const saved = [];
  const pending = { 555: { tid: 'UA-1', kind: 'sign', step: 'confirm',
                           company: 'МАЙЛАБ', letterDate: '13.08.2026' } };
  await handleCallback({
    ...baseDeps,                       // повтори форму сусіднього amend-тесту
    data: 'agent:confirm:UA-1',
    chatId: 555,
    role: 'editor',
    _loadAgentPending: async () => ({ pending, sha: 'S' }),
    _saveAgentPending: async () => {},
    _loadAgentJob: async () => ({
      company: 'МАЙЛАБ',
      result: { drive_link: 'https://d/1', package_dir: 'P' },
    }),
    _saveAgentJob: async (env, job, opts) => { saved.push({ job, opts }); },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].job.job_type, 'sign');
  assert.equal(saved[0].job.letter_date, '13.08.2026');
  assert.equal(saved[0].job.target.package_dir, 'P');
  assert.ok(saved[0].opts.message.includes('agent_sign'));
});

test('agent:sign refuses when the proposal is not ready', async () => {
  const acks = [];
  await handleCallback({
    ...baseDeps,
    data: 'agent:sign:UA-9',
    chatId: 555,
    role: 'editor',
    ack: async (t) => acks.push(t),
    _loadAgentJob: async () => ({ status: 'running' }),
  });
  assert.ok(String(acks[0]).includes('не готова'));
});
```

- [ ] **Step 2: Запустити — мають впасти**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test worker/test/handler.test.mjs`
Expected: FAIL — job не збережено, ack не той.

- [ ] **Step 3: Додати гілки `sign` / `signdate` / `signother`**

Після гілки `amend` у `handleAgentCallback`:

```javascript
  if (action === 'sign') {
    let prior;
    try {
      prior = await _loadAgentJob(env, tid);
    } catch (err) {
      console.error('worker: agent sign load job failed:', err.message);
      await ack(githubUnavailableAck(err, isAdmin), true);
      return;
    }
    if (!prior || prior.status !== 'done' || !prior.result?.package_dir) {
      await ack('🚫 Пропозиція ще не готова', true);
      return;
    }
    const todayStr = formatLetterDate(_now());
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { tid, kind: 'sign', step: 'await_date',
                          company: prior.company ?? null, at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
      await sendNew('Яку дату проставити в документах?',
                    buildAgentSignDateKeyboard(tid, todayStr));
    } catch (err) {
      console.error('worker: agent sign date prompt failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }

  if (action === 'signdate' || action === 'signother') {
    let entry;
    try {
      const loaded = await _loadAgentPending(env);
      entry = loaded.pending?.[chatId];
    } catch (err) {
      console.error('worker: agent signdate load pending failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    if (!entry || entry.tid !== tid || entry.kind !== 'sign') {
      await ack('⚠️ Немає активного запиту');
      return;
    }
    if (action === 'signother') {
      try {
        const { pending, sha } = await _loadAgentPending(env);
        pending[chatId] = { ...entry, step: 'await_letter_date', at: _now().toISOString() };
        await _saveAgentPending(env, pending, sha);
        await sendNew('Надішли дату у форматі ДД.ММ.РРРР (напр. 13.08.2026):');
      } catch (err) {
        console.error('worker: agent signother failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      await ack();
      return;
    }
    const letterDate = validateLetterDate(parts[3] ?? '', _now());
    if (!letterDate) { await ack('❌ Невірна дата', true); return; }
    try {
      const { pending, sha } = await _loadAgentPending(env);
      pending[chatId] = { ...entry, step: 'confirm', letterDate, at: _now().toISOString() };
      await _saveAgentPending(env, pending, sha);
      await sendNew(
        buildAgentSignConfirmText({ tenderId: tid, company: entry.company, letterDate }),
        buildAgentConfirmKeyboard(tid),
      );
    } catch (err) {
      console.error('worker: agent signdate confirm failed:', err.message);
      await ack('⚠️ Помилка, спробуй ще раз', true);
      return;
    }
    await ack();
    return;
  }
```

- [ ] **Step 4: Додати гілку `sign` у `confirm`**

Перед гілкою `entry.kind === 'amend'`:

```javascript
    if (entry.kind === 'sign') {
      if (!entry.letterDate) { await ack('⚠️ Немає активного запиту'); return; }
      let prior;
      try {
        prior = await _loadAgentJob(env, tid);
      } catch (err) {
        console.error('worker: agent sign confirm load job failed:', err.message);
        await ack('⚠️ Помилка, спробуй ще раз', true);
        return;
      }
      if (!prior?.result?.package_dir) { await ack('🚫 Пропозиція ще не готова', true); return; }
      const job = buildAgentSignJob({
        tenderId: tid,
        company: entry.company ?? prior.company ?? null,
        letterDate: entry.letterDate,
        target: {
          drive_link: prior.result.drive_link ?? null,
          package_dir: prior.result.package_dir,
        },
        requestedBy: String(chatId),
        createdAt: _now().toISOString(),
      });
      try {
        await _saveAgentJob(env, job, {
          message: formatAuditMessage({ action: 'agent_sign', target: tid, actor: actorName, chatId, role }),
        });
      } catch (err) {
        console.error('worker: saveAgentJob (sign) failed:', err.message);
        await ack('⚠️ Не зміг поставити в чергу, спробуй ще раз', true);
        return;
      }
      await clearAgentPending({ env, chatId, _loadAgentPending, _saveAgentPending });
      try {
        await sendNew('✅ Підписання поставлено в чергу. Сповіщу, коли буде готово.');
      } catch (err) {
        console.error('worker: agent sign confirm reply failed:', err.message);
      }
      await notifyAdminAgentRun({
        env, isAdmin, adminChatId, _sendReply,
        kind: 'sign', actorName, chatId, tenderId: tid, company: job.company,
      });
      await ack('✅ В черзі');
      return;
    }
```

- [ ] **Step 5: Обробити введену вручну дату в `handleAgentTextReply`**

У рядку 1487 розширити умову й додати гілку обробки:

```javascript
  if (!entry || (entry.step !== 'await_price'
                 && entry.step !== 'await_instruction'
                 && entry.step !== 'await_letter_date')) return false;
```

```javascript
  if (entry.step === 'await_letter_date') {
    const letterDate = validateLetterDate(msg.text, _now());
    if (!letterDate) {
      await _sendReply({
        token: env.TELEGRAM_BOT_TOKEN, chatId: Number(chatId),
        text: '❌ Дата має бути у форматі ДД.ММ.РРРР і в межах ±30 днів. Спробуй ще раз:',
      });
      return true;
    }
    pending[chatId] = { ...entry, step: 'confirm', letterDate, at: _now().toISOString() };
    await _saveAgentPending(env, pending, sha);
    await _sendReply({
      token: env.TELEGRAM_BOT_TOKEN, chatId: Number(chatId),
      text: buildAgentSignConfirmText({
        tenderId: entry.tid, company: entry.company, letterDate,
      }),
      replyMarkup: buildAgentConfirmKeyboard(entry.tid),
    });
    return true;
  }
```

- [ ] **Step 6: Тест на ручне введення дати**

```javascript
test('a typed letter date moves the dialog to confirm', async () => {
  const pending = { 555: { tid: 'UA-1', kind: 'sign', step: 'await_letter_date', company: 'МАЙЛАБ' } };
  let saved = null;
  const sent = [];
  const handled = await handleAgentTextReply({
    env: { TELEGRAM_BOT_TOKEN: 'T' },
    chatId: 555,
    msg: { text: '14.08.2026' },
    _sendReply: async (o) => sent.push(o),
    _loadAgentPending: async () => ({ pending, sha: 'S' }),
    _saveAgentPending: async (env, p) => { saved = p; },
    _now: () => new Date('2026-08-13T09:00:00Z'),
  });
  assert.equal(handled, true);
  assert.equal(saved[555].step, 'confirm');
  assert.equal(saved[555].letterDate, '14.08.2026');
  assert.ok(sent[0].text.includes('14.08.2026'));
});
```

(`handleAgentTextReply` не експортується — або експортуй його, або перевір цей сценарій через публічний вхід, як це роблять сусідні тести цього файлу.)

- [ ] **Step 7: Прогнати всі тести бота**

Run: `cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/*.test.mjs worker/test/*.test.mjs`
Expected: PASS

- [ ] **Step 8: Коміт**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add worker/src/handler.mjs worker/test/handler.test.mjs
git commit -m "feat(worker): sign dialog with date choice and confirmation"
```

---

### Task 9: Синхронізація `CLAUDE.md` обох репозиторіїв

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\tender-monitor\CLAUDE.md`
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\CLAUDE.md`

**Interfaces:**
- Consumes: фактичні поля з Task 6 (`result`) і Task 7 (job).
- Produces: документація контракту.

- [ ] **Step 1: Додати тип задачі в обидва файли**

```markdown
- **`sign`** (`job_type:'sign'`) — підписання й архів:
  `{ tender_id, link, job_type:'sign', company, letter_date:'ДД.ММ.РРРР',
     target:{drive_link, package_dir}, requested_by, status:'pending', created_at }`
  (БЕЗ `price`; `target.package_dir` ОБОВ'ЯЗКОВИЙ)
  → поллер викликає `sign_lib.sign_package(...)` — **без `claude -p`**, це
  детермінований Python: копії → дата → підпис → PDF (Word COM) → `Підписані PDF\`
  + ZIP у `ТЕНДЕРИ 2026\<N>. <Замовник>\`.
```

- [ ] **Step 2: Додати опис `result` в обидва файли**

```markdown
Для `sign` у `result`: `zip_path`, `zip_link`, `signed_dir`, `letter_date`,
`n_signed`, `n_pdf_total`, `unsigned`. `drive_link` і `package_dir` переносяться
з попереднього результату без змін.
```

- [ ] **Step 3: Оновити «Вхід у боті» і «Ключові місця» в обох файлах**

«Вхід у боті»: `🖊 Підписати й запакувати — на готовій пропозиції в «📊 Останні задачі»; крок вибору дати (сьогодні / ввести свою).`

«Ключові місця»: бот — `validateLetterDate`, `buildAgentSignJob`, `buildAgentSignDateKeyboard` (`commands.mjs`); агент — `sign_lib.py` (`replace_letter_date`, `find_signature_index`, `stamp_docx`, `sign_package`), `_sign_keyboard` (`agent_poller.py`).

- [ ] **Step 4: Звірити обидва файли**

Run:
```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor" && grep -c "job_type:'sign'" CLAUDE.md
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій" && grep -c "job_type:'sign'" CLAUDE.md
```
Expected: обидва ≥ 1, описи полів збігаються дослівно.

- [ ] **Step 5: Коміт в обох репозиторіях**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add CLAUDE.md && git commit -m "docs: sign job type in the integration contract"
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add CLAUDE.md && git commit -m "docs: sign job type in the integration contract"
```

---

### Task 10: Ручна перевірка вигляду підпису

Три константи в `sign_lib.py` (`SIGNATURE_WIDTH_CM`, `SIGNATURE_OFFSET_X_CM`, `SIGNATURE_OFFSET_Y_CM`) підібрані наосліп. Автотест перевіряє лише, що картинка потрапила в потрібний абзац і плаваюча — як саме вона лягла на аркуш, видно тільки очима.

**Files:** можлива правка трьох констант у `scripts/sign_lib.py`.

- [ ] **Step 1: Переконатися, що скани на місці**

Run: `ls "G:/Мій диск/AI/Активи компаній/"*/"Підпис і печатка"/*.png`
Expected: по одному PNG на кожну компанію, для якої плануються подачі. Немає — фічу запускати нема сенсу, спершу власник кладе файли.

- [ ] **Step 2: Прогнати всі тести обох репозиторіїв**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor" && node --test test/*.test.mjs worker/test/*.test.mjs
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій" && py -m pytest tests/ -q
```
Expected: PASS в обох.

- [ ] **Step 3: Прогнати на ОДНОМУ реальному пакеті й показати власнику**

Запустити підписання на готовій пропозиції, відкрити `Підписані PDF\` у Drive і показати власнику пару «до/після» на одному листі. **Не розкочувати на всі шаблони, поки він не підтвердить вигляд** — він перевіряє це сам, у реальному середовищі.

- [ ] **Step 4: За потреби підкрутити зсув і повторити**

Правити лише три константи в `scripts/sign_lib.py`, перезапускати підписання й показувати результат, доки власник не скаже «так». Логіку не чіпати — вона від цих чисел не залежить.

- [ ] **Step 5: Мердж у `main` — тільки після «ок» власника**

У бота push у `main` одразу тягне деплой Worker-а, агент підхоплює `main` без CI. Тому мердж — останній крок, після підтвердження.

---

## Self-Review

**Spec coverage:**

| Вимога спеки | Завдання |
|---|---|
| Кнопка `🖊 Підписати й запакувати` на готовій пропозиції | Task 7 |
| Крок вибору дати (сьогодні / ввести свою), валідація ±30 днів | Task 7, Task 8 |
| Контракт job-а `sign`, `letter_date`, обовʼязковий `package_dir` | Task 7, Task 8 |
| Перевірка скана підпису першим кроком | Task 5 (`sign_package` починається з `signature_png_for`) |
| Копії, оригінали не чіпати | Task 3, Task 5 (тест на незмінність оригіналів) |
| Дата лише листа, дати договорів не чіпати | Task 2 (окреме завдання з тестами) |
| Підпис за якорем «Директор» | Task 3 |
| Рендер одним заходом Word | Task 5 (`render` = `docx_to_pdf_batch`) |
| `Підписані PDF\` + постійні PDF пакета | Task 5 |
| Плоский ZIP `<Замовник> ТП <дата>.zip` | Task 4, Task 5 |
| Дві кнопки в повідомленні, `kind="file"` для ZIP | Task 6 |
| `unsigned` — не помилка, а рядок у звіті | Task 5, Task 6 |
| Повторний запуск перезаписує результат | Task 5 (`shutil.rmtree` перед роботою) |
| Аудит `agent_sign` + сповіщення адміну | Task 7, Task 8 |
| Синхронний `CLAUDE.md` | Task 9 |
| Ручна перевірка вигляду | Task 10 |

**Розбіжність зі спекою:** скіл `tender-proposal-sign` і `run_agent.run_sign` замінені на `sign_lib.sign_package` — описано вгорі окремим блоком, потребує рішення власника.

**Placeholder scan:** порожніх кроків немає. Три місця свідомо посилаються на наявні фікстури репозиторію замість дублювання чужого коду: Task 8 Step 1 і Step 6 (`baseDeps`, форма виклику `handleAgentTextReply`).

**Type consistency:** `sign_package(package_dir, out_dir, company, letter_date, short_entity, assets_root, render=None)` — Task 5 (визначення), Task 6 (виклик), збігається. `stamp_docx(...) -> {dated, old_date, new_date, signed}` — Task 3 (визначення), Task 5 (споживання ключів `signed`/`dated`/`old_date`). `zip_name(short_entity, letter_date)` — Task 4 (визначення), Task 5 (виклик). `_sign_keyboard(zip_url, folder_url)` — Task 6 (визначення й виклик). `validateLetterDate(text, today)` — Task 7 (визначення), Task 8 (два виклики, обидва передають `_now()`).
