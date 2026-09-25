#!/usr/bin/env node
// Runs the whole stack on your machine (on Windows: inside WSL2). See docs/local.md.
//
//   npm run demo            WhatsApp + Claude simulated; plays a full customer journey
//   npm run local:whatsapp  real Meta test number + real Claude through a Cloudflare tunnel
//   npm run demo:stop | local:stop      stop (keeps data)
//   npm run demo:reset | local:reset    stop and delete the local database
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = path.join(ROOT, 'infra');
const MODES = {
  demo: { project: 'mashsip-demo', envFile: '.env.demo', profiles: 'demo', edge: 'gate mock' },
  whatsapp: { project: 'mashsip-local', envFile: '.env.local', profiles: 'whatsapp', edge: 'gate tunnel' },
};
const GATE = 'http://127.0.0.1:8080/webhook/whatsapp';
const MOCK = 'http://127.0.0.1:55999';
const DEMO = { customer: '233241234567', customerName: 'Akosua', owner: '233200000001', phoneNumberId: '1234567890' };
const GENERATED = ['POSTGRES_SUPERUSER_PASSWORD', 'N8N_DB_PASSWORD', 'CRM_ADMIN_PASSWORD', 'CRM_BOT_PASSWORD', 'N8N_ENCRYPTION_KEY', 'META_VERIFY_TOKEN', 'N8N_GATE_TOKEN', 'BACKUP_PASSPHRASE'];
const LOCAL_EXTRAS = `
# ── Local test settings (npm run local:whatsapp) ─────────────────────────────────────────────
# Meta app → WhatsApp → API Setup → "Phone number ID" of the test number
WHATSAPP_PHONE_NUMBER_ID=
# The owner's WhatsApp number for approvals/alerts, digits with country code (e.g. 233241234567).
# Use a different phone to play the customer.
OWNER_WA_ID=
# Values with spaces or & need quotes.
MOMO_NUMBER="055 886 6617"
MOMO_NAME="Mash & Sip Co."
`;

const secret = () => randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// ─── env files ────────────────────────────────────────────────────────────────────────────────

function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// Windows editors can save CRLF, which bash would read into every value.
function normalizeEol(file) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('\r')) writeFileSync(file, text.replace(/\r\n?/g, '\n'), { mode: 0o600 });
}

// Fills empty KEY= lines, keeping comments and order.
function fillEnv(file, values) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return m && m[2] === '' && values[m[1]] !== undefined ? `${m[1]}=${values[m[1]]}` : line;
  });
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

function prepareEnv(mode) {
  const file = path.join(INFRA, MODES[mode].envFile);
  if (mode === 'demo') {
    if (!existsSync(file)) {
      copyFileSync(path.join(INFRA, '.env.example'), file);
      chmodSync(file, 0o600);
      fillEnv(file, {
        PUBLIC_HOST: 'localhost', ACME_EMAIL: 'dev@localhost', META_APP_SECRET: secret(),
        WHATSAPP_ACCESS_TOKEN: 'demo-token', WHATSAPP_WABA_ID: '999', ANTHROPIC_API_KEY: 'demo-key',
        ...Object.fromEntries(GENERATED.map((k) => [k, secret()])),
      });
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nANTHROPIC_BASE_URL=http://mock:55999\n`, { mode: 0o600 });
    }
    return readEnv(file);
  }

  if (!existsSync(file)) {
    copyFileSync(path.join(INFRA, '.env.example'), file);
    chmodSync(file, 0o600);
    writeFileSync(file, readFileSync(file, 'utf8') + LOCAL_EXTRAS);
    fillEnv(file, { PUBLIC_HOST: 'localhost', ACME_EMAIL: 'dev@localhost', ...Object.fromEntries(GENERATED.map((k) => [k, secret()])) });
    fail(`Created infra/${MODES[mode].envFile}. Fill in the Meta values, your Anthropic key and the local test settings at the bottom, then run this again (docs/local.md).`);
  }
  normalizeEol(file);
  const env = readEnv(file);
  fillEnv(file, Object.fromEntries(GENERATED.filter((k) => !env[k]).map((k) => [k, secret()])));
  const needed = ['META_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WABA_ID', 'ANTHROPIC_API_KEY', 'WHATSAPP_PHONE_NUMBER_ID', 'OWNER_WA_ID'];
  const missing = needed.filter((k) => !readEnv(file)[k]);
  if (missing.length) fail(`Fill these in infra/${MODES[mode].envFile}: ${missing.join(', ')}`);
  if (!/^\d{9,15}$/.test(readEnv(file).OWNER_WA_ID)) fail('OWNER_WA_ID must be digits with the country code, e.g. 233241234567');
  return readEnv(file);
}

