// Гейт на `.gitlab-ci.yml`. З'явився 23.08.2026 після конкретної помилки:
// при винесенні спільного блоку монітора в шаблон я вирізав старий текст по
// рядку `exit 1`, вважаючи його кінцем джоби. Насправді після скрипта в джоби
// йшов ще її `rules:` — він лишився висіти й приліпився до нової джоби
// `monitor-production`, дав їй ДРУГИЙ ключ `rules:`, і в YAML переміг останній.
// Прод-монітор дістав умову staging-монітора й побіг на staging-розкладі.
//
// Чому цього не спіймали раніше:
//   * `POST /ci/lint` відповів `valid: true` — дубльований ключ його не турбує;
//   * я перевірив merged_yaml на те, що змінював свідомо (STATE_BRANCH,
//     наявність блоку пуша), і не перевірив те, що міг зламати випадково;
//   * врятував лише живий цикл — і те, що `ci.mjs` має запобіжник і вийшов
//     на «Missing TELEGRAM_BOT_TOKEN», не написавши реальним користувачам.
//
// Розбір текстовий: у проєкті немає залежностей, а YAML-парсер тут ще й
// спіткнувся б на теґу `!reference`, специфічному для GitLab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CI = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');

// Верхньорівневі ключі починаються з нульової колонки; усе до наступного
// такого ключа належить попередньому блоку.
function topLevelBlocks(text) {
  const blocks = {};
  let name = null;
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_.][A-Za-z0-9_.-]*):\s*$/.exec(line);
    if (m) {
      if (name) blocks[name] = buf.join('\n');
      name = m[1];
      buf = [];
      continue;
    }
    if (name) buf.push(line);
  }
  if (name) blocks[name] = buf.join('\n');
  return blocks;
}

const BLOCKS = topLevelBlocks(CI);

test('.gitlab-ci.yml: розбір бачить обидві джоби монітора', () => {
  for (const j of ['monitor-staging', 'monitor-production']) {
    assert.ok(BLOCKS[j], `блок ${j} не знайдено — перевірки нижче були б порожні`);
  }
});

// Головна перевірка: жоден блок не має двічі того самого ключа другого рівня.
// Саме це й сталося з `rules:`; YAML тихо бере останній, лінт не заперечує.
test('.gitlab-ci.yml: у жодному блоці немає дубльованих ключів', () => {
  for (const [name, body] of Object.entries(BLOCKS)) {
    const keys = body
      .split('\n')
      .map((l) => /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual([...new Set(dupes)], [], `у блоці «${name}» ключ повторюється`);
  }
});

// Обидва монітори читають один і той самий шаблон, тож єдине, що їх
// відрізняє, — ці два значення. Помилка в них означає, що монітор побіжить не
// за тим розкладом або запише стан не в ту гілку.
// Прод-стан лежить в окремій гілці `prod-state`, а НЕ в `main` (рішення
// 23.08.2026). Причина: `main` захищена, писати в неї може лише Maintainer, а
// токен, яким пишуть і бот, і ця джоба, має Developer. Піднімати його до
// Maintainer означало б видати набір повноважень, з якого використовується
// рівно один пункт — право писати в захищену гілку. Окрема незахищена гілка
// знімає потребу взагалі, і робить прод такої самої форми, як staging, який ми
// три дні перевіряли.
const EXPECTED = {
  'monitor-staging': { target: 'staging', branch: 'staging-state' },
  'monitor-production': { target: 'production', branch: 'prod-state' },
};

for (const [job, { target, branch }] of Object.entries(EXPECTED)) {
  test(`.gitlab-ci.yml: ${job} слухає розклад ${target} і пише в ${branch}`, () => {
    const body = BLOCKS[job];
    assert.match(body, new RegExp(`SCHEDULE_TARGET == "${target}"`),
      `${job} мусить реагувати лише на SCHEDULE_TARGET=${target}`);
    assert.match(body, new RegExp(`STATE_BRANCH:\\s*${branch}\\b`),
      `${job} мусить писати стан у ${branch}`);
    // Дзеркальна перевірка: жодних слідів чужої цілі в тому самому блоці.
    const other = target === 'staging' ? 'production' : 'staging';
    assert.doesNotMatch(body, new RegExp(`SCHEDULE_TARGET == "${other}"`),
      `у блоці ${job} лишилась умова чужого розкладу — саме так і сталася помилка 23.08`);
  });
}
