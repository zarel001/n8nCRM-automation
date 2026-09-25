import { Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, triggerParams, ifTrueParams } from '../../scripts/lib/wf.mjs';

// WA · Send — every outbound WhatsApp message goes through here (called once per request):
// picks free-form vs template by the 24-hour window, sends in order, logs each message, and
// alerts the developer if WhatsApp rejects one.
export default function send() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.send,
    name: 'WA · Send',
    description: 'Sends WhatsApp messages (free-form inside the 24 h window, template outside it) and logs them.',
  });

  wf.add('execTrigger', 'Start', triggerParams());

  wf.add('code', 'Plan', codeParams([], `
const out = [];
for (const item of $input.all()) {
  const r = item.json;
  const wa = r.whatsapp || {};
  const url = \`\${wa.graph_base_url}/\${wa.graph_version}/\${wa.phone_number_id}/messages\`;
  const open = r.window_open !== false;
  const list = open ? (r.payloads || []) : (r.template ? [r.template] : []);
  const mode = open ? 'freeform' : (r.template ? 'template' : 'skipped');
  if (!list.length) {
    out.push({ json: { skip: true, mode, customer_id: r.customer_id ?? null, ref: r.ref ?? null } });
    continue;
  }
  for (const payload of list) {
    out.push({ json: { skip: false, mode, customer_id: r.customer_id ?? null, ref: r.ref ?? null, url, payload } });
  }
}
return out;`));

  wf.add('if', 'Nothing to send?', ifTrueParams('={{ $json.skip }}'));

  wf.add('http', 'Send to WhatsApp', {
    method: 'POST',
    url: '={{ $json.url }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'whatsAppApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.payload) }}',
    options: {
      batching: { batch: { batchSize: 1, batchInterval: 0 } },
      response: { response: { fullResponse: true, neverError: true } },
      timeout: 20000,
    },
  }, { credentials: CREDENTIALS.whatsapp, onError: 'continueRegularOutput' });

  wf.add('code', 'Log rows', codeParams(['wa'], `
const planned = $('Plan').all().filter((i) => !i.json.skip);
return $input.all().map((item, idx) => {
  const plan = (planned[idx] || {}).json || {};
  const res = item.json || {};
  const status = res.statusCode ?? null;
  const body = res.body ?? null;
  const ok = status !== null && status >= 200 && status < 300;
  const waMessageId = ok && body && body.messages && body.messages[0] ? body.messages[0].id : null;
  const error = ok ? null : ((body && body.error) || { message: (res.error && res.error.message) || res.message || 'send failed', status });
  return { json: {
    customer_id: plan.customer_id, wa_message_id: waMessageId, type: (plan.payload && plan.payload.type) || 'text',
    body: waLogBody(plan.payload), payload: plan.payload, error, ok, mode: plan.mode, ref: plan.ref,
  } };
});`));

  wf.add('postgres', 'Log outbound', pgCall('log_outbound',
    '{ customer_id: $json.customer_id, wa_message_id: $json.wa_message_id, type: $json.type, body: $json.body, payload: $json.payload, error: $json.error }'),
  { credentials: CREDENTIALS.postgres });

  wf.add('code', 'Failures', codeParams([], `
const start = $('Start').first().json;
const failed = $('Log rows').all().map((i) => i.json).filter((r) => !r.ok);
const detail = failed.map((r) => (r.error && (r.error.message || r.error.code)) || 'unknown error').join('; ');
return [{ json: {
  alert: failed.length > 0 && Boolean(start.alert_url),
  url: start.alert_url,
  text: '⚠️ WhatsApp send failed (' + failed.length + ' message' + (failed.length === 1 ? '' : 's') + ', customer ' + start.customer_id + '): ' + detail.slice(0, 500),
} }];`));

  wf.add('if', 'Alert needed?', ifTrueParams('={{ $json.alert }}'));

  wf.add('http', 'Alert developer', {
    method: 'POST',
    url: '={{ $json.url }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ text: $json.text, content: $json.text }) }}',
    options: { timeout: 10000 },
  }, { onError: 'continueRegularOutput' });

  wf.add('code', 'Result', codeParams([], `
const first = $input.first().json;
if (first.skip) {
  return [{ json: { ok: false, skipped: true, mode: first.mode, sent: 0, ref: first.ref ?? null } }];
}
const rows = $('Log rows').all().map((i) => i.json);
const failed = rows.filter((r) => !r.ok);
return [{ json: {
  ok: failed.length === 0, skipped: false, mode: rows[0] ? rows[0].mode : null, sent: rows.length - failed.length,
  errors: failed.map((r) => r.error), wa_message_ids: rows.map((r) => r.wa_message_id).filter(Boolean), ref: rows[0] ? rows[0].ref : null,
} }];`));

  wf.chain('Start', 'Plan', 'Nothing to send?');
  wf.connect('Nothing to send?', 'Result', { output: 0 });
  wf.connect('Nothing to send?', 'Send to WhatsApp', { output: 1 });
  wf.chain('Send to WhatsApp', 'Log rows', 'Log outbound', 'Failures', 'Alert needed?');
  wf.connect('Alert needed?', 'Alert developer', { output: 0 });
  wf.connect('Alert needed?', 'Result', { output: 1 });
  wf.connect('Alert developer', 'Result');
  return wf;
}
