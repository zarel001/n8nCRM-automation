// End-to-end: signed Meta webhooks → gate → real n8n workflows → Postgres, with Meta and Claude
// mocked. Covers the whole storefront contract plus the agent, hand-off and template paths.
//   npm run test:e2e        (KEEP_STACK=1 leaves the containers running for inspection)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { startStack, SECRETS, OWNER, PHONE_NUMBER_ID } = require('./stack.js');
const { waitFor } = require('../helpers/postgres.js');

const CUSTOMER = '233241234567';
let stack;
let seq = 0;

test.before(async () => {
  stack = await startStack();
}, { timeout: 600000 });

test.after(async () => {
  await stack?.stop();
});

function envelope(messages, contacts) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '233558866617', phone_number_id: PHONE_NUMBER_ID },
      contacts, messages,
    } }] }],
  };
}

function inbound(from, name, message) {
  const id = message.id || `wamid.in.${Date.now()}.${++seq}`;
  return envelope([{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message }], [{ profile: { name }, wa_id: from }]);
}

async function post(payload, { secret = SECRETS.appSecret } = {}) {
  const raw = JSON.stringify(payload);
  const res = await fetch(stack.gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
    body: raw,
  });
  return res.status;
}

const text = (from, name, body, extra = {}) => post(inbound(from, name, { type: 'text', text: { body }, ...extra }));
const tap = (from, name, id, title = 'button') =>
  post(inbound(from, name, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }));

// Waits until at least `count` outbound WhatsApp messages exist after `since`, returns them.
async function outbound(since, count, timeoutMs = 45000) {
  let msgs = [];
  try {
    await waitFor(() => {
      msgs = stack.mock.sent().slice(since);
      return msgs.length >= count;
    }, { timeoutMs, intervalMs: 300 });
  } catch (e) {
    console.error(stack.n8nLogs());
    throw new Error(`expected ${count} outbound messages, got ${msgs.length}: ${JSON.stringify(msgs, null, 1).slice(0, 3000)}`);
  }
  // give straggling messages a moment, so "exactly N" assertions are meaningful
  await new Promise((r) => setTimeout(r, 1500));
  return stack.mock.sent().slice(since);
}

const to = (msgs, who) => msgs.filter((m) => m.to === who);
const bodyOf = (m) => (m.type === 'text' ? m.text.body : m.type === 'interactive' ? m.interactive.body.text : `[${m.type}:${m.template && m.template.name}]`);
const one = async (sql, params) => (await stack.admin.query(sql, params)).rows[0];

test('forged webhooks are rejected at the gate', async () => {
  const before = stack.mock.sent().length;
  assert.equal(await post(inbound(CUSTOMER, 'Akosua', { type: 'text', text: { body: 'hi' } }), { secret: 'wrong' }), 401);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(stack.mock.sent().length, before);
});

test('storefront checkout message → order + payment instructions (+ AI disclosure on first contact)', async () => {
  const since = stack.mock.sent().length;
  const payload = inbound(CUSTOMER, 'Akosua', { id: 'wamid.checkout.1', type: 'text', text: { body: 'Order: Cinnamon 250ml x2\nName: Akosua Mensah' } });
  assert.equal(await post(payload), 200);
  const msgs = await outbound(since, 1);
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.to, CUSTOMER);
  assert.equal(m.type, 'interactive');
  const body = m.interactive.body.text;
  assert.match(body, /Thanks, Akosua!/);
  assert.match(body, /\*Order MS-[A-Z0-9]{4}\*/);
  assert.match(body, /2 × Cinnamon 250ml — GHS 80\.00/);
  assert.match(body, /Number: \*055 886 6617\*/);
  assert.match(body, /I'm the Mash & Sip assistant, an AI/);
  assert.deepEqual(m.interactive.action.buttons.map((b) => b.reply.title), ['Cancel order', 'Talk to a person']);
  const order = await one("select code, status, total from crm.orders o join crm.customers c on c.id = o.customer_id where c.wa_id = $1", [CUSTOMER]);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(Number(order.total), 80);

  // Meta re-delivers the same webhook: nothing new happens
  const again = stack.mock.sent().length;
  assert.equal(await post(payload), 200);
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(stack.mock.sent().length, again);
});

