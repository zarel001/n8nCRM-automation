// Storefront order contract (see Whatsapp-storefront/docs/whatsapp-bot-contract.md):
//
//   Order: {Variant} {Size} x{Qty}
//   Name: {Customer name}
//
// Inlined into n8n Code nodes; keep dependency-free.

// Reference patterns exported by the storefront (lib/whatsapp.ts). The parser below accepts a
// superset (any case, "×" for x, stray spaces) because customers sometimes edit the text.
const ORDER_LINE_PATTERN = /^Order: (.+) (\d+)ml x(\d+)$/m;
const NAME_LINE_PATTERN = /^Name: ([\p{L}\p{M}' .-]{2,40})$/mu;

const LENIENT_ORDER_LINE = /^[ \t]*order[ \t]*:[ \t]*(.+?)[ \t]+(\d{2,4})[ \t]*ml[ \t]*[x×*][ \t]*(\d{1,3})[ \t]*$/im;
const LENIENT_NAME_LINE = /^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/im;
const ORDER_ATTEMPT = /^[ \t]*order[ \t]*:/im;

const NAME_MAX = 40;

// Same cleaning as the storefront's sanitizeName: letters, marks, spaces, apostrophes, dots and
// hyphens on one line, so a name can't smuggle in a second "Order:" line.
function sanitizeName(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}' .-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

// Returns {variant, size, qty, name} or null. Validation against the catalog happens in the
// database (crm.create_order), which is the single pricing authority.
function parseOrderMessage(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\r\n?/g, '\n');
  const m = t.match(LENIENT_ORDER_LINE);
  if (!m) return null;
  const n = t.match(LENIENT_NAME_LINE);
  const name = n ? sanitizeName(n[1]) : '';
  return {
    variant: m[1].replace(/\s+/g, ' ').trim(),
    size: `${Number(m[2])}ml`,
    qty: Number(m[3]),
    name: name.length >= 2 ? name : null,
  };
}

// "Order:" is there but the line doesn't parse: worth a format hint rather than the AI agent.
function looksLikeOrderAttempt(text) {
  return typeof text === 'string' && ORDER_ATTEMPT.test(text) && parseOrderMessage(text) === null;
}

function money(amount, currency) {
  return `${currency || 'GHS'} ${Number(amount || 0).toFixed(2)}`;
}

function orderLines(order) {
  const currency = (order && order.currency) || 'GHS';
  return ((order && order.items) || []).map(
    (i) => `${i.qty} × ${i.variant} ${i.size} — ${money(Number(i.unit_price) * Number(i.qty), currency)}`,
  );
}

function itemsSummary(order) {
  return ((order && order.items) || []).map((i) => `${i.qty} × ${i.variant} ${i.size}`).join(', ');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ORDER_LINE_PATTERN,
    NAME_LINE_PATTERN,
    sanitizeName,
    parseOrderMessage,
    looksLikeOrderAttempt,
    money,
    orderLines,
    itemsSummary,
  };
}
