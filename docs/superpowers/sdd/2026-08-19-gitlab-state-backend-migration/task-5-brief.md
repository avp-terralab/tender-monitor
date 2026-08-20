### Task 5: Перемкнути `handler.mjs` на `state.mjs`

**Files:**
- Modify: `worker/src/handler.mjs:31-44`

**Interfaces:**
- Consumes: `worker/src/state.mjs` (Task 4) — той самий набір імен, що й раніше з `github.mjs`.

- [ ] **Крок 1: Змінити джерело імпорту**

У `worker/src/handler.mjs`, рядок 44, замінити:

```js
} from './github.mjs';
```

на:

```js
} from './state.mjs';
```

(Імпортований список функцій, рядки 31-43, лишається без змін — усі імена присутні в `state.mjs`.)

- [ ] **Крок 2: Прогнати повний тестовий набір Worker'а**

Run: `node --test worker/test/*.test.mjs`
Expected: PASS, включно з усіма 4506 рядками `handler.test.mjs` — жодного регресу, бо `env` у тестах не має `STATE_BACKEND`, тож диспетчер обирає `github.mjs` (поточну поведінку) так само, як і до зміни.

- [ ] **Крок 3: Commit**

```bash
git add worker/src/handler.mjs
git commit -m "worker: route handler.mjs through state.mjs dispatcher"
```

---

