const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXTRACTION_SCHEMA, buildExtractionRequest, parseExtractionResponse, normalizeTxnId, ghanaLocalDigits, namesMatch,
  parseReceiptTime, precheckPayment,
} = require('../../src/lib/payments.js');

const merchant = { momo_number: '055 886 6617', momo_name: 'Mash & Sip Co.' };
const order = { code: 'MS-7K4Q', total: 80, currency: 'GHS', created_at: '2026-09-25T14:00:00Z' };
const good = {
  is_payment_receipt: true,
  provider: 'MTN MoMo',
  status: 'successful',
  amount: 80,
  currency: 'GHS',
  recipient_name: 'MASH AND SIP',
  recipient_number: '0558866617',
  sender_name: 'AKOSUA MENSAH',
  transaction_id: '48291034871',
  reference: 'MS-7K4Q',
  transaction_time: '25/09/2026 14:32',
  legibility: 'clear',
  tampering_signs: [],
  notes: '',
};
const now = '2026-09-25T14:40:00Z';

test('schema is valid for structured outputs (every object closed, every key required)', () => {
  assert.equal(EXTRACTION_SCHEMA.additionalProperties, false);
  assert.deepEqual([...EXTRACTION_SCHEMA.required].sort(), Object.keys(EXTRACTION_SCHEMA.properties).sort());
});

test('extraction request: image first, no expected values leaked to the model, fallbacks on', () => {
  const req = buildExtractionRequest({ model: 'claude-opus-5', imageBase64: 'AAAA', mediaType: 'image/jpeg' });
  assert.equal(req.model, 'claude-opus-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.messages[0].content[0].type, 'image');
  assert.equal(req.messages[0].content[0].source.media_type, 'image/jpeg');
  const serialized = JSON.stringify(req);
  assert.ok(!serialized.includes('80.00') && !serialized.includes('558866617'), 'expected amount/recipient must not be in the prompt');
});

test('response parsing: skips thinking blocks, handles refusal/truncation/errors', () => {
  const ok = parseExtractionResponse({
    model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(good) }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.amount, 80);
  assert.deepEqual(parseExtractionResponse({ stop_reason: 'refusal', content: [] }), { ok: false, reason: 'refusal' });
  assert.deepEqual(parseExtractionResponse({ stop_reason: 'max_tokens', content: [] }), { ok: false, reason: 'max_tokens' });
  assert.equal(parseExtractionResponse({ type: 'error', error: { message: 'overloaded' } }).reason, 'api_error');
  assert.equal(parseExtractionResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }).reason, 'bad_json');
});

test('helpers: txn ids, Ghana numbers, names, dates', () => {
  assert.equal(normalizeTxnId(' 4829-1034 871 '), '48291034871');
  assert.equal(normalizeTxnId('12'), null);
  assert.equal(ghanaLocalDigits('+233 55 886 6617'), '558866617');
  assert.equal(ghanaLocalDigits('055 886 6617'), '558866617');
  assert.equal(ghanaLocalDigits('233558866617'), '558866617');
  assert.equal(ghanaLocalDigits('123'), null);
  assert.ok(namesMatch('Mash & Sip Co.', 'MASH AND SIP'));
  assert.ok(namesMatch('MASH & SIP COMPANY LTD', 'Mash & Sip Co.'));
  assert.ok(!namesMatch('Mash & Sip Co.', 'KOFI MENSAH'));
  assert.equal(parseReceiptTime('25/09/2026 14:32').toISOString(), '2026-09-25T14:32:00.000Z');
  assert.equal(parseReceiptTime('2026-09-25 02:05:09').toISOString(), '2026-09-25T02:05:09.000Z');
  assert.equal(parseReceiptTime('25-Sep-2026 02:32 PM').toISOString(), '2026-09-25T14:32:00.000Z');
  assert.equal(parseReceiptTime('Sep 25, 2026 12:10 AM').toISOString(), '2026-09-25T00:10:00.000Z');
  assert.equal(parseReceiptTime('yesterday'), null);
});

test('clean receipt → looks_ok', () => {
  const r = precheckPayment({ extraction: good, order, merchant, duplicates: {}, now });
  assert.equal(r.verdict, 'looks_ok');
  assert.equal(r.checks.amount, 'match');
  assert.equal(r.checks.recipient, 'match');
  assert.equal(r.checks.reference, 'match');
  assert.equal(r.checks.timing, 'ok');
  assert.equal(r.txnId, '48291034871');
  assert.deepEqual(r.flags, []);
});

test('wrong amount, wrong recipient, reused transaction, editing signs → mismatch with reasons', () => {
  const cases = [
    [{ amount: 60 }, /Amount GHS 60.00 ≠ expected GHS 80.00/],
    [{ recipient_name: 'KOFI MENSAH', recipient_number: '0244000000' }, /not the shop's MoMo account/],
    [{ status: 'pending' }, /not successful/],
    [{ currency: 'USD' }, /Amount USD 80.00/],
    [{ transaction_id: null }, /No transaction ID/],
    [{ transaction_time: '24/09/2026 09:00' }, /before the order/],
    [{ transaction_time: '26/09/2026 09:00' }, /in the future/],
    [{ tampering_signs: ['digits in amount use a different font'] }, /Possible editing/],
  ];
  for (const [patch, pattern] of cases) {
    const r = precheckPayment({ extraction: { ...good, ...patch }, order, merchant, duplicates: {}, now });
    assert.equal(r.verdict, 'mismatch', JSON.stringify(patch));
    assert.ok(r.flags.some((f) => pattern.test(f)), `${JSON.stringify(patch)} → ${r.flags.join(' | ')}`);
  }
  const reused = precheckPayment({ extraction: good, order, merchant, duplicates: { txn_used_by: 'MS-AAAA', image_used_by: 'MS-BBBB' }, now });
  assert.equal(reused.verdict, 'mismatch');
  assert.ok(reused.flags.some((f) => f.includes('MS-AAAA')));
  assert.ok(reused.flags.some((f) => f.includes('MS-BBBB')));
});

test('recipient matches by name alone when the number is cut off', () => {
  const r = precheckPayment({ extraction: { ...good, recipient_number: null }, order, merchant, duplicates: {}, now });
  assert.equal(r.checks.recipient, 'match');
});

test('not a receipt / unreadable → unreadable', () => {
  assert.equal(precheckPayment({ extraction: { ...good, is_payment_receipt: false }, order, merchant, duplicates: {}, now }).verdict, 'unreadable');
  assert.equal(precheckPayment({ extraction: { ...good, legibility: 'unreadable' }, order, merchant, duplicates: {}, now }).verdict, 'unreadable');
  assert.equal(precheckPayment({ extraction: null, order, merchant, duplicates: {}, now }).verdict, 'unreadable');
});
