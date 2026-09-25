// Exercises every crm.* function as the restricted mashsip_bot role, against a Postgres
// container initialised with the production scripts. Requires Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startPostgres, call } = require('../helpers/postgres.js');

const OWNER = '233200000001';
let pg;
let bot;
let admin;

test.before(async () => {
  pg = await startPostgres({ name: 'mashsip-dbtest', port: 55433 });
  bot = new Client(pg.bot());
  admin = new Client(pg.admin());
  await bot.connect();
  await admin.connect();
  await admin.query(`select crm.put_setting($1::jsonb)`, [JSON.stringify({ key: 'owner', value: { wa_id: OWNER, name: 'Owner' } })]);
  await admin.query(`select crm.put_setting($1::jsonb)`, [JSON.stringify({ key: 'momo', value: { number: '055 886 6617', name: 'Mash & Sip Co.' } })]);
});

test.after(async () => {
  await bot?.end();
  await admin?.end();
  pg?.stop();
});

let seq = 0;
const inbound = (from, extra = {}) =>
  call(bot, 'ingest_inbound', { wa_message_id: `wamid.${++seq}`, phone: from, type: 'text', body: 'hi', ...extra });

test('bot role can only execute the API functions', async () => {
  await assert.rejects(bot.query('select * from crm.orders'), /permission denied/);
  await assert.rejects(bot.query('select * from crm.settings'), /permission denied/);
  await assert.rejects(bot.query(`select crm.put_setting('{"key":"owner","value":{}}')`), /permission denied/);
  await assert.rejects(bot.query('create table crm.x (id int)'), /permission denied/);
  const settings = await call(bot, 'get_settings');
  assert.equal(settings.owner.wa_id, OWNER);
  assert.equal(settings.catalog.sizes.length, 3);
});

test('config_problems lists what is still missing', async () => {
  const problems = await call(bot, 'config_problems');
  assert.ok(problems.some((p) => p.includes('phone_number_id')));
  assert.ok(!problems.some((p) => p.includes('owner.wa_id')));
});

test('ingest: new customer, duplicate delivery, owner detection', async () => {
  const first = await call(bot, 'ingest_inbound', { wa_message_id: 'wamid.dup', phone: '233241234567', profile_name: 'Akosua', type: 'text', body: 'Hello' });
  assert.equal(first.duplicate, false);
  assert.equal(first.is_new, true);
  assert.equal(first.customer.wa_id, '233241234567');
  assert.equal(first.customer.name, 'Akosua');
  assert.equal(first.customer.window_open, true);
  const again = await call(bot, 'ingest_inbound', { wa_message_id: 'wamid.dup', phone: '233241234567', type: 'text', body: 'Hello' });
  assert.equal(again.duplicate, true);
  const owner = await inbound(OWNER);
  assert.equal(owner.customer.is_owner, true);
});

test('BSUID-only customer later gains a phone number', async () => {
  const a = await call(bot, 'ingest_inbound', { wa_message_id: 'wamid.b1', bsuid: 'GH.555', type: 'text', body: 'x' });
  assert.equal(a.customer.wa_id, null);
  const b = await call(bot, 'ingest_inbound', { wa_message_id: 'wamid.b2', bsuid: 'GH.555', phone: '233209999999', type: 'text', body: 'y' });
  assert.equal(b.customer.id, a.customer.id);
  assert.equal(b.customer.wa_id, '233209999999');
  assert.equal(b.is_new, true, 'no outbound yet, still new');
});

test('orders: pricing from the catalog, duplicate taps, validation', async () => {
  const s = await inbound('233241110000');
  const customer_id = s.customer.id;
  const r = await call(bot, 'create_order', { customer_id, variant: 'cinnamon', size: '250ml', qty: 2, name: 'Akosua Mensah' });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.match(r.order.code, /^MS-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(Number(r.order.total), 80);
  assert.deepEqual(r.order.items, [{ variant: 'Cinnamon', size: '250ml', qty: 2, unit_price: 40 }]);
  const dup = await call(bot, 'create_order', { customer_id, variant: 'Cinnamon', size: '250ml', qty: 2 });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.order.id, r.order.id);

  assert.equal((await call(bot, 'create_order', { customer_id, variant: 'Chocolate', size: '250ml', qty: 1 })).error, 'unknown_variant');
  assert.equal((await call(bot, 'create_order', { customer_id, variant: 'Vanilla', size: '1000ml', qty: 1 })).error, 'unknown_size');
  assert.equal((await call(bot, 'create_order', { customer_id, variant: 'Vanilla', size: '150ml', qty: 25 })).error, 'bad_qty');
  assert.equal((await call(bot, 'create_order', { customer_id, variant: 'Vanilla', size: '150ml', qty: '1; drop table x' })).error, 'bad_qty');

  const state = await inbound('233241110000');
  assert.equal(state.open_order.code, r.order.code);
  const mine = await call(bot, 'customer_orders', { customer_id });
  assert.equal(mine.length, 1);
});

