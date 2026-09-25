#!/usr/bin/env bash
# Applies db/migrations/*.sql (each once, in order), then roles.sql and the idempotent seed.
# Runs inside the postgres container as the superuser; objects are created as mashsip_admin.
#   docker compose exec postgres /mashsip-db/migrate.sh
set -euo pipefail

DB_DIR="$(cd "$(dirname "$0")" && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 --no-psqlrc -q --username "${POSTGRES_USER:-postgres}" --dbname mashsip)

"${PSQL[@]}" -c "create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
)"

for file in "$DB_DIR"/migrations/*.sql; do
  name="$(basename "$file")"
  if [ -z "$("${PSQL[@]}" -tAc "select 1 from public.schema_migrations where filename = '$name'")" ]; then
    echo "migrate: applying $name"
    "${PSQL[@]}" -c "set role mashsip_admin" -f "$file"
    "${PSQL[@]}" -c "insert into public.schema_migrations (filename) values ('$name')"
  fi
done

"${PSQL[@]}" -c "set role mashsip_admin" -f "$DB_DIR/roles.sql"
"${PSQL[@]}" -c "set role mashsip_admin" -f "$DB_DIR/seed/settings.sql"
echo "migrate: done"
