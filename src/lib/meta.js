// WhatsApp Cloud API webhook parsing.
//
// Inlined into n8n Code nodes by scripts/build-workflows.mjs, so this file must stay
// dependency-free and only declare functions/constants.

const PHONE_ID_PATTERN = /^\d{6,15}$/;
// Business-scoped user ID: ISO country code, a dot, then an opaque ID (e.g. "GH.13491208655302741918").
const BSUID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9._-]{1,160}$/;

function metaIdentity(message, contact) {
  const m = message || {};
  const c = contact || {};
  const idCandidates = [m.from, c.wa_id].filter(Boolean).map(String);
  const phone = idCandidates.find((v) => PHONE_ID_PATTERN.test(v)) || null;
  const explicitBsuid = [m.from_user_id, m.user_id, c.user_id].filter(Boolean).map(String)[0];
  const bsuid = explicitBsuid || idCandidates.find((v) => BSUID_PATTERN.test(v)) || null;
  return {
    phone,
    bsuid,
    profileName: (c.profile && c.profile.name) || null,
    username: c.username || (c.profile && c.profile.username) || null,
  };
}

function metaMedia(part) {
  if (!part) return null;
  return {
    mediaId: part.id || null,
    mimeType: part.mime_type || null,
    sha256: part.sha256 || null,
    caption: part.caption || null,
    filename: part.filename || null,
    voice: part.voice === true,
  };
}

// Reduces one inbound message to the fields the workflows use, plus a one-line `body` for the log.
function metaMessage(m, contact, metadata) {
  const type = m.type || 'unknown';
  const out = {
    kind: 'message',
    waMessageId: m.id,
    timestamp: m.timestamp ? Number(m.timestamp) : null,
    phoneNumberId: (metadata && metadata.phone_number_id) || null,
    from: metaIdentity(m, contact),
    type,
    text: null,
    media: null,
    location: null,
    reply: null,
    reaction: null,
    contextId: (m.context && m.context.id) || null,
    referral: m.referral || null,
    errors: m.errors || null,
    body: null,
  };

  switch (type) {
    case 'text':
      out.text = (m.text && m.text.body) || '';
      out.body = out.text;
      break;
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      out.media = metaMedia(m[type]);
      out.text = (out.media && out.media.caption) || null;
      out.body = `[${type === 'audio' && out.media && out.media.voice ? 'voice note' : type}]` +
        (out.text ? ` ${out.text}` : '');
      break;
    case 'location': {
      const l = m.location || {};
      out.location = {
        latitude: Number(l.latitude),
        longitude: Number(l.longitude),
        name: l.name || null,
        address: l.address || null,
        url: l.url || null,
      };
      out.body = `[location] ${[l.name, l.address].filter(Boolean).join(', ') || `${l.latitude},${l.longitude}`}`;
      break;
    }
    case 'interactive': {
      const i = m.interactive || {};
      const r = i.button_reply || i.list_reply || null;
      if (r) {
        out.reply = { id: r.id || '', title: r.title || '', description: r.description || null };
        out.body = `[reply] ${out.reply.title}`;
      } else if (i.nfm_reply) {
        out.reply = { id: 'flow', title: i.nfm_reply.name || 'flow', responseJson: i.nfm_reply.response_json || null };
        out.body = '[flow reply]';
      }
      break;
    }
    case 'button':
      // quick-reply button on a template message
      out.reply = { id: (m.button && m.button.payload) || '', title: (m.button && m.button.text) || '' };
      out.body = `[reply] ${out.reply.title}`;
      break;
    case 'reaction':
      out.reaction = { messageId: (m.reaction && m.reaction.message_id) || null, emoji: (m.reaction && m.reaction.emoji) || '' };
      out.body = `[reaction] ${out.reaction.emoji}`;
      break;
    default:
      out.body = `[${type}]`;
  }
  return out;
}

function metaStatus(s, metadata) {
  return {
    kind: 'status',
    waMessageId: s.id,
    status: s.status,
    timestamp: s.timestamp ? Number(s.timestamp) : null,
    phoneNumberId: (metadata && metadata.phone_number_id) || null,
    recipientPhone: s.recipient_id || null,
    recipientBsuid: s.recipient_user_id || null,
    errors: s.errors || null,
  };
}

// One webhook POST can batch several messages and statuses; returns them as a flat list.
function normalizeWebhook(body) {
  const events = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return events;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages' || !change.value) continue;
      const v = change.value;
      const contacts = Array.isArray(v.contacts) ? v.contacts : [];
      for (const m of v.messages || []) {
        const contact =
          contacts.find((c) => (m.from && c.wa_id === m.from) || (m.from_user_id && c.user_id === m.from_user_id)) ||
          contacts[0] ||
          {};
        events.push(metaMessage(m, contact, v.metadata));
      }
      for (const s of v.statuses || []) events.push(metaStatus(s, v.metadata));
    }
  }
  return events;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeWebhook, metaIdentity, metaMessage, metaStatus, PHONE_ID_PATTERN, BSUID_PATTERN };
}
