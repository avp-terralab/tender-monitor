// Гейт на `wrangler.toml`. З'явився після того, як ОДНА Й ТА САМА вада
// повторилась двічі: спершу `[env.production]` не мав KV-байндингу (знайдено
// оглядом у Task 6), потім не мав `GITLAB_PROJECT_ID`/`GITLAB_REF` (знайдено
// оглядом при підготовці cutover, 22.08.2026). Обидві — «оточення оголошене,
// але без параметра, без якого воно не працює», і обидві виявились би вже
// після перемикання прода.
//
// Розбір тут навмисно мінімальний: у проєкті немає залежностей (кореневого
// package.json теж немає), тягнути TOML-парсер заради трьох перевірок дорожче,
// ніж прочитати рівно ті рядки, які нас цікавлять.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TOML = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

// → { staging: { vars: {...}, kvBindings: ['EPHEMERAL_KV'] }, production: {...} }
function parseEnvs(toml) {
  const envs = {};
  let current = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const kv = /^\[\[env\.([A-Za-z0-9_]+)\.kv_namespaces\]\]$/.exec(line);
    if (kv) {
      envs[kv[1]] ??= { vars: {}, kvBindings: [] };
      current = { env: kv[1], inKv: true };
      continue;
    }
    const head = /^\[env\.([A-Za-z0-9_]+)\]$/.exec(line);
    if (head) {
      envs[head[1]] ??= { vars: {}, kvBindings: [] };
      current = { env: head[1], inKv: false };
      continue;
    }
    if (/^\[/.test(line)) { current = null; continue; }
    if (!current) continue;

    if (current.inKv) {
      const b = /^binding\s*=\s*"([^"]+)"$/.exec(line);
      if (b) envs[current.env].kvBindings.push(b[1]);
      continue;
    }
    const v = /^vars\s*=\s*\{(.*)\}$/.exec(line);
    if (v) {
      for (const pair of v[1].split(',')) {
        const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(pair);
        if (m) envs[current.env].vars[m[1]] = m[2];
      }
    }
  }
  return envs;
}

const ENVS = parseEnvs(TOML);

test('wrangler.toml: розбір знаходить обидва оточення', () => {
  assert.deepEqual(Object.keys(ENVS).sort(), ['production', 'staging'],
    'якщо оточень стало більше — перевірки нижче мусять покрити й нові');
});

// Перемикання бекенду мусить бути зміною ОДНОГО значення. Якщо параметри
// GitLab лежать лише в тому оточенні, яке вже на GitLab, то перемикання
// другого тихо заведе бота в бекенд, що не знає, куди писати: `gitlab.mjs`
// читає env.GITLAB_PROJECT_ID, env.GITLAB_REF і env.GITLAB_TOKEN (перші два —
// зі vars, токен — секретом).
for (const name of ['staging', 'production']) {
  test(`wrangler.toml: [env.${name}] має параметри GitLab незалежно від прапорця`, () => {
    const vars = ENVS[name]?.vars ?? {};
    assert.ok(vars.GITLAB_PROJECT_ID, `[env.${name}] без GITLAB_PROJECT_ID`);
    assert.ok(vars.GITLAB_REF, `[env.${name}] без GITLAB_REF`);
    // Гілка коду задається ОКРЕМО від гілки стану (рішення 23.08.2026). Без
    // неї `fetchLatestDeployCommit` шукав би деплой у гілці стану, де лежать
    // самі службові коміти, і стрічка «останній деплой» у /status спорожніла б.
    assert.ok(vars.GITLAB_CODE_REF, `[env.${name}] без GITLAB_CODE_REF`);
  });

  // Головний інваріант нової схеми: стан НЕ лежить у гілці коду. Якби лежав,
  // запис стану вимагав би права писати в захищену `main`, тобто Maintainer —
  // повноваження, з яких використовувався б рівно один пункт.
  test(`wrangler.toml: [env.${name}] тримає стан НЕ в гілці коду`, () => {
    const vars = ENVS[name]?.vars ?? {};
    assert.notEqual(vars.GITLAB_REF, vars.GITLAB_CODE_REF,
      `[env.${name}]: гілка стану збіглася з гілкою коду — саме цього ми й уникаємо`);
  });

  // Урок Task 6: оточення без свого KV-байндингу ламає ephemeral.mjs
  // (видалення попереднього повідомлення-перегляду) — і саме на проді.
  test(`wrangler.toml: [env.${name}] має власний KV-байндинг EPHEMERAL_KV`, () => {
    assert.deepEqual(ENVS[name]?.kvBindings, ['EPHEMERAL_KV'],
      `[env.${name}] мусить оголошувати рівно один KV-байндинг EPHEMERAL_KV`);
  });
}

// ⚠️ Найпідліша вада, знайдена 23.08.2026 при підготовці cutover.
//
// Топ-рівень wrangler.toml має ТЕ САМЕ ім'я скрипта, що й [env.production] —
// `tender-monitor-bot`. Тому `wrangler deploy` БЕЗ `--env` викочує той самий
// продовий Worker, але з топ-рівневим конфігом, а [env.production] не
// застосовується взагалі. Тобто цілий блок налаштувань виглядає живим і не є.
//
// Наслідок на cutover: прапорець STATE_BACKEND перемкнули б у блоці, якого
// ніхто не читає, побачили б, що поведінка не змінилась, і шукали б причину
// де завгодно, крім цього місця. (`deploy-production` у .gitlab-ci.yml
// `--env production` уже вживав — розбіжність була саме в GitHub-шляху.)
test('worker-deploy.yml: деплой застосовує саме [env.production]', () => {
  const wf = readFileSync(
    new URL('../../.github/workflows/worker-deploy.yml', import.meta.url), 'utf8');
  // Коментарі відкидаємо ДО пошуку: у самому воркфлоу є коментар, який
  // цитує «wrangler deploy без прапорця», і наївний фільтр приймав його за
  // команду. Дзеркало класичної помилки — гейт, що падає на власному тексті.
  const deployLines = wf
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /wrangler deploy/.test(l));
  assert.ok(deployLines.length > 0, 'у воркфлоу немає команди wrangler deploy');
  for (const line of deployLines) {
    assert.match(line, /--env\s+production/,
      'деплой без --env бере топ-рівневий конфіг, і [env.production] стає мертвим');
  }
});

test('wrangler.toml: STATE_BACKEND задано явно в обох оточеннях', () => {
  // Типове значення (github) працює, але «не задано» і «задано github» —
  // різні речі при читанні конфіга людиною перед cutover.
  assert.equal(ENVS.staging?.vars.STATE_BACKEND, 'gitlab');
  assert.ok(['github', 'gitlab'].includes(ENVS.production?.vars.STATE_BACKEND));
});
