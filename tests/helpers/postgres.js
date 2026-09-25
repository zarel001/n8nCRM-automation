// Starts a throwaway Postgres container initialised exactly like production
// (infra/postgres/10-init-mashsip.sh + db/migrate.sh), for the db and e2e tests.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const IMAGE = 'pgvector/pgvector:pg17';

const PASSWORDS = {
  superuser: 'test-superuser',
  n8n: 'test-n8n',
  admin: 'test-admin',
  bot: 'test-bot',
};

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

async function waitFor(fn, { timeoutMs = 90000, intervalMs = 500 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e.fatal) throw e;
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out: ${lastError ? lastError.message : 'condition not met'}`);
}

async function startPostgres({ name, port, network }) {
  try {
    docker(['rm', '-f', name]);
  } catch {
    /* not running */
  }
  const args = [
    'run', '-d', '--name', name,
    '-e', `POSTGRES_PASSWORD=${PASSWORDS.superuser}`,
    '-e', `N8N_DB_PASSWORD=${PASSWORDS.n8n}`,
    '-e', `CRM_ADMIN_PASSWORD=${PASSWORDS.admin}`,
    '-e', `CRM_BOT_PASSWORD=${PASSWORDS.bot}`,
    '-v', `${path.join(ROOT, 'db')}:/mashsip-db:ro`,
    '-v', `${path.join(ROOT, 'infra/postgres/10-init-mashsip.sh')}:/docker-entrypoint-initdb.d/10-init-mashsip.sh:ro`,
    '-p', `127.0.0.1:${port}:5432`,
  ];
  if (network) args.push('--network', network, '--network-alias', 'postgres');
  args.push(IMAGE);
  docker(args);

  const conn = (user, password) => ({ host: '127.0.0.1', port, user, password, database: 'mashsip' });
  await waitFor(async () => {
    const c = new Client(conn('mashsip_bot', PASSWORDS.bot));
    await c.connect();
    try {
      await c.query('select crm.get_settings()');
      return true;
    } finally {
      await c.end();
    }
  });
  return {
    name,
    port,
    bot: () => conn('mashsip_bot', PASSWORDS.bot),
    admin: () => conn('mashsip_admin', PASSWORDS.admin),
    superuser: () => ({ ...conn('postgres', PASSWORDS.superuser) }),
    logs: () => docker(['logs', name]),
    stop: () => {
      try {
        docker(['rm', '-f', name]);
      } catch {
        /* already gone */
      }
    },
  };
}

// Calls crm.<fn>(jsonb) the way n8n does and returns the jsonb result.
async function call(client, fn, payload = {}) {
  const { rows } = await client.query(`select crm.${fn}($1::jsonb) as result`, [JSON.stringify(payload)]);
  return rows[0].result;
}

module.exports = { startPostgres, call, waitFor, docker, PASSWORDS, ROOT };
