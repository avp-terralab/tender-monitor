# Task 6 Report: wrangler.toml — staging/production environments

**Date:** 2026-08-20  
**Branch:** `feat/gitlab-state-backend`  
**Commit:** `b341425`

## Status: DONE ✓

All steps completed successfully. Staging Worker deployed and live.

---

## wrangler.toml diff

```diff
diff --git a/worker/wrangler.toml b/worker/wrangler.toml
index 498c89c..da0056b 100644
--- a/worker/wrangler.toml
+++ b/worker/wrangler.toml
@@ -5,3 +5,15 @@ compatibility_date = "2026-05-01"
 [[kv_namespaces]]
 binding = "EPHEMERAL_KV"
 id = "f9c6d80922f24615ab394d3cc1aa7251"   # KV namespace "tender-monitor-ephemeral"
+
+[env.staging]
+name = "tender-monitor-bot-staging"
+vars = { STATE_BACKEND = "gitlab", GITLAB_PROJECT_ID = "14", GITLAB_REF = "staging-state" }
+
+[[env.staging.kv_namespaces]]
+binding = "EPHEMERAL_KV"
+id = "197ecb4e174848aa8efed56ffffa8698"   # staging KV namespace
+
+[env.production]
+name = "tender-monitor-bot"
+vars = { STATE_BACKEND = "github" }
```

---

## Steps executed

### Step 1: Modified wrangler.toml
Added two environment sections:
- **staging**: `tender-monitor-bot-staging` with GitLab backend (project id 14, ref "staging-state"), staging KV namespace
- **production**: `tender-monitor-bot` with GitHub backend (unchanged until Task 10 cutover)

### Step 2: Put GITLAB_TOKEN secret
```bash
cd worker/
wrangler secret put GITLAB_TOKEN --env staging
```

**Output (secrets redacted):**
```
⛅️ wrangler 3.114.17 (update available 4.124.0)
...
🌀 Creating the secret for the Worker "tender-monitor-bot-staging" 
? There doesn't seem to be a Worker called "tender-monitor-bot-staging". Do you want to create a new Worker with that name and add secrets to it?
🤖 Using fallback value in non-interactive context: yes
🌀 Creating new Worker "tender-monitor-bot-staging"...
✨ Success! Uploaded secret GITLAB_TOKEN
Exit code: 0
```

### Step 3: Validate with dry-run deployment
```bash
wrangler deploy --env staging --dry-run
```

**Output:**
```
Total Upload: 257.42 KiB / gzip: 48.11 KiB
Your worker has access to the following bindings:
- KV Namespaces:
  - EPHEMERAL_KV: 197ecb4e174848aa8efed56ffffa8698
- Vars:
  - STATE_BACKEND: "gitlab"
  - GITLAB_PROJECT_ID: "14"
  - GITLAB_REF: "staging-state"
--dry-run: exiting now.
Exit code: 0
```

✓ **Dry-run validation: PASSED**

### Step 3b: Real staging deployment
```bash
wrangler deploy --env staging
```

**Output (shortened):**
```
Total Upload: 257.42 KiB / gzip: 48.11 KiB
Worker Startup Time: 2 ms
Your worker has access to the following bindings:
- KV Namespaces:
  - EPHEMERAL_KV: 197ecb4e174848aa8efed56ffffa8698
- Vars:
  - STATE_BACKEND: "gitlab"
  - GITLAB_PROJECT_ID: "14"
  - GITLAB_REF: "staging-state"
Uploaded tender-monitor-bot-staging (5.06 sec)
Deployed tender-monitor-bot-staging triggers (1.74 sec)
  https://tender-monitor-bot-staging.avp-7d8.workers.dev
Current Version ID: 6c4136a7-09c4-441e-bd2c-22014a210c63
Exit code: 0
```

✓ **Staging Worker deployed live:** https://tender-monitor-bot-staging.avp-7d8.workers.dev

### Step 4: Commit
```bash
git add worker/wrangler.toml
git commit -m "worker: add staging/production environments to wrangler.toml"
```

**Output:**
```
[feat/gitlab-state-backend b341425] worker: add staging/production environments to wrangler.toml
 1 file changed, 12 insertions(+)
```

---

## Verification

✓ Configuration is valid (dry-run passed, exit code 0)  
✓ Staging Worker live and accessible  
✓ All bindings correctly configured:
  - KV namespace: 197ecb4e174848aa8efed56ffffa8698 (staging)
  - STATE_BACKEND: "gitlab" (staging)
  - GITLAB_PROJECT_ID: "14" (staging)
  - GITLAB_REF: "staging-state" (staging)
✓ GITLAB_TOKEN secret stored in Cloudflare (staging environment)  
✓ Changes committed to branch

---

## Fix Round (Code Review Finding)

**Issue:** `[env.production]` was missing `[[env.production.kv_namespaces]]` block. Wrangler environments do not inherit binding blocks from the top-level config; each named environment must redeclare its bindings. This would silently drop the EPHEMERAL_KV binding when Task 10 (cutover) deploys with `--env production`, breaking any code path using KV (e.g., `worker/src/ephemeral.mjs`).

**Fix:** Add the missing KV namespace block to production environment (commit `d06d1a7`)

### Diff:
```diff
diff --git a/worker/wrangler.toml b/worker/wrangler.toml
index da0056b..6273c97 100644
--- a/worker/wrangler.toml
+++ b/worker/wrangler.toml
@@ -17,3 +17,7 @@ id = "197ecb4e174848aa8efed56ffffa8698"   # staging KV namespace
 [env.production]
 name = "tender-monitor-bot"
 vars = { STATE_BACKEND = "github" }
+
+[[env.production.kv_namespaces]]
+binding = "EPHEMERAL_KV"
+id = "f9c6d80922f24615ab394d3cc1aa7251"   # KV namespace "tender-monitor-ephemeral"
```

### Validation:
```bash
cd worker/
wrangler deploy --env production --dry-run
```

**Output:**
```
Total Upload: 257.42 KiB / gzip: 48.11 KiB
Your worker has access to the following bindings:
- KV Namespaces:
  - EPHEMERAL_KV: f9c6d80922f24615ab394d3cc1aa7251
- Vars:
  - STATE_BACKEND: "github"
--dry-run: exiting now.
Exit code: 0
```

✓ **Production environment dry-run validation: PASSED** — KV binding now correctly present

### Commit:
```bash
[feat/gitlab-state-backend d06d1a7] worker: add production KV namespace binding to wrangler.toml
 1 file changed, 4 insertions(+)
```

✓ **Fix verified:** Both staging and production environments now correctly declare their KV namespace bindings.

---

## Next steps

Task 7 onwards can now test against the live staging Worker at:
`https://tender-monitor-bot-staging.avp-7d8.workers.dev`

Environment secrets (GITLAB_TOKEN) are stored in Cloudflare Workers secrets (not in .env or wrangler.toml).
