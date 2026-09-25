#!/usr/bin/env bash
# Deploys a new version of this repo (workflows, migrations, gate) with a backup first.
# To upgrade n8n itself: change the pinned image tag in infra/docker-compose.yml, then run this.
#   git pull && ./scripts/update.sh
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPTS/../infra"
compose() { docker compose "$@"; }
n8n_cli() { compose exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n "$@"; }

"$SCRIPTS/backup.sh"

echo "▸ images"
compose pull postgres n8n caddy
compose up -d --build

until compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; do sleep 3; done

echo "▸ database migrations"
compose exec -T postgres /mashsip-db/migrate.sh

echo "▸ workflows"
n8n_cli n8n import:workflow --separate --input=/opt/mashsip/workflows
for id in $(compose exec -T n8n node -e '
  const fs = require("fs"); const dir = "/opt/mashsip/workflows";
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) console.log(JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")).id);'); do
  n8n_cli n8n publish:workflow --id="$id" >/dev/null
done
compose restart n8n
echo "Updated."
