### Task 7: `agent_poller.py` — GitLab-бекенд (проєкт `tender-agent`)

**Files:**
- Modify: `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\agent_poller.py:978-1128`
- Modify: `_secrets/agent_poller.example.json` (додати приклад полів)
- Test: наявний тестовий файл поллера (той, що покриває `make_list_jobs`/`make_set_status`)

**Interfaces:**
- Consumes: `cfg.backend` (`"github"`/`"gitlab"`), `cfg.gitlab_token`, `cfg.gitlab_project_id`, `cfg.gitlab_ref`.
- Produces: `make_list_jobs(cfg)`/`make_set_status(cfg)` повертають те саме замикання незалежно від бекенду — виклики з `main()` не змінюються.

- [ ] **Крок 1: Написати падаючі тести на GitLab-гілку фабрик**

Додати в тестовий файл поллера:

```python
def test_make_list_jobs_gitlab_backend(monkeypatch):
    cfg = SimpleNamespace(
        backend="gitlab", gitlab_token="glpat-x",
        gitlab_project_id="99", gitlab_ref="main",
    )
    calls = []

    def fake_gl_request(url, token, *, method="GET", payload=None):
        calls.append((url, token, method))
        if "tree" in url:
            return [{"name": "UA-1.json", "path": "_state/agent_jobs/UA-1.json", "type": "blob"}]
        content = base64.b64encode(json.dumps({"tender_id": "UA-1"}).encode()).decode()
        return {"content": content, "last_commit_id": "c1"}

    monkeypatch.setattr(agent_poller, "_gl_request", fake_gl_request)
    list_jobs = agent_poller.make_list_jobs(cfg)
    jobs = list_jobs()
    assert len(jobs) == 1
    assert jobs[0][1]["tender_id"] == "UA-1"
    assert jobs[0][1]["_sha"] == "c1"
    assert any("PRIVATE-TOKEN" not in str(c) for c in calls)  # токен передається окремим аргументом, не в url


def test_make_set_status_gitlab_backend_update(monkeypatch):
    cfg = SimpleNamespace(
        backend="gitlab", gitlab_token="glpat-x",
        gitlab_project_id="99", gitlab_ref="main",
    )
    captured = {}

    def fake_gl_request(url, token, *, method="GET", payload=None):
        if method == "GET":
            return {"last_commit_id": "old-commit"}
        captured["payload"] = payload
        captured["method"] = method
        return {}

    monkeypatch.setattr(agent_poller, "_gl_request", fake_gl_request)
    set_status = agent_poller.make_set_status(cfg)
    set_status("UA-1.json", {"tender_id": "UA-1", "status": "done", "_sha": "old-commit"})
    assert captured["method"] == "PUT"
    assert captured["payload"]["last_commit_id"] == "old-commit"
    assert "_sha" not in json.loads(base64.b64decode(captured["payload"]["content"]))
```

- [ ] **Крок 2: Прогнати — FAIL**

Run: `py -m pytest tests/ -k gitlab_backend -v`
Expected: FAIL, `AttributeError: module 'agent_poller' has no attribute '_gl_request'`

- [ ] **Крок 3: Реалізувати GitLab-гілку в `agent_poller.py`**

Додати поруч із наявним `_gh_request` (після рядка 1001):

```python
_GL_API = "https://cl-gl.listerralab.com/api/v4"


def _gl_request(url, token, *, method="GET", payload=None):
    """Issue an authenticated GitLab API request; return parsed JSON or None."""
    data = None
    headers = {"PRIVATE-TOKEN": token}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
```

Далі перевести `make_list_jobs`/`make_set_status` (рядки 1004-1058) на дві гілки за `cfg.backend`:

