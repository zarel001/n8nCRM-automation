#!/usr/bin/env node
// Generates workflows/*.json from src/workflows/*.mjs (+ the tested src/lib modules inlined into
// Code nodes). `--check` fails if the committed JSON is out of date.
//
//   npm run build     # regenerate
//   npm run check     # CI: verify committed JSON matches the source
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import send from '../src/workflows/send.mjs';
import inbound from '../src/workflows/inbound.mjs';
import order from '../src/workflows/order.mjs';
import payment from '../src/workflows/payment.mjs';
import owner from '../src/workflows/owner.mjs';
import customer from '../src/workflows/customer.mjs';
import escalate from '../src/workflows/escalate.mjs';
import agent from '../src/workflows/agent.mjs';
import { toolOrders, toolCancel, toolDelivery } from '../src/workflows/tools.mjs';
import { housekeeping, errors } from '../src/workflows/ops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'workflows');

const FILES = [
  ['01-wa-inbound.json', inbound],
  ['02-wa-send.json', send],
  ['03-flow-order.json', order],
  ['04-flow-payment.json', payment],
  ['05-flow-owner.json', owner],
  ['06-flow-customer.json', customer],
  ['07-flow-escalate.json', escalate],
  ['08-flow-agent.json', agent],
  ['09-tool-my-orders.json', toolOrders],
  ['10-tool-cancel-order.json', toolCancel],
  ['11-tool-delivery-details.json', toolDelivery],
  ['12-ops-housekeeping.json', housekeeping],
  ['13-ops-errors.json', errors],
];

function validate(workflows) {
  const ids = new Set(workflows.map((w) => w.id));
  for (const w of workflows) {
    for (const n of w.nodes) {
      const ref = n.parameters && n.parameters.workflowId && n.parameters.workflowId.value;
      if (ref && !ids.has(ref)) throw new Error(`${w.name} › ${n.name}: unknown workflow id ${ref}`);
      if (n.type.endsWith('.toolWorkflow') && !/^[a-z][a-z0-9_]{2,63}$/.test(n.name)) {
        throw new Error(`${w.name} › ${n.name}: tool node names become tool names; use snake_case`);
      }
    }
    for (const [from, byType] of Object.entries(w.connections)) {
      if (!w.nodes.some((n) => n.name === from)) throw new Error(`${w.name}: connection from unknown node ${from}`);
      for (const outputs of Object.values(byType)) {
        for (const t of outputs.flat()) {
          if (!w.nodes.some((n) => n.name === t.node)) throw new Error(`${w.name}: connection to unknown node ${t.node}`);
        }
      }
    }
  }
}

const check = process.argv.includes('--check');
const built = FILES.map(([file, make]) => [file, make().toJSON()]);
validate(built.map(([, wf]) => wf));

let stale = 0;
if (!check) {
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.json')) rmSync(path.join(OUT, f));
}
for (const [file, wf] of built) {
  const json = `${JSON.stringify(wf, null, 2)}\n`;
  const target = path.join(OUT, file);
  if (check) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== json) {
      stale++;
      console.error(`stale: workflows/${file}`);
    }
  } else {
    writeFileSync(target, json);
  }
}
if (check && stale) {
  console.error('Run `npm run build` and commit the result.');
  process.exit(1);
}
const nodeCount = built.reduce((n, [, wf]) => n + wf.nodes.length, 0);
console.log(`${check ? 'checked' : 'built'} ${built.length} workflows (${nodeCount} nodes)`);
