# Prozorro API — пошук тендера за tenderID (UA-...)

**Дата дослідження:** 2026-05-06
**Тестовий тендер:** UA-2026-04-30-010542-a (UUID `24bba48fbd154ca68690335ccf7d888e`)

## Висновок: двокроковий запит

### Крок 1 — отримати UUID за tenderID

```
GET https://prozorro.gov.ua/api/tenders/<tenderID>/summary
```

- Повертає JSON з полями: `id` (UUID), `tenderID`, `title`, `status`, `dateModified`, `tenderPeriod`, `auctionPeriod`, `awardPeriod`, `enquiryPeriod`, `complaints`, `questions`, `tabCounters` (counts of lots/questions/complaints/monitorings/agreements), `procuringEntity` (з контактами).
- **БРАКУЄ:** `documents`, `awards`, `contracts`, `cancellations` — потрібен крок 2 для повного об'єкту.
- HTTP 200, no auth required.

### Крок 2 — отримати повний тендер за UUID

```
GET https://public-api.prozorro.gov.ua/api/2.5/tenders/<UUID>
```

- Повертає `{data: {...full tender object...}}` — джерело правди для diff.
- Включає всі потрібні нам масиви: `documents`, `questions`, `complaints`, `awards`, `contracts`, `cancellations`, `lots`, `items`.
- HTTP 200, no auth required.
- Розмір типового джейсону: ~200-250 KB (для активного тендеру з кваліфікаційними критеріями).

## Чому direct lookup `?tender_id=` не працює

`https://public-api.prozorro.gov.ua/api/2.5/tenders?tender_id=UA-...` ігнорує параметр і повертає сторінку з 100 останніх тендерів CDB, відсортованих за `dateModified`. У офіційній документації `/api/2.5/tenders/{id}` приймає лише UUID, а пошуку за tenderID офіційний API не має.

## Як знайдено

Розпарсено фронтенд-бандл `https://prozorro.gov.ua/static-front/Tender.store-*.js`:

```javascript
async getTender(t) {
  const { data: a } = await o.get(`${s}/tenders/${t}/summary`);
  // ...
}
```

де `s = "https://prozorro.gov.ua/api"`. Другий запит — у `TenderPage-*.js`:

```javascript
`${i(J)}/tenders/${e.tender.id}`  // i(J) = "https://public-api.prozorro.gov.ua/api/2.5"
```

## Реалізація для prozorro.mjs

```javascript
export async function fetchTender(tenderId) {
  // Step 1: tenderID -> UUID via summary endpoint
  const summaryRes = await fetch(`https://prozorro.gov.ua/api/tenders/${encodeURIComponent(tenderId)}/summary`);
  if (!summaryRes.ok) throw new Error(`Prozorro summary ${summaryRes.status}: ${tenderId}`);
  const summary = await summaryRes.json();
  const uuid = summary.id;
  if (!uuid) throw new Error(`Prozorro: no UUID in summary for ${tenderId}`);

  // Step 2: UUID -> full tender via CDB
  const fullRes = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${uuid}`);
  if (!fullRes.ok) throw new Error(`Prozorro CDB ${fullRes.status}: ${uuid}`);
  return fullRes.json(); // {data: {...}}
}
```

## Верифіковано

- ✅ Step 1: повертає JSON з `id=24bba48fbd154ca68690335ccf7d888e`, `tenderID=UA-2026-04-30-010542-a`, `status=active.tendering`
- ✅ Step 2: повертає 233 KB JSON з повним об'єктом включно з `documents` (ТД та додатки)
- ⚠ В цьому конкретному тендері (status `active.tendering`) масиви `awards`, `contracts`, `cancellations` природно відсутні чи порожні. Перевірити їхню форму на завершеному тендері — TODO у Phase 2 (для фікстури).

## Артефакти

- `notes/sample_summary.json` — приклад step 1 (3 KB)
- `notes/sample_full.json` — приклад step 2 (233 KB) — згодиться як test fixture для prozorro.mjs.
