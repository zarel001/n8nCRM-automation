import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, triggerParams, execWorkflowParams, ifTrueParams,
} from '../../scripts/lib/wf.mjs';

const pg = { credentials: CREDENTIALS.postgres };

// Tool · My orders — get_my_orders: the sender's recent orders, simplified for the model.
export function toolOrders() {
  const wf = new Workflow({ id: WORKFLOW_IDS.toolOrders, name: 'Tool · My orders', description: 'AI tool: the customer\'s own recent orders.' });
  wf.add('execTrigger', 'Start', triggerParams([{ name: 'customer_id', type: 'number' }]));
  wf.add('postgres', 'Orders', pgCall('customer_orders', '{ customer_id: $json.customer_id, limit: 5 }'), pg);
  wf.add('code', 'Format', codeParams(['orders'], `
const orders = $input.first().json.result || [];
if (!orders.length) return [{ json: { orders: [], note: 'This customer has no orders yet.' } }];
return [{ json: { orders: orders.map((o) => ({
  code: o.code,
  status: o.status,
  items: itemsSummary(o),
  total: money(o.total, o.currency),
  placed_at: o.created_at,
  paid: Boolean(o.paid_at),
  delivery_details_received: Boolean(o.delivery_location || o.delivery_note),
})) } }];`));
  wf.chain('Start', 'Orders', 'Format');
  return wf;
}

// Tool · Cancel order — cancel_my_order: only the sender's own unpaid orders.
export function toolCancel() {
  const wf = new Workflow({ id: WORKFLOW_IDS.toolCancel, name: 'Tool · Cancel order', description: 'AI tool: cancel the customer\'s own unpaid order.' });
  wf.add('execTrigger', 'Start', triggerParams([{ name: 'customer_id', type: 'number' }, { name: 'code', type: 'string' }]));
  wf.add('postgres', 'Cancel', pgCall('cancel_order', "{ customer_id: $json.customer_id, code: $json.code || '' }"), pg);
  wf.add('code', 'Result', codeParams([], `
const r = $input.first().json.result;
return [{ json: r.ok
  ? { ok: true, cancelled: r.order.code, note: 'Tell the customer the order is cancelled.' }
  : { ok: false, error: r.error, note: 'There is no unpaid order to cancel for this customer.' } }];`));
  wf.chain('Start', 'Cancel', 'Result');
  return wf;
}

// Tool · Delivery details — set_delivery_details: saves a typed address for the sender's paid
// order and tells the owner the order is ready.
export function toolDelivery() {
  const wf = new Workflow({ id: WORKFLOW_IDS.toolDelivery, name: 'Tool · Delivery details', description: 'AI tool: save a typed delivery address and alert the owner.' });
  wf.add('execTrigger', 'Start', triggerParams([{ name: 'customer_id', type: 'number' }, { name: 'note', type: 'string' }]));
  wf.add('postgres', 'Save note', pgCall('set_delivery_note', '{ customer_id: $json.customer_id, note: $json.note }'), pg);
  wf.add('if', 'Saved?', ifTrueParams('={{ $json.result.ok }}'));
  wf.add('postgres', 'Context', pgQuery(
    "select crm.get_owner('{}'::jsonb) as owner, crm.get_customer($1::jsonb) as customer, crm.get_settings() as settings",
    ["{ customer_id: $('Start').first().json.customer_id }"],
  ), pg);
  wf.add('code', 'Compose', codeParams(['wa', 'copy', 'templates'], `
const order = $('Save note').first().json.result.order;
const { owner, customer, settings } = $input.first().json;
if (!owner) return [{ json: { nothing: true } }];
const lang = (settings.whatsapp && settings.whatsapp.template_language) || 'en';
const to = waRecipientOf(owner);
return [{ json: waSendRequest(owner,
  [waButtons(to, copy.ownerOrderReady({ order, customer }), copy.ownerOrderButtons(order.id))],
  tplOrderReady(to, lang, { orderCode: order.code, items: copyItems(order), customer: customerLabel(customer), location: order.delivery_note || 'see chat', orderId: order.id }),
  settings) }];`));
  wf.add('execWorkflow', 'Send', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));
  wf.add('code', 'Result', codeParams([], `
const r = $('Save note').first().json.result;
return [{ json: r.ok
  ? { ok: true, order: r.order.code, note: 'Saved. Tell the customer the team has their delivery details.' }
  : { ok: false, error: r.error, note: 'No paid order is waiting for delivery details; explain that payment must be confirmed first.' } }];`));
  wf.chain('Start', 'Save note', 'Saved?');
  wf.connect('Saved?', 'Context', { output: 0 });
  wf.connect('Saved?', 'Result', { output: 1 });
  wf.chain('Context', 'Compose', 'Send', 'Result');
  return wf;
}
