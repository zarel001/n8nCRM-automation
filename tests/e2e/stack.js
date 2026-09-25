// Boots the real stack for end-to-end tests: Postgres (production init scripts), n8n 2.40.7
// (workflows + credentials imported with the same CLI steps as scripts/bootstrap.sh), the webhook
// gate, and mock Graph/Anthropic APIs. Requires Docker.
const fs = require('node:fs');
const { promisify } = require('node:util');
const execFileAsync = promisify(require('node:child_process').execFile);
const path = require('node:path');
const { Client } = require('pg');
const { startPostgres, docker, waitFor, PASSWORDS, ROOT } = require('../helpers/postgres.js');
const { createMockApis } = require('./mock-apis.js');

const NETWORK = 'mashsip-e2e';
const N8N_IMAGE = process.env.N8N_IMAGE || 'n8nio/n8n:2.40.7';
const PORTS = { postgres: 55434, n8n: 55678, mock: 55999, gate: 55880 };
const SECRETS = { appSecret: 'e2e-app-secret', verifyToken: 'e2e-verify', gateToken: 'e2e-gate-token' };
const OWNER = '233200000001';
const PHONE_NUMBER_ID = '1234567890';

async function startStack() {
  try {
    docker(['network', 'create', NETWORK]);
  } catch {
    /* exists */
  }
  const pg = await startPostgres({ name: 'mashsip-e2e-db', port: PORTS.postgres, network: NETWORK });
  const admin = new Client(pg.admin());
  await admin.connect();

  const mock = createMockApis();
  await mock.listen(PORTS.mock);
  const mockUrl = `http://host.docker.internal:${PORTS.mock}`;

  const put = (key, value) => admin.query('select crm.put_setting($1::jsonb)', [JSON.stringify({ key, value })]);
  await put('owner', { wa_id: OWNER, name: 'Owner' });
  await put('momo', { number: '055 886 6617', name: 'Mash & Sip Co.', network: 'MTN MoMo' });
  await put('whatsapp', { graph_base_url: mockUrl, graph_version: 'v26.0', phone_number_id: PHONE_NUMBER_ID, template_language: 'en' });
  await put('ai', { vision_model: 'claude-opus-5', anthropic_base_url: mockUrl });
  await put('catalog_url', `${mockUrl}/api/catalog`);
  await put('alerts', { webhook_url: `${mockUrl}/alert` });
  await put('business', { hours: 'Mon–Sat, 8am–7pm', delivery_areas: 'Accra and Tema', delivery_fee: null, delivery_time: null, storage: 'Keep refrigerated', shelf_life: null, pickup: null, extra_faq: [] });

  const name = 'mashsip-e2e-n8n';
  try {
    docker(['rm', '-f', name]);
  } catch {
    /* not running */
  }
  docker([
    'run', '-d', '--name', name, '--network', NETWORK, '--add-host', 'host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${PORTS.n8n}:5678`,
    '-e', 'DB_TYPE=postgresdb', '-e', 'DB_POSTGRESDB_HOST=postgres', '-e', 'DB_POSTGRESDB_DATABASE=n8n',
    '-e', 'DB_POSTGRESDB_USER=n8n', '-e', `DB_POSTGRESDB_PASSWORD=${PASSWORDS.n8n}`,
    '-e', 'N8N_ENCRYPTION_KEY=e2e-encryption-key-0123456789abcdef',
    '-e', 'GENERIC_TIMEZONE=Africa/Accra', '-e', 'TZ=Africa/Accra',
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false', '-e', 'N8N_TEMPLATES_ENABLED=false',
    '-e', 'N8N_SECURE_COOKIE=false',
    '-e', 'NODES_EXCLUDE=["n8n-nodes-base.form","n8n-nodes-base.formTrigger","n8n-nodes-base.executeCommand","n8n-nodes-base.localFileTrigger","n8n-nodes-base.ssh"]',
    '-e', 'N8N_SSRF_PROTECTION_ENABLED=true', '-e', 'N8N_SSRF_ALLOWED_HOSTNAMES=host.docker.internal',
    '-e', 'EXECUTIONS_DATA_PRUNE=true', '-e', 'EXECUTIONS_DATA_MAX_AGE=168',
    '-e', 'N8N_LOG_LEVEL=info', '-e', 'N8N_LISTEN_ADDRESS=0.0.0.0',
    '-v', `${path.join(ROOT, 'workflows')}:/opt/mashsip/workflows:ro`,
    '-v', `${path.join(ROOT, 'scripts')}:/opt/mashsip/scripts:ro`,
    N8N_IMAGE,
  ]);

  const health = async () => {
    if (docker(['inspect', '-f', '{{.State.Running}}', name]) !== 'true') {
      throw Object.assign(new Error(`n8n container exited:\n${docker(['logs', '--tail', '30', name])}`), { fatal: true });
    }
    return (await fetch(`http://127.0.0.1:${PORTS.n8n}/healthz`)).ok;
  };
  await waitFor(health, { timeoutMs: 180000, intervalMs: 1000 });

  const exec = (args, env = {}) =>
    docker(['exec', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), name, ...args]);
  // One-off CLI runs next to the running instance need their own task-broker port. Async, so the
  // in-process mock APIs keep answering while the CLI's workflow calls them.
  const run = (args) => execFileAsync('docker', ['exec', '-e', 'N8N_RUNNERS_BROKER_PORT=5690', name, ...args], { encoding: 'utf8' });
  exec(['node', '/opt/mashsip/scripts/credentials.mjs', '/tmp/credentials.json'], {
    CRM_BOT_PASSWORD: PASSWORDS.bot,
    WHATSAPP_ACCESS_TOKEN: 'e2e-wa-token',
    WHATSAPP_WABA_ID: '999',
    ANTHROPIC_API_KEY: 'e2e-anthropic-key',
    ANTHROPIC_BASE_URL: mockUrl,
    N8N_GATE_TOKEN: SECRETS.gateToken,
  });
  exec(['n8n', 'import:credentials', '--input=/tmp/credentials.json']);
  exec(['rm', '-f', '/tmp/credentials.json']);
  exec(['n8n', 'import:workflow', '--separate', '--input=/opt/mashsip/workflows']);
  // n8n 2.x only runs published workflows, sub-workflows and the error workflow included
  const ids = fs.readdirSync(path.join(ROOT, 'workflows')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8')).id);
  exec(['sh', '-c', ids.map((id) => `n8n publish:workflow --id=${id}`).join(' && ')]);
  docker(['restart', name]);
  await waitFor(health, { timeoutMs: 180000, intervalMs: 1000 });
  // the production webhook is registered once n8n answers 403 (bad token) instead of 404
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PORTS.n8n}/webhook/wa-inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return r.status === 403 || r.status === 401;
  }, { timeoutMs: 60000, intervalMs: 1000 });

  const { createGate } = await import(path.join(ROOT, 'gate', 'server.mjs'));
  const gate = createGate({
    port: PORTS.gate,
    appSecret: SECRETS.appSecret,
    verifyToken: SECRETS.verifyToken,
    upstreamUrl: `http://127.0.0.1:${PORTS.n8n}/webhook/wa-inbound`,
    upstreamToken: SECRETS.gateToken,
    healthUrl: `http://127.0.0.1:${PORTS.n8n}/healthz`,
    forwardStatuses: 'failed',
    maxBodyBytes: 1024 * 1024,
    upstreamTimeoutMs: 10000,
    path: '/webhook/whatsapp',
  });
  await new Promise((r) => gate.listen(PORTS.gate, '127.0.0.1', r));

  return {
    pg,
    admin,
    mock,
    gateUrl: `http://127.0.0.1:${PORTS.gate}/webhook/whatsapp`,
    n8nLogs: () => docker(['logs', '--tail', '200', name]),
    exec,
    run,
    async stop() {
      await new Promise((r) => gate.close(r));
      await mock.close();
      await admin.end();
      if (!process.env.KEEP_STACK) {
        try {
          docker(['rm', '-f', name]);
        } catch {
          /* gone */
        }
        pg.stop();
      }
    },
  };
}

module.exports = { startStack, SECRETS, OWNER, PHONE_NUMBER_ID, PORTS };
