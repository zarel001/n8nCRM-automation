import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, switchParams, triggerParams, execWorkflowParams,
} from '../../scripts/lib/wf.mjs';

// Flow · Owner — the owner's personal WhatsApp talking to the bot: approve/reject payments, take
// over or dismiss chats, mark deliveries, and chat with a customer through the business number.
export default function owner() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.owner,
    name: 'Flow · Owner actions',
    description: 'Handles the owner\'s button taps, commands and relayed chat messages.',
  });

  wf.add('execTrigger', 'Start', triggerParams());

  wf.add('code', 'Parse', codeParams(['owner'], `
const { msg, state } = $input.first().json;
return [{ json: parseOwnerInput(msg, state.owner_session) }];`));

  wf.add('switch', 'By action', switchParams('={{ $json.action }}',
    ['payment_decision', 'takeover', 'dismiss', 'advance', 'end_takeover', 'relay']));

  const pg = { credentials: CREDENTIALS.postgres };
  wf.add('postgres', 'Decide payment', pgCall('decide_payment', '{ payment_id: $json.paymentId, decision: $json.decision }'), pg);
  wf.add('postgres', 'Start takeover', pgCall('start_takeover', '{ escalation_id: $json.escalationId, minutes: 30 }'), pg);
  wf.add('postgres', 'Dismiss', pgCall('dismiss_escalation', '{ escalation_id: $json.escalationId }'), pg);
  wf.add('postgres', 'Advance order', pgCall('advance_order', '{ order_id: $json.orderId, status: $json.status }'), pg);
  wf.add('postgres', 'End takeover', pgCall('end_takeover', '{}'), pg);
  wf.add('postgres', 'Keep chat open', pgCall('touch_takeover', '{ minutes: 30 }'), pg);

  wf.add('code', 'Compose', codeParams(['wa', 'copy', 'templates'], `
const { state, settings } = $('Start').first().json;
const action = $('Parse').first().json;
const db = ($input.first().json || {}).result || null;
const lang = (settings.whatsapp && settings.whatsapp.template_language) || 'en';
const brand = settings.brand || {};
const owner = state.customer;
const toOwner = (text) => waSendRequest(owner, [waText(waRecipientOf(owner), text)], null, settings);
const out = [];

switch (action.action) {
  case 'payment_decision': {
    out.push(toOwner(copy.ownerDecision(db)));
    if (db.ok) {
      const c = db.customer;
      const o = db.order;
      const to = waRecipientOf(c);
      if (db.decision === 'approve') {
        out.push(waSendRequest(c, [waLocationRequest(to, copy.paymentApproved(o))],
          tplCustomerUpdate(to, lang, TEMPLATE.paymentConfirmed, firstName(o.customer_name), o.code), settings));
      } else {
        out.push(waSendRequest(c, [waText(to, copy.paymentRejected(o, settings.momo || {}))],
          tplCustomerUpdate(to, lang, TEMPLATE.paymentNotConfirmed, firstName(o.customer_name), o.code), settings));
      }
    }
    break;
  }
  case 'takeover': {
    if (!db.ok) { out.push(toOwner("I couldn't find that chat.")); break; }
    const c = db.customer;
    if (c.window_open) {
      out.push(toOwner(copy.ownerTakeoverStarted(c)));
      out.push(waSendRequest(c, [waText(waRecipientOf(c), copy.takeoverStarted(brand))], null, settings));
    } else {
      out.push(toOwner(copy.ownerRelayFailed(c)));
    }
    break;
  }
  case 'dismiss':
    out.push(toOwner('Dismissed. 👍'));
    break;
  case 'advance': {
    out.push(toOwner(copy.ownerAdvanced(db)));
    if (db.ok) {
      const c = db.customer;
      const o = db.order;
      const to = waRecipientOf(c);
      const delivered = o.status === 'delivered';
      out.push(waSendRequest(c, [waText(to, delivered ? copy.delivered(o) : copy.outForDelivery(o))],
        tplCustomerUpdate(to, lang, delivered ? TEMPLATE.orderDelivered : TEMPLATE.orderOnTheWay, firstName(o.customer_name), o.code), settings));
    }
    break;
  }
  case 'end_takeover': {
    if (!db.ok) { out.push(toOwner(copy.ownerNoSession())); break; }
    out.push(toOwner(copy.ownerTakeoverEnded(db.customer)));
    out.push(waSendRequest(db.customer, [waText(waRecipientOf(db.customer), copy.takeoverEnded(brand))], null, settings));
    break;
  }
  case 'relay': {
    const c = state.owner_session && state.owner_session.customer;
    if (!c) { out.push(toOwner(copy.ownerNoSession())); break; }
    if (!c.window_open) { out.push(toOwner(copy.ownerRelayFailed(c))); break; }
    out.push(waSendRequest(c, [waText(waRecipientOf(c), action.text)], null, settings));
    break;
  }
  case 'relay_unsupported':
    out.push(toOwner(copy.ownerMediaNotRelayed()));
    break;
  case 'no_session':
    out.push(toOwner(copy.ownerNoSession()));
    break;
  case 'ignore':
    break;
  default:
    out.push(toOwner(copy.ownerHelp()));
}
return out.map((json) => ({ json }));`));

  wf.add('execWorkflow', 'Send', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));

  wf.chain('Start', 'Parse', 'By action');
  ['Decide payment', 'Start takeover', 'Dismiss', 'Advance order', 'End takeover', 'Keep chat open'].forEach((node, output) => {
    wf.connect('By action', node, { output });
    wf.connect(node, 'Compose');
  });
  wf.connect('By action', 'Compose', { output: 6 });
  wf.connect('Compose', 'Send');
  return wf;
}