// ─── docker compose ───────────────────────────────────────────────────────────────────────────

function composeEnv(mode) {
  const m = MODES[mode];
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: m.project,
    COMPOSE_FILE: 'docker-compose.yml:docker-compose.local.yml',
    COMPOSE_PROFILES: m.profiles,
    ENV_FILE: m.envFile,
    EDGE_SERVICES: m.edge,
  };
}

function compose(mode, args, input) {
  return execFileSync('docker', ['compose', '--env-file', MODES[mode].envFile, ...args], {
    cwd: INFRA, env: composeEnv(mode), encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

function checkPrerequisites() {
  if (process.platform === 'win32') fail('On Windows, run this in the Ubuntu (WSL2) terminal, not PowerShell or cmd. See docs/local.md.');
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) fail(`Node 22+ needed (you have ${process.versions.node}).`);
  const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (r.status !== 0) fail('Docker with the compose plugin is needed (Windows: Docker Desktop with WSL integration for your distro).');
  const info = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (info.status !== 0) fail('Docker is installed but not running. Start Docker Desktop and try again.');
}

function bootstrap(mode) {
  console.log('▸ starting the stack (first run pulls images; a few minutes)…');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'bootstrap.sh')], { env: composeEnv(mode), stdio: 'inherit' });
  if (r.status !== 0) fail('bootstrap failed (see the output above).');
}

const sqlText = (value) => `'${JSON.stringify(value).replace(/'/g, "''")}'`;

function applySettings(mode, settings) {
  const sql = ['set role mashsip_admin;']
    .concat(Object.entries(settings).map(([key, value]) => `select crm.put_setting(${sqlText({ key, value })}::jsonb);`))
    .join('\n');
  compose(mode, ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'mashsip', '-v', 'ON_ERROR_STOP=1', '-q'], sql);
}

// ─── demo conversation ────────────────────────────────────────────────────────────────────────

let seq = 0;

async function send(appSecret, from, name, message) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '233558866617', phone_number_id: DEMO.phoneNumberId },
      contacts: [{ profile: { name }, wa_id: from }],
      messages: [{ from, id: `wamid.demo.${Date.now()}.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
    } }] }],
  };
  const raw = JSON.stringify(payload);
  const res = await fetch(GATE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}` },
    body: raw,
  });
  if (res.status !== 200) fail(`the gate answered ${res.status}`);
}

async function outbound() {
  const log = await (await fetch(`${MOCK}/_log`)).json();
  return log
    .filter((e) => e.method === 'POST' && /\/messages$/.test(e.path) && e.body && e.body.messaging_product && !e.body.status)
    .map((e) => e.body);
}

async function waitFor(count, since, timeoutMs = 90000) {
  const started = Date.now();
  let msgs = [];
  while (Date.now() - started < timeoutMs) {
    msgs = (await outbound()).slice(since);
    if (msgs.length >= count) {
      await sleep(1200);
      return (await outbound()).slice(since);
    }
    await sleep(500);
  }
  fail(`timed out waiting for the bot (got ${msgs.length}/${count} replies). Check executions at http://localhost:5678`);
}

function describe(m) {
  switch (m.type) {
    case 'text':
      return m.text.body;
    case 'interactive': {
      const i = m.interactive;
      const buttons = i.action && i.action.buttons ? `\n[ ${i.action.buttons.map((b) => b.reply.title).join(' ] [ ')} ]` : '';
      const extra = i.type === 'location_request_message' ? '\n[ 📍 Send location ]' : '';
      const image = i.header && i.header.type === 'image' ? '🖼  (payment screenshot attached)\n' : '';
      return `${image}${i.body.text}${buttons}${extra}`;
    }
    case 'template':
      return `[template "${m.template.name}"] ${m.template.components.filter((c) => c.type === 'body').flatMap((c) => c.parameters.map((p) => p.text)).join(' | ')}`;
    default:
      return `[${m.type}]`;
  }
}

