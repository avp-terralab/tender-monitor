import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWatchlist, saveWatchlist, ConflictError,
  loadWatchedEntities, saveWatchedEntities,
  loadInvites, saveInvites,
  saveAgentJob, listAgentJobs,
  fetchAuditLog, fetchLastCommit, fetchLatestDeployCommit,
} from '../src/gitlab.mjs';

const ENV = { GITLAB_TOKEN: 'glpat-TEST', GITLAB_PROJECT_ID: '99', GITLAB_REF: 'main' };

test('loadWatchlist: builds correct GET request against Files API', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    const json = JSON.stringify([{ tender_id: 'UA-X', enabled: true }]);
    const content = Buffer.from(json).toString('base64');
    return { ok: true, status: 200, json: async () => ({ content, last_commit_id: 'commit123' }) };
  };
  const result = await loadWatchlist(ENV, { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /projects\/99\/repository\/files\/watchlist\.json\?ref=main/);
  assert.equal(calls[0].opts.headers['PRIVATE-TOKEN'], 'glpat-TEST');
  assert.deepEqual(result.watchlist, [{ tender_id: 'UA-X', enabled: true }]);
  assert.equal(result.sha, 'commit123');
});

test('loadWatchlist: throws on 404 (does NOT tolerate missing file — matches github.mjs)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  await assert.rejects(() => loadWatchlist(ENV, { fetch: fakeFetch }), /404/);
});

test('saveWatchlist: builds PUT with last_commit_id and correct body', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const wl = [{ tender_id: 'UA-X', enabled: true }];
  await saveWatchlist(ENV, wl, 'oldCommit', { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /repository\/files\/watchlist\.json$/);
  assert.equal(calls[0].opts.method, 'PUT');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.last_commit_id, 'oldCommit');
  assert.equal(body.branch, 'main');
  assert.equal(body.encoding, 'base64');
  const decoded = atob(body.content);
  assert.deepEqual(JSON.parse(decoded), wl);
});

test('saveWatchlist: throws ConflictError on 400 with "changed since" message', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ message: 'You are attempting to update a file that has changed since you started editing it.' }),
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof ConflictError
  );
});

test('saveWatchlist: throws plain Error on unrelated 400 (not a conflict)', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ message: 'branch is invalid' }),
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof Error && !(err instanceof ConflictError)
  );
});

test('saveWatchlist: throws plain Error on 400 with plain-text (non-JSON) body', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 400,
    text: async () => 'Bad Request',
  });
  await assert.rejects(
    () => saveWatchlist(ENV, [], 'sha', { fetch: fakeFetch }),
    (err) => err instanceof Error && !(err instanceof ConflictError)
  );
});

test('loadWatchedEntities: 404 returns empty array (goes through tolerant loadFile)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const result = await loadWatchedEntities(ENV, { fetch: fakeFetch });
  assert.deepEqual(result.entities, []);
  assert.equal(result.sha, null);
});

test('saveWatchedEntities: POSTs (create) when sha is null', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201, json: async () => ({}) }; };
  await saveWatchedEntities(ENV, [{ edrpou: '1' }], null, { fetch: fakeFetch });
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.last_commit_id, undefined);
  assert.equal(body.encoding, 'base64');
});

test('saveWatchedEntities: PUTs (update) with last_commit_id when sha present', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; };
  await saveWatchedEntities(ENV, [{ edrpou: '1' }], 'commitAbc', { fetch: fakeFetch });
  assert.equal(calls[0].opts.method, 'PUT');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.last_commit_id, 'commitAbc');
  assert.equal(body.encoding, 'base64');
});

test('loadInvites: 404 → empty list + null sha', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  const { invites, sha } = await loadInvites(ENV, { fetch: fakeFetch });
  assert.deepEqual(invites, []);
  assert.equal(sha, null);
});

test('saveAgentJob: existence GET (404) then POST create', async () => {
  const tid = 'UA-2026-08-19-000001-a';
  const job = { tender_id: tid, status: 'pending' };
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (!opts || opts.method === undefined) {
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }
    return { ok: true, status: 201, json: async () => ({}) };
  };
  await saveAgentJob(ENV, job, { fetch: fakeFetch });
  const post = calls.find(c => c.opts && c.opts.method === 'POST');
  assert.ok(post, 'a POST must be issued when the job file does not exist yet');
  assert.match(post.url, /_state%2Fagent_jobs%2FUA-2026-08-19-000001-a\.json/);
});

