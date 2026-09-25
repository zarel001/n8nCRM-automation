#!/usr/bin/env bash
# Nightly backup of both databases (n8n + CRM), encrypted when BACKUP_PASSPHRASE is set.
# Keeps 14 days locally. Copy backups/ off the VM too (e.g. Oracle Object Storage via rclone):
# a backup on the same disk doesn't survive losing the VM.
#   crontab: 30 2 * * * /home/ubuntu/n8nCRM-automation/scripts/backup.sh >> /var/log/mashsip-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/backups"
mkdir -p "$OUT"
chmod 700 "$OUT"
cd "$ROOT/infra"
[ -f .env ] && { set -a; . ./.env; set +a; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for db in n8n mashsip; do
  file="$OUT/$db-$stamp.dump"
  docker compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$file"
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -in "$file" -out "$file.enc"
    rm -f "$file"
    file="$file.enc"
  fi
  chmod 600 "$file"
  echo "backup: $(basename "$file") ($(du -h "$file" | cut -f1))"
done

find "$OUT" -type f -mtime +14 -delete
