// Owner messages: alert buttons (approve/reject payments, take over chats, delivery updates),
// slash commands, and free text relayed to the customer during a takeover.
//
// Inlined into n8n Code nodes; keep dependency-free.

const OWNER_BUTTON = /^(pay|esc|ord):([a-z]+):(\d{1,18})$/;

// msg: output of metaMessage(); session: state.owner_session (null when no chat is open).
function parseOwnerInput(msg, session) {
  const replyId = (msg.reply && msg.reply.id) || '';
  const m = replyId.match(OWNER_BUTTON);
  if (m) {
    const kind = m[1];
    const verb = m[2];
    const id = Number(m[3]);
    if (kind === 'pay' && (verb === 'approve' || verb === 'reject')) {
      return { action: 'payment_decision', paymentId: id, decision: verb };
    }
    if (kind === 'esc' && verb === 'take') return { action: 'takeover', escalationId: id };
    if (kind === 'esc' && verb === 'dismiss') return { action: 'dismiss', escalationId: id };
    if (kind === 'ord' && verb === 'out') return { action: 'advance', orderId: id, status: 'out_for_delivery' };
    if (kind === 'ord' && verb === 'done') return { action: 'advance', orderId: id, status: 'delivered' };
  }
  if (replyId) return { action: 'help' };

  if (msg.type === 'text') {
    const text = String(msg.text || '').trim();
    if (/^\/done\b/i.test(text)) return { action: 'end_takeover' };
    if (/^\/(help|start)\b/i.test(text)) return { action: 'help' };
    if (!text) return { action: 'ignore' };
    return session ? { action: 'relay', text } : { action: 'no_session' };
  }
  if (['reaction', 'sticker'].includes(msg.type)) return { action: 'ignore' };
  return session ? { action: 'relay_unsupported' } : { action: 'no_session' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseOwnerInput, OWNER_BUTTON };
}