test('payments: review, owner approval, re-use detection, location, delivery', async () => {
  const s = await inbound('233241220000');
  const customer_id = s.customer.id;
  const { order } = await call(bot, 'create_order', { customer_id, variant: 'Original', size: '500ml', qty: 1, name: 'Kofi' });

  const rec = await call(bot, 'record_payment', {
    order_id: order.id, customer_id, media_id: 'MEDIA-1', media_sha256: 'sha-1', mime_type: 'image/jpeg',
    image_base64: Buffer.from('fake-jpeg').toString('base64'), extraction: { amount: 70 }, precheck: { verdict: 'looks_ok' },
    verdict: 'looks_ok', txn_id: 'TXN12345', amount: 70,
  });
  assert.equal(rec.ok, true);
  assert.equal(rec.order.status, 'payment_review');

  // someone else tries the same transaction and the same image on their own order
  const other = await inbound('233241330000');
  const o2 = (await call(bot, 'create_order', { customer_id: other.customer.id, variant: 'Vanilla', size: '500ml', qty: 1 })).order;
  const dups = await call(bot, 'payment_duplicates', { order_id: o2.id, txn_id: 'TXN12345', media_sha256: 'sha-1' });
  assert.deepEqual(dups, { txn_used_by: order.code, image_used_by: order.code });
  // and can't record a payment against an order that isn't theirs
  assert.equal((await call(bot, 'record_payment', { order_id: order.id, customer_id: other.customer.id, media_id: 'M', verdict: 'mismatch' })).ok, false);

  const approved = await call(bot, 'decide_payment', { payment_id: rec.payment_id, decision: 'approve' });
  assert.equal(approved.ok, true);
  assert.equal(approved.order.status, 'paid');
  assert.equal(approved.customer.wa_id, '233241220000');
  const twice = await call(bot, 'decide_payment', { payment_id: rec.payment_id, decision: 'reject' });
  assert.equal(twice.error, 'already_decided');

  // the second order reuses the approved transaction: approval is refused
  const rec2 = await call(bot, 'record_payment', { order_id: o2.id, customer_id: other.customer.id, media_id: 'MEDIA-2', verdict: 'mismatch', txn_id: 'TXN12345' });
  const refused = await call(bot, 'decide_payment', { payment_id: rec2.payment_id, decision: 'approve' });
  assert.equal(refused.error, 'txn_already_used');
  assert.equal(refused.other_order, order.code);
  const rejected = await call(bot, 'decide_payment', { payment_id: rec2.payment_id, decision: 'reject' });
  assert.equal(rejected.order.status, 'awaiting_payment');

  const state = await inbound('233241220000', { type: 'location' });
  assert.equal(state.awaiting_location_order.code, order.code);
  const loc = await call(bot, 'set_order_location', { customer_id, location: { latitude: 5.6, longitude: -0.18, name: 'Osu' } });
  assert.equal(loc.order.status, 'ready');
  assert.equal((await call(bot, 'advance_order', { order_id: order.id, status: 'out_for_delivery' })).order.status, 'out_for_delivery');
  const done = await call(bot, 'advance_order', { order_id: order.id, status: 'delivered' });
  assert.equal(done.order.status, 'delivered');
  assert.equal(done.customer.id, customer_id);
  assert.equal((await call(bot, 'advance_order', { order_id: order.id, status: 'out_for_delivery' })).error, 'bad_transition');
});

test('cancel only touches the sender\'s own unpaid order', async () => {
  const a = await inbound('233241440000');
  const b = await inbound('233241550000');
  const { order } = await call(bot, 'create_order', { customer_id: a.customer.id, variant: 'Vanilla', size: '150ml', qty: 1 });
  assert.equal((await call(bot, 'cancel_order', { customer_id: b.customer.id, code: order.code })).ok, false);
  const ok = await call(bot, 'cancel_order', { customer_id: a.customer.id });
  assert.equal(ok.order.status, 'cancelled');
});

test('delivery note from chat marks a paid order ready', async () => {
  const s = await inbound('233241660000');
  const { order } = await call(bot, 'create_order', { customer_id: s.customer.id, variant: 'Vanilla', size: '150ml', qty: 1 });
  assert.equal((await call(bot, 'set_delivery_note', { customer_id: s.customer.id, note: 'Opposite the Shell, Spintex' })).error, 'no_paid_order');
  const rec = await call(bot, 'record_payment', { order_id: order.id, customer_id: s.customer.id, media_id: 'M3', verdict: 'looks_ok' });
  await call(bot, 'decide_payment', { payment_id: rec.payment_id, decision: 'approve' });
  const r = await call(bot, 'set_delivery_note', { customer_id: s.customer.id, note: 'Opposite the Shell, Spintex' });
  assert.equal(r.order.status, 'ready');
  assert.equal(r.order.delivery_note, 'Opposite the Shell, Spintex');
});

