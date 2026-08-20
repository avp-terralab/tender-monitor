### Task 6: `wrangler.toml` — середовища staging/production

**Files:**
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Produces: два Cloudflare-середовища одного Worker-скрипта, що різняться лише `STATE_BACKEND`, `GITLAB_PROJECT_ID`, `GITLAB_REF` і KV namespace.

⚠️ **Потребує оператора:** id staging KV namespace і project access token GitLab (Task 1) мають бути відомі до цього кроку.

- [ ] **Крок 1: Дописати `wrangler.toml`**

```toml
name = "tender-monitor-bot"
main = "src/index.mjs"
compatibility_date = "2026-05-01"

[[kv_namespaces]]
binding = "EPHEMERAL_KV"
id = "f9c6d80922f24615ab394d3cc1aa7251"   # KV namespace "tender-monitor-ephemeral"

[env.staging]
name = "tender-monitor-bot-staging"
vars = { STATE_BACKEND = "gitlab", GITLAB_PROJECT_ID = "<PROJECT_ID з Task 1>", GITLAB_REF = "staging-state" }

[[env.staging.kv_namespaces]]
binding = "EPHEMERAL_KV"
id = "<staging-kv-id, окремий namespace>"

[env.production]
name = "tender-monitor-bot"
vars = { STATE_BACKEND = "github" }
```

`STATE_BACKEND` у `[env.production]` лишається `"github"` до моменту cutover (Task 10) — код деплоїться заздалегідь, поведінка не міняється.

- [ ] **Крок 2: Секрети (не в `wrangler.toml`, окремо через wrangler)**

```bash
cd worker
wrangler secret put GITLAB_TOKEN --env staging
# (продовий GITHUB_PAT уже є секретом — не чіпається)
```

- [ ] **Крок 3: Перевірити конфіг без деплою**

Run: `wrangler deploy --env staging --dry-run`
Expected: валідна конфігурація, без помилок парсингу.

- [ ] **Крок 4: Commit**

```bash
git add worker/wrangler.toml
git commit -m "worker: add staging/production environments to wrangler.toml"
```

---

