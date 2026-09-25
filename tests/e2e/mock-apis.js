// In-process stand-ins for the WhatsApp Cloud API (Graph), the Anthropic Messages API, the
// storefront catalog and the alert webhook, so the real n8n workflows can run end to end.
const http = require('node:http');

// 1×1 white JPEG
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

function createMockApis() {
  const log = [];
  let outId = 0;
  let uploadId = 0;
  const anthropic = { extraction: null, chat: [], chatFallback: null, failNext: 0 };
  const catalog = {
    brand: { name: 'Mash & Sip Co.', currency: 'GHS' },
    variants: [
      { id: 'original', name: 'Original', ingredients: 'Kenkey (fermented maize), milk, sugar' },
      { id: 'vanilla', name: 'Vanilla', ingredients: 'Kenkey, milk, vanilla, sugar' },
      { id: 'cinnamon', name: 'Cinnamon', ingredients: 'Kenkey, milk, cinnamon, sugar' },
      { id: 'peanut-butter', name: 'Peanut Butter', ingredients: 'Kenkey, milk, groundnut paste, sugar' },
    ],
    sizes: [{ label: '150ml', price: 25 }, { label: '250ml', price: 40 }, { label: '500ml', price: 70 }],
    maxQty: 24,
  };

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function anthropicMessage(content, stopReason = 'end_turn') {
    return {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content,
      stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
    };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://mock');
      let body = null;
      if ((req.headers['content-type'] || '').includes('application/json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = raw.toString('utf8');
        }
      }
      const entry = { method: req.method, path: url.pathname, headers: req.headers, body, size: raw.length, at: Date.now() };
      log.push(entry);

      // ── WhatsApp Cloud API ──
      let m = url.pathname.match(/^\/v\d+\.\d+\/(\d+)\/messages$/);
      if (m && req.method === 'POST') {
        if (body && body.status === 'read') return json(res, 200, { success: true });
        if (body && body.to === '233000000404') {
          return json(res, 400, { error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030 } });
        }
        outId += 1;
        return json(res, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: body.to || body.recipient, wa_id: body.to || null }],
          messages: [{ id: `wamid.out.${outId}` }],
        });
      }
      m = url.pathname.match(/^\/v\d+\.\d+\/(\d+)\/media$/);
      if (m && req.method === 'POST') {
        uploadId += 1;
        entry.multipart = raw.toString('latin1').includes('name="file"');
        return json(res, 200, { id: `uploaded-${uploadId}` });
      }
      m = url.pathname.match(/^\/v\d+\.\d+\/(MEDIA-[\w-]+)$/);
      if (m && req.method === 'GET') {
        const host = req.headers.host;
        return json(res, 200, { url: `http://${host}/media-bytes/${m[1]}`, mime_type: 'image/jpeg', sha256: `sha-${m[1]}`, file_size: TINY_JPEG.length, id: m[1], messaging_product: 'whatsapp' });
      }
      if (url.pathname.startsWith('/media-bytes/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': TINY_JPEG.length });
        return res.end(TINY_JPEG);
      }

      // ── Anthropic Messages API ──
      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        if (anthropic.failNext > 0) {
          anthropic.failNext -= 1;
          return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'mock failure' } });
        }
        if (body.output_config && body.output_config.format) {
          entry.kind = 'extraction';
          return json(res, 200, anthropicMessage([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(anthropic.extraction) }]));
        }
        entry.kind = 'chat';
        const step = anthropic.chat.length ? anthropic.chat.shift() : anthropic.chatFallback;
        const content = typeof step === 'function' ? step(body) : step;
        if (!content) return json(res, 200, anthropicMessage([{ type: 'text', text: 'NO_REPLY' }]));
        const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
        return json(res, 200, anthropicMessage(content, stop));
      }
      if (url.pathname === '/v1/models') return json(res, 200, { data: [{ id: 'claude-opus-5' }] });

      // ── storefront + alerts ──
      if (url.pathname === '/api/catalog') return json(res, 200, catalog);
      if (url.pathname === '/alert') return json(res, 200, { ok: true });

      json(res, 404, { error: 'mock: no route' });
    });
  });

  return {
    server,
    log,
    anthropic,
    catalog,
    listen: (port) => new Promise((r) => server.listen(port, '0.0.0.0', r)),
    close: () => new Promise((r) => server.close(r)),
    reset() {
      log.length = 0;
      anthropic.extraction = null;
      anthropic.chat = [];
      anthropic.chatFallback = null;
      anthropic.failNext = 0;
    },
    sent: () => log.filter((e) => /\/messages$/.test(e.path) && e.method === 'POST' && e.body && e.body.messaging_product && !e.body.status).map((e) => e.body),
    typing: () => log.filter((e) => e.body && e.body.status === 'read'),
    chatRequests: () => log.filter((e) => e.kind === 'chat').map((e) => e.body),
    extractionRequests: () => log.filter((e) => e.kind === 'extraction').map((e) => e.body),
    uploads: () => log.filter((e) => /\/media$/.test(e.path) && e.method === 'POST'),
    alerts: () => log.filter((e) => e.path === '/alert').map((e) => e.body),
  };
}

module.exports = { createMockApis, TINY_JPEG };
