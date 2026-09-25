// WhatsApp Cloud API outbound message payloads (POST /{phone-number-id}/messages).
// Limits enforced here so a long customer name or AI reply can't make Meta reject the message.
//
// Inlined into n8n Code nodes; keep dependency-free.

const WA_LIMITS = { text: 4096, interactiveBody: 1024, buttonTitle: 20, buttonId: 256, footer: 60, header: 60, caption: 1024 };

function clip(value, max) {
  const s = String(value == null ? '' : value);
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// `to` (phone) wins when both are present; `recipient` carries a business-scoped user ID for
// customers who hide their number behind a WhatsApp username.
function waRecipient(r) {
  if (r && r.wa_id) return { to: String(r.wa_id) };
  if (r && r.bsuid) return { recipient: String(r.bsuid) };
  throw new Error('Recipient has neither wa_id nor bsuid');
}

function waBase(r) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', ...waRecipient(r) };
}

function waText(r, body, options) {
  return { ...waBase(r), type: 'text', text: { body: clip(body, WA_LIMITS.text), preview_url: Boolean(options && options.previewUrl) } };
}

// buttons: [{id, title}] (max 3). header: {text} or {imageId}.
function waButtons(r, body, buttons, options) {
  const opts = options || {};
  const interactive = {
    type: 'button',
    body: { text: clip(body, WA_LIMITS.interactiveBody) },
    action: {
      buttons: (buttons || []).slice(0, 3).map((b) => ({
        type: 'reply',
        reply: { id: clip(b.id, WA_LIMITS.buttonId), title: clip(b.title, WA_LIMITS.buttonTitle) },
      })),
    },
  };
  if (opts.header && opts.header.imageId) interactive.header = { type: 'image', image: { id: opts.header.imageId } };
  else if (opts.header && opts.header.text) interactive.header = { type: 'text', text: clip(opts.header.text, WA_LIMITS.header) };
  if (opts.footer) interactive.footer = { text: clip(opts.footer, WA_LIMITS.footer) };
  return { ...waBase(r), type: 'interactive', interactive };
}

function waLocationRequest(r, body) {
  return {
    ...waBase(r),
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: clip(body, WA_LIMITS.interactiveBody) },
      action: { name: 'send_location' },
    },
  };
}

function waImage(r, mediaId, caption) {
  const image = { id: mediaId };
  if (caption) image.caption = clip(caption, WA_LIMITS.caption);
  return { ...waBase(r), type: 'image', image };
}

// components: raw Cloud API template components (header/body/button parameters).
function waTemplate(r, name, language, components) {
  return { ...waBase(r), type: 'template', template: { name, language: { code: language || 'en' }, components: components || [] } };
}

function waTemplateText(value) {
  // Template parameters can't contain newlines, tabs or more than four consecutive spaces.
  return { type: 'text', text: clip(String(value == null ? '' : value).replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   '), 1024) };
}

// Marks the customer's message as read and shows "typing…" until the reply is sent (max ~25 s).
function waTyping(messageId) {
  return { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } };
}

function waRecipientOf(customer) {
  return { wa_id: (customer && customer.wa_id) || null, bsuid: (customer && customer.bsuid) || null };
}

// Input for the "WA · Send" sub-workflow: free-form payloads when the recipient's 24-hour window
// is open, otherwise the template (or nothing, if there is none).
function waSendRequest(customer, payloads, template, settings, ref) {
  return {
    customer_id: customer.id,
    window_open: customer.window_open !== false,
    payloads: payloads || [],
    template: template || null,
    whatsapp: (settings && settings.whatsapp) || {},
    // a failed send (expired token, blocked number…) alerts the developer straight away
    alert_url: (settings && settings.alerts && settings.alerts.webhook_url) || null,
    ref: ref === undefined ? null : ref,
  };
}

// Short human-readable version of an outbound payload for the conversation log.
function waLogBody(payload) {
  if (!payload) return '';
  switch (payload.type) {
    case 'text':
      return payload.text.body;
    case 'interactive':
      return (payload.interactive.body && payload.interactive.body.text) || `[${payload.interactive.type}]`;
    case 'image':
      return `[image] ${(payload.image && payload.image.caption) || ''}`.trim();
    case 'template':
      return `[template ${payload.template.name}]`;
    default:
      return `[${payload.type}]`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WA_LIMITS,
    clip,
    waRecipient,
    waText,
    waButtons,
    waLocationRequest,
    waImage,
    waTemplate,
    waTemplateText,
    waTyping,
    waLogBody,
    waRecipientOf,
    waSendRequest,
  };
}
