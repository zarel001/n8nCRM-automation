const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWebhook, metaIdentity } = require('../../src/lib/meta.js');

function envelope(value) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID', display_phone_number: '233558866617' }, ...value } }] }],
  };
}

test('text message with phone + BSUID', () => {
  const [e] = normalizeWebhook(envelope({
    contacts: [{ profile: { name: 'Akosua' }, wa_id: '233241234567', user_id: 'GH.998877' }],
    messages: [{ from: '233241234567', from_user_id: 'GH.998877', id: 'wamid.1', timestamp: '1790000000', type: 'text', text: { body: 'Hello' } }],
  }));
  assert.equal(e.kind, 'message');
  assert.equal(e.waMessageId, 'wamid.1');
  assert.deepEqual(e.from, { phone: '233241234567', bsuid: 'GH.998877', profileName: 'Akosua', username: null });
  assert.equal(e.text, 'Hello');
  assert.equal(e.body, 'Hello');
  assert.equal(e.phoneNumberId, 'PNID');
});

test('username user: phone omitted, BSUID only', () => {
  const [e] = normalizeWebhook(envelope({
    contacts: [{ profile: { name: 'Kofi' }, user_id: 'GH.13491208655302741918', username: 'kofi.drinks' }],
    messages: [{ from_user_id: 'GH.13491208655302741918', id: 'wamid.2', timestamp: '1790000000', type: 'text', text: { body: 'hi' } }],
  }));
  assert.equal(e.from.phone, null);
  assert.equal(e.from.bsuid, 'GH.13491208655302741918');
  assert.equal(e.from.username, 'kofi.drinks');
});

test('BSUID delivered in the legacy from/wa_id fields is recognised', () => {
  const id = metaIdentity({ from: 'GH.1A2B3C' }, { wa_id: 'GH.1A2B3C' });
  assert.equal(id.phone, null);
  assert.equal(id.bsuid, 'GH.1A2B3C');
});

test('image with caption, location, button replies, reaction', () => {
  const events = normalizeWebhook(envelope({
    contacts: [{ profile: { name: 'A' }, wa_id: '233200000001' }],
    messages: [
      { from: '233200000001', id: 'w1', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'paid' } },
      { from: '233200000001', id: 'w2', type: 'location', location: { latitude: 5.6, longitude: -0.18, name: 'Osu', address: 'Oxford St' } },
      { from: '233200000001', id: 'w3', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'pay:approve:7', title: '✅ Approve' } } },
      { from: '233200000001', id: 'w4', type: 'button', button: { payload: 'esc:take:3', text: 'Take over chat' } },
      { from: '233200000001', id: 'w5', type: 'reaction', reaction: { message_id: 'w0', emoji: '👍' } },
      { from: '233200000001', id: 'w6', type: 'audio', audio: { id: 'MEDIA2', mime_type: 'audio/ogg', voice: true } },
    ],
  }));
  assert.equal(events.length, 6);
  assert.deepEqual(events[0].media, { mediaId: 'MEDIA1', mimeType: 'image/jpeg', sha256: 'abc', caption: 'paid', filename: null, voice: false });
  assert.equal(events[0].text, 'paid');
  assert.equal(events[0].body, '[image] paid');
  assert.equal(events[1].location.latitude, 5.6);
  assert.match(events[1].body, /Osu, Oxford St/);
  assert.deepEqual(events[2].reply, { id: 'pay:approve:7', title: '✅ Approve', description: null });
  assert.equal(events[3].reply.id, 'esc:take:3');
  assert.equal(events[4].reaction.emoji, '👍');
  assert.equal(events[5].body, '[voice note]');
});

test('statuses carry recipient phone and BSUID', () => {
  const [s] = normalizeWebhook(envelope({
    statuses: [{ id: 'wamid.out', status: 'failed', timestamp: '1790000001', recipient_id: '233241234567', recipient_user_id: 'GH.1', errors: [{ code: 131047 }] }],
  }));
  assert.equal(s.kind, 'status');
  assert.equal(s.status, 'failed');
  assert.equal(s.recipientBsuid, 'GH.1');
  assert.deepEqual(s.errors, [{ code: 131047 }]);
});

test('ignores other objects and fields', () => {
  assert.deepEqual(normalizeWebhook({ object: 'page', entry: [] }), []);
  assert.deepEqual(normalizeWebhook(null), []);
  const body = envelope({});
  body.entry[0].changes[0].field = 'message_template_status_update';
  assert.deepEqual(normalizeWebhook(body), []);
});
