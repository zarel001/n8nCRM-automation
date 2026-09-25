# Runbook

All commands run on the VM from the repo root unless noted. Shorthand:

```bash
alias dc='docker compose -f infra/docker-compose.yml'
alias crm='dc exec postgres psql -U postgres -d mashsip'
```

## Routine

- **Uptime monitor:** point a free monitor (UptimeRobot, Better Stack) at `https://<PUBLIC_HOST>/healthz`. It checks the gate and n8n.
- **Alerts:** set `alerts.webhook_url` (Discord/Slack). Failed sends and workflow errors post there immediately.
- **Weekly:** `crm -c "select created_at, level, source, message from crm.ops_events order by id desc limit 30"` and read a few conversations (`crm.messages`).
- **Backups:** `crontab -e` → `30 2 * * * /home/ubuntu/n8nCRM-automation/scripts/backup.sh >> /home/ubuntu/backup.log 2>&1`. Set `BACKUP_PASSPHRASE` in `.env` and copy `backups/` off the VM (e.g. rclone to Oracle Object Storage, 20 GB free).

## Everyday tasks

| Task | How |
|---|---|
| Open the n8n editor | `ssh -L 5678:127.0.0.1:5678 ubuntu@<vm>` → http://localhost:5678 (first visit: create the owner account) |
| See orders | `crm -c "select * from crm.v_orders limit 20"` |
| Change a fact, MoMo detail or owner number | `crm -c "set role mashsip_admin; select crm.put_setting('{\"key\":\"business\",\"value\":{…}}')"` (takes effect on the next message) |
| Change prices | Edit `lib/site-config.ts` in the storefront and deploy; the bot syncs within the hour |
| Run housekeeping now | `dc exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=MsHousekeep00001` |
| Switch the AI model | `src/workflows/agent.mjs` (`Claude` node) + `settings.ai.vision_model`, then deploy below |
| Logs | `dc logs -f gate` (signature failures, n8n reachability) · `dc logs -f n8n` · executions in the editor |

## Deploying changes

1. Edit `src/` or `prompts/`, then `npm test && npm run build && npm run test:e2e`, commit, push.
2. On the VM: `git pull && ./scripts/update.sh`. It backs up, pulls pinned images, migrates, re-imports and publishes all workflows, then restarts.

Don't edit workflows in the n8n editor: the next deploy overwrites them. Prototype there if you like, then move the change into `src/workflows/`.

## Updating n8n (security releases)

Watch [n8n security advisories](https://github.com/n8n-io/n8n/security/advisories). To upgrade, change the `n8nio/n8n:<version>` tag in `infra/docker-compose.yml`, run the e2e suite locally with `N8N_IMAGE=n8nio/n8n:<version> npm run test:e2e`, then deploy. Patch critical advisories within days; the webhook gate buys time but isn't a substitute.

## Rotating secrets

| Secret | Steps |
|---|---|
| WhatsApp token | New System User token → `.env` → `./scripts/bootstrap.sh` |
| Meta app secret | Reset in Meta → `.env` → `dc up -d gate` |
| Gate token | `.env` → `./scripts/bootstrap.sh` (updates n8n) → `dc up -d gate` |
| Anthropic key | New key → `.env` → `./scripts/bootstrap.sh` |
| DB passwords | `ALTER ROLE … PASSWORD` in psql → `.env` → `./scripts/bootstrap.sh` → `dc up -d` |

## Incidents

| Symptom | Check | Fix |
|---|---|---|
| Bot silent | `/healthz`; `dc logs gate` | `invalid signature` → `META_APP_SECRET` mismatch. `n8n unreachable` → `dc up -d n8n`. No requests at all → Meta webhook subscription (setup §5) |
| Alert "send failed … (#190)" | Token expired or revoked | New System User token (rotation above) |
| Alert "send failed … (#131047)" | Customer's 24 h window closed | Expected for late free-form replies; the owner should call |
| Owner gets no alerts | `select crm.config_problems()`; template status in WhatsApp Manager | Fix `owner.wa_id`; approve templates; meanwhile the owner can message the bot to open her window |
| Payment approval refused "already used" | Same transaction ID approved on another order | Check the MoMo statement; likely a reused screenshot |
| Customer stuck with the bot paused | `select id, bot_paused_until from crm.customers where wa_id='…'` | Owner sends `/done`, or it clears 30 minutes after the owner's last message |
| VM stopped by Oracle | OCI console | Start it; upgrade to Pay-As-You-Go (setup §1.2) |
| Disk full | `df -h`, `docker system df` | `docker image prune -a`, trim `backups/` |

## Restore

```bash
dc stop n8n gate
cat backups/mashsip-<stamp>.dump | dc exec -T postgres pg_restore -U postgres -d mashsip --clean --if-exists
cat backups/n8n-<stamp>.dump     | dc exec -T postgres pg_restore -U postgres -d n8n --clean --if-exists
dc up -d        # needs the same N8N_ENCRYPTION_KEY as when the backup was taken
```
Encrypted backups: `openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in file.dump.enc -out file.dump` first.
