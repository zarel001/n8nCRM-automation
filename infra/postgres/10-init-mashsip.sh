#!/usr/bin/env bash
# Runs once, when the postgres container starts on an empty data volume.
# Creates n8n's own database plus the CRM database with an owner role and a restricted bot role.
set -euo pipefail
: "${N8N_DB_PASSWORD:?set N8N_DB_PASSWORD}"
: "${CRM_ADMIN_PASSWORD:?set CRM_ADMIN_PASSWORD}"
: "${CRM_BOT_PASSWORD:?set CRM_BOT_PASSWORD}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set n8n_pw="$N8N_DB_PASSWORD" --set admin_pw="$CRM_ADMIN_PASSWORD" --set bot_pw="$CRM_BOT_PASSWORD" <<'SQL'
create role n8n login password :'n8n_pw';
create database n8n owner n8n;
revoke all on database n8n from public;

create role mashsip_admin login password :'admin_pw';
create role mashsip_bot login password :'bot_pw';
create database mashsip owner mashsip_admin;
revoke all on database mashsip from public;
grant connect on database mashsip to mashsip_bot;
SQL

/mashsip-db/migrate.sh