test('listAgentJobs: lists tree, filters .json blobs, sorts desc, caps 20', async () => {
  const jobA = { tender_id: 'UA-1', status: 'done', created_at: '2026-06-20T10:00:00Z' };
  const jobB = { tender_id: 'UA-2', status: 'pending', created_at: '2026-06-22T10:00:00Z' };
  const fakeFetch = async (url) => {
    if (/repository\/tree\?path=_state\/agent_jobs/.test(url)) {
      return { ok: true, status: 200, json: async () => ([
        { name: 'UA-1.json', path: '_state/agent_jobs/UA-1.json', type: 'blob' },
        { name: 'UA-2.json', path: '_state/agent_jobs/UA-2.json', type: 'blob' },
        { name: 'README.md', path: '_state/agent_jobs/README.md', type: 'blob' },
      ]) };
    }
    const job = /UA-1\.json/.test(url) ? jobA : jobB;
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(job)).toString('base64'), last_commit_id: 's' }) };
  };
  const jobs = await listAgentJobs(ENV, { fetch: fakeFetch });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].tender_id, 'UA-2'); // newest first
});

test('listAgentJobs: requests per_page=100 on the tree endpoint (job files are never deleted, tree is sorted by name — a bare default 20-per-page cuts off the newest UA-YYYY-MM-DD-* jobs)', async () => {
  const treeUrls = [];
  const entries = Array.from({ length: 25 }, (_, i) => {
    const tid = `UA-2026-08-${String(i + 1).padStart(2, '0')}-000001-a`;
    return { name: `${tid}.json`, path: `_state/agent_jobs/${tid}.json`, type: 'blob' };
  });
  const fakeFetch = async (url) => {
    if (/repository\/tree\?path=_state\/agent_jobs/.test(url)) {
      treeUrls.push(url);
      return { ok: true, status: 200, json: async () => entries };
    }
    const job = { tender_id: 'UA-X', status: 'pending', created_at: '2026-08-01T00:00:00Z' };
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(job)).toString('base64'), last_commit_id: 's' }) };
  };
  await listAgentJobs(ENV, { fetch: fakeFetch });
  assert.equal(treeUrls.length, 1);
  assert.match(treeUrls[0], /per_page=100/);
});

// Сторінка дерева обмежена сотнею записів, і GitLab сортує імена за зростанням,
// тобто перша сторінка — найдавніші завдання. Без проходу по сторінках
// per_page=100 лише відсуває той самий обрив, а не знімає його.
test('listAgentJobs: проходить сторінки дерева і повертає найновіші, а не найдавніші', async () => {
  const mkEntry = (tid) => ({ name: `${tid}.json`, path: `_state/agent_jobs/${tid}.json`, type: 'blob' });
  // 150 завдань: сторінка 1 — найдавніші сто, сторінка 2 — найновіші п'ятдесят.
  const all = Array.from({ length: 150 }, (_, i) => `UA-2026-08-01-${String(i + 1).padStart(6, '0')}-a`);
  const pages = [all.slice(0, 100), all.slice(100)];
  const treeUrls = [];
  const fetched = [];
  const fakeFetch = async (url) => {
    if (/repository\/tree\?path=_state\/agent_jobs/.test(url)) {
      treeUrls.push(url);
      const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
      const items = (pages[page - 1] ?? []).map(mkEntry);
      const next = page < pages.length ? String(page + 1) : '';
      return { ok: true, status: 200, headers: { get: (h) => (h === 'x-next-page' ? next : null) }, json: async () => items };
    }
    const tid = /agent_jobs%2F(.+?)\.json/.exec(url)[1];
    fetched.push(tid);
    const job = { tender_id: tid, status: 'pending', created_at: `2026-08-01T00:00:${String(all.indexOf(tid) % 60).padStart(2, '0')}Z` };
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(job)).toString('base64'), last_commit_id: 's' }) };
  };

  const jobs = await listAgentJobs(ENV, { fetch: fakeFetch });

  assert.equal(treeUrls.length, 2, 'обидві сторінки дерева прочитані');
  // Зріз до двадцяти робиться ДО читання файлів: інакше кожен зайвий файл —
  // окремий підзапит, а стеля Cloudflare 50 на виклик.
  assert.equal(fetched.length, 20, 'читаємо рівно двадцять файлів, не всі сто п’ятдесят');
  assert.equal(jobs.length, 20);
  assert.deepEqual(fetched.slice().sort(), all.slice(-20).slice().sort(), 'взято саме найновіші двадцять');
});

