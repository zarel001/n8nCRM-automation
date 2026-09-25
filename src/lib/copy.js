// Every message the bot sends that isn't written by the AI agent. Brand voice lives here.
// WhatsApp formatting: *bold*, _italic_.
//
// Inlined into n8n Code nodes; keep dependency-free (money/lines are duplicated from orders.js on
// purpose so this file stands alone).

function copyMoney(amount, currency) {
  return `${currency || 'GHS'} ${Number(amount || 0).toFixed(2)}`;
}

function copyLines(order) {
  return ((order && order.items) || []).map(
    (i) => `${i.qty} × ${i.variant} ${i.size} — ${copyMoney(Number(i.unit_price) * Number(i.qty), order.currency)}`,
  );
}

function copyItems(order) {
  return ((order && order.items) || []).map((i) => `${i.qty} × ${i.variant} ${i.size}`).join(', ');
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function customerLabel(customer) {
  const c = customer || {};
  const name = c.display_name || c.name || c.profile_name || 'Customer';
  const contact = c.wa_id ? `+${c.wa_id}` : 'number hidden';
  return `${name} (${contact})`;
}

function mapsLink(location) {
  if (!location || !Number.isFinite(Number(location.latitude))) return null;
  return `https://maps.google.com/?q=${Number(location.latitude)},${Number(location.longitude)}`;
}

const copy = {
  aiDisclosure(brand) {
    return `_I'm the ${brand.shortName} assistant, an AI. Type *human* anytime to reach the team._`;
  },

  paymentInstructions(order, momo) {
    if (!momo || !momo.number) {
      return "We'll send you the Mobile Money details in a moment. 🙏";
    }
    return [
      'Pay with Mobile Money:',
      `• Number: *${momo.number}*`,
      `• Name: ${momo.name}`,
      `• Reference: *${order.code}*`,
      '',
      'Then send a screenshot of the payment confirmation here. 📸',
    ].join('\n');
  },

  orderReceived(order, momo, duplicate) {
    const opener = duplicate
      ? `You already have order *${order.code}* waiting for payment, so here it is again:`
      : order.customer_name
        ? `Thanks, ${firstName(order.customer_name)}! 🧡 Here's your order:`
        : "Thanks for your order! 🧡 Here's what you picked:";
    return [
      opener,
      '',
      `*Order ${order.code}*`,
      ...copyLines(order),
      `*Total: ${copyMoney(order.total, order.currency)}*`,
      '',
      copy.paymentInstructions(order, momo),
    ].join('\n');
  },

  orderButtons(order) {
    return [
      { id: `cust:cancel:${order.id}`, title: 'Cancel order' },
      { id: 'cust:human', title: 'Talk to a person' },
    ];
  },

  orderInvalid(result, siteUrl) {
    const options = (result && result.options) || [];
    switch (result && result.error) {
      case 'unknown_variant':
        return `I couldn't find that flavour. We have ${options.join(', ')}. Could you send the order again?`;
      case 'unknown_size':
        return `We have ${options.join(', ')} bottles. Could you send the order again with one of those sizes?`;
      case 'bad_qty':
        return `You can order 1 to ${result.max} bottles at a time. Planning something bigger? Tell me about your event and I'll pass it to the team. 🎉`;
      case 'catalog_unavailable':
        return 'Sorry, our menu is updating right now. Please try again in a few minutes. 🙏';
      default:
        return copy.orderHelp(siteUrl);
    }
  },

  orderHelp(siteUrl) {
    return [
      "I couldn't read that order. The easiest way is the *Order* button on our site:",
      `${siteUrl}/#order`,
      '',
      'Or send it like this:',
      'Order: Cinnamon 500ml x2',
      'Name: Your name',
    ].join('\n');
  },

  paymentReceived(order, verdict) {
    if (verdict === 'unreadable') {
      return `Thanks! I couldn't read that screenshot clearly, so I've passed it to the team to check for *${order.code}*. If you have a clearer one, send it here.`;
    }
    return `Thanks! 🙏 We're confirming your payment for *${order.code}* now. You'll get a message as soon as it's approved.`;
  },

  unsupportedReceipt() {
    return 'Thanks! Please send the payment confirmation as a *photo or screenshot* so I can read it. 📸';
  },

  paymentApproved(order) {
    const name = firstName(order.customer_name);
    return [
      `Payment confirmed ✅ Thank you${name ? `, ${name}` : ''}!`,
      '',
      `Please share your *delivery location* 📍 so we can bring order *${order.code}* to you. Add a landmark if it's hard to find.`,
    ].join('\n');
  },

  paymentRejected(order, momo) {
    return [
      `We couldn't confirm the payment for *${order.code}* yet.`,
      `Please check that you sent *${copyMoney(order.total, order.currency)}* to *${momo.number}* (${momo.name}), then send a new screenshot.`,
      '',
      'Reply *human* if you need help.',
    ].join('\n');
  },

  locationSaved(order) {
    return `Got it 📍 We'll deliver order *${order.code}* soon and message you when it's on the way.`;
  },

  outForDelivery(order) {
    return `Your order *${order.code}* is on the way 🛵`;
  },

  delivered(order) {
    return `Delivered ✅ Enjoy your mashkey! 🧡 We'd love to hear what you think of *${copyItems(order)}*.`;
  },

  cancelled(order, siteUrl) {
    return `Order *${order.code}* is cancelled. Whenever you're ready, you can order again: ${siteUrl}/#order`;
  },

  nothingToCancel() {
    return "You don't have an unpaid order to cancel. 🙂";
  },

  reminder(order, momo) {
    const name = firstName(order.customer_name);
    return [
      `Hi${name ? ` ${name}` : ''}! Your order *${order.code}* (${copyMoney(order.total, order.currency)}) is still waiting for payment.`,
      '',
      copy.paymentInstructions(order, momo),
      '',
      'Changed your mind? Reply *cancel*.',
    ].join('\n');
  },

  voiceNote() {
    return "Sorry, I can't listen to voice notes yet 🙏 Please type your message, or type *human* to reach the team.";
  },

  unsupportedMedia() {
    return 'Thanks! I can read text, payment screenshots and locations for now. Please type your message. 🙂';
  },

  optedOut() {
    return "Done. We won't send you reminders or updates you didn't ask for. You can still message us anytime; reply *START* to turn updates back on.";
  },

  optedIn() {
    return 'Welcome back! 🧡 Updates are on again.';
  },

  humanRequested(existing) {
    return existing
      ? "The team already knows you'd like to talk. Someone will reply here soon. 🙏"
      : "I've let the team know. Someone will reply here shortly. 🙏";
  },

  takeoverStarted(brand) {
    return `You're now chatting with the ${brand.shortName} team 👋`;
  },

  takeoverEnded(brand) {
    return `Thanks for chatting with us! 🧡 The ${brand.shortName} assistant is back. Message anytime.`;
  },

  agentFallback() {
    return "Sorry, I'm having a little trouble right now. I've told the team and someone will reply soon. 🙏";
  },

  // ─── owner-facing ───────────────────────────────────────────────────────────────────────

  ownerPaymentReview({ order, customer, extraction, precheck }) {
    const e = extraction || {};
    const c = precheck.checks;
    const seen = [
      typeof e.amount === 'number' ? copyMoney(e.amount, 'GHS') : 'no amount',
      e.recipient_name || e.recipient_number ? `to ${[e.recipient_name, e.recipient_number].filter(Boolean).join(' ')}` : null,
      e.transaction_id ? `Txn ${e.transaction_id}` : null,
      e.transaction_time || null,
    ].filter(Boolean).join(' · ');
    const marks =
      precheck.verdict === 'unreadable'
        ? '⚠️ AI could not read this screenshot'
        : [
            `${c.amount === 'match' ? '✅' : '⚠️'} amount`,
            `${c.recipient === 'match' ? '✅' : '⚠️'} recipient`,
            `${c.txn === 'present' && !c.txn_reused_by ? '✅' : '⚠️'} transaction ID`,
            `${c.image_reused_by || c.tampering.length ? '⚠️' : '✅'} image`,
          ].join('  ');
    return [
      `💰 *Payment check: ${order.code}*`,
      customerLabel(customer),
      copyItems(order),
      `Expected: *${copyMoney(order.total, order.currency)}*`,
      precheck.verdict === 'unreadable' ? null : `Screenshot: ${seen}`,
      '',
      marks,
      ...precheck.flags.slice(0, 4).map((f) => `• ${f}`),
      '',
      '_Check your MoMo balance before approving._',
    ].filter((line) => line !== null).join('\n');
  },

  ownerPaymentButtons(paymentId) {
    return [
      { id: `pay:approve:${paymentId}`, title: '✅ Approve' },
      { id: `pay:reject:${paymentId}`, title: '❌ Reject' },
    ];
  },

  ownerDecision(result) {
    const order = result.order || {};
    const name = firstName(order.customer_name) || 'the customer';
    if (!result.ok) {
      switch (result.error) {
        case 'already_decided':
          return `${order.code || 'That payment'} was already handled (${result.status}).`;
        case 'txn_already_used':
          return `⚠️ Not approved: that transaction ID was already used for order ${result.other_order}. Check your MoMo statement.`;
        case 'order_not_in_review':
          return `${order.code} is no longer waiting for a payment check (status: ${order.status}).`;
        default:
          return "⚠️ I couldn't update that payment. Please try again.";
      }
    }
    return result.decision === 'approve'
      ? `✅ ${order.code} marked paid. I've asked ${name} for the delivery location.`
      : `❌ ${order.code}: payment rejected. I've asked ${name} to check and resend.`;
  },

  ownerHumanAlert({ customer, reason, lastMessage }) {
    return [
      `🙋 *${customerLabel(customer)}* would like to talk to someone.`,
      reason ? `Why: ${reason}` : null,
      lastMessage ? `Last message: “${String(lastMessage).slice(0, 300)}”` : null,
    ].filter(Boolean).join('\n');
  },

  ownerLeadAlert({ customer, lead }) {
    return [
      '🎉 *Bulk / event order lead*',
      customerLabel(customer),
      [lead.event_type, lead.event_date].filter(Boolean).join(' · ') || null,
      lead.quantity_estimate ? `About ${lead.quantity_estimate} bottles` : null,
      lead.area ? `Area: ${lead.area}` : null,
      lead.flavours ? `Flavours: ${lead.flavours}` : null,
      lead.notes ? `Notes: ${lead.notes}` : null,
    ].filter(Boolean).join('\n');
  },

  ownerEscalationButtons(escalationId) {
    return [
      { id: `esc:take:${escalationId}`, title: 'Take over chat' },
      { id: `esc:dismiss:${escalationId}`, title: 'Dismiss' },
    ];
  },

  ownerOrderReady({ order, customer }) {
    const link = mapsLink(order.delivery_location);
    return [
      `📦 *${order.code} ready for delivery*`,
      `${copyItems(order)} · ${copyMoney(order.total, order.currency)} (paid)`,
      customerLabel(customer),
      link ? `📍 ${link}` : null,
      order.delivery_location && order.delivery_location.address ? order.delivery_location.address : null,
      order.delivery_note ? `Note: ${order.delivery_note}` : null,
    ].filter(Boolean).join('\n');
  },

  ownerOrderButtons(orderId) {
    return [
      { id: `ord:out:${orderId}`, title: '🛵 On the way' },
      { id: `ord:done:${orderId}`, title: '✅ Delivered' },
    ];
  },

  ownerAdvanced(result) {
    const order = result.order || {};
    if (!result.ok) return `${order.code || 'That order'} can't move to that step (status: ${order.status || 'unknown'}).`;
    return order.status === 'delivered'
      ? `✅ ${order.code} delivered. The customer has been told.`
      : `🛵 ${order.code} is on the way. The customer has been told.`;
  },

  ownerTakeoverStarted(customer) {
    return `You're now chatting with *${customerLabel(customer)}* through the business number. Type here and I'll forward it. Send */done* when you're finished (it ends by itself after 30 quiet minutes).`;
  },

  ownerTakeoverEnded(customer) {
    return `Chat with ${customerLabel(customer)} closed. The assistant is back on.`;
  },

  ownerRelay(customer, text) {
    return `💬 *${(customer && (customer.display_name || customer.name)) || 'Customer'}:* ${text}`;
  },

  ownerRelayFailed(customer) {
    return `⚠️ Couldn't deliver that. ${customerLabel(customer)} hasn't messaged in 24 hours, so WhatsApp blocks free-form replies. Please call them instead.`;
  },

  ownerNoSession() {
    return 'No chat is open. Tap *Take over chat* on an alert to talk to a customer. Send */help* for commands.';
  },

  ownerHelp() {
    return [
      '*Mash & Sip assistant: owner help*',
      '• Tap the buttons on alerts to approve payments, take over chats or update deliveries.',
      '• */done*: end the current chat takeover.',
      '• */help*: show this message.',
    ].join('\n');
  },

  ownerMediaNotRelayed() {
    return 'Only text can be forwarded for now. Please type your message.';
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { copy, copyMoney, copyLines, copyItems, customerLabel, mapsLink, firstName };
}