test('payment screenshot → Claude reads it → customer told, owner gets screenshot + Approve/Reject', async () => {
  const order = await one("select o.* from crm.orders o join crm.customers c on c.id = o.customer_id where c.wa_id = $1 order by o.id desc limit 1", [CUSTOMER]);
  stack.mock.anthropic.extraction = {
    is_payment_receipt: true, provider: 'MTN MoMo', status: 'successful', amount: 80, currency: 'GHS',
    recipient_name: 'MASH AND SIP', recipient_number: '0558866617', sender_name: 'AKOSUA MENSAH',
    transaction_id: '48291034871', reference: order.code, transaction_time: new Date().toISOString().replace('T', ' ').slice(0, 16),
    legibility: 'clear', tampering_signs: [], notes: '',
  };
  const since = stack.mock.sent().length;
  assert.equal(await post(inbound(CUSTOMER, 'Akosua', { type: 'image', image: { id: 'MEDIA-001', mime_type: 'image/jpeg', sha256: 'sha-MEDIA-001' } })), 200);
  const msgs = await outbound(since, 2, 60000);

  const customerMsg = to(msgs, CUSTOMER)[0];
  assert.match(bodyOf(customerMsg), new RegExp(`confirming your payment for \\*${order.code}\\*`));
  const ownerMsg = to(msgs, OWNER)[0];
  assert.ok(ownerMsg, 'owner alerted');
  // owner has never messaged the bot → 24 h window closed → template with the screenshot
  assert.equal(ownerMsg.type, 'template');
  assert.equal(ownerMsg.template.name, 'payment_check');
  assert.equal(ownerMsg.template.components[0].parameters[0].image.id, 'uploaded-1');
  const payment = await one('select * from crm.payments where order_id = $1', [order.id]);
  assert.equal(payment.verdict, 'looks_ok');
  assert.equal(payment.status, 'pending_owner');
  assert.equal(payment.txn_id, '48291034871');
  assert.deepEqual(ownerMsg.template.components.slice(-2).map((c) => c.parameters[0].payload), [`pay:approve:${payment.id}`, `pay:reject:${payment.id}`]);
  assert.equal((await one('select status from crm.orders where id = $1', [order.id])).status, 'payment_review');

  const [extraction] = stack.mock.extractionRequests();
  assert.equal(extraction.model, 'claude-opus-5');
  assert.equal(extraction.fallbacks, 'default');
  assert.equal(extraction.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.ok(!JSON.stringify(extraction).includes('80.00'), 'expected amount not leaked to the model');
  assert.equal(stack.mock.uploads()[0].multipart, true);
});

test('owner approves → order paid, customer asked for location pin', async () => {
  const payment = await one("select p.id, o.code from crm.payments p join crm.orders o on o.id = p.order_id order by p.id desc limit 1");
  const since = stack.mock.sent().length;
  await tap(OWNER, 'Owner', `pay:approve:${payment.id}`, 'Approve');
  const msgs = await outbound(since, 2);
  assert.match(bodyOf(to(msgs, OWNER)[0]), new RegExp(`${payment.code} marked paid`));
  const c = to(msgs, CUSTOMER)[0];
  assert.equal(c.interactive.type, 'location_request_message');
  assert.match(c.interactive.body.text, /Payment confirmed ✅ Thank you, Akosua!/);
  assert.equal((await one('select status from crm.orders where code = $1', [payment.code])).status, 'paid');

  // tapping again is harmless
  const again = stack.mock.sent().length;
  await tap(OWNER, 'Owner', `pay:approve:${payment.id}`, 'Approve');
  const dup = await outbound(again, 1);
  assert.match(bodyOf(dup[0]), /already handled/);
});

test('customer shares location → owner gets delivery card → On the way / Delivered', async () => {
  const since = stack.mock.sent().length;
  await post(inbound(CUSTOMER, 'Akosua', { type: 'location', location: { latitude: 5.6037, longitude: -0.187, name: 'Osu', address: 'Oxford Street' } }));
  const msgs = await outbound(since, 2);
  assert.match(bodyOf(to(msgs, CUSTOMER)[0]), /Got it 📍/);
  const card = to(msgs, OWNER)[0];
  assert.equal(card.type, 'interactive', 'owner window is open now (they tapped Approve)');
  assert.match(card.interactive.body.text, /ready for delivery/);
  assert.match(card.interactive.body.text, /maps\.google\.com\/\?q=5\.6037,-0\.187/);
  const order = await one("select id, code, status from crm.orders order by id desc limit 1");
  assert.equal(order.status, 'ready');

  let s = stack.mock.sent().length;
  await tap(OWNER, 'Owner', `ord:out:${order.id}`, 'On the way');
  let out = await outbound(s, 2);
  assert.match(bodyOf(to(out, CUSTOMER)[0]), /on the way 🛵/);
  s = stack.mock.sent().length;
  await tap(OWNER, 'Owner', `ord:done:${order.id}`, 'Delivered');
  out = await outbound(s, 2);
  assert.match(bodyOf(to(out, CUSTOMER)[0]), /Delivered ✅/);
  assert.equal((await one('select status from crm.orders where id = $1', [order.id])).status, 'delivered');
});

test('AI agent answers a question with Claude (adaptive thinking, tools, cached system prompt)', async () => {
  stack.mock.anthropic.chat = [[{ type: 'text', text: 'Yes, we deliver across *Accra and Tema*! 🛵' }]];
  const since = stack.mock.sent().length;
  await text(CUSTOMER, 'Akosua', 'Do you deliver to Tema?');
  const msgs = await outbound(since, 1, 60000);
  assert.equal(bodyOf(msgs[0]), 'Yes, we deliver across *Accra and Tema*! 🛵');
  assert.ok(stack.mock.typing().length >= 1, 'typing indicator sent');

  const req = stack.mock.chatRequests().at(-1);
  assert.equal(req.model, 'claude-opus-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.output_config && req.output_config.effort, 'medium');
  assert.equal(req.temperature, undefined, 'no sampling params on current models');
  const system = typeof req.system === 'string' ? req.system : JSON.stringify(req.system);
  assert.match(system, /WhatsApp assistant for Mash & Sip Co\./);
  assert.match(system, /Delivery areas: Accra and Tema/);
  assert.deepEqual(req.tools.map((t) => t.name).sort(),
    ['cancel_my_order', 'create_order', 'get_my_orders', 'request_human', 'save_bulk_lead', 'set_delivery_details']);
  assert.match(JSON.stringify(req.messages), /Do you deliver to Tema\?/);
});

test('agent tool call: get_my_orders only ever sees the sender\'s orders', async () => {
  let toolResult = null;
  stack.mock.anthropic.chat = [
    [{ type: 'tool_use', id: 'toolu_1', name: 'get_my_orders', input: { input: 'orders' } }],
    (body) => {
      const last = body.messages.at(-1);
      toolResult = JSON.stringify(last.content);
      return [{ type: 'text', text: 'Your order is delivered — enjoy!' }];
    },
  ];
  const since = stack.mock.sent().length;
  await text(CUSTOMER, 'Akosua', 'where is my order?');
  const msgs = await outbound(since, 1, 60000);
  assert.equal(bodyOf(msgs[0]), 'Your order is delivered — enjoy!');
  const code = (await one("select code from crm.orders order by id desc limit 1")).code;
  assert.ok(toolResult && toolResult.includes(code), `tool result contains ${code}: ${toolResult}`);
  assert.match(toolResult, /delivered/);
});

test('bursts of short messages get one reply covering all of them', async () => {
  stack.mock.anthropic.chatFallback = [{ type: 'text', text: 'Sure! Which flavour would you like?' }];
  const since = stack.mock.sent().length;
  const chatBefore = stack.mock.chatRequests().length;
  await text(CUSTOMER, 'Akosua', 'hello');
  await text(CUSTOMER, 'Akosua', 'I want to order');
  await text(CUSTOMER, 'Akosua', 'for my sister');
  const msgs = await outbound(since, 1, 60000);
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(stack.mock.sent().length - since, 1, 'exactly one reply');
  assert.equal(stack.mock.chatRequests().length - chatBefore, 1, 'one model call');
  assert.match(JSON.stringify(stack.mock.chatRequests().at(-1).messages), /hello\\nI want to order\\nfor my sister/);
  assert.equal(bodyOf(msgs[0]), 'Sure! Which flavour would you like?');
});

test('agent places a chat order through create_order', async () => {
  stack.mock.anthropic.chat = [
    [{ type: 'tool_use', id: 'toolu_2', name: 'create_order', input: { variant: 'Vanilla', size: '500ml', qty: 3, name: 'Akosua' } }],
    [{ type: 'text', text: 'NO_REPLY' }],
  ];
  const since = stack.mock.sent().length;
  await text(CUSTOMER, 'Akosua', '3 vanilla 500ml please');
  const msgs = await outbound(since, 1, 60000);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(stack.mock.sent().length - since, 1, 'only the order summary, no extra AI message');
  assert.match(bodyOf(msgs[0]), /3 × Vanilla 500ml — GHS 210\.00/);
  const order = await one("select source, total from crm.orders order by id desc limit 1");
  assert.equal(order.source, 'chat');
  assert.equal(Number(order.total), 210);
});

test('hand-off: "human" → owner alert → take over → relay both ways → /done', async () => {
  const other = '233209990000';
  let since = stack.mock.sent().length;
  await text(other, 'Kofi', 'human');
  let msgs = await outbound(since, 2);
  assert.match(bodyOf(to(msgs, other)[0]), /let the team know/);
  const alert = to(msgs, OWNER)[0];
  assert.equal(alert.type, 'interactive');
  const takeId = alert.interactive.action.buttons[0].reply.id;
  assert.match(takeId, /^esc:take:\d+$/);

  since = stack.mock.sent().length;
  await tap(OWNER, 'Owner', takeId, 'Take over chat');
  msgs = await outbound(since, 2);
  assert.match(bodyOf(to(msgs, OWNER)[0]), /now chatting with \*Kofi/);
  assert.match(bodyOf(to(msgs, other)[0]), /chatting with the Mash & Sip team/);

  since = stack.mock.sent().length;
  const chatBefore = stack.mock.chatRequests().length;
  await text(other, 'Kofi', 'Can you bring 40 bottles on Saturday?');
  msgs = await outbound(since, 1);
  assert.equal(bodyOf(to(msgs, OWNER)[0]), '💬 *Kofi:* Can you bring 40 bottles on Saturday?');
  assert.equal(stack.mock.chatRequests().length, chatBefore, 'AI stays quiet during a takeover');

  since = stack.mock.sent().length;
  await text(OWNER, 'Owner', 'Yes we can! I will call you.');
  msgs = await outbound(since, 1);
  assert.equal(bodyOf(to(msgs, other)[0]), 'Yes we can! I will call you.');

  since = stack.mock.sent().length;
  await text(OWNER, 'Owner', '/done');
  msgs = await outbound(since, 2);
  assert.match(bodyOf(to(msgs, other)[0]), /assistant is back/);
  assert.equal((await one('select bot_paused_until from crm.customers where wa_id = $1', [other])).bot_paused_until, null);
});

test('owner alerts fall back to a template when the owner has been quiet for a day', async () => {
  await stack.admin.query("update crm.customers set last_inbound_at = now() - interval '2 days' where wa_id = $1", [OWNER]);
  const since = stack.mock.sent().length;
  await text('233201112222', 'Esi', 'talk to a person');
  const msgs = await outbound(since, 2);
  const alert = to(msgs, OWNER)[0];
  assert.equal(alert.type, 'template');
  assert.equal(alert.template.name, 'owner_alert');
  assert.equal(alert.template.components[0].parameters[0].text, 'chat request');
});

test('voice notes and wrong order formats get helpful replies', async () => {
  let since = stack.mock.sent().length;
  await post(inbound(CUSTOMER, 'Akosua', { type: 'audio', audio: { id: 'MEDIA-VOICE', mime_type: 'audio/ogg', voice: true } }));
  let msgs = await outbound(since, 1);
  assert.match(bodyOf(msgs[0]), /can't listen to voice notes yet/);
  since = stack.mock.sent().length;
  await text(CUSTOMER, 'Akosua', 'Order: Cinnamon big x2');
  msgs = await outbound(since, 1);
  assert.match(bodyOf(msgs[0]), /couldn't read that order/);
});

test('when Claude fails the customer gets an apology and the owner is alerted', async () => {
  await stack.admin.query("update crm.customers set last_inbound_at = now() where wa_id = $1", [OWNER]);
  stack.mock.anthropic.failNext = 10;
  const since = stack.mock.sent().length;
  await text('233203334444', 'Yaw', 'what flavours do you have?');
  const msgs = await outbound(since, 2, 90000);
  stack.mock.anthropic.failNext = 0;
  assert.match(bodyOf(to(msgs, '233203334444')[0]), /having a little trouble/);
  assert.match(bodyOf(to(msgs, OWNER)[0]), /The assistant hit an error/);
  const ev = await one("select count(*)::int as n from crm.ops_events where source = 'agent'");
  assert.ok(ev.n >= 1);
});

test('a message WhatsApp rejects is logged and alerts the developer', async () => {
  const before = stack.mock.alerts().length;
  await text('233000000404', 'Blocked', 'Order: Original 150ml x1\nName: Blocked');
  await waitFor(() => stack.mock.alerts().length > before, { timeoutMs: 45000, intervalMs: 300 });
  assert.match(stack.mock.alerts().at(-1).text, /WhatsApp send failed \(1 message, customer \d+\): \(#131030\) Recipient phone number not in allowed list/);
  const failed = await one("select m.status from crm.messages m join crm.customers c on c.id = m.customer_id where c.wa_id = '233000000404' and m.direction = 'out'");
  assert.equal(failed.status, 'failed');
  const ev = await one("select count(*)::int as n from crm.ops_events where source = 'whatsapp.send'");
  assert.ok(ev.n >= 1);
});

test('housekeeping: live catalog replaces the seed, reminders go out once', async () => {
  const s = await one("select id from crm.customers where wa_id = $1", [CUSTOMER]);
  const { rows } = await stack.admin.query(
    "insert into crm.orders (code, customer_id, customer_name, items, total, status, created_at) values ('MS-RMND', $1, 'Akosua', '[{\"variant\":\"Original\",\"size\":\"150ml\",\"qty\":1,\"unit_price\":25}]', 25, 'awaiting_payment', now() - interval '4 hours') returning id",
    [s.id]);
  const since = stack.mock.sent().length;
  await stack.run(['n8n', 'execute', '--id=MsHousekeep00001']);
  const msgs = await outbound(since, 1, 60000);
  assert.match(bodyOf(msgs[0]), /MS-RMND.*still waiting for payment/s);
  assert.ok((await one('select reminder_sent_at from crm.orders where id = $1', [rows[0].id])).reminder_sent_at);
  const catalog = await one("select value->>'source' as source from crm.settings where key = 'catalog'");
  assert.equal(catalog.source, 'storefront');
});