test('listAgentJobs: 404 (missing tree) → empty array', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  assert.deepEqual(await listAgentJobs(ENV, { fetch: fakeFetch }), []);
});

test('fetchLastCommit: maps GitLab commit shape (short_id/committed_date/title)', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { short_id: 'abc1234', committed_date: '2026-08-19T10:00:00Z', title: 'monitor: state update 2026' },
  ]) });
  const out = await fetchLastCommit(ENV, { fetch: fakeFetch });
  assert.deepEqual(out, { sha: 'abc1234', date: '2026-08-19T10:00:00Z', message: 'monitor: state update 2026' });
});

test('fetchLatestDeployCommit: skips bot-authored commits (same BOT_RE as github.mjs)', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { short_id: 'aaa1111', title: 'agent job UA-X: done', committed_date: '2026-06-27T08:00:00Z' },
    { short_id: 'bbb2222', title: 'feat: add history view', committed_date: '2026-06-25T10:00:00Z' },
  ]) });
  const out = await fetchLatestDeployCommit(ENV, { fetch: fakeFetch });
  assert.equal(out.message, 'feat: add history view');
});

// Ця функція про ДЕПЛОЙ КОДУ, тож читати мусить гілку коду, а не гілку стану.
// На GitHub вони збігалися (стан і код в одній `main`), тому неточність не
// проявлялась. Коли прод-стан переїде в окрему гілку (рішення 23.08.2026 —
// щоб жоден компонент не потребував прав вище Developer), гілка стану матиме
// ЛИШЕ службові коміти, і серед двадцяти прочитаних не знайшлось би жодного
// не-службового: стрічка «останній деплой» у /status спорожніла б за добу.
test('fetchLatestDeployCommit: читає гілку КОДУ (GITLAB_CODE_REF), а не гілку стану', async () => {
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ([
      { short_id: 'ccc3333', title: 'feat: щось у коді', committed_date: '2026-08-23T10:00:00Z' },
    ]) };
  };
  const env = { ...ENV, GITLAB_REF: 'prod-state', GITLAB_CODE_REF: 'main' };
  await fetchLatestDeployCommit(env, { fetch: fakeFetch });
  assert.match(urls[0], /ref_name=main/, 'мусить питати гілку коду');
  assert.doesNotMatch(urls[0], /ref_name=prod-state/, 'гілка стану тут ні до чого');
});

// Сумісність: доки GITLAB_CODE_REF не задано (staging до правки конфіга),
// поведінка лишається як була — читаємо гілку стану. Інакше правка коду
// зламала б staging до того, як там з'явиться нова змінна.
test('fetchLatestDeployCommit: без GITLAB_CODE_REF падає назад на гілку стану', async () => {
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ([
      { short_id: 'ddd4444', title: 'feat: старий шлях', committed_date: '2026-08-23T10:00:00Z' },
    ]) };
  };
  await fetchLatestDeployCommit({ ...ENV, GITLAB_REF: 'staging-state' }, { fetch: fakeFetch });
  assert.match(urls[0], /ref_name=staging-state/);
});

// Дзеркально: журнал дій — це САМЕ службові коміти (`audit:`), тож він мусить
// лишитися на гілці стану. Якби він теж переїхав на код, /log спорожнів би.
test('fetchAuditLog: лишається на гілці СТАНУ, навіть коли задано GITLAB_CODE_REF', async () => {
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ([]) };
  };
  await fetchAuditLog({ ...ENV, GITLAB_REF: 'prod-state', GITLAB_CODE_REF: 'main' }, { fetch: fakeFetch });
  assert.match(urls[0], /ref_name=prod-state/);
});

test('fetchAuditLog: maps title+committed_date for each commit', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
    { title: 'audit: add UA-x · A [1/editor]', committed_date: '2026-05-26T10:00:00Z' },
  ]) });
  const out = await fetchAuditLog(ENV, { fetch: fakeFetch });
  assert.deepEqual(out, [{ message: 'audit: add UA-x · A [1/editor]', date: '2026-05-26T10:00:00Z' }]);
});
