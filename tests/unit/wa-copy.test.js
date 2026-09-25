const test = require('node:test');
const assert = require('node:assert/strict');
const { waText, waButtons, waLocationRequest, waTemplate, waTemplateText, waTyping, waLogBody, waRecipient } = require('../../src/lib/wa.js');
const { copy, customerLabel } = require('../../src/lib/copy.js');
const { precheckPayment } = require('../../src/lib/payments.js');

const order = {
  id: 5, code: 'MS-7K4Q', total: 80, currency: 'GHS', customer_name: 'Akosua Mensah', status: 'awaiting_payment',
  items: [{ variant: 'Cinnamon', size: '250ml', qty: 2, unit_price: 40 }], created_at: '2026-09-25T14:00:00Z',
};
const momo = { number: '055 886 6617', name: 'Mash & Sip Co.' };

test('recipient: phone wins, BSUID fallback, neither throws', () => {
  assert.deepEqual(waRecipient({ wa_id: '233241234567', bsuid: 'GH.1' }), { to: '233241234567' });
  assert.deepEqual(waRecipient({ bsuid: 'GH.1' }), { recipient: 'GH.1' });
  assert.throws(() => waRecipient({}), /neither/);
});

test('payload shapes and limits', () => {
  const t = waText({ wa_id: '1' }, 'x'.repeat(5000));
  assert.equal(t.type, 'text');
  assert.equal(t.text.body.length, 4096);
  const b = waButtons({ wa_id: '1' }, 'body', [
    { id: 'a', title: 'A very long button title indeed' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
  ], { header: { imageId: 'IMG' }, footer: 'f' });
  assert.equal(b.interactive.action.buttons.length, 3);
  assert.ok(b.interactive.action.buttons[0].reply.title.length <= 20);
  assert.deepEqual(b.interactive.header, { type: 'image', image: { id: 'IMG' } });
  assert.equal(waLocationRequest({ wa_id: '1' }, 'where?').interactive.action.name, 'send_location');
  assert.equal(waTemplate({ bsuid: 'GH.1' }, 'owner_alert', 'en', []).recipient, 'GH.1');
  assert.equal(waTemplateText('a\nb\tc      d').text, 'a b c   d');
  assert.deepEqual(waTyping('wamid.1'), { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.1', typing_indicator: { type: 'text' } });
  assert.equal(waLogBody(b), 'body');
});

test('order confirmation carries code, total and MoMo details', () => {
  const body = copy.orderReceived(order, momo, false);
  assert.match(body, /Thanks, Akosua!/);
  assert.match(body, /\*Order MS-7K4Q\*/);
  assert.match(body, /2 × Cinnamon 250ml — GHS 80.00/);
  assert.match(body, /\*Total: GHS 80.00\*/);
  assert.match(body, /Number: \*055 886 6617\*/);
  assert.match(body, /Reference: \*MS-7K4Q\*/);
  assert.ok(body.length < 1024, 'must fit an interactive message body');
  assert.match(copy.orderReceived(order, momo, true), /already have order \*MS-7K4Q\*/);
});

test('owner payment review fits the 1024-char interactive body even with hostile input', () => {
  const extraction = {
    is_payment_receipt: true, status: 'successful', amount: 80, currency: 'GHS', recipient_name: 'X'.repeat(300),
    recipient_number: '0558866617', transaction_id: '9'.repeat(200), transaction_time: 'T'.repeat(200), legibility: 'clear',
    tampering_signs: ['a'.repeat(300), 'b'.repeat(300)], reference: null, notes: '',
  };
  const precheck = precheckPayment({ extraction, order, merchant: { momo_number: momo.number, momo_name: momo.name }, duplicates: {}, now: '2026-09-25T15:00:00Z' });
  const body = copy.ownerPaymentReview({ order, customer: { display_name: 'Akosua', wa_id: '233241234567' }, extraction, precheck });
  const payload = waButtons({ wa_id: '233200000000' }, body, copy.ownerPaymentButtons(7));
  assert.ok(payload.interactive.body.text.length <= 1024);
  assert.deepEqual(payload.interactive.action.buttons.map((b) => b.reply.id), ['pay:approve:7', 'pay:reject:7']);
});

test('owner-facing labels never invent a number for username-only customers', () => {
  assert.equal(customerLabel({ display_name: 'Kofi', wa_id: null }), 'Kofi (number hidden)');
  assert.equal(customerLabel({ profile_name: 'Ama', wa_id: '233241234567' }), 'Ama (+233241234567)');
});

test('button titles stay within WhatsApp limits', () => {
  for (const b of [...copy.orderButtons(order), ...copy.ownerPaymentButtons(1), ...copy.ownerEscalationButtons(1), ...copy.ownerOrderButtons(1)]) {
    assert.ok([...b.title].length <= 20, b.title);
  }
});
