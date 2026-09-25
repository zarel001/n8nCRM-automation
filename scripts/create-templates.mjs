#!/usr/bin/env node
// Submits the WhatsApp message templates in templates/whatsapp-templates.json to Meta for review.
// Text-only templates are created here; `payment_check` has an image header, which Meta wants
// with an uploaded sample image, so create that one in WhatsApp Manager (docs/setup.md, step 6).
//
//   WHATSAPP_ACCESS_TOKEN=… WHATSAPP_WABA_ID=… node scripts/create-templates.mjs [--dry-run]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { language, templates } = JSON.parse(readFileSync(path.join(ROOT, 'templates', 'whatsapp-templates.json'), 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const version = process.env.GRAPH_VERSION || 'v26.0';
const token = process.env.WHATSAPP_ACCESS_TOKEN;
const waba = process.env.WHATSAPP_WABA_ID;

if (!dryRun && (!token || !waba)) {
  console.error('Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_WABA_ID (or pass --dry-run).');
  process.exit(2);
}

let failures = 0;
for (const t of templates) {
  if (t.components.some((c) => c.type === 'HEADER' && c.format !== 'TEXT')) {
    console.log(`skip   ${t.name}: has a media header; create it in WhatsApp Manager`);
    continue;
  }
  const body = { name: t.name, language, category: t.category, components: t.components };
  if (dryRun) {
    console.log(`dry    ${t.name}\n${JSON.stringify(body, null, 2)}`);
    continue;
  }
  const res = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`ok     ${t.name}: ${data.status || 'submitted'} (${data.id})`);
  } else {
    failures++;
    console.log(`error  ${t.name}: ${(data.error && data.error.message) || res.status}`);
  }
}
process.exit(failures ? 1 : 0);