```python
def make_list_jobs(cfg):
    """Return a list_jobs() that lists pending job files from the bot repo."""
    if cfg.backend == "gitlab":
        def list_jobs_gitlab():
            url = "%s/projects/%s/repository/tree?path=%s&ref=%s" % (
                _GL_API, cfg.gitlab_project_id, _JOBS_DIR, cfg.gitlab_ref)
            entries = _gl_request(url, cfg.gitlab_token)
            if not entries:
                return []
            out = []
            for entry in entries:
                if entry.get("type") != "blob" or not entry.get("name", "").endswith(".json"):
                    continue
                file_url = "%s/projects/%s/repository/files/%s?ref=%s" % (
                    _GL_API, cfg.gitlab_project_id,
                    urllib.parse.quote(entry["path"], safe=""), cfg.gitlab_ref)
                meta = _gl_request(file_url, cfg.gitlab_token)
                if not meta or "content" not in meta:
                    continue
                raw = base64.b64decode(meta["content"]).decode("utf-8")
                try:
                    job = json.loads(raw)
                except ValueError:
                    continue
                job["_sha"] = meta.get("last_commit_id")
                out.append((entry["name"], job))
            return out
        return list_jobs_gitlab

    def list_jobs():
        url = "%s/repos/%s/contents/%s" % (_GH_API, cfg.repo, _JOBS_DIR)
        entries = _gh_request(url, cfg.github_pat)
        if not entries:
            return []
        out = []
        for entry in entries:
            if not entry.get("name", "").endswith(".json"):
                continue
            file_url = "%s/repos/%s/contents/%s/%s" % (
                _GH_API, cfg.repo, _JOBS_DIR, entry["name"])
            meta = _gh_request(file_url, cfg.github_pat)
            if not meta or "content" not in meta:
                continue
            raw = base64.b64decode(meta["content"]).decode("utf-8")
            try:
                job = json.loads(raw)
            except ValueError:
                continue
            job["_sha"] = meta.get("sha")
            out.append((entry["name"], job))
        return out
    return list_jobs


def make_set_status(cfg):
    """Return a set_status(name, job) that writes the job file back to the repo."""
    if cfg.backend == "gitlab":
        def set_status_gitlab(name, job):
            file_path = urllib.parse.quote("%s/%s" % (_JOBS_DIR, name), safe="")
            url = "%s/projects/%s/repository/files/%s" % (_GL_API, cfg.gitlab_project_id, file_path)
            current = _gl_request(url + "?ref=" + cfg.gitlab_ref, cfg.gitlab_token)
            last_commit_id = current.get("last_commit_id") if isinstance(current, dict) else None
            clean = {k: v for k, v in job.items() if k != "_sha"}
            content = json.dumps(clean, ensure_ascii=False, indent=2)
            payload = {
                "branch": cfg.gitlab_ref,
                "content": content,
                "commit_message": "agent job %s: %s" % (job.get("tender_id", name), job.get("status", "?")),
            }
            if last_commit_id:
                payload["last_commit_id"] = last_commit_id
                method = "PUT"
            else:
                method = "POST"
            _gl_request(url, cfg.gitlab_token, method=method, payload=payload)
        return set_status_gitlab

    def set_status(name, job):
        url = "%s/repos/%s/contents/%s/%s" % (_GH_API, cfg.repo, _JOBS_DIR, name)
        current = _gh_request(url + "?ref=" + cfg.branch, cfg.github_pat)
        sha = current.get("sha") if isinstance(current, dict) else None
        clean = {k: v for k, v in job.items() if k != "_sha"}
        content = base64.b64encode(
            json.dumps(clean, ensure_ascii=False, indent=2).encode("utf-8")
        ).decode("ascii")
        payload = {
            "message": "agent job %s: %s" % (job.get("tender_id", name), job.get("status", "?")),
            "content": content,
            "branch": cfg.branch,
        }
        if sha:
            payload["sha"] = sha
        _gh_request(url, cfg.github_pat, method="PUT", payload=payload)
    return set_status
```

Додати `import urllib.parse` до наявних імпортів на початку файлу, якщо його там ще немає.

У `Config`/`load_config` (де читається `_secrets/agent_poller.json`) додати поля `backend` (типово `"github"` — зворотна сумісність), `gitlab_token`, `gitlab_project_id`, `gitlab_ref` за тим самим зразком, що й наявні `github_pat`/`repo`/`branch`.

- [ ] **Крок 4: Прогнати тести — PASS**

Run: `py -m pytest tests/ -k gitlab_backend -v`
Expected: обидва нові тести проходять.

- [ ] **Крок 5: Прогнати весь набір поллера — без регресій**

Run: `py -m pytest tests/ -q`
Expected: усі наявні 33+ тести на GitHub-гілку далі проходять незмінно (`cfg.backend` типово `"github"`).

- [ ] **Крок 6: Оновити `_secrets/agent_poller.example.json`**

Додати (без реальних значень) поля `backend`, `gitlab_token`, `gitlab_project_id`, `gitlab_ref` до прикладу структури, з коментарем про признач кожного.

- [ ] **Крок 7: Commit**

```bash
cd "C:/Users/andre/Desktop/AI/Агент підготовки пропозицій"
git add scripts/agent_poller.py _secrets/agent_poller.example.json tests/
git commit -m "poller: add GitLab backend to make_list_jobs/make_set_status"
```

---

