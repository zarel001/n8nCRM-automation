const test = require('node:test');
const assert = require('node:assert/strict');

// router.js expects orders.js to be inlined before it (as in the n8n Code node)
Object.assign(globalThis, require('../../src/lib/orders.js'));
const { routeInbound } = require('../../src/lib/router.js');
const { parseOwnerInput } = require('../../src/lib/owner.js');

const customer = { id: 1, is_owner: false, bot_paused: false };
const base = { duplicate: false, customer, open_order: null, awaiting_location_order: null };
const text = (t) => ({ type: 'text', text: t });

test('duplicates and owner messages', () => {
  assert.equal(routeInbound(text('hi'), { duplicate: true }).route, 'ignore');
  assert.equal(routeInbound(text('hi'), { ...base, customer: { ...customer, is_owner: true } }).route, 'owner');
});

test('orders, format help, keywords', () => {
  const r = routeInbound(text('Order: Cinnamon 250ml x2\nName: Akosua'), base);
  assert.equal(r.route, 'order');
  assert.equal(r.order.qty, 2);
  assert.equal(routeInbound(text('Order: Cinnamon big x2'), base).route, 'order_help');
  assert.equal(routeInbound(text('STOP'), base).route, 'opt_out');
  assert.equal(routeInbound(text('start'), base).route, 'opt_in');
  assert.equal(routeInbound(text('Talk to a person'), base).route, 'human');
  assert.equal(routeInbound(text('human'), base).route, 'human');
  assert.equal(routeInbound(text('cancel'), base).route, 'cancel');
  assert.equal(routeInbound(text('cancel my order'), base).route, 'cancel');
  assert.equal(routeInbound(text('can I cancel if I pay late?'), base).route, 'agent');
  assert.equal(routeInbound(text('Do you deliver to Tema?'), base).route, 'agent');
});

test('screenshots only count as payments when an order is waiting', () => {
  const img = { type: 'image', text: null, media: { mediaId: 'M' } };
  assert.equal(routeInbound(img, { ...base, open_order: { id: 5 } }).route, 'payment');
  const r = routeInbound({ ...img, text: 'look' }, base);
  assert.equal(r.route, 'agent');
  assert.match(r.note, /photo with the caption "look"/);
  assert.equal(routeInbound({ type: 'document' }, { ...base, open_order: { id: 5 } }).route, 'receipt_not_image');
});

test('location pin only attaches to a paid order awaiting delivery details', () => {
  const loc = { type: 'location', location: { latitude: 5.6, longitude: -0.2, name: 'Osu' } };
  assert.equal(routeInbound(loc, { ...base, awaiting_location_order: { id: 9 } }).route, 'location');
  assert.equal(routeInbound(loc, base).route, 'agent');
});

test('customer buttons', () => {
  const tap = (id) => ({ type: 'interactive', reply: { id, title: 'x' } });
  assert.deepEqual(routeInbound(tap('cust:cancel:42'), base), { route: 'cancel', orderId: 42 });
  assert.equal(routeInbound(tap('cust:human'), base).route, 'human');
  assert.equal(routeInbound(tap('something-old'), base).route, 'agent');
});

test('during a takeover, chat goes to the owner but orders and screenshots still work', () => {
  const paused = { ...base, customer: { ...customer, bot_paused: true } };
  assert.equal(routeInbound(text('are you there?'), paused).route, 'takeover_forward');
  assert.equal(routeInbound(text('Order: Vanilla 150ml x1'), paused).route, 'order');
  assert.equal(routeInbound({ type: 'image', media: {} }, { ...paused, open_order: { id: 1 } }).route, 'payment');
});

test('voice, stickers, video', () => {
  assert.equal(routeInbound({ type: 'audio', media: { voice: true } }, base).route, 'voice');
  assert.equal(routeInbound({ type: 'sticker' }, base).route, 'ignore');
  assert.equal(routeInbound({ type: 'reaction' }, base).route, 'ignore');
  assert.equal(routeInbound({ type: 'video' }, base).route, 'unsupported');
});

test('owner input parsing', () => {
  const tap = (id) => ({ type: 'interactive', reply: { id } });
  assert.deepEqual(parseOwnerInput(tap('pay:approve:12'), null), { action: 'payment_decision', paymentId: 12, decision: 'approve' });
  assert.deepEqual(parseOwnerInput(tap('pay:reject:12'), null), { action: 'payment_decision', paymentId: 12, decision: 'reject' });
  assert.deepEqual(parseOwnerInput({ type: 'button', reply: { id: 'esc:take:3' } }, null), { action: 'takeover', escalationId: 3 });
  assert.deepEqual(parseOwnerInput(tap('esc:dismiss:3'), null), { action: 'dismiss', escalationId: 3 });
  assert.deepEqual(parseOwnerInput(tap('ord:out:8'), null), { action: 'advance', orderId: 8, status: 'out_for_delivery' });
  assert.deepEqual(parseOwnerInput(tap('ord:done:8'), null), { action: 'advance', orderId: 8, status: 'delivered' });
  assert.deepEqual(parseOwnerInput(tap('pay:steal:8'), null), { action: 'help' });
  assert.deepEqual(parseOwnerInput(text('/done'), { customer: {} }), { action: 'end_takeover' });
  assert.deepEqual(parseOwnerInput(text('/help'), null), { action: 'help' });
  assert.deepEqual(parseOwnerInput(text('On my way!'), { customer: {} }), { action: 'relay', text: 'On my way!' });
  assert.deepEqual(parseOwnerInput(text('On my way!'), null), { action: 'no_session' });
  assert.deepEqual(parseOwnerInput({ type: 'image' }, { customer: {} }), { action: 'relay_unsupported' });
});
