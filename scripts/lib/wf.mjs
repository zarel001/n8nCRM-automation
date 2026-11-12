// Tiny builder for n8n workflow JSON (n8n 2.40). Keeps workflow definitions readable, IDs stable
// (so Execute Workflow references survive re-imports) and Code nodes built from the unit-tested
// modules in src/lib.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TYPES = {
  webhook: ['n8n-nodes-base.webhook', 2.1],
  code: ['n8n-nodes-base.code', 2],
  postgres: ['n8n-nodes-base.postgres', 2.7],
  http: ['n8n-nodes-base.httpRequest', 4.5],
  switch: ['n8n-nodes-base.switch', 3.4],
  if: ['n8n-nodes-base.if', 2.3],
  execWorkflow: ['n8n-nodes-base.executeWorkflow', 1.3],
  execTrigger: ['n8n-nodes-base.executeWorkflowTrigger', 1.2],
  wait: ['n8n-nodes-base.wait', 1.1],
  schedule: ['n8n-nodes-base.scheduleTrigger', 1.4],
  errorTrigger: ['n8n-nodes-base.errorTrigger', 1],
  extractFromFile: ['n8n-nodes-base.extractFromFile', 1.1],
  noOp: ['n8n-nodes-base.noOp', 1],
  sticky: ['n8n-nodes-base.stickyNote', 1],
  agent: ['@n8n/n8n-nodes-langchain.agent', 3.1],
  anthropic: ['@n8n/n8n-nodes-langchain.lmChatAnthropic', 1.6],
  toolWorkflow: ['@n8n/n8n-nodes-langchain.toolWorkflow', 2.2],
};

// Credentials are referenced by fixed IDs; scripts/bootstrap-n8n.mjs creates them with these IDs.
export const CREDENTIALS = {
  postgres: { postgres: { id: 'MsCredPostgres01', name: 'Mash & Sip CRM (bot role)' } },
  whatsapp: { whatsAppApi: { id: 'MsCredWhatsApp01', name: 'WhatsApp Cloud API' } },
  anthropic: { anthropicApi: { id: 'MsCredAnthropic1', name: 'Anthropic' } },
  gate: { httpHeaderAuth: { id: 'MsCredGateToken1', name: 'Webhook gate token' } },
};

export const WORKFLOW_IDS = {
  inbound: 'MsInbound0000001',
  send: 'MsWaSend00000001',
  order: 'MsOrder000000001',
  payment: 'MsPayment0000001',
  owner: 'MsOwner000000001',
  customer: 'MsCustomer000001',
  escalate: 'MsEscalate000001',
  agent: 'MsAgent000000001',
  toolOrders: 'MsToolOrders0001',
  toolCancel: 'MsToolCancel0001',
  toolDelivery: 'MsToolDeliver001',
  housekeeping: 'MsHousekeep00001',
  errors: 'MsErrors00000001',
};

function uuidFor(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Loads src/lib/<name>.js without its CommonJS export footer, for inlining into Code nodes.
export function lib(name) {
  const src = readFileSync(path.join(ROOT, 'src', 'lib', `${name}.js`), 'utf8');
  const cut = src.indexOf("if (typeof module !== 'undefined'");
  return (cut === -1 ? src : src.slice(0, cut)).trimEnd();
}

export function readPrompt(name) {
  return readFileSync(path.join(ROOT, 'prompts', name), 'utf8');
}

export class Workflow {
  constructor({ id, name, description, tags = [] }) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.tags = tags;
    this.nodes = [];
    this.connections = {};
  }

  add(type, name, parameters = {}, extra = {}) {
    if (this.nodes.some((n) => n.name === name)) throw new Error(`${this.name}: duplicate node name "${name}"`);
    const [nodeType, typeVersion] = TYPES[type];
    const node = { parameters, id: uuidFor(`${this.id}:${name}`), name, type: nodeType, typeVersion, position: [0, 0], ...extra };
    this.nodes.push(node);
    return name;
  }

  connect(from, to, { output = 0, input = 0 } = {}) {
    this.#link(from, to, 'main', output, input);
    return this;
  }

  // AI sub-node (model, tool) → root node (agent).
  connectAi(from, to, type) {
    this.#link(from, to, type, 0, 0);
    return this;
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
    return this;
  }

  #link(from, to, type, output, input) {
    for (const n of [from, to]) {
      if (!this.nodes.some((x) => x.name === n)) throw new Error(`${this.name}: unknown node "${n}"`);
    }
    const byType = (this.connections[from] ??= {});
    const outputs = (byType[type] ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output].push({ node: to, type, index: input });
  }

  #layout() {
    const incoming = new Map(this.nodes.map((n) => [n.name, []]));
    for (const [from, byType] of Object.entries(this.connections)) {
      for (const [type, outputs] of Object.entries(byType)) {
        outputs.forEach((targets, output) => {
          for (const t of targets) incoming.get(t.node).push({ from, type, output });
        });
      }
    }
    const depth = new Map();
    const visit = (name, seen = new Set()) => {
      if (depth.has(name)) return depth.get(name);
      if (seen.has(name)) return 0;
      seen.add(name);
      const mains = incoming.get(name).filter((c) => c.type === 'main');
      const d = mains.length ? Math.max(...mains.map((c) => visit(c.from, seen) + 1)) : 0;
      depth.set(name, d);
      return d;
    };
    const aiParents = new Map();
    for (const [from, byType] of Object.entries(this.connections)) {
      for (const [type, outputs] of Object.entries(byType)) {
        if (type !== 'main') for (const t of outputs.flat()) aiParents.set(from, t.node);
      }
    }
    // AI sub-nodes (model, tools) sit in a band under their parent, 180 apart from 120 to its left.
    // Columns after that parent start past the band, so nothing is drawn on top of it.
    const subNodes = new Map();
    for (const parent of aiParents.values()) subNodes.set(parent, (subNodes.get(parent) ?? 0) + 1);
    const shift = (d) => {
      let x = 0;
      for (const [parent, count] of subNodes) {
        const bandEnd = -120 + (count - 1) * 180 + 80; // right edge of the last sub-node, from the parent's x
        if (visit(parent) < d) x += Math.max(0, bandEnd + 300 - 280); // keep a 300px gap; columns are 280 apart
      }
      return x;
    };
    // Column by depth. Within a column, siblings are ordered like their parent's outputs (output 0
    // on top), and each node stays in its parent's row when that slot is free, so a branch (such as
    // an error path) reads as one lane; otherwise it takes the next free row below.
    const columns = new Map();
    this.nodes.forEach((n, i) => {
      if (n.type === TYPES.sticky[0] || aiParents.has(n.name)) return;
      const d = visit(n.name);
      columns.set(d, [...(columns.get(d) ?? []), { n, i }]);
    });
    const rowOf = new Map();
    for (const d of [...columns.keys()].sort((a, b) => a - b)) {
      const used = new Set();
      const column = columns.get(d).map(({ n, i }) => {
        const [parent] = incoming.get(n.name)
          .filter((c) => c.type === 'main' && rowOf.has(c.from))
          .sort((a, b) => rowOf.get(a.from) - rowOf.get(b.from) || a.output - b.output);
        return { n, i, row: parent ? rowOf.get(parent.from) : 0, output: parent ? parent.output : 0 };
      }).sort((a, b) => a.row - b.row || a.output - b.output || a.i - b.i);
      for (const { n, row: preferred } of column) {
        let row = preferred;
        while (used.has(row)) row++;
        used.add(row);
        rowOf.set(n.name, row);
        n.position = [d * 280 + shift(d), row * 200];
      }
    }
    const aiCount = new Map();
    for (const n of this.nodes) {
      const parent = aiParents.get(n.name);
      if (!parent) continue;
      const p = this.nodes.find((x) => x.name === parent).position;
      const i = aiCount.get(parent) ?? 0;
      aiCount.set(parent, i + 1);
      n.position = [p[0] - 120 + i * 180, p[1] + 260];
    }
  }

  toJSON() {
    this.#layout();
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      active: false,
      isArchived: false,
      nodes: this.nodes,
      connections: this.connections,
      settings: {
        executionOrder: 'v1',
        errorWorkflow: this.id === WORKFLOW_IDS.errors ? undefined : WORKFLOW_IDS.errors,
        callerPolicy: 'workflowsFromSameOwner',
        saveManualExecutions: true,
        saveExecutionProgress: false,
      },
      pinData: {},
      meta: { templateCredsSetupCompleted: true },
      tags: [],
    };
  }
}

