# Доробка підготовлених пропозицій через бота (agent amend)

Дата: 2026-06-24
Гілка: `feat/agent-amend-proposal`

## Мета

Дати адміну змогу через Telegram-бота **давати агенту текстове завдання доробити вже
підготовлену тендерну пропозицію** — додати документ або внести зміни в наявні
(«додай довідку КВЕД», «заміни ціну в листі на X»). Бот записує job із завданням;
саму доробку виконує зовнішній (локальний) агент.

## Затверджені рішення (brainstorm)

- **Формат завдання:** лише текст. Бот файлів не приймає — агент сам робить роботу за
  інструкцією.
- **Точка входу:** кнопка `✏️ Доробити` біля кожної **готової** (`✅ done` + `drive_link`)
  пропозиції на екрані `🤖 Агент → 📊 Останні задачі`. Доробляти можна лише підготовлені
  пропозиції.
- **Модель job-а (A):** перезапис того самого файлу `_state/agent_jobs/<tid>.json` новим
  записом `job_type:'amend'` + `instruction` + `target` (ціль із попереднього `result`).
  Узгоджено з наявною поведінкою повторного запуску (re-run теж перезаписує файл).
- **Агент — зовнішній:** job-и обробляє локальний процес поза цим репозиторієм. Бот лише
  пише job-файл; обробку `job_type:'amend'` користувач додає у свій агент-скрипт окремо
  (див. розділ «Контракт для агента»).

## Контракт job-а

### Початковий «prepare» job — БЕЗ змін
Наявний `buildAgentJob` лишається як є (поля `tender_id, link, company, price,
requested_by, status, created_at`, без `job_type`). Агент трактує **відсутність**
`job_type` як підготовку з нуля (наявна поведінка). Нічого в цьому записі не чіпаємо,
щоб не зламати наявний контракт.

### Новий «amend» job
Пишеться у той самий `_state/agent_jobs/<tid>.json` (перезаписує попередній done-запис):
```json
{
  "tender_id": "UA-2026-06-19-008416-a",
  "link": "https://prozorro.gov.ua/tender/UA-2026-06-19-008416-a",
  "job_type": "amend",
  "instruction": "<вільний текст адміна>",
  "company": "<company з попереднього job-а>",
  "target": {
    "drive_link": "<попередній result.drive_link>",
    "package_dir": "<попередній result.package_dir, якщо є>"
  },
  "requested_by": "<chatId>",
  "status": "pending",
  "created_at": "<ISO>"
}
```
- **`price` НЕ включається** — доробка не задає нову ціну (за потреби це вказують у тексті
  інструкції).
- `target` несе посилання на готову папку, щоб агент знав, ДЕ доробляти.
- Якщо у попереднього job-а немає `result.package_dir` — поле опускається/`null`; обов'язковий
  лише `drive_link` (саме за ним визначається «готовність»).

## Потік у боті

### Стан діалогу (`_state/agent_pending.json`)
Наявна структура keyed by `chatId`. Для доробки запис набуває:
```js
{ [chatId]: { tid, kind: 'amend', step: 'await_instruction' | 'confirm', instruction?, at } }
```
Prepare-діалог лишається без `kind` (`{ tid, company, step:'await_price'|'confirm', price?, at }`).
Розрізнення на кроці підтвердження — за наявністю `kind === 'amend'`. TTL — наявний
`AGENT_PENDING_TTL_MS` (15 хв).

### Кроки
1. **Кнопка** (екран «Останні задачі»): для кожного `done`-job із `result.drive_link`
   рядок отримує другу кнопку: `[ 📁 <tid> ][ ✏️ Доробити ]`, де `✏️ Доробити` →
   `callback_data: agent:amend:<tid>`. Для pending/running/error кнопки немає.
2. **`agent:amend:<tid>`** (admin-only): повторно завантажити job для `<tid>`; якщо
   `status !== 'done'` або немає `result.drive_link` → `ack('🚫 Пропозиція ще не готова', true)`
   і вихід (захист від застарілої кнопки). Інакше записати
   `pending[chatId] = { tid, kind:'amend', step:'await_instruction', at: now }` і надіслати
   промпт: `✏️ Напиши, що доробити в пропозиції <tid> (одним повідомленням):`.
3. **Перехоплення тексту:** наявний text-interceptor (зараз — `handleAgentPriceReply`,
   викликається для адміна на не-`/` повідомленні до парсингу команд) **узагальнити** в
   `handleAgentTextReply`, що диспетчеризує за `pending[chatId].step`:
   - `await_price` → наявна логіка ціни (без змін).
   - `await_instruction` → `validateInstruction(text)`; якщо невалідна (порожня) →
     повторний промпт, лишити стан; інакше зберегти `instruction`, перейти в
     `step:'confirm'`, надіслати `buildAgentAmendConfirmText(...)` + наявну
     `buildAgentConfirmKeyboard(tid)` (`✅ Підтвердити agent:confirm:<tid>` /
     `✖ Скасувати agent:cancel:<tid>`).
   TTL-перевірка — як у ціни (прострочений діалог чиститься, повідомлення йде у звичайний
   парсинг).