function print(who, text) {
  console.log(`\n${who}\n   ${String(text).replace(/\n/g, '\n   ')}`);
}

async function say(ctx, from, text, expect) {
  const since = (await outbound()).length;
  print(from === DEMO.owner ? '👩🏾‍🍳 Owner:' : `🙋🏾 ${DEMO.customerName}:`, text);
  await send(ctx.appSecret, from, from === DEMO.owner ? 'Owner' : DEMO.customerName, { type: 'text', text: { body: text } });
  return show(await waitFor(expect, since));
}

async function act(ctx, from, message, label, expect) {
  const since = (await outbound()).length;
  print(from === DEMO.owner ? '👩🏾‍🍳 Owner:' : `🙋🏾 ${DEMO.customerName}:`, label);
  await send(ctx.appSecret, from, from === DEMO.owner ? 'Owner' : DEMO.customerName, message);
  return show(await waitFor(expect, since));
}

function show(msgs) {
  for (const m of msgs) print(m.to === DEMO.owner ? '🤖 → owner:' : `🤖 → ${DEMO.customerName}:`, describe(m));
  return msgs;
}

const buttonId = (msgs, prefix) => {
  for (const m of msgs) {
    const ids = [
      ...((m.interactive && m.interactive.action && m.interactive.action.buttons) || []).map((b) => b.reply.id),
      ...((m.template && m.template.components) || []).filter((c) => c.type === 'button').map((c) => c.parameters[0].payload),
    ];
    const id = ids.find((x) => x.startsWith(prefix));
    if (id) return id;
  }
  fail(`no "${prefix}" button in the bot's messages`);
};

async function runDemo(env) {
  const ctx = { appSecret: env.META_APP_SECRET };
  // a new customer each run, so re-runs don't collide with the previous run's orders or alerts
  DEMO.customer = `23324${String(Date.now()).slice(-7)}`;
  await fetch(`${MOCK}/_reset`, { method: 'POST' });
  console.log('\n━━━ Demo conversation (WhatsApp and Claude are simulated) ━━━');

  await say(ctx, DEMO.owner, '/help', 1);
  const order = await say(ctx, DEMO.customer, 'Order: Cinnamon 250ml x2\nName: Akosua Mensah', 1);
  const total = Number((describe(order[0]).match(/Total: GHS ([\d.]+)/) || [])[1] || 0);
  const code = (describe(order[0]).match(/Order (MS-[A-Z0-9]{4})/) || [])[1];

  await fetch(`${MOCK}/_script`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ extraction: {
      is_payment_receipt: true, provider: 'MTN MoMo', status: 'successful', amount: total, currency: 'GHS',
      recipient_name: 'MASH AND SIP', recipient_number: '0558866617', sender_name: 'AKOSUA MENSAH',
      transaction_id: `7${Date.now()}`.slice(0, 11), reference: code, transaction_time: new Date().toISOString().replace('T', ' ').slice(0, 16),
      legibility: 'clear', tampering_signs: [], notes: '',
    } }),
  });
  const review = await act(ctx, DEMO.customer, { type: 'image', image: { id: `MEDIA-DEMO-${Date.now()}`, mime_type: 'image/jpeg' } }, '🖼  (sends MoMo payment screenshot)', 2);
  await act(ctx, DEMO.owner, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId(review, 'pay:approve:'), title: '✅ Approve' } } }, 'taps ✅ Approve', 2);
  const card = await act(ctx, DEMO.customer, { type: 'location', location: { latitude: 5.6037, longitude: -0.187, name: 'Osu', address: 'Oxford Street, Accra' } }, '📍 (shares location: Osu, Oxford Street)', 2);
  await act(ctx, DEMO.owner, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId(card, 'ord:out:'), title: '🛵 On the way' } } }, 'taps 🛵 On the way', 2);

  await say(ctx, DEMO.customer, 'Do you deliver to Tema?', 1);
  await say(ctx, DEMO.customer, 'where is my order?', 1);
  await say(ctx, DEMO.customer, 'I need 60 bottles for my wedding next Saturday', 2);
  const alert = await say(ctx, DEMO.customer, 'human', 2);
  await act(ctx, DEMO.owner, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId(alert, 'esc:take:'), title: 'Take over chat' } } }, 'taps Take over chat', 2);
  await say(ctx, DEMO.customer, 'Can I pick up instead?', 1);
  await say(ctx, DEMO.owner, 'Sure! Come to Osu after 4pm 😊', 1);
  await say(ctx, DEMO.owner, '/done', 2);

  console.log('\n━━━ Done ━━━');
}

