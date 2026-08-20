### Task 2: Винести `ConflictError` у спільний модуль

**Files:**
- Create: `worker/src/state-errors.mjs`
- Modify: `worker/src/github.mjs:1-13` (прибрати локальний клас, імпортувати)
- Test: наявний `worker/test/github.test.mjs` не змінюється — `ConflictError` і далі імпортується з `../src/github.mjs` (github.mjs ре-експортує).

**Interfaces:**
- Produces: `export class ConflictError extends Error` у `state-errors.mjs`, з полем `status = 409`.
- Consumes: нічого.

- [ ] **Крок 1: Написати тест, що фіксує поточну поведінку `ConflictError` (regression guard)**

Додати на початок `worker/test/github.test.mjs` (перед наявними тестами):

```js
test('ConflictError: has status 409 and is instanceof Error', () => {
  const e = new ConflictError('conflict on x');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 409);
  assert.equal(e.name, 'ConflictError');
});
```

- [ ] **Крок 2: Прогнати тест — має пройти вже зараз (не впаде, бо клас іще тут)**

Run: `node --test worker/test/github.test.mjs`
Expected: PASS (це regression guard, не TDD-red — клас іще на місці).

- [ ] **Крок 3: Створити `worker/src/state-errors.mjs`**

```js
export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
    this.status = 409;
  }
}
```

- [ ] **Крок 4: Прибрати клас із `github.mjs`, імпортувати й ре-експортувати**

У `worker/src/github.mjs` замінити рядки 7-13 (визначення класу):

```js
export class ConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConflictError';
    this.status = 409;
  }
}
```

на:

```js
export { ConflictError } from './state-errors.mjs';
```

- [ ] **Крок 5: Прогнати весь тестовий набір Worker'а**

Run: `node --test worker/test/*.test.mjs`
Expected: PASS, без регресій (github.test.mjs і handler.test.mjs далі бачать той самий клас через ре-експорт).

- [ ] **Крок 6: Commit**

```bash
cd "C:/Users/andre/Desktop/AI/tender-monitor"
git add worker/src/state-errors.mjs worker/src/github.mjs worker/test/github.test.mjs
git commit -m "worker: extract ConflictError into shared state-errors.mjs"
```

---

