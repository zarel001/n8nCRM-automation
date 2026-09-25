import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, triggerParams, execWorkflowParams, ifTrueParams,
} from '../../scripts/lib/wf.mjs';

export const ESCALATE_INPUTS = [
  { name: 'customer_id', type: 'number' },
  { name: 'kind', type: 'string' },
  { name: 'reason', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'event_type', type: 'string' },
  { name: 'event_date', type: 'string' },
  { name: 'quantity_estimate', type: 'number' },
  { name: 'area', type: 'string' },
  { name: 'flavours', type: 'string' },
  { name: 'notes', type: 'string' },
  { name: 'contact_name', type: 'string' },
  { name: 'notify_customer', type: 'boolean' },
  { name: 'last_message', type: 'string' },
];

// Flow · Escalate — brings in the owner: a customer asked for a person (keyword, button or the AI
// agent's request_human tool) or the agent captured a bulk/event order lead (save_bulk_lead).
// Repeat requests within 2 hours don't re-alert the owner.
export default function escalate() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.escalate,
    name: 'Flow · Escalate',
    description: 'Alerts the owner (Take over / Dismiss) about hand-off requests and bulk-order leads.',
  });

  const pg = { credentials: CREDENTIALS.postgres };
  wf.add('execTrigger', 'Start', triggerParams(ESCALATE_INPUTS));
  wf.add('if', 'Bulk lead?', ifTrueParams("={{ $json.kind === 'bulk_lead' }}"));
  wf.add('postgres', 'Save lead', pgCall('save_lead', `{
    customer_id: $json.customer_id, contact_name: $json.contact_name, event_type: $json.event_type,
    event_date: $json.event_date, quantity_estimate: $json.quantity_estimate || null, area: $json.area,
    flavours: $json.flavours, notes: $json.notes
  }`), pg);
  wf.add('postgres', 'Open escalation', pgCall('open_escalation', `{
    customer_id: $('Start').first().json.customer_id,
    kind: $('Start').first().json.kind === 'bulk_lead' ? 'bulk_lead' : 'human_request',
    reason: $('Start').first().json.reason,
    summary: $('Start').first().json.summary || $('Start').first().json.last_message
  }`), pg);
  wf.add('postgres', 'Context', pgQuery(
    "select crm.get_owner('{}'::jsonb) as owner, crm.get_customer($1::jsonb) as customer, crm.get_settings() as settings",
    ["{ customer_id: $('Start').first().json.customer_id }"],
  ), pg);

  wf.add('code', 'Compose', codeParams(['wa', 'copy', 'templates'], `
const input = $('Start').first().json;
const esc = $('Open escalation').first().json.result;
const { owner, customer, settings } = $input.first().json;
const lang = (settings.whatsapp && settings.whatsapp.template_language) || 'en';
const isLead = input.kind === 'bulk_lead';
const out = [];

if (owner && !esc.existing) {
  const to = waRecipientOf(owner);
  const lead = {
    event_type: input.event_type, event_date: input.event_date, quantity_estimate: input.quantity_estimate || null,
    area: input.area, flavours: input.flavours, notes: input.notes || input.summary,
  };
  const body = isLead
    ? copy.ownerLeadAlert({ customer, lead })
    : copy.ownerHumanAlert({ customer, reason: input.reason, lastMessage: input.summary || input.last_message });
  const details = isLead
    ? [lead.event_type, lead.event_date, lead.quantity_estimate ? lead.quantity_estimate + ' bottles' : null, lead.area].filter(Boolean).join(', ') || 'see chat'
    : (input.summary || input.reason || input.last_message || 'wants to talk to someone');
  out.push(waSendRequest(owner,
    [waButtons(to, body, copy.ownerEscalationButtons(esc.escalation_id))],
    tplOwnerAlert(to, lang, { what: isLead ? 'bulk order lead' : 'chat request', customer: customerLabel(customer), details, escalationId: esc.escalation_id }),
    settings, 'owner'));
}
if (input.notify_customer) {
  out.push(waSendRequest(customer, [waText(waRecipientOf(customer), copy.humanRequested(esc.existing))], null, settings, 'customer'));
}
if (!out.length) return [{ json: { nothing: true } }];
return out.map((json) => ({ json }));`));

  wf.add('if', 'Anything to send?', ifTrueParams('={{ !$json.nothing }}'));
  wf.add('execWorkflow', 'Send', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));

  wf.add('code', 'Result', codeParams([], `
const esc = $('Open escalation').first().json.result;
const input = $('Start').first().json;
return [{ json: {
  ok: true,
  escalation_id: esc.escalation_id,
  owner_notified: !esc.existing,
  note: esc.existing ? 'The team was already alerted about this recently.' : (input.kind === 'bulk_lead'
    ? 'The lead was saved and the team was alerted; tell the customer the team will get back to them with a quote.'
    : 'The team was alerted; tell the customer someone will reply here soon.'),
} }];`));

  wf.chain('Start', 'Bulk lead?');
  wf.connect('Bulk lead?', 'Save lead', { output: 0 });
  wf.connect('Bulk lead?', 'Open escalation', { output: 1 });
  wf.chain('Save lead', 'Open escalation', 'Context', 'Compose', 'Anything to send?');
  wf.connect('Anything to send?', 'Send', { output: 0 });
  wf.connect('Anything to send?', 'Result', { output: 1 });
  wf.connect('Send', 'Result');
  return wf;
}
