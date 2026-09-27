const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(__dirname, '..', '..', 'workflows');

// Node sizes on n8n's canvas: regular nodes are 100×100, the AI Agent is wider, and its model and
// tools are 80×80 circles. Names are drawn under each node, so reserve room for them too.
const LABEL = 40;
function box(node) {
  const [x, y] = node.position;
  if (node.type === '@n8n/n8n-nodes-langchain.agent') return { name: node.name, x0: x, y0: y, x1: x + 240, y1: y + 100 + LABEL };
  if (node.type.startsWith('@n8n/n8n-nodes-langchain.')) return { name: node.name, x0: x, y0: y, x1: x + 80, y1: y + 80 + LABEL };
  return { name: node.name, x0: x, y0: y, x1: x + 100, y1: y + 100 + LABEL };
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  test(`${file}: no nodes drawn on top of each other`, () => {
    const { nodes } = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const boxes = nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').map(box);
    const clashes = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) clashes.push(`${boxes[i].name} ↔ ${boxes[j].name}`);
    }
    assert.deepEqual(clashes, []);
  });
}