4. **`agent:confirm:<tid>`** — розгалузити за `entry.kind`:
   - `kind === 'amend'`: завантажити попередній job для `<tid>`, витягти `company` і
     `target = { drive_link, package_dir }` з його `result`; `buildAgentAmendJob(...)` →
     `saveAgentJob` (перезапис) → `clearAgentPending` → відповідь
     `✅ Завдання на доробку поставлено в чергу. Сповіщу, коли буде готово.`
   - інакше: наявний prepare-flow **без змін**.
   `agent:cancel:<tid>` — наявна логіка (чистить pending) покриває обидва типи.

### Відображення amend-job-ів у списку
`buildAgentJobsPage`: рядок job-а з `job_type === 'amend'` додатково позначається маркером
`✏️` (перед статус-іконкою), напр. `✏️ ⏳ <link> · <company>`, щоб доробки відрізнялись від
підготовок. Поки amend у `pending`/`running` — кнопки `📁` немає (лінк повернеться, коли
агент перезапише `result` на `done`).

## Нові/змінені одиниці

**`commands.mjs` (чисті функції):**
- `buildAgentAmendJob({ tenderId, instruction, company, target, requestedBy, createdAt })`
  → amend-запис (форма вище). `link` будується з `tenderId`.
- `buildAgentAmendConfirmText({ tenderId, instruction })` → однорядковий промпт підтвердження
  (напр. `✏️ Доробити <tid>:\n«<instruction (обрізана для показу)>»`).
- `validateInstruction(text)` → `string | null`: trim; `null` якщо порожнє; обрізати до
  розумного ліміту (**2000** символів — instruction живе у файлі, не в callback).
- `buildAgentJobsPage` — додати кнопку `✏️ Доробити` (done+drive_link) і маркер `✏️` для
  amend-job-ів.

**`worker/src/handler.mjs`:**
- `handleAgentCallback`: гілка `action === 'amend'` (старт діалогу інструкції); у гілці
  `action === 'confirm'` — розгалуження за `entry.kind`.
- Узагальнити `handleAgentPriceReply` → `handleAgentTextReply` (диспетч за `step`); оновити
  виклик-сайт (~рядок 108).
- Гейт `agent:` уже admin-only — додаткового не треба.

**`agent_pending.json`** — без міграції (транзієнтний об'єкт); просто з'являються поля `kind`,
`instruction`.

## Edge cases / помилки
- Застаріла кнопка `✏️ Доробити` (job перезапустили після рендеру) → перевірка на
  `agent:amend` повертає `ack('🚫 Пропозиція ще не готова', true)`.
- Порожня інструкція → повторний промпт, стан зберігається.
- GitHub/Prozorro недоступні під час `amend`/`confirm` → `ack('⚠️ …', true)`, як у наявних
  гілках.
- Перезапис файлу: поки amend виконується, у списку видно `✏️ ⏳` без `📁`; це очікувано —
  агент поверне `result` на `done`.
- TTL 15 хв на діалог інструкції (наявний механізм).

## Контракт для агента (поза цим репо — реалізуєш ти)
Локальний агент-скрипт, що обробляє `_state/agent_jobs/*.json`, треба навчити:
1. Читати `job_type`. Якщо `job_type === 'amend'` — **не** готувати пропозицію з нуля.
2. Для amend: відкрити вже готову папку за `target.drive_link` (та/або `target.package_dir`)
   і виконати `instruction` над наявними документами.
3. Писати статус назад як і раніше (`running` → `done`/`error`), на `done` оновити `result`
   (`drive_link`, `package_dir`, тощо), щоб у боті знову з'явився `📁`-лінк.
Бот гарантує лише формат запису `pending` (поля вище). Уся обробка — на боці агента.

## Поза скоупом
- Завантаження файлів через Telegram (свідомо лише текст).
- Історія доробок (модель A перезаписує; обрано замість B).
- Зміна початкового `prepare`-контракту.
- Будь-яка зміна коду зовнішнього агента (його оновлює користувач окремо).

## Тестування
- **`test/commands.test.mjs`:** форма `buildAgentAmendJob` (`job_type:'amend'`, `instruction`,
  `target` із переданого, без `price`); `buildAgentAmendConfirmText`; `validateInstruction`
  (порожнє→null, trim, обрізання >2000); `buildAgentJobsPage` показує `✏️ Доробити` **лише**
  для done+drive_link (не для pending/running/error) і маркер `✏️` для amend-job-ів.
- **`worker/test/handler.test.mjs`:** `agent:amend:<tid>` стартує діалог (pending записано,
  промпт надіслано) і відхиляє не-done тендер; текст при `step:'await_instruction'` зберігає
  інструкцію + показує confirm; `agent:confirm` з `kind:'amend'` будує amend-job із `target`
  попереднього done-job + перезаписує файл + чистить pending; prepare-flow (`agent:confirm`
  без kind) лишається зеленим; усе admin-only.
- Наявні агентні тести (start/co/price/confirm/cancel, jobs page) лишаються зеленими.

## Порядок реалізації (для плану)
1. Чисті функції: `validateInstruction`, `buildAgentAmendJob`, `buildAgentAmendConfirmText` (+тести).
2. `buildAgentJobsPage`: кнопка `✏️ Доробити` + маркер amend (+тести).
3. Worker: узагальнити text-interceptor у `handleAgentTextReply` (+тести, prepare зелений).
4. Worker: `agent:amend` старт діалогу (+тест, не-done відхилення).
5. Worker: розгалуження `agent:confirm` за kind → amend-job (+тест).
