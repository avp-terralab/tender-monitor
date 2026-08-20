# Task 7 report — `agent_poller.py` GitLab backend

Target repo/worktree for the actual code changes:
`C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\.worktrees\feat-gitlab-state-backend`
(project `tender-agent`, branch `feat/gitlab-state-backend`). This report file
lives here, in the sibling `tender-monitor` worktree, per the plan's convention
(that's also where `task-7-brief.md` was found).

## Two corrections followed (given by the coordinator, checked against real code)

1. **`Config` is a real `@dataclass`** in `scripts/agent_poller.py` (around
   line 56-75 at the start of this task), not a `SimpleNamespace`. New fields
   were added to the dataclass itself, defaults matching its existing style.
   Tests construct `cfg` via
   `ap.Config(repo="r", github_pat="x", telegram_bot_token="y", admin_chat_id="42", backend="gitlab", gitlab_token="glpat-x", gitlab_project_id="99", gitlab_ref="main")`
   — the real dataclass with real field names — not `SimpleNamespace`.
2. **Module import convention**: `tests/test_agent_poller.py` already does
   `import agent_poller as ap` (line 4) and calls `ap.Config(...)`,
   `ap.process_pending(...)`, etc. New tests follow that exact convention
   (`ap.Config`, `ap.make_list_jobs`, `ap.make_set_status`,
   `monkeypatch.setattr(ap, "_gl_request", ...)`), appended to the existing
   file rather than creating a new test file.

## What was built

### 1. `Config` dataclass — four new fields

Added after the existing `timeout: int = 2700` field:

```python
backend: str = "github"
gitlab_token: str = ""
gitlab_project_id: str = ""
gitlab_ref: str = "main"
```

`backend` defaults to `"github"` for backward compatibility — every existing
caller and test that doesn't pass `backend=` keeps behaving exactly as before.

### 2. `import urllib.parse`

Added next to the existing `urllib.request` / `urllib.error` imports at the
top of the module (needed for `urllib.parse.quote` on GitLab file paths; it
wasn't imported before).

### 3. `_gl_request` — new function, added right after `_gh_request`

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

Mirrors `_gh_request`'s shape exactly, just with GitLab's `PRIVATE-TOKEN`
header instead of GitHub's `Authorization: Bearer`.

### 4. `make_list_jobs` / `make_set_status` — GitLab branch added to each

Both factories now check `cfg.backend == "gitlab"` first and return a GitLab
closure in that case; the existing GitHub closure is returned unchanged
otherwise. `main()`'s call sites (`make_list_jobs(cfg)`, `make_set_status(cfg)`)
were **not** touched — same signature, same call shape, regardless of backend.

`list_jobs_gitlab`:
- Lists `_state/agent_jobs/*.json` via GitLab's repository tree API
  (`GET /projects/:id/repository/tree?path=...&ref=...`), filtering to
  `type == "blob"` and a `.json` name.
- For each entry, fetches file content via the Repository Files API
  (`GET /projects/:id/repository/files/:file_path?ref=...`, with the path
  URL-quoted via `urllib.parse.quote(..., safe="")`).
- Decodes `meta["content"]` from base64 (GitLab returns file content
  base64-encoded by default on this endpoint — no encoding-flag needed on
  reads, only on writes, see below).
- Stashes `meta.get("last_commit_id")` into `job["_sha"]`, mirroring the
  GitHub branch's use of `_sha` for the blob sha — so the shared
  `set_status(name, job)` contract (`job["_sha"]` carries whatever
  concurrency token the backend needs) holds for both backends.

`set_status_gitlab`:
- GETs the current file (`?ref=cfg.gitlab_ref`) to read `last_commit_id`.
- Strips the internal `_sha` key from the job dict before serializing.
- Base64-encodes the JSON body and sends `"encoding": "base64"` explicitly
  (see the deviation below for why).
- If a `last_commit_id` was found: PUT (update), with `last_commit_id` in the
  payload as GitLab's optimistic-concurrency token. If not (file doesn't exist
  yet, i.e. `_gl_request` returned `None` for a 404): POST (create), no
  `last_commit_id` in the payload.

### 5. Deviation from the brief's literal code — base64 `content`, deliberate, flagged

The brief's `make_set_status`/`set_status_gitlab` snippet built `content` as
**plain-text** JSON:

```python
content = json.dumps(clean, ensure_ascii=False, indent=2)
payload = {"branch": cfg.gitlab_ref, "content": content, "commit_message": ...}
```

— no base64, no `"encoding"` key. But the brief's **own test** for this
function (`test_make_set_status_gitlab_backend_update`) asserts:

```python
assert "_sha" not in json.loads(base64.b64decode(captured["payload"]["content"]))
```

That assertion requires `payload["content"]` to be valid base64. A plain JSON
string is not: I confirmed by hand that
`base64.b64decode(json.dumps({"a": 1}))` raises
`binascii.Error: Invalid base64-encoded string: number of data characters (…) cannot be 1 more than a multiple of 4`.
So the brief's implementation snippet and its own test contradict each other —
implementing the snippet literally would make it impossible for the test to
pass (Step 4 requires PASS).

**Resolution:** implemented `content` as base64-encoded (matching the existing
GitHub branch's own encoding style) and added `"encoding": "base64"` to the
payload explicitly. This is also the technically correct choice against the
real GitLab API: the Repository Files API defaults `encoding` to `"text"`; had
I sent a base64 string without declaring `encoding: "base64"`, a real GitLab
server would have written the literal base64 text into the file instead of
decoding it — silently corrupting every job file on the first real write. So
the fix satisfies the given test **and** is required for correctness against
the live API, not just a test-pleasing tweak.

### 6. `_main_locked` — read the new fields from `_secrets/agent_poller.json`

Per the brief's instruction to wire the new fields in "за тим самим зразком,
що й наявні github_pat/repo/branch", added to the `Config(...)` construction:

```python
backend=secrets.get("backend", "github"),
gitlab_token=secrets.get("gitlab_token", ""),
gitlab_project_id=secrets.get("gitlab_project_id", ""),
gitlab_ref=secrets.get("gitlab_ref", "main"),
```

Without this, the feature would exist in the module but never be reachable
from the real secrets file used by `main()`.

### 7. `_secrets/agent_poller.example.json` — new example fields (no real values)

```json
"backend": "github",
"_backend_comment": "State backend for the job queue: 'github' (default, backward-compatible) or 'gitlab'. When 'gitlab', the fields below select the target project instead of repo/branch/github_pat.",
"gitlab_token": "glpat-…",
"gitlab_project_id": "99",
"gitlab_ref": "main"
```

### 8. Tests — `tests/test_agent_poller.py`

Added `json, base64` to the top-level import line (`import sys, os, time,
tempfile, datetime, shutil, json, base64` — neither was imported before).
Appended three tests at the end of the file, plain-function style, matching
the file's existing conventions:

- `test_make_list_jobs_gitlab_backend(monkeypatch)` — GitLab tree + file-content
  listing, decodes correctly, `_sha` set from `last_commit_id`, and confirms
  the token travels as a function argument (`fake_gl_request(url, token, ...)`),
  never embedded in the URL string.
- `test_make_set_status_gitlab_backend_update(monkeypatch)` — GET returns an
  existing `last_commit_id` → PUT, with that id carried in the payload and
  `_sha` stripped from the persisted content.
- `test_make_set_status_gitlab_backend_create(monkeypatch)` — **added in the
  fix round below**, see there.

## Exact test commands run, in order, with output

**Initial round — Step 2, confirm new tests fail without the implementation**
(adapted: since `Config` itself needed new fields before `_gl_request` is ever
touched, I isolated the test-only change via
`git stash push -- scripts/agent_poller.py`, ran, then `git stash pop`):

```
$ py -m pytest tests/ -k gitlab_backend -v
tests/test_agent_poller.py::test_make_list_jobs_gitlab_backend FAILED
tests/test_agent_poller.py::test_make_set_status_gitlab_backend_update FAILED
E       TypeError: Config.__init__() got an unexpected keyword argument 'backend'
2 failed, 253 deselected in 1.40s
```

(Failure is `Config` rejecting the new kwargs, not literally
`AttributeError: ... has no attribute '_gl_request'` as the brief's Step 2
states — expected given correction #1: the test builds a real `Config`
instance before `_gl_request` is ever reached. Either way, confirms the tests
fail pre-implementation.)

**Step 4 — new tests pass after implementation:**

```
$ py -m pytest tests/ -k gitlab_backend -v
tests/test_agent_poller.py::test_make_list_jobs_gitlab_backend PASSED
tests/test_agent_poller.py::test_make_set_status_gitlab_backend_update PASSED
2 passed, 253 deselected in 0.50s
```

**Step 5 — full suite, no regressions** (baseline: 253 passing before this
task):

```
$ py -m pytest tests/ -q      # baseline, before any change
253 passed in 39.62s

$ py -m pytest tests/ -q      # after implementation: 253 + 2 new
255 passed in 28.93s

$ py -m pytest tests/ -q      # re-run after wiring _main_locked's secrets read
255 passed in 28.56s
```

**Commit 1:**

```
$ git add scripts/agent_poller.py _secrets/agent_poller.example.json tests/test_agent_poller.py
$ git commit -m "poller: add GitLab backend to make_list_jobs/make_set_status"
[feat/gitlab-state-backend a25f8d5] poller: add GitLab backend to make_list_jobs/make_set_status
 3 files changed, 143 insertions(+), 6 deletions(-)
```

Commit hash: **`a25f8d5`** (branch `feat/gitlab-state-backend`, parent
`a1f2056`).

## Fix round (post-review)

Review of `a25f8d5` raised two findings:

1. **This report file was never written** — confirmed: it did not exist at
   this path. Root cause: I had written a full report, but to the wrong
   workspace (the `tender-agent` worktree instead of this `tender-monitor`
   worktree, where the brief itself and all other task reports for this plan
   live). Fixed by writing this file here.
2. **`test_make_set_status_gitlab_backend_update` only covers the PUT/update
   branch** — its `fake_gl_request` always returns
   `{"last_commit_id": "old-commit"}` on GET, so the POST/create branch (first
   write for a tender, GET → 404 → `_gl_request` returns `None` →
   `last_commit_id=None` → method must be `"POST"`, no `last_commit_id` key in
   the payload) was never exercised.

### Fix for finding 2 — new test

Added `test_make_set_status_gitlab_backend_create` right after the existing
update test in `tests/test_agent_poller.py`:

```python
def test_make_set_status_gitlab_backend_create(monkeypatch):
    cfg = ap.Config(repo="r", github_pat="x", telegram_bot_token="y", admin_chat_id="42",
                    backend="gitlab", gitlab_token="glpat-x",
                    gitlab_project_id="99", gitlab_ref="main")
    captured = {}

    def fake_gl_request(url, token, *, method="GET", payload=None):
        if method == "GET":
            return None  # 404 — _gl_request already turns that into None
        captured["payload"] = payload
        captured["method"] = method
        return {}

    monkeypatch.setattr(ap, "_gl_request", fake_gl_request)
    set_status = ap.make_set_status(cfg)
    set_status("UA-2.json", {"tender_id": "UA-2", "status": "pending"})
    assert captured["method"] == "POST"
    assert "last_commit_id" not in captured["payload"]
    print("OK make_set_status_gitlab_backend_create")
```

No implementation change was needed — `make_set_status`'s `set_status_gitlab`
already branches correctly on `last_commit_id` being falsy (the `if
last_commit_id: ... else: method = "POST"` in the existing implementation);
this test simply closes the coverage gap the review identified.

### Fix-round test commands and output

```
$ py -m pytest tests/ -k gitlab_backend -v
tests/test_agent_poller.py::test_make_list_jobs_gitlab_backend PASSED
tests/test_agent_poller.py::test_make_set_status_gitlab_backend_update PASSED
tests/test_agent_poller.py::test_make_set_status_gitlab_backend_create PASSED
3 passed, 253 deselected in 1.00s

$ py -m pytest tests/ -q
........................................................................ [ 28%]
........................................................................ [ 56%]
........................................................................ [ 84%]
........................................                                 [100%]
256 passed in 31.52s
```

256 passed = 255 (previous total) + 1 new test. No regressions.

### Fix-round commit

```
$ git add tests/test_agent_poller.py
$ git commit -m "poller: add missing test for GitLab set_status create/404 path"
[feat/gitlab-state-backend ce99b87] poller: add missing test for GitLab set_status create/404 path
 1 file changed, 21 insertions(+)
```

Commit hash: **`ce99b87`** (branch `feat/gitlab-state-backend`, parent
`a25f8d5`).

## Files touched (both commits combined)

- `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\scripts\agent_poller.py`
- `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\tests\test_agent_poller.py`
- `C:\Users\andre\Desktop\AI\Агент підготовки пропозицій\_secrets\agent_poller.example.json`

(all worktree-relative — same files in the `feat-gitlab-state-backend`
worktree)

## Scope notes

- `main()`'s call sites were not touched — factories return the same closure
  signature regardless of backend.
- The GitHub branch of both factories is byte-for-byte unchanged (confirmed:
  the pre-existing 253 baseline tests still pass unmodified).
- No other file in the repo references `cfg.backend` yet — this task only
  adds the capability to `agent_poller.py`; flipping `_secrets/agent_poller.json`
  to `"backend": "gitlab"` in a real deployment is out of scope for Task 7.
