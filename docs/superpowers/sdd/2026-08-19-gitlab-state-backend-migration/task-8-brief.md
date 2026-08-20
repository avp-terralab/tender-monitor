### Task 8: GitLab CI для `tender-monitor`

**Files:**
- Create: `.gitlab-ci.yml` (у проєкті `terralab-manual/tender-monitor`)

**Interfaces:**
- Consumes: masked CI-змінні `GITLAB_TOKEN` (project access token, для деплой-джобів), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (ті самі, що вже в GitHub Actions).

- [ ] **Крок 1: Додати CI-змінні через API (masked, protected)**

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "key=CLOUDFLARE_API_TOKEN" --data-urlencode "value=<...>" \
  --data-urlencode "masked=true" --data-urlencode "protected=true" \
  "$GITLAB_URL/api/v4/projects/<PROJECT_ID>/variables"
# повторити для CLOUDFLARE_ACCOUNT_ID
```

- [ ] **Крок 2: Написати `.gitlab-ci.yml`**

```yaml
stages:
  - test
  - deploy

test:
  stage: test
  script:
    - node --test test/*.test.mjs worker/test/*.test.mjs

deploy-staging:
  stage: deploy
  when: manual
  script:
    - cd worker && npm install --no-save wrangler@^3 && npx wrangler deploy --env staging

monitor-staging:
  stage: test
  script:
    - node ci.mjs
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $SCHEDULE_TARGET == "staging"'

deploy-production:
  stage: deploy
  script:
    - cd worker && npm install --no-save wrangler@^3 && npx wrangler deploy --env production
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: manual
```

- [ ] **Крок 3: Створити Scheduled Pipeline (staging cron) через API**

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "description=staging monitor cron" \
  --data-urlencode "ref=staging-state" \
  --data-urlencode "cron=*/15 * * * *" \
  --data-urlencode "variables[][key]=SCHEDULE_TARGET" \
  --data-urlencode "variables[][value]=staging" \
  "$GITLAB_URL/api/v4/projects/<PROJECT_ID>/pipeline_schedules"
```

- [ ] **Крок 4: Валідувати YAML перед пушем**

```bash
python3 -c "
import json, urllib.request
content = open('.gitlab-ci.yml', encoding='utf-8').read()
req = urllib.request.Request(
    '$GITLAB_URL/api/v4/projects/<PROJECT_ID>/ci/lint',
    data=json.dumps({'content': content}).encode('utf-8'),
    headers={'PRIVATE-TOKEN': '$GITLAB_TOKEN', 'Content-Type': 'application/json'},
    method='POST')
print(json.load(urllib.request.urlopen(req)))
"
```

Expected: `{'valid': True, 'errors': [], ...}`

- [ ] **Крок 5: Push і перевірити перший тестовий пайплайн**

```bash
git checkout -b ci/gitlab-pipeline
git add .gitlab-ci.yml
git commit -m "ci: add GitLab CI (test, staging schedule, staging/prod deploy)"
git push gitlab ci/gitlab-pipeline
```

Перевірити через API, що `test`-джоба на цьому пуші пройшла (`status: success`).

---

