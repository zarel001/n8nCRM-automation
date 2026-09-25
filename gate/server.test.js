const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let gateMod;
let upstream;
let upstreamHits = [];
let upstreamStatus = 200;
let gate;
let base;

const cfg = {
  port: 0,
  appSecret: 'app-secret',
  verifyToken: 'verify-me',
  upstreamToken: 'gate-token',
  forwardStatuses: 'failed',
  maxBodyBytes: 2048,
  upstreamTimeoutMs: 2000,
  path: '/webhook/whatsapp',
};

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function signed(obj, secret = cfg.appSecret) {
  const raw = Buffer.from(JSON.stringify(obj));
  return { body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': gateMod.signatureFor(secret, raw) } };
}

const messagePayload = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.1', type: 'text', text: { body: 'Akwaaba' } }] } }] }],
};
const statusPayload = (status) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.o', status }] } }] }],
});

test.before(async () => {
  gateMod = await import('./server.mjs');
  upstream = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      upstreamHits.push({ headers: req.headers, body: data, url: req.url });
      res.writeHead(upstreamStatus);
      res.end('{}');
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  gate = gateMod.createGate({ ...cfg, upstreamUrl: `${up}/webhook/wa-inbound`, healthUrl: `${up}/healthz` });
  await new Promise((r) => gate.listen(0, r));
  base = `http://127.0.0.1:${gate.address().port}`;
});

test.after(() => {
  gate.close();
  upstream.close();
});

test.beforeEach(() => {
  upstreamHits = [];
  upstreamStatus = 200;
});

test('config validation', () => {
  assert.throws(() => gateMod.loadConfig({}), /missing config/);
  assert.throws(() => gateMod.loadConfig({ META_APP_SECRET: 'a', META_VERIFY_TOKEN: 'b', N8N_GATE_TOKEN: 'c', FORWARD_STATUSES: 'x' }), /FORWARD_STATUSES/);
});

test('subscription handshake', async () => {
  const ok = await request('GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444');
  assert.deepEqual(ok, { status: 200, body: '1158201444' });
  assert.equal((await request('GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  assert.equal((await request('GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=<script>')).status, 403);
});

test('forwards a correctly signed message, byte for byte, with the gate token', async () => {
  const req = signed(messagePayload);
  const res = await request('POST', '/webhook/whatsapp', req);
  assert.equal(res.status, 200);
  assert.equal(upstreamHits.length, 1);
  assert.equal(upstreamHits[0].url, '/webhook/wa-inbound');
  assert.equal(upstreamHits[0].headers['x-gate-token'], 'gate-token');
  assert.equal(upstreamHits[0].body, req.body.toString());
});

test('rejects forged, unsigned, wrong-type and oversized requests without calling n8n', async () => {
  assert.equal((await request('POST', '/webhook/whatsapp', signed(messagePayload, 'wrong-secret'))).status, 401);
  const unsigned = signed(messagePayload);
  delete unsigned.headers['x-hub-signature-256'];
  assert.equal((await request('POST', '/webhook/whatsapp', unsigned)).status, 401);
  const wrongType = signed(messagePayload);
  wrongType.headers['content-type'] = 'multipart/form-data; boundary=x';
  assert.equal((await request('POST', '/webhook/whatsapp', wrongType)).status, 415);
  const big = signed({ ...messagePayload, pad: 'x'.repeat(5000) });
  assert.equal((await request('POST', '/webhook/whatsapp', big)).status, 413);
  assert.equal((await request('POST', '/other', signed(messagePayload))).status, 404);
  assert.equal((await request('PUT', '/webhook/whatsapp', signed(messagePayload))).status, 405);
  assert.equal(upstreamHits.length, 0);
});

test('routine delivery receipts are dropped, failures forwarded', async () => {
  assert.equal((await request('POST', '/webhook/whatsapp', signed(statusPayload('delivered')))).status, 200);
  assert.equal((await request('POST', '/webhook/whatsapp', signed(statusPayload('read')))).status, 200);
  assert.equal(upstreamHits.length, 0);
  assert.equal((await request('POST', '/webhook/whatsapp', signed(statusPayload('failed')))).status, 200);
  assert.equal(upstreamHits.length, 1);
});

test('asks Meta to retry when n8n is failing', async () => {
  upstreamStatus = 500;
  assert.equal((await request('POST', '/webhook/whatsapp', signed(messagePayload))).status, 503);
});

test('health check reflects n8n', async () => {
  assert.equal((await request('GET', '/healthz')).status, 200);
  upstreamStatus = 503;
  assert.equal((await request('GET', '/healthz')).status, 503);
});
