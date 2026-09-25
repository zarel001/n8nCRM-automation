// WhatsApp message templates: the only way to message someone whose 24-hour customer-service
// window is closed. Owner alerts use them whenever the owner hasn't messaged the bot in the last
// day. The definitions to submit to Meta are in templates/whatsapp-templates.json; the parameter
// counts here must match (tests/unit/templates.test.js checks this).
//
// Inlined into n8n Code nodes after wa.js (uses waTemplate / waTemplateText).
/* global waTemplate, waTemplateText */

const TEMPLATE = {
  paymentCheck: 'payment_check',
  ownerAlert: 'owner_alert',
  orderReady: 'order_ready',
  paymentConfirmed: 'payment_confirmed',
  paymentNotConfirmed: 'payment_not_confirmed',
  orderOnTheWay: 'order_on_the_way',
  orderDelivered: 'order_delivered',
};

function tplBody(values) {
  return { type: 'body', parameters: values.map((v) => waTemplateText(v)) };
}

function tplQuickReplies(payloads) {
  return payloads.map((payload, i) => ({
    type: 'button',
    sub_type: 'quick_reply',
    index: String(i),
    parameters: [{ type: 'payload', payload }],
  }));
}

// Owner: screenshot + summary + Approve / Reject.
function tplPaymentCheck(r, lang, { imageId, orderCode, customer, expected, precheck, paymentId }) {
  return waTemplate(r, TEMPLATE.paymentCheck, lang, [
    { type: 'header', parameters: [{ type: 'image', image: { id: imageId } }] },
    tplBody([orderCode, customer, expected, precheck]),
    ...tplQuickReplies([`pay:approve:${paymentId}`, `pay:reject:${paymentId}`]),
  ]);
}

// Owner: someone wants a person / a bulk-order lead / a message during a takeover.
function tplOwnerAlert(r, lang, { what, customer, details, escalationId }) {
  return waTemplate(r, TEMPLATE.ownerAlert, lang, [
    tplBody([what, customer, details]),
    ...tplQuickReplies([`esc:take:${escalationId}`, `esc:dismiss:${escalationId}`]),
  ]);
}

// Owner: paid order with delivery details.
function tplOrderReady(r, lang, { orderCode, items, customer, location, orderId }) {
  return waTemplate(r, TEMPLATE.orderReady, lang, [
    tplBody([orderCode, items, customer, location]),
    ...tplQuickReplies([`ord:out:${orderId}`, `ord:done:${orderId}`]),
  ]);
}

// Customer updates: name + order code.
function tplCustomerUpdate(r, lang, name, firstName, orderCode) {
  return waTemplate(r, name, lang, [tplBody([firstName || 'there', orderCode])]);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TEMPLATE, tplPaymentCheck, tplOwnerAlert, tplOrderReady, tplCustomerUpdate };
}
