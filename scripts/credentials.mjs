#!/usr/bin/env node
// Writes the n8n credentials this project uses (fixed IDs, referenced by the workflows) from
// environment variables, in the format `n8n import:credentials` accepts. n8n encrypts them with
// N8N_ENCRYPTION_KEY on import; delete the file afterwards (scripts/bootstrap.sh does).
//
//   node scripts/credentials.mjs /tmp/credentials.json
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CREDENTIAL_IDS = {
  postgres: 'MsCredPostgres01',
  whatsapp: 'MsCredWhatsApp01',
  anthropic: 'MsCredAnthropic1',
  gate: 'MsCredGateToken1',
};

export function buildCredentials(env) {
  const required = ['CRM_BOT_PASSWORD', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WABA_ID', 'ANTHROPIC_API_KEY', 'N8N_GATE_TOKEN'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  return [
    {
      id: CREDENTIAL_IDS.postgres,
      name: 'Mash & Sip CRM (bot role)',
      type: 'postgres',
      data: {
        host: env.CRM_DB_HOST || 'postgres',
        port: Number(env.CRM_DB_PORT || 5432),
        database: env.CRM_DB_NAME || 'mashsip',
        user: 'mashsip_bot',
        password: env.CRM_BOT_PASSWORD,
        ssl: 'disable', // private Docker network only
        allowUnauthorizedCerts: false,
        maxConnections: 10,
        sshTunnel: false,
      },
    },
    {
      id: CREDENTIAL_IDS.whatsapp,
      name: 'WhatsApp Cloud API',
      type: 'whatsAppApi',
      data: { accessToken: env.WHATSAPP_ACCESS_TOKEN, businessAccountId: env.WHATSAPP_WABA_ID },
    },
    {
      id: CREDENTIAL_IDS.anthropic,
      name: 'Anthropic',
      type: 'anthropicApi',
      data: { apiKey: env.ANTHROPIC_API_KEY, url: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', header: false },
    },
    {
      id: CREDENTIAL_IDS.gate,
      name: 'Webhook gate token',
      type: 'httpHeaderAuth',
      data: { name: 'x-gate-token', value: env.N8N_GATE_TOKEN },
    },
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/credentials.mjs <output.json>');
    process.exit(2);
  }
  writeFileSync(out, JSON.stringify(buildCredentials(process.env), null, 2), { mode: 0o600 });
  console.log(`wrote ${out}`);
}