// ─── modes ────────────────────────────────────────────────────────────────────────────────────

async function tunnelUrl(mode) {
  for (let i = 0; i < 60; i++) {
    const logs = compose(mode, ['logs', 'tunnel']);
    const m = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return m[0];
    await sleep(1000);
  }
  return null;
}

async function main() {
  const [cmd, which = 'demo'] = process.argv.slice(2);
  if (cmd === 'stop' || cmd === 'reset') {
    if (!MODES[which]) fail('usage: local.mjs stop|reset demo|whatsapp');
    if (!existsSync(path.join(INFRA, MODES[which].envFile))) return console.log('Nothing to stop.');
    compose(which, cmd === 'stop' ? ['stop'] : ['down', '-v']);
    if (cmd === 'reset' && which === 'demo') rmSync(path.join(INFRA, MODES.demo.envFile), { force: true });
    return console.log(cmd === 'stop' ? 'Stopped (data kept).' : 'Removed containers and the local database.');
  }
  if (!MODES[cmd]) fail('usage: local.mjs demo|whatsapp|stop <mode>|reset <mode>');

  checkPrerequisites();
  const other = cmd === 'demo' ? 'whatsapp' : 'demo';
  if (existsSync(path.join(INFRA, MODES[other].envFile))) {
    try {
      compose(other, ['stop']); // both modes use ports 5678/8080
    } catch {
      /* not running */
    }
  }
  const env = prepareEnv(cmd);
  bootstrap(cmd);

  if (cmd === 'demo') {
    applySettings('demo', {
      owner: { wa_id: DEMO.owner, name: 'Owner' },
      momo: { number: '055 886 6617', name: 'Mash & Sip Co.', network: 'MTN MoMo' },
      whatsapp: { graph_base_url: 'http://mock:55999', graph_version: 'v26.0', phone_number_id: DEMO.phoneNumberId, template_language: 'en' },
      ai: { vision_model: 'claude-opus-5', anthropic_base_url: 'http://mock:55999' },
      catalog_url: 'http://mock:55999/api/catalog',
      business: { hours: 'Mon–Sat, 8am–7pm', delivery_areas: 'Accra and Tema', delivery_fee: null, delivery_time: null, storage: 'Keep refrigerated', shelf_life: null, pickup: null, extra_faq: [] },
      alerts: { webhook_url: 'http://mock:55999/alert' },
    });
    await runDemo(env);
    console.log(`
Open n8n at http://localhost:5678 (first visit: create a local owner account), then
Overview → Executions to see every run above, node by node.
Browse the CRM:  docker exec -it mashsip-demo-postgres-1 psql -U postgres -d mashsip -c "select * from crm.v_orders"
Run it again:    npm run demo      Stop: npm run demo:stop      Start fresh: npm run demo:reset`);
    return;
  }

  applySettings('whatsapp', {
    owner: { wa_id: env.OWNER_WA_ID, name: 'Owner' },
    momo: { number: env.MOMO_NUMBER || null, name: env.MOMO_NAME || null, network: 'MTN MoMo' },
    whatsapp: { graph_base_url: 'https://graph.facebook.com', graph_version: 'v26.0', phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID, template_language: 'en' },
  });
  const url = await tunnelUrl('whatsapp');
  if (!url) fail('the Cloudflare tunnel did not start; run `docker logs mashsip-local-tunnel-1` to see why.');
  console.log(`
━━━ Ready ━━━
In your Meta app → WhatsApp → Configuration → Webhook → Edit:
  Callback URL:  ${url}/webhook/whatsapp
  Verify token:  ${env.META_VERIFY_TOKEN}
→ Verify and save, then subscribe the "messages" field.

Then message the test number from the customer phone, e.g.
  Order: Cinnamon 250ml x2
  Name: Test Customer

n8n: http://localhost:5678    Business facts: docs/setup.md step 6 (psql: docker exec -it mashsip-local-postgres-1 psql -U postgres -d mashsip)
The tunnel URL changes whenever it restarts; update Meta when it does.   Stop: npm run local:stop`);
}

main().catch((e) => fail(e.stack || e.message));