// ─── parameter helpers ────────────────────────────────────────────────────────────────────────

export const expr = (s) => `=${s}`;

// Code node from inlined libs + body. mode: 'all' (runOnceForAllItems) | 'each'.
export function codeParams(libs, body, mode = 'all') {
  const parts = libs.map((l) => `// ── src/lib/${l}.js ──\n${lib(l)}`);
  parts.push(`// ── node logic ──\n${body.trim()}\n`);
  return {
    mode: mode === 'each' ? 'runOnceForEachItem' : 'runOnceForAllItems',
    language: 'javaScript',
    jsCode: parts.join('\n\n'),
  };
}

// Postgres "Execute query" calling crm.<fn>($1::jsonb). `payload` is an n8n expression (without
// the leading "=") evaluating to an object.
export function pgCall(fn, payload, alias = 'result') {
  return {
    operation: 'executeQuery',
    query: `select crm.${fn}($1::jsonb) as ${alias}`,
    options: { queryReplacement: `={{ [ JSON.stringify(${payload}) ] }}` },
  };
}

export function pgQuery(query, payloads = []) {
  const params = { operation: 'executeQuery', query, options: {} };
  if (payloads.length) params.options.queryReplacement = `={{ [ ${payloads.map((p) => `JSON.stringify(${p})`).join(', ')} ] }}`;
  return params;
}

// Resource-mapper value for Execute Workflow / Call Workflow Tool nodes whose child declares inputs.
export function workflowInputs(fields) {
  return {
    mappingMode: 'defineBelow',
    value: Object.fromEntries(fields.map((f) => [f.name, f.value])),
    matchingColumns: [],
    schema: fields.map((f) => ({
      id: f.name,
      displayName: f.name,
      required: false,
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: true,
      type: f.type,
      removed: false,
    })),
    attemptToConvertTypes: false,
    convertFieldsToString: true,
  };
}

export function execWorkflowParams(workflowId, { inputs, each = false, wait = true } = {}) {
  const p = {
    workflowId: { __rl: true, mode: 'id', value: workflowId },
    mode: each ? 'each' : 'once',
    options: { waitForSubWorkflow: wait },
  };
  if (inputs) p.workflowInputs = workflowInputs(inputs);
  return p;
}

export function triggerParams(inputs) {
  if (!inputs) return { inputSource: 'passthrough' };
  return { inputSource: 'workflowInputs', workflowInputs: { values: inputs.map(({ name, type }) => ({ name, type })) } };
}

// Switch on a string field with one output per value (+ fallback output "other").
export function switchParams(leftValue, values) {
  return {
    mode: 'rules',
    rules: {
      values: values.map((v) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
          conditions: [{ id: uuidFor(`${leftValue}:${v}`), leftValue, rightValue: v, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: v,
      })),
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'other' },
  };
}

export function ifTrueParams(leftValue) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
      conditions: [{ id: uuidFor(`if:${leftValue}`), leftValue, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  };
}
