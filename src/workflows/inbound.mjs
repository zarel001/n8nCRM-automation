import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, switchParams, execWorkflowParams,
} from '../../scripts/lib/wf.mjs';
import { ESCALATE_INPUTS } from './escalate.mjs';

// WA · Inbound — the only public entry point (behind the gate). Normalises Meta's webhook, logs
// and de-duplicates each message in one database call, routes it, and hands it to a flow.
export default function inbound() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.inbound,
    name: 'WA · Inbound',
    description: 'Receives verified WhatsApp webhooks from the gate, logs and routes every message.',
  });

  wf.add('webhook', 'Webhook', {
    httpMethod: 'POST',
    path: 'wa-inbound',
    authentication: 'headerAuth',
    responseMode: 'onReceived',
    options: {},
  }, { credentials: CREDENTIALS.gate, webhookId: '6f3f2a1e-9a57-4f0e-8f0c-5a1c2e7b9d41' });

  wf.add('postgres', 'Settings', pgQuery('select crm.get_settings() as settings'), {
    credentials: CREDENTIALS.postgres,
    executeOnce: true,
  });

  wf.add('code', 'Normalize', codeParams(['meta'], `
const body = $('Webhook').first().json.body;
const settings = $('Settings').first().json.settings;
const ourNumber = settings.whatsapp && settings.whatsapp.phone_number_id;
return normalizeWebhook(body)
  // ignore events for other numbers on the same WhatsApp Business Account
  .filter((e) => !ourNumber || !e.phoneNumberId || String(e.phoneNumberId) === String(ourNumber))
  .map((event) => ({ json: { event } }));`));

  wf.add('switch', 'Message or status', switchParams('={{ $json.event.kind }}', ['message', 'status']));

  wf.add('postgres', 'Record status', pgCall('apply_status',
    '{ wa_message_id: $json.event.waMessageId, status: $json.event.status, errors: $json.event.errors }'),
  { credentials: CREDENTIALS.postgres });

  wf.add('postgres', 'Ingest', pgQuery(
    'select crm.ingest_inbound($1::jsonb) as state, $2::jsonb as event',
    [
      `{ wa_message_id: $json.event.waMessageId, phone: $json.event.from.phone, bsuid: $json.event.from.bsuid,
         profile_name: $json.event.from.profileName, username: $json.event.from.username, type: $json.event.type,
         body: $json.event.body,
         payload: { text: $json.event.text, media: $json.event.media, location: $json.event.location,
                    reply: $json.event.reply, context_id: $json.event.contextId, referral: $json.event.referral } }`,
      '$json.event',
    ],
  ), { credentials: CREDENTIALS.postgres });

  wf.add('code', 'Route', codeParams(['orders', 'router'], `
const settings = $('Settings').first().json.settings;
const out = [];
for (const item of $input.all()) {
  const { state, event } = item.json;
  const decision = routeInbound(event, state);
  if (decision.route === 'ignore') continue;
  out.push({ json: { route: decision.route, decision, msg: event, state, settings } });
}
return out;`));

  wf.add('switch', 'By route', switchParams('={{ $json.route }}', ['owner', 'order', 'payment', 'agent', 'human']));

  wf.add('execWorkflow', 'Owner flow', execWorkflowParams(WORKFLOW_IDS.owner, { each: true }));
  wf.add('execWorkflow', 'Order flow', execWorkflowParams(WORKFLOW_IDS.order, {
    each: true,
    inputs: [
      { name: 'customer_id', type: 'number', value: '={{ $json.state.customer.id }}' },
      { name: 'variant', type: 'string', value: '={{ $json.decision.order.variant }}' },
      { name: 'size', type: 'string', value: '={{ $json.decision.order.size }}' },
      { name: 'qty', type: 'number', value: '={{ $json.decision.order.qty }}' },
      { name: 'name', type: 'string', value: "={{ $json.decision.order.name || '' }}" },
      { name: 'source', type: 'string', value: 'storefront' },
      { name: 'first_contact', type: 'boolean', value: '={{ $json.state.is_new }}' },
    ],
  }));
  wf.add('execWorkflow', 'Payment flow', execWorkflowParams(WORKFLOW_IDS.payment, { each: true }));
  wf.add('execWorkflow', 'Agent flow', execWorkflowParams(WORKFLOW_IDS.agent, { each: true }));
  wf.add('execWorkflow', 'Human request', execWorkflowParams(WORKFLOW_IDS.escalate, {
    each: true,
    inputs: escalateInputs({
      customer_id: '={{ $json.state.customer.id }}',
      kind: 'human_request',
      reason: "={{ $json.decision.reason || 'Asked for a person' }}",
      notify_customer: true,
      last_message: "={{ $json.msg.body || '' }}",
    }),
  }));
  wf.add('execWorkflow', 'Customer flow', execWorkflowParams(WORKFLOW_IDS.customer, { each: true }));

  wf.chain('Webhook', 'Settings', 'Normalize', 'Message or status');
  wf.connect('Message or status', 'Ingest', { output: 0 });
  wf.connect('Message or status', 'Record status', { output: 1 });
  wf.chain('Ingest', 'Route', 'By route');
  ['Owner flow', 'Order flow', 'Payment flow', 'Agent flow', 'Human request', 'Customer flow'].forEach((node, output) => {
    wf.connect('By route', node, { output });
  });
  return wf;
}

// Inputs declared by "Flow · Escalate"; unspecified ones are sent empty.
export function escalateInputs(values) {
  return ESCALATE_INPUTS.map(({ name, type }) => ({
    name,
    type,
    value: name in values ? values[name] : type === 'number' ? 0 : type === 'boolean' ? false : '',
  }));
}
