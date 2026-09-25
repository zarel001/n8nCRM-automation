// Builds the AI agent's system prompt (from prompts/agent-system.md + settings) and the per-turn
// prompt, and cleans the agent's reply for WhatsApp.
//
// The system prompt only changes when settings change, so it stays byte-identical between turns
// and can be served from the prompt cache. Anything that varies per turn (time, customer, orders,
// conversation) goes in the turn prompt.
//
// Inlined into n8n Code nodes; keep dependency-free.

const FACT_LABELS = {
  hours: 'Opening hours',
  delivery_areas: 'Delivery areas',
  delivery_fee: 'Delivery fee',
  delivery_time: 'Delivery time',
  storage: 'Storage',
  shelf_life: 'Shelf life',
  pickup: 'Pickup',
};

function agentMoney(amount, currency) {
  return `${currency || 'GHS'} ${Number(amount || 0).toFixed(2)}`;
}

function renderCatalog(catalog) {
  const c = catalog || {};
  const currency = (c.brand && c.brand.currency) || 'GHS';
  const lines = (c.variants || []).map((v) => {
    const parts = [v.ingredients ? `ingredients: ${v.ingredients}` : null, v.copy || null].filter(Boolean);
    return `- ${v.name}${parts.length ? `: ${parts.join('. ')}` : ''}`;
  });
  const sizes = (c.sizes || []).map((s) => `${s.label} ${agentMoney(s.price, currency)}`).join(' · ');
  lines.push(`Sizes and prices (same for every flavour): ${sizes}. Up to ${c.maxQty || 24} bottles per order.`);
  return lines.join('\n');
}

function renderFacts(business) {
  const b = business || {};
  const known = [];
  const unknown = [];
  for (const [key, label] of Object.entries(FACT_LABELS)) {
    if (b[key] === null || b[key] === undefined || b[key] === '') unknown.push(label.toLowerCase());
    else known.push(`- ${label}: ${b[key]}`);
  }
  for (const f of b.extra_faq || []) {
    if (f && f.q && f.a) known.push(`- ${f.q} ${f.a}`);
  }
  return {
    facts: known.length ? known.join('\n') : '- (none yet)',
    unknown: unknown.length ? unknown.join(', ') : 'nothing',
  };
}

function buildAgentSystem(template, settings) {
  const s = settings || {};
  const brand = s.brand || {};
  const momo = s.momo || {};
  const { facts, unknown } = renderFacts(s.business);
  const momoText = momo.number ? `${momo.number}, account name ${momo.name}` : 'details the team sends';
  const values = {
    BRAND_NAME: brand.name || 'the shop',
    BRAND_SHORT: brand.shortName || brand.name || 'the shop',
    CITY: brand.city || 'Accra',
    SITE_URL: brand.siteUrl || '',
    CATALOG: renderCatalog(s.catalog),
    BUSINESS_FACTS: facts,
    UNKNOWN_FACTS: unknown,
    MOMO: momoText,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

function describeOrder(o) {
  if (!o) return 'none';
  const items = (o.items || []).map((i) => `${i.qty} × ${i.variant} ${i.size}`).join(', ');
  return `${o.code}, ${items}, ${agentMoney(o.total, o.currency)}, status ${o.status}`;
}

function formatAccraTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

// state: crm.ingest_inbound output; pendingTexts: texts since the bot last replied; note: what a
// non-text message was (photo, location, button); transcript: crm.recent_transcript output.
function buildAgentPrompt({ state, pendingTexts, note, transcript, now }) {
  const c = (state && state.customer) || {};
  const name = c.display_name || c.name || c.profile_name || 'unknown';
  const history = (transcript || [])
    .map((m) => `${m.dir === 'in' ? 'customer' : 'you'}: ${String(m.body || '').replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n');
  const incoming = [...(pendingTexts || [])];
  if (note) incoming.push(note);
  return [
    `Now: ${formatAccraTime(now ? new Date(now) : new Date())} (Accra time)`,
    `Customer: ${name}${c.wa_id ? ` (+${c.wa_id})` : ''}${state && state.is_new ? ', first time messaging us' : ''}`,
    `Their open order: ${describeOrder(state && state.open_order)}`,
    `Paid order waiting for a delivery location: ${describeOrder(state && state.awaiting_location_order)}`,
    '',
    'Recent conversation (oldest first):',
    history || '(no earlier messages)',
    '',
    'New message(s) from the customer:',
    '<customer_message>',
    incoming.join('\n') || '(empty)',
    '</customer_message>',
  ].join('\n');
}

// Returns the text to send, or null when nothing should be sent.
function cleanAgentReply(output) {
  let text = String(output == null ? '' : output).trim();
  if (!text || /^NO_REPLY\b/.test(text)) return null;
  text = text
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // markdown bold → WhatsApp bold
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*NO_REPLY\s*$/, '')
    .trim();
  return text || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderCatalog, renderFacts, buildAgentSystem, buildAgentPrompt, cleanAgentReply, describeOrder };
}
