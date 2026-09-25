// Decides what happens to each inbound message. Deterministic paths (orders, payments, delivery
// pins, keywords, owner actions) never reach the AI agent: they're cheaper, faster and can't be
// talked into doing something else.
//
// Inlined into n8n Code nodes after orders.js (uses parseOrderMessage / looksLikeOrderAttempt).
/* global parseOrderMessage, looksLikeOrderAttempt */

const ROUTE_KEYWORDS = {
  optOut: /^\s*(stop|stop all|unsubscribe)\s*[.!]*\s*$/i,
  optIn: /^\s*(start|unstop|subscribe)\s*[.!]*\s*$/i,
  human: /^\s*(human|agent|person|real person|(talk|speak|chat) (to|with) (a |the )?(human|person|someone|agent|team|owner)|call me)\s*[.!?]*\s*$/i,
  cancel: /^\s*cancel( (my|the))?( order)?\s*[.!]*\s*$/i,
};

function describeLocation(location) {
  const l = location || {};
  return [l.name, l.address].filter(Boolean).join(', ') || `${l.latitude}, ${l.longitude}`;
}

// msg: output of metaMessage(); state: output of crm.ingest_inbound().
// Returns {route, ...details}.
function routeInbound(msg, state) {
  if (!state || state.duplicate) return { route: 'ignore', reason: 'duplicate' };
  const customer = state.customer || {};
  if (customer.is_owner) return { route: 'owner' };

  const text = String(msg.text || '').trim();
  const replyId = (msg.reply && msg.reply.id) || '';

  if (['reaction', 'sticker', 'system', 'request_welcome'].includes(msg.type)) {
    return { route: 'ignore', reason: msg.type };
  }

  // A checkout message or a payment screenshot still goes through the normal flow while the
  // owner is chatting with this customer; everything else is forwarded to the owner.
  const order = msg.type === 'text' ? parseOrderMessage(text) : null;
  if (customer.bot_paused) {
    if (order) return { route: 'order', order };
    if (msg.type === 'image' && state.open_order) return { route: 'payment' };
    return { route: 'takeover_forward' };
  }

  if (replyId.startsWith('cust:')) {
    const [, action, id] = replyId.split(':');
    if (action === 'cancel') return { route: 'cancel', orderId: Number(id) || null };
    if (action === 'human') return { route: 'human', reason: 'Tapped "Talk to a person"' };
  }

  switch (msg.type) {
    case 'text':
      if (ROUTE_KEYWORDS.optOut.test(text)) return { route: 'opt_out' };
      if (ROUTE_KEYWORDS.optIn.test(text)) return { route: 'opt_in' };
      if (ROUTE_KEYWORDS.human.test(text)) return { route: 'human', reason: 'Asked for a person' };
      if (ROUTE_KEYWORDS.cancel.test(text)) return { route: 'cancel', orderId: null };
      if (order) return { route: 'order', order };
      if (looksLikeOrderAttempt(text)) return { route: 'order_help' };
      return { route: 'agent' };
    case 'image':
      if (state.open_order) return { route: 'payment' };
      return { route: 'agent', note: `[The customer sent a photo${text ? ` with the caption "${text}"` : ''}]` };
    case 'document':
      return state.open_order ? { route: 'receipt_not_image' } : { route: 'unsupported' };
    case 'location':
      if (state.awaiting_location_order) return { route: 'location' };
      return { route: 'agent', note: `[The customer shared a location: ${describeLocation(msg.location)}]` };
    case 'audio':
      return { route: 'voice' };
    case 'interactive':
    case 'button':
      // an old button, or a button from a message the bot didn't send
      return { route: 'agent', note: `[The customer tapped "${(msg.reply && msg.reply.title) || 'a button'}"]` };
    case 'video':
    case 'contacts':
    case 'order':
    case 'unsupported':
      return { route: 'unsupported' };
    default:
      return { route: 'ignore', reason: msg.type };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { routeInbound, ROUTE_KEYWORDS };
}