test('escalations are de-duplicated; takeover pauses and resumes the bot', async () => {
  const s = await inbound('233241770000');
  const e1 = await call(bot, 'open_escalation', { customer_id: s.customer.id, kind: 'human_request', reason: 'asked' });
  const e2 = await call(bot, 'open_escalation', { customer_id: s.customer.id, kind: 'human_request', reason: 'asked again' });
  assert.equal(e2.existing, true);
  assert.equal(e2.escalation_id, e1.escalation_id);

  const t = await call(bot, 'start_takeover', { escalation_id: e1.escalation_id });
  assert.equal(t.customer.bot_paused, true);
  const during = await inbound('233241770000');
  assert.equal(during.customer.bot_paused, true);
  const ownerState = await inbound(OWNER);
  assert.equal(ownerState.owner_session.customer.id, s.customer.id);
  assert.equal((await call(bot, 'touch_takeover')).ok, true);

  const ended = await call(bot, 'end_takeover');
  assert.equal(ended.customer.bot_paused, false);
  assert.equal((await inbound(OWNER)).owner_session, null);
  assert.equal((await call(bot, 'end_takeover')).error, 'no_active_takeover');
});

test('bursts: only the latest message answers, with all pending texts', async () => {
  const a = await call(bot, 'ingest_inbound', { wa_message_id: 'burst-1', phone: '233241880000', type: 'text', body: 'hi' });
  const b = await call(bot, 'ingest_inbound', { wa_message_id: 'burst-2', phone: '233241880000', type: 'text', body: 'do you deliver' });
  const c = await call(bot, 'ingest_inbound', { wa_message_id: 'burst-3', phone: '233241880000', type: 'text', body: 'to Tema?' });
  assert.equal((await call(bot, 'pending_inbound', { customer_id: a.customer.id, message_id: a.message_id })).is_latest, false);
  const last = await call(bot, 'pending_inbound', { customer_id: c.customer.id, message_id: c.message_id });
  assert.equal(last.is_latest, true);
  assert.deepEqual(last.texts, ['hi', 'do you deliver', 'to Tema?']);
  await call(bot, 'log_outbound', { customer_id: a.customer.id, wa_message_id: 'wamid.out-1', type: 'text', body: 'Yes we do' });
  const d = await call(bot, 'ingest_inbound', { wa_message_id: 'burst-4', phone: '233241880000', type: 'text', body: 'thanks' });
  assert.deepEqual((await call(bot, 'pending_inbound', { customer_id: d.customer.id, message_id: d.message_id })).texts, ['thanks']);
  assert.equal(d.is_new, false);
  const transcript = await call(bot, 'recent_transcript', { customer_id: d.customer.id, limit: 3 });
  assert.deepEqual(transcript.map((m) => [m.dir, m.body]), [['in', 'to Tema?'], ['out', 'Yes we do'], ['in', 'thanks']]);
  assert.equal(b.duplicate, false);
});

test('status updates and failures are recorded', async () => {
  const s = await inbound('233241990000');
  await call(bot, 'log_outbound', { customer_id: s.customer.id, wa_message_id: 'wamid.st', type: 'text', body: 'x' });
  assert.equal((await call(bot, 'apply_status', { wa_message_id: 'wamid.st', status: 'delivered' })).matched, true);
  await call(bot, 'apply_status', { wa_message_id: 'wamid.st', status: 'failed', errors: [{ code: 131047 }] });
  const { rows } = await admin.query(`select count(*)::int as n from crm.ops_events where source = 'whatsapp.status'`);
  assert.equal(rows[0].n, 1);
});

test('housekeeping: reminders, expiry, retention, stale takeovers', async () => {
  const s = await inbound('233240001111');
  const { order } = await call(bot, 'create_order', { customer_id: s.customer.id, variant: 'Original', size: '150ml', qty: 1 });
  await admin.query(`update crm.orders set created_at = now() - interval '4 hours' where id = $1`, [order.id]);
  const due = await call(bot, 'orders_due_for_reminder', { after_hours: 3 });
  assert.ok(due.some((d) => d.order.id === order.id));
  await call(bot, 'mark_reminded', { order_id: order.id });
  assert.ok(!(await call(bot, 'orders_due_for_reminder', { after_hours: 3 })).some((d) => d.order.id === order.id));

  await admin.query(`update crm.orders set created_at = now() - interval '3 days' where id = $1`, [order.id]);
  const hk = await call(bot, 'housekeeping', { expire_after_hours: 48 });
  assert.ok(hk.expired_orders >= 1);
  const { rows } = await admin.query('select status from crm.orders where id = $1', [order.id]);
  assert.equal(rows[0].status, 'expired');
});

test('catalog cache rejects malformed catalogs', async () => {
  assert.equal((await call(bot, 'cache_catalog', { variants: [], sizes: [] })).error, 'invalid_catalog');
  assert.equal((await call(bot, 'cache_catalog', { variants: [{ name: 'X' }], sizes: [{ label: '150ml', price: -1 }] })).error, 'invalid_catalog');
  const ok = await call(bot, 'cache_catalog', {
    variants: [{ id: 'original', name: 'Original' }], sizes: [{ label: '150ml', price: 30 }], maxQty: 24, brand: { currency: 'GHS' },
  });
  assert.equal(ok.ok, true);
  const s = await inbound('233240002222');
  const r = await call(bot, 'create_order', { customer_id: s.customer.id, variant: 'Original', size: '150ml', qty: 2 });
  assert.equal(Number(r.order.total), 60);
});
