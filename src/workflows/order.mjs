import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, triggerParams, execWorkflowParams,
} from '../../scripts/lib/wf.mjs';

export const ORDER_INPUTS = [
  { name: 'customer_id', type: 'number' },
  { name: 'variant', type: 'string' },
  { name: 'size', type: 'string' },
  { name: 'qty', type: 'number' },
  { name: 'name', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'first_contact', type: 'boolean' },
];

// Flow · Order — creates an order (priced by the database from the storefront catalog) and sends
// the summary with Mobile Money instructions. Used for checkout messages and by the AI agent's
// create_order tool.
export default function order() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.order,
    name: 'Flow · Order',
    description: 'Creates an order and sends the order summary with payment instructions.',
  });

  wf.add('execTrigger', 'Start', triggerParams(ORDER_INPUTS));

  wf.add('postgres', 'Create order', pgCall('create_order',
    "{ customer_id: $json.customer_id, variant: $json.variant, size: $json.size, qty: $json.qty, name: $json.name, source: $json.source || 'storefront' }"),
  { credentials: CREDENTIALS.postgres });

  wf.add('postgres', 'Customer and settings', pgQuery(
    'select crm.get_customer($1::jsonb) as customer, crm.get_settings() as settings',
    ["{ customer_id: $('Start').first().json.customer_id }"],
  ), { credentials: CREDENTIALS.postgres });

  wf.add('code', 'Compose', codeParams(['wa', 'copy'], `
const start = $('Start').first().json;
const result = $('Create order').first().json.result;
const { customer, settings } = $input.first().json;
const brand = settings.brand || {};
const to = waRecipientOf(customer);
let payload;
if (result.ok) {
  let body = copy.orderReceived(result.order, settings.momo || {}, result.duplicate);
  if (start.first_contact) body += '\\n\\n' + copy.aiDisclosure(brand);
  payload = waButtons(to, body, copy.orderButtons(result.order));
} else {
  payload = waText(to, copy.orderInvalid(result, brand.siteUrl || ''));
}
return [{ json: waSendRequest(customer, [payload], null, settings) }];`));

  wf.add('execWorkflow', 'Send', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));

  wf.add('code', 'Result', codeParams([], `
const r = $('Create order').first().json.result;
const sent = $input.first().json;
if (!r.ok) {
  return [{ json: { ok: false, error: r.error, options: r.options || null, max: r.max || null,
    customer_was_told: 'The customer was sent a message explaining the problem.' } }];
}
return [{ json: {
  ok: true, duplicate: r.duplicate, order_code: r.order.code, total: r.order.currency + ' ' + Number(r.order.total).toFixed(2),
  status: r.order.status, message_sent: sent.ok,
  customer_was_told: 'The order summary, total and Mobile Money payment instructions were sent to the customer. Do not repeat them.',
} }];`));

  wf.chain('Start', 'Create order', 'Customer and settings', 'Compose', 'Send', 'Result');
  return wf;
}
