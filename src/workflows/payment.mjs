import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, triggerParams, execWorkflowParams,
} from '../../scripts/lib/wf.mjs';

// Flow · Payment — a customer with an unpaid order sent a screenshot:
// download it → Claude reads it (structured output, blind to the expected values) → code
// compares it with the order and looks for re-used transactions/images → saved for review →
// the owner gets the screenshot with Approve / Reject → the customer is told it's being checked.
export default function payment() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.payment,
    name: 'Flow · Payment screenshot',
    description: 'Reads a Mobile Money screenshot, pre-checks it and asks the owner to approve.',
  });

  const graphRetry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

  wf.add('execTrigger', 'Start', triggerParams());

  wf.add('postgres', 'Owner', pgQuery("select crm.get_owner('{}'::jsonb) as owner"), { credentials: CREDENTIALS.postgres });

  wf.add('code', 'Prepare', codeParams([], `
const { msg, state, settings } = $('Start').first().json;
const wa = settings.whatsapp || {};
const graph = wa.graph_base_url + '/' + wa.graph_version;
const media = msg.media || {};
return [{ json: {
  graph,
  mediaInfoUrl: graph + '/' + media.mediaId,
  uploadUrl: graph + '/' + wa.phone_number_id + '/media',
  mediaId: media.mediaId,
  sha256: media.sha256 || null,
  order: state.open_order,
  customer: state.customer,
  owner: $input.first().json.owner,
  settings,
} }];`));

  wf.add('http', 'Media info', {
    method: 'GET',
    url: '={{ $json.mediaInfoUrl }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'whatsAppApi',
    options: { timeout: 20000 },
  }, { credentials: CREDENTIALS.whatsapp, ...graphRetry });

  wf.add('http', 'Download', {
    method: 'GET',
    url: '={{ $json.url }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'whatsAppApi',
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } }, timeout: 30000 },
  }, { credentials: CREDENTIALS.whatsapp, ...graphRetry });

  wf.add('extractFromFile', 'To base64', {
    operation: 'binaryToPropery',
    binaryPropertyName: 'data',
    destinationKey: 'imageBase64',
    options: { keepSource: 'both' },
  });

  // Re-upload so the owner's alert can show the screenshot (inbound media IDs can't be re-sent).
  wf.add('http', 'Upload for owner', {
    method: 'POST',
    url: "={{ $('Prepare').first().json.uploadUrl }}",
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'whatsAppApi',
    sendBody: true,
    contentType: 'multipart-form-data',
    bodyParameters: {
      parameters: [
        { parameterType: 'formData', name: 'messaging_product', value: 'whatsapp' },
        { parameterType: 'formData', name: 'type', value: "={{ $('Media info').first().json.mime_type || 'image/jpeg' }}" },
        { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      ],
    },
    options: { timeout: 30000 },
  }, { credentials: CREDENTIALS.whatsapp, ...graphRetry });

  wf.add('code', 'Build extraction request', codeParams(['payments'], `
const p = $('Prepare').first().json;
const info = $('Media info').first().json;
const mediaType = String(info.mime_type || 'image/jpeg').split(';')[0].trim();
const ai = p.settings.ai || {};
return [{ json: {
  url: (ai.anthropic_base_url || 'https://api.anthropic.com') + '/v1/messages',
  body: buildExtractionRequest({ model: ai.vision_model, imageBase64: $('To base64').first().json.imageBase64, mediaType }),
  betaHeader: EXTRACTION_BETA_HEADER,
} }];`));

  wf.add('http', 'Read screenshot (Claude)', {
    method: 'POST',
    url: '={{ $json.url }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'anthropicApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'anthropic-beta', value: '={{ $json.betaHeader }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { response: { response: { neverError: true } }, timeout: 180000 },
  }, { credentials: CREDENTIALS.anthropic, onError: 'continueRegularOutput' });

  wf.add('code', 'Parse extraction', codeParams(['payments'], `
const parsed = parseExtractionResponse($input.first().json);
return [{ json: { parsed, txnId: parsed.ok ? normalizeTxnId(parsed.data.transaction_id) : null } }];`));

  wf.add('postgres', 'Find re-use', pgCall('payment_duplicates',
    "{ order_id: $('Prepare').first().json.order.id, txn_id: $json.txnId, media_sha256: $('Media info').first().json.sha256 || $('Prepare').first().json.sha256 }"),
  { credentials: CREDENTIALS.postgres });

  wf.add('code', 'Pre-check', codeParams(['payments'], `
const p = $('Prepare').first().json;
const parsed = $('Parse extraction').first().json.parsed;
const momo = p.settings.momo || {};
const pre = precheckPayment({
  extraction: parsed.ok ? parsed.data : null,
  order: p.order,
  merchant: { momo_number: momo.number, momo_name: momo.name },
  duplicates: $input.first().json.result,
  now: new Date().toISOString(),
});
return [{ json: { pre, extraction: parsed.ok ? parsed.data : { error: parsed.reason } } }];`));

  wf.add('postgres', 'Save for review', pgCall('record_payment', `{
    order_id: $('Prepare').first().json.order.id,
    customer_id: $('Prepare').first().json.customer.id,
    media_id: $('Prepare').first().json.mediaId,
    media_sha256: $('Media info').first().json.sha256 || $('Prepare').first().json.sha256,
    mime_type: $('Media info').first().json.mime_type,
    image_base64: $('To base64').first().json.imageBase64,
    extraction: $json.extraction,
    precheck: $json.pre,
    verdict: $json.pre.verdict,
    txn_id: $json.pre.txnId,
    amount: $json.pre.amount
  }`), { credentials: CREDENTIALS.postgres });

  wf.add('code', 'Compose', codeParams(['wa', 'copy', 'templates'], `
const p = $('Prepare').first().json;
const { pre, extraction } = $('Pre-check').first().json;
const saved = $input.first().json.result;
const settings = p.settings;
const lang = (settings.whatsapp && settings.whatsapp.template_language) || 'en';
const customer = p.customer;
const out = [];

if (!saved.ok) {
  // the order was paid or cancelled in the meantime
  const status = saved.order ? saved.order.status : 'unknown';
  out.push(waSendRequest(customer, [waText(waRecipientOf(customer),
    'Thanks! That order is already ' + String(status).replace(/_/g, ' ') + '. Reply *human* if something looks wrong.')], null, settings));
  return out.map((json) => ({ json }));
}

const order = saved.order;
out.push(waSendRequest(customer, [waText(waRecipientOf(customer), copy.paymentReceived(order, pre.verdict))], null, settings));

const owner = p.owner;
if (owner) {
  const imageId = $('Upload for owner').first().json.id || null;
  const body = copy.ownerPaymentReview({ order, customer, extraction: pre.verdict === 'unreadable' ? null : extraction, precheck: pre });
  const freeform = waButtons(waRecipientOf(owner), body, copy.ownerPaymentButtons(saved.payment_id), imageId ? { header: { imageId } } : {});
  const summary = pre.verdict === 'looks_ok' ? 'amount, recipient and transaction ID look right'
    : pre.verdict === 'unreadable' ? 'could not read the screenshot' : pre.flags.slice(0, 2).join(' ');
  const template = imageId ? tplPaymentCheck(waRecipientOf(owner), lang, {
    imageId, orderCode: order.code, customer: customerLabel(customer), expected: copyMoney(order.total, order.currency),
    precheck: summary, paymentId: saved.payment_id,
  }) : null;
  out.push(waSendRequest(owner, [freeform], template, settings));
}
return out.map((json) => ({ json }));`));

  wf.add('execWorkflow', 'Send', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));

  wf.chain('Start', 'Owner', 'Prepare', 'Media info', 'Download', 'To base64', 'Upload for owner', 'Build extraction request',
    'Read screenshot (Claude)', 'Parse extraction', 'Find re-use', 'Pre-check', 'Save for review', 'Compose', 'Send');
  return wf;
}
