import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, switchParams, triggerParams, execWorkflowParams,
} from '../../scripts/lib/wf.mjs';

// Flow · Customer actions — the deterministic customer paths: opt-out/in, cancel, delivery pin,
// messages during a takeover (forwarded to the owner), voice notes and other unsupported media.
export default function customer() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.customer,
    name: 'Flow · Customer actions',
    description: 'Opt-out/in, cancel, delivery location, takeover forwarding and unsupported media.',
  });

  wf.add('execTrigger', 'Start', triggerParams());
  wf.add('postgres', 'Owner', pgQuery("select crm.get_owner('{}'::jsonb) as owner"), { credentials: CREDENTIALS.postgres });
  wf.add('switch', 'By route', switchParams("={{ $('Start').first().json.route }}", ['opt_out', 'opt_in', 'cancel', 'location']));

  const pg = { credentials: CREDENTIALS.postgres };
  const start = "$('Start').first().json";
  wf.add('postgres', 'Opt out', pgCall('set_opt_out', `{ customer_id: ${start}.state.customer.id, opted_out: true }`), pg);
  wf.add('postgres', 'Opt in', pgCall('set_opt_out', `{ customer_id: ${start}.state.customer.id, opted_out: false }`), pg);
  wf.add('postgres', 'Cancel order', pgCall('cancel_order',
    `{ customer_id: ${start}.state.customer.id, order_id: ${start}.decision.orderId || null }`), pg);
  wf.add('postgres', 'Save location', pgCall('set_order_location',
    `{ customer_id: ${start}.state.customer.id, location: ${start}.msg.location }`), pg);

  wf.add('code', 'Compose', codeParams(['wa', 'copy', 'templates'], `
const { route, msg, state, settings } = $('Start').first().json;
const owner = $('Owner').first().json.owner;
const db = ($input.first().json || {}).result || null;
const lang = (settings.whatsapp && settings.whatsapp.template_language) || 'en';
const brand = settings.brand || {};
const customer = state.customer;
const reply = (text) => waSendRequest(customer, [waText(waRecipientOf(customer), text)], null, settings);
const out = [];

switch (route) {
  case 'opt_out': out.push(reply(copy.optedOut())); break;
  case 'opt_in': out.push(reply(copy.optedIn())); break;
  case 'cancel':
    out.push(reply(db && db.ok ? copy.cancelled(db.order, brand.siteUrl || '') : copy.nothingToCancel()));
    break;
  case 'location': {
    if (!db || !db.ok) { out.push(reply('Thanks for the location! 📍')); break; }
    out.push(reply(copy.locationSaved(db.order)));
    if (owner) {
      const o = { ...db.order };
      const to = waRecipientOf(owner);
      const link = mapsLink(o.delivery_location) || 'not shared';
      out.push(waSendRequest(owner,
        [waButtons(to, copy.ownerOrderReady({ order: o, customer }), copy.ownerOrderButtons(o.id))],
        tplOrderReady(to, lang, { orderCode: o.code, items: copyItems(o), customer: customerLabel(customer), location: link, orderId: o.id }),
        settings));
    }
    break;
  }
  case 'takeover_forward': {
    // Only the owner's own messages keep a takeover alive, so the owner has written within the
    // last 30 minutes and their 24-hour window is open: no template needed.
    if (owner) out.push(waSendRequest(owner, [waText(waRecipientOf(owner), copy.ownerRelay(customer, msg.text || msg.body || '[message]'))], null, settings));
    break;
  }
  case 'voice': out.push(reply(copy.voiceNote())); break;
  case 'receipt_not_image': out.push(reply(copy.unsupportedReceipt())); break;
  case 'order_help': out.push(reply(copy.orderHelp(brand.siteUrl || ''))); break;
  default: out.push(reply(copy.unsupportedMedia()));
}
return out.map((json) => ({ json }));`));

  wf.add('execWorkflow', 'Send', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));

  wf.chain('Start', 'Owner', 'By route');
  ['Opt out', 'Opt in', 'Cancel order', 'Save location'].forEach((node, output) => {
    wf.connect('By route', node, { output });
    wf.connect(node, 'Compose');
  });
  wf.connect('By route', 'Compose', { output: 4 });
  wf.connect('Compose', 'Send');
  return wf;
}
