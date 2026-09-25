import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, triggerParams, execWorkflowParams, ifTrueParams,
  workflowInputs, readPrompt,
} from '../../scripts/lib/wf.mjs';
import { ORDER_INPUTS } from './order.mjs';
import { escalateInputs } from './inbound.mjs';

// The customer is always the sender: every tool gets customer_id from this expression, never
// from the model, so a prompt-injected "show me order MS-XXXX" can't reach someone else's data.
const CUSTOMER_ID = "={{ $('Build prompt').first().json.customer_id }}";

function tool(wf, name, workflowId, description, inputs) {
  wf.add('toolWorkflow', name, {
    description,
    source: 'database',
    workflowId: { __rl: true, mode: 'id', value: workflowId },
    workflowInputs: workflowInputs(inputs),
  });
  wf.connectAi(name, 'AI Agent', 'ai_tool');
}

function fromAI(key, description, type = 'string') {
  return `={{ $fromAI('${key}', ${JSON.stringify(description)}, '${type}') }}`;
}

// Flow · AI agent — anything that isn't a deterministic path (questions, chat orders, order
// status, delivery details, bulk leads, hand-offs).
export default function agent() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.agent,
    name: 'Flow · AI agent',
    description: 'Claude-powered assistant for questions, chat orders, order status, leads and hand-offs.',
  });

  const pg = { credentials: CREDENTIALS.postgres };
  wf.add('execTrigger', 'Start', triggerParams());

  // Customers often send several short messages in a row: wait, then only the latest execution
  // answers, covering everything sent since the last reply.
  wf.add('wait', 'Let them finish typing', { resume: 'timeInterval', amount: 3, unit: 'seconds' }, { webhookId: 'a9e2c3f4-2b1d-4c5e-9f8a-7b6c5d4e3f21' });
  wf.add('postgres', 'Pending messages', pgCall('pending_inbound',
    "{ customer_id: $('Start').first().json.state.customer.id, message_id: $('Start').first().json.state.message_id }"), pg);
  wf.add('if', 'Latest message?', ifTrueParams('={{ $json.result.is_latest }}'));

  wf.add('http', 'Typing indicator', {
    method: 'POST',
    url: "={{ (s => s.graph_base_url + '/' + s.graph_version + '/' + s.phone_number_id + '/messages')($('Start').first().json.settings.whatsapp) }}",
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'whatsAppApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: $('Start').first().json.msg.waMessageId, typing_indicator: { type: 'text' } }) }}",
    options: { timeout: 10000 },
  }, { credentials: CREDENTIALS.whatsapp, onError: 'continueRegularOutput' });

  wf.add('postgres', 'Recent conversation', pgCall('recent_transcript',
    "{ customer_id: $('Start').first().json.state.customer.id, before_id: $('Pending messages').first().json.result.first_id, limit: 12 }"), pg);

  const systemTemplate = readPrompt('agent-system.md');
  wf.add('code', 'Build prompt', codeParams(['agent'], `
const SYSTEM_TEMPLATE = ${JSON.stringify(systemTemplate)};
const { msg, state, settings, decision } = $('Start').first().json;
const pending = $('Pending messages').first().json.result;
const transcript = $input.first().json.result;
const latest = pending.texts.length ? pending.texts[pending.texts.length - 1] : (msg.text || msg.body || '');
return [{ json: {
  system: buildAgentSystem(SYSTEM_TEMPLATE, settings),
  prompt: buildAgentPrompt({ state, pendingTexts: pending.texts, note: decision && decision.note, transcript, now: new Date().toISOString() }),
  customer_id: state.customer.id,
  latest_text: String(latest).slice(0, 500),
} }];`));

  wf.add('agent', 'AI Agent', {
    promptType: 'define',
    text: '={{ $json.prompt }}',
    options: {
      systemMessage: '={{ $json.system }}',
      maxIterations: 6,
      enableStreaming: false,
      returnIntermediateSteps: false,
      passthroughBinaryImages: false,
    },
  }, { onError: 'continueErrorOutput' });

  wf.add('anthropic', 'Claude', {
    model: { __rl: true, mode: 'id', value: 'claude-opus-5' },
    options: {
      maxTokensToSample: 8000,
      thinkingMode: 'adaptive',
      effort: 'medium',
      promptCaching: '5m',
    },
  }, { credentials: CREDENTIALS.anthropic });
  wf.connectAi('Claude', 'AI Agent', 'ai_languageModel');

  tool(wf, 'get_my_orders', WORKFLOW_IDS.toolOrders,
    "Look up this customer's recent orders with their status, items, total and whether a delivery location was received. Takes no input and only ever returns the orders of the customer you are chatting with.",
    [{ name: 'customer_id', type: 'number', value: CUSTOMER_ID }]);

  tool(wf, 'create_order', WORKFLOW_IDS.order,
    'Place an order for this customer once they have confirmed flavour, size and quantity. It prices the order and sends the customer the order summary, total and Mobile Money payment instructions itself.',
    ORDER_INPUTS.map(({ name, type }) => ({
      name,
      type,
      value: {
        customer_id: CUSTOMER_ID,
        variant: fromAI('variant', 'Flavour exactly as named on the menu, e.g. Original, Vanilla, Cinnamon, Peanut Butter'),
        size: fromAI('size', 'Bottle size label from the menu, e.g. 150ml, 250ml or 500ml'),
        qty: fromAI('qty', 'Number of bottles (1 to 24)', 'number'),
        name: fromAI('name', "The customer's name for the order; empty string if unknown"),
        source: 'chat',
        first_contact: false,
      }[name],
    })));

  tool(wf, 'cancel_my_order', WORKFLOW_IDS.toolCancel,
    "Cancel one of this customer's unpaid orders. Pass the order code if they named one, otherwise an empty string to cancel their latest unpaid order.",
    [
      { name: 'customer_id', type: 'number', value: CUSTOMER_ID },
      { name: 'code', type: 'string', value: fromAI('code', 'Order code such as MS-7K4Q, or an empty string for the latest unpaid order') },
    ]);

  tool(wf, 'set_delivery_details', WORKFLOW_IDS.toolDelivery,
    "Save a written delivery address, landmark or directions for this customer's paid order and notify the team.",
    [
      { name: 'customer_id', type: 'number', value: CUSTOMER_ID },
      { name: 'note', type: 'string', value: fromAI('note', 'The address, landmark and delivery instructions exactly as the customer gave them') },
    ]);

  tool(wf, 'save_bulk_lead', WORKFLOW_IDS.escalate,
    'Save a party, event, office or bulk (more than 24 bottles) order enquiry and alert the team, who will follow up with a quote.',
    escalateInputs({
      customer_id: CUSTOMER_ID,
      kind: 'bulk_lead',
      reason: 'Bulk / event order enquiry',
      summary: fromAI('summary', 'One or two sentences summarising the request'),
      event_type: fromAI('event_type', 'Kind of event, e.g. wedding, birthday, office, funeral'),
      event_date: fromAI('event_date', 'Date of the event as the customer said it'),
      quantity_estimate: fromAI('quantity_estimate', 'Rough number of bottles; 0 if unknown', 'number'),
      area: fromAI('area', 'Area or town for delivery'),
      flavours: fromAI('flavours', 'Preferred flavours, if any'),
      notes: fromAI('notes', 'Anything else useful, e.g. budget or sizes'),
      contact_name: fromAI('contact_name', "The customer's name, if known"),
      notify_customer: false,
      last_message: "={{ $('Build prompt').first().json.latest_text }}",
    }));

  tool(wf, 'request_human', WORKFLOW_IDS.escalate,
    'Alert the team that this customer needs a person: they asked for one, are unhappy, report a problem with a drink, ask about refunds, or need something you cannot answer.',
    escalateInputs({
      customer_id: CUSTOMER_ID,
      kind: 'human_request',
      reason: fromAI('reason', 'Why a person is needed, in a few words'),
      summary: fromAI('summary', 'One or two sentences on what the customer needs'),
      notify_customer: false,
      last_message: "={{ $('Build prompt').first().json.latest_text }}",
    }));

  wf.add('code', 'Reply', codeParams(['wa', 'copy', 'agent'], `
const { state, settings } = $('Start').first().json;
const customer = state.customer;
let text = cleanAgentReply($input.first().json.output);
if (text && state.is_new) text += '\\n\\n' + copy.aiDisclosure(settings.brand || {});
const payloads = text ? [waText(waRecipientOf(customer), text)] : [];
return [{ json: waSendRequest(customer, payloads, null, settings) }];`));

  wf.add('execWorkflow', 'Send reply', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));

  // If Claude or a tool fails: apologise, alert the team, record the error.
  wf.add('code', 'Fallback reply', codeParams(['wa', 'copy'], `
const { state, settings } = $('Start').first().json;
return [{ json: waSendRequest(state.customer, [waText(waRecipientOf(state.customer), copy.agentFallback())], null, settings) }];`));
  wf.add('execWorkflow', 'Send fallback', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));
  wf.add('execWorkflow', 'Alert team', execWorkflowParams(WORKFLOW_IDS.escalate, {
    inputs: escalateInputs({
      customer_id: "={{ $('Start').first().json.state.customer.id }}",
      kind: 'human_request',
      reason: 'The assistant hit an error and could not reply',
      last_message: "={{ $('Build prompt').first().json.latest_text }}",
      notify_customer: false,
    }),
  }));
  wf.add('postgres', 'Log agent error', pgCall('log_event',
    "{ level: 'error', source: 'agent', message: 'AI agent failed', details: { error: $('AI Agent').first().json.error || null, customer_id: $('Start').first().json.state.customer.id } }"), pg);

  wf.chain('Start', 'Let them finish typing', 'Pending messages', 'Latest message?');
  wf.connect('Latest message?', 'Typing indicator', { output: 0 });
  wf.chain('Typing indicator', 'Recent conversation', 'Build prompt', 'AI Agent');
  wf.connect('AI Agent', 'Reply', { output: 0 });
  wf.connect('AI Agent', 'Fallback reply', { output: 1 });
  wf.chain('Reply', 'Send reply');
  wf.chain('Fallback reply', 'Send fallback', 'Alert team', 'Log agent error');
  return wf;
}
