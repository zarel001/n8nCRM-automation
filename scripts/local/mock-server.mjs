// Runs the mock WhatsApp/Claude/storefront APIs as a container for `npm run demo`.
// Claude is replaced by a few keyword rules, just enough to walk through every tool. The real
// assistant runs when you use `npm run local:whatsapp` with an Anthropic key.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMockApis } = require('../../tests/e2e/mock-apis.js');

let toolSeq = 0;
const toolUse = (name, input) => [{ type: 'tool_use', id: `toolu_demo_${++toolSeq}`, name, input }];
const text = (t) => [{ type: 'text', text: t }];

function lastBlocks(body) {
  const last = (body.messages || []).at(-1) || {};
  return Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content ?? '') }];
}

function systemText(body) {
  return typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
}

// Stand-in for Claude behind n8n's AI Agent node.
export function demoBrain(body) {
  const blocks = lastBlocks(body);
  const result = blocks.find((b) => b.type === 'tool_result');
  if (result) {
    const out = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const order = out.match(/"code":"(MS-[A-Z0-9]{4})","status":"([a-z_]+)"/);
    if (order) return text(`Your order *${order[1]}* is ${order[2].replace(/_/g, ' ')}. 🧡`);
    if (/lead was saved/.test(out)) return text("Lovely! 🎉 I've passed your event details to the team; they'll get back to you with a quote.");
    return text('Done! Anything else I can help with?');
  }

  const prompt = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const incoming = ((prompt.match(/<customer_message>\n([\s\S]*?)\n<\/customer_message>/) || [])[1] || prompt).toLowerCase();
  const system = systemText(body);

  if (/where.*order|my order|order status/.test(incoming)) return toolUse('get_my_orders', { input: 'orders' });
  if (/wedding|party|event|funeral|office|bottles for/.test(incoming)) {
    return toolUse('save_bulk_lead', {
      summary: 'Wedding next Saturday, about 60 bottles', event_type: 'wedding', event_date: 'next Saturday',
      quantity_estimate: 60, area: 'East Legon', flavours: 'Original and Cinnamon', notes: '', contact_name: '',
    });
  }
  if (/deliver/.test(incoming)) {
    const areas = (system.match(/- Delivery areas: (.+)/) || [])[1];
    return text(areas ? `Yes! We deliver to ${areas.trim()} 🛵` : "Good question. Let me check with the team and get back to you.");
  }
  if (/flavou?r|menu|price|how much/.test(incoming)) {
    const sizes = (system.match(/Sizes and prices \(same for every flavour\): (.+?)\. Up to/) || [])[1];
    return text(`We have Original, Vanilla, Cinnamon and Peanut Butter${sizes ? `: ${sizes}` : ''}. Which one would you like? 😋`);
  }
  return text("I'm the Mash & Sip assistant (simulated in this demo). I can help with orders, payments and delivery!");
}

const mock = createMockApis({ control: true, brain: demoBrain });
await mock.listen(Number(process.env.PORT || 55999));
console.log(`mock APIs listening on :${process.env.PORT || 55999}`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => mock.close().then(() => process.exit(0)));
