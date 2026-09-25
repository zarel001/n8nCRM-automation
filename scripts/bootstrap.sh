#!/usr/bin/env bash
# First-time setup (safe to re-run): start the database and n8n, load credentials from
# infra/.env, import every workflow, publish them, then start the gate and Caddy.
#   ./scripts/bootstrap.sh
set -euo pipefail

cd "$(dirname "$0")/../infra"
[ -f .env ] || { echo "infra/.env is missing (copy .env.example)"; exit 1; }
set -a; . ./.env; set +a

compose() { docker compose "$@"; }
n8n_cli() { compose exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n "$@"; }

echo "▸ starting postgres + n8n"
compose up -d postgres n8n
until compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; do sleep 3; done

echo "▸ database migrations"
compose exec -T postgres /mashsip-db/migrate.sh

echo "▸ n8n credentials (encrypted with N8N_ENCRYPTION_KEY)"
compose exec -T -e CRM_BOT_PASSWORD -e WHATSAPP_ACCESS_TOKEN -e WHATSAPP_WABA_ID -e ANTHROPIC_API_KEY -e N8N_GATE_TOKEN \
  n8n node /opt/mashsip/scripts/credentials.mjs /tmp/credentials.json
trap 'compose exec -T n8n rm -f /tmp/credentials.json >/dev/null 2>&1 || true' EXIT
n8n_cli n8n import:credentials --input=/tmp/credentials.json
compose exec -T n8n rm -f /tmp/credentials.json

echo "▸ workflows"
n8n_cli n8n import:workflow --separate --input=/opt/mashsip/workflows
# n8n 2.x only runs published workflows (sub-workflows and the error workflow included)
for id in $(compose exec -T n8n node -e '
  const fs = require("fs"); const dir = "/opt/mashsip/workflows";
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) console.log(JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")).id);'); do
  n8n_cli n8n publish:workflow --id="$id" >/dev/null
  echo "  published $id"
done
compose restart n8n
until compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; do sleep 3; done

echo "▸ gate + caddy"
compose up -d --build gate caddy

echo
echo "Done. Next:"
echo "  • Fill in settings:   docker compose exec postgres psql -U postgres -d mashsip -c \"select crm.config_problems()\""
echo "  • Meta webhook URL:   https://${PUBLIC_HOST}/webhook/whatsapp   (verify token = META_VERIFY_TOKEN)"
echo "  • Editor (tunnel):    ssh -L 5678:127.0.0.1:5678 <user>@<vm>  →  http://localhost:5678"
