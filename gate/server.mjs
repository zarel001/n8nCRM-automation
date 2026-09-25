// Webhook gate: the only thing the internet can reach.
//
//   Meta ──HTTPS──▶ Caddy ──▶ gate ──(verified, shared token)──▶ n8n (private network)
//
// * Answers Meta's subscription handshake (GET hub.challenge).
// * Verifies X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the Meta app secret) before
//   anything reaches n8n, so forged or malformed requests never touch n8n's webhook parser.
// * Accepts JSON only, with a size cap.
// * Drops routine delivery receipts (sent/delivered/read) unless configured otherwise, so n8n
//   only runs for messages and failures.
// * Answers Meta with 503 when n8n is down: Meta keeps retrying for days, so nothing is lost.
// * Never logs message content (customer personal data).
//
// No dependencies; Node 22+.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function loadConfig(env = process.env) {
  const cfg = {
    port: Number(env.PORT || 8080),
    appSecret: env.META_APP_SECRET || '',
    verifyToken: env.META_VERIFY_TOKEN || '',
    upstreamUrl: env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/wa-inbound',
    upstreamToken: env.N8N_GATE_TOKEN || '',
    healthUrl: env.N8N_HEALTH_URL || 'http://n8n:5678/healthz',
    forwardStatuses: (env.FORWARD_STATUSES || 'failed').toLowerCase(),
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 1024 * 1024),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 10000),
    path: env.WEBHOOK_PATH || '/webhook/whatsapp',
  };
  const missing = ['appSecret', 'verifyToken', 'upstreamToken'].filter((k) => !cfg[k]);
  if (missing.length) throw new Error(`gate: missing config ${missing.join(', ')}`);
  if (!['all', 'failed', 'none'].includes(cfg.forwardStatuses)) throw new Error('gate: FORWARD_STATUSES must be all|failed|none');
  return cfg;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signatureFor(appSecret, rawBody) {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

// Should this payload reach n8n at all?
export function shouldForward(payload, forwardStatuses) {
  let hasMessages = false;
  let hasWantedStatus = false;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (Array.isArray(v.messages) && v.messages.length) hasMessages = true;
      for (const s of v.statuses || []) {
        if (forwardStatuses === 'all' || (forwardStatuses === 'failed' && s.status === 'failed')) hasWantedStatus = true;
      }
    }
  }
  return hasMessages || hasWantedStatus;
}

function log(level, msg, extra = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
}

function send(res, status, body = '', type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(Object.assign(new Error('too large'), { status: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit * 10) {
        req.destroy(); // abusive stream: stop reading
        return;
      }
      if (size <= limit) chunks.push(chunk); // past the limit: keep draining so we can answer 413
    });
    req.on('end', () => {
      if (size > limit) reject(Object.assign(new Error('too large'), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function createGate(cfg, { fetchImpl = fetch } = {}) {
  async function forward(rawBody) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
    try {
      const r = await fetchImpl(cfg.upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gate-token': cfg.upstreamToken },
        body: rawBody,
        signal: controller.signal,
      });
      await r.arrayBuffer().catch(() => null);
      return r.status;
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://gate');

    if (url.pathname === '/healthz' && req.method === 'GET') {
      try {
        const r = await fetchImpl(cfg.healthUrl, { signal: AbortSignal.timeout(3000) });
        return send(res, r.ok ? 200 : 503, r.ok ? 'ok' : 'n8n unhealthy');
      } catch {
        return send(res, 503, 'n8n unreachable');
      }
    }

    if (url.pathname !== cfg.path) return send(res, 404, 'not found');

    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token') || '';
      const challenge = url.searchParams.get('hub.challenge') || '';
      if (mode === 'subscribe' && safeEqual(token, cfg.verifyToken) && /^[\w-]{1,128}$/.test(challenge)) {
        log('info', 'subscription verified');
        return send(res, 200, challenge);
      }
      log('warn', 'bad verification request', { ip: req.socket.remoteAddress });
      return send(res, 403, 'forbidden');
    }

    if (req.method !== 'POST') return send(res, 405, 'method not allowed');

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return send(res, 415, 'unsupported media type');

    let raw;
    try {
      raw = await readBody(req, cfg.maxBodyBytes);
    } catch (e) {
      return send(res, e.status || 400, 'bad request');
    }

    const signature = String(req.headers['x-hub-signature-256'] || '');
    if (!signature || !safeEqual(signature, signatureFor(cfg.appSecret, raw))) {
      log('warn', 'invalid signature', { ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, bytes: raw.length });
      return send(res, 401, 'invalid signature');
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, 'invalid json');
    }
    if (payload.object !== 'whatsapp_business_account') return send(res, 200, 'ignored');
    if (!shouldForward(payload, cfg.forwardStatuses)) return send(res, 200, 'ok');

    try {
      const status = await forward(raw);
      if (status >= 200 && status < 300) return send(res, 200, 'ok');
      log('error', 'n8n rejected webhook', { status });
      return send(res, 503, 'retry later');
    } catch (e) {
      log('error', 'n8n unreachable', { error: e.name });
      return send(res, 503, 'retry later');
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', 'unhandled', { error: e.message });
      if (!res.headersSent) send(res, 500, 'error');
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cfg = loadConfig();
  const server = createGate(cfg);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(cfg.port, () => log('info', 'gate listening', { port: cfg.port, path: cfg.path, forwardStatuses: cfg.forwardStatuses }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
