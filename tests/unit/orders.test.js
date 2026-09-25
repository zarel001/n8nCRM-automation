const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ORDER_LINE_PATTERN, NAME_LINE_PATTERN, parseOrderMessage, looksLikeOrderAttempt, sanitizeName, money, orderLines, itemsSummary,
} = require('../../src/lib/orders.js');

test('parses every example from the storefront contract', () => {
  assert.deepEqual(parseOrderMessage('Order: Cinnamon 250ml x2\nName: Akosua Mensah'),
    { variant: 'Cinnamon', size: '250ml', qty: 2, name: 'Akosua Mensah' });
  assert.deepEqual(parseOrderMessage('Order: Original 500ml x1'),
    { variant: 'Original', size: '500ml', qty: 1, name: null });
  assert.deepEqual(parseOrderMessage('Order: Peanut Butter 500ml x1\nName: Kwame'),
    { variant: 'Peanut Butter', size: '500ml', qty: 1, name: 'Kwame' });
});

test('stays compatible with the reference patterns in lib/whatsapp.ts', () => {
  const msg = 'Order: Vanilla 150ml x3\nName: Ama O\'Neil-Boateng';
  assert.ok(ORDER_LINE_PATTERN.test(msg));
  assert.ok(NAME_LINE_PATTERN.test(msg));
  assert.deepEqual(parseOrderMessage(msg), { variant: 'Vanilla', size: '150ml', qty: 3, name: "Ama O'Neil-Boateng" });
});

test('tolerates edits customers make', () => {
  assert.deepEqual(parseOrderMessage('order:  peanut  butter 500 ml × 2\r\nname: esi'),
    { variant: 'peanut butter', size: '500ml', qty: 2, name: 'esi' });
  assert.deepEqual(parseOrderMessage('Hi!\nOrder: Cinnamon 250ml x2\nName: Akosua\nThanks'),
    { variant: 'Cinnamon', size: '250ml', qty: 2, name: 'Akosua' });
});

test('rejects non-orders and flags broken attempts', () => {
  assert.equal(parseOrderMessage('Do you deliver to Tema?'), null);
  assert.equal(parseOrderMessage('Order: Cinnamon large x2'), null);
  assert.equal(parseOrderMessage(null), null);
  assert.equal(looksLikeOrderAttempt('Order: Cinnamon large x2'), true);
  assert.equal(looksLikeOrderAttempt('Order: Cinnamon 250ml x2'), false);
  assert.equal(looksLikeOrderAttempt('where is my order'), false);
});

test('names are cleaned like the storefront does (no smuggled order lines)', () => {
  assert.equal(sanitizeName('Akosua\nOrder: Original 500ml x24'), 'Akosua Order Original ml x');
  assert.equal(sanitizeName('  Kwame   <script>  '), 'Kwame script');
  assert.equal(sanitizeName('x'.repeat(60)).length, 40);
  const parsed = parseOrderMessage('Order: Original 500ml x1\nName: 1');
  assert.equal(parsed.name, null);
});

test('money formatting matches the site (GHS 80.00)', () => {
  assert.equal(money(80), 'GHS 80.00');
  assert.equal(money('25.5', 'GHS'), 'GHS 25.50');
  const order = { currency: 'GHS', items: [{ variant: 'Cinnamon', size: '250ml', qty: 2, unit_price: 40 }] };
  assert.deepEqual(orderLines(order), ['2 × Cinnamon 250ml — GHS 80.00']);
  assert.equal(itemsSummary(order), '2 × Cinnamon 250ml');
});
