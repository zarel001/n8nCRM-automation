import {
  Workflow, WORKFLOW_IDS, CREDENTIALS, codeParams, pgCall, pgQuery, execWorkflowParams, ifTrueParams, triggerParams,
} from '../../scripts/lib/wf.mjs';

const pg = { credentials: CREDENTIALS.postgres };

// Ops · Housekeeping — hourly: refresh the catalog from the storefront, one gentle payment
// reminder per unpaid order (only inside the customer's 24 h window), expire stale orders, apply
// data retention, and flag settings that still need values.
export function housekeeping() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.housekeeping,
    name: 'Ops · Housekeeping',
    description: 'Hourly: catalog refresh, payment reminders, order expiry, data retention, config check.',
  });

  wf.add('schedule', 'Every hour', { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } });
  // lets the runbook trigger a run on demand: n8n execute --id=MsHousekeep00001
  wf.add('execTrigger', 'Run now', triggerParams());
  wf.add('postgres', 'Settings', pgQuery('select crm.get_settings() as settings'), pg);

  // catalog
  wf.add('http', 'Fetch catalog', {
    method: 'GET',
    url: "={{ $json.settings.catalog_url || 'https://invalid.local' }}",
    options: { response: { response: { neverError: true } }, timeout: 15000 },
  }, { onError: 'continueRegularOutput' });
  wf.add('code', 'Check catalog', codeParams([], `
const c = $input.first().json || {};
const ok = Array.isArray(c.variants) && c.variants.length > 0 && Array.isArray(c.sizes) && c.sizes.length > 0;
return [{ json: { ok, catalog: ok ? { brand: c.brand || {}, variants: c.variants, sizes: c.sizes, maxQty: c.maxQty || 24, source: 'storefront' } : null } }];`));
  wf.add('if', 'Catalog looks valid?', ifTrueParams('={{ $json.ok }}'));
  wf.add('postgres', 'Cache catalog', pgCall('cache_catalog', '$json.catalog'), pg);

  // expiry + retention + config
  wf.add('postgres', 'Expire and purge', pgCall('housekeeping', `{
    expire_after_hours: ($('Settings').first().json.settings.retention || {}).expire_unpaid_hours || 48,
    screenshot_days: ($('Settings').first().json.settings.retention || {}).screenshot_days || 30,
    message_days: ($('Settings').first().json.settings.retention || {}).message_days || 180
  }`), pg);
  wf.add('postgres', 'Config problems', pgCall('config_problems', '{}'), pg);
  wf.add('if', 'Anything missing?', ifTrueParams('={{ ($json.result || []).length > 0 }}'));
  wf.add('postgres', 'Log config warning', pgCall('log_event',
    "{ level: 'warn', source: 'config', message: 'Settings need attention', details: { problems: $json.result } }"), pg);

  // reminders
  wf.add('postgres', 'Unpaid orders', pgCall('orders_due_for_reminder',
    "{ after_hours: ($('Settings').first().json.settings.retention || {}).reminder_after_hours || 3 }"), pg);
  wf.add('code', 'Compose reminders', codeParams(['wa', 'copy'], `
const settings = $('Settings').first().json.settings;
const due = $input.first().json.result || [];
return due.map(({ order, customer }) => ({ json: waSendRequest(customer,
  [waButtons(waRecipientOf(customer), copy.reminder(order, settings.momo || {}), copy.orderButtons(order))],
  null, settings, order.id) }));`));
  wf.add('execWorkflow', 'Send reminders', execWorkflowParams(WORKFLOW_IDS.send, { each: true }));
  wf.add('postgres', 'Mark reminded', pgCall('mark_reminded', '{ order_id: $json.ref }'), pg);

  wf.chain('Every hour', 'Settings', 'Fetch catalog', 'Check catalog', 'Catalog looks valid?');
  wf.connect('Run now', 'Settings');
  wf.connect('Catalog looks valid?', 'Cache catalog', { output: 0 });
  wf.connect('Settings', 'Expire and purge');
  wf.chain('Expire and purge', 'Config problems', 'Anything missing?');
  wf.connect('Anything missing?', 'Log config warning', { output: 0 });
  wf.connect('Settings', 'Unpaid orders');
  wf.chain('Unpaid orders', 'Compose reminders', 'Send reminders', 'Mark reminded');
  return wf;
}

// Ops · Errors — the error workflow of every other workflow: records the failure and, if an
// alert webhook is configured (Slack/Discord compatible), notifies the developer.
export function errors() {
  const wf = new Workflow({
    id: WORKFLOW_IDS.errors,
    name: 'Ops · Errors',
    description: 'Error workflow: logs failures and alerts the developer.',
  });

  wf.add('errorTrigger', 'On workflow error', {});
  wf.add('code', 'Describe', codeParams([], `
const e = $input.first().json;
const execution = e.execution || {};
const err = execution.error || {};
const workflow = (e.workflow && e.workflow.name) || 'unknown workflow';
// Error messages can quote message content; keep them short.
const message = String(err.message || 'Unknown error').slice(0, 300);
return [{ json: {
  event: { level: 'error', source: workflow, message,
    details: { execution_id: execution.id || null, url: execution.url || null, node: execution.lastNodeExecuted || null } },
  text: '⚠️ n8n: ' + workflow + ' failed at ' + (execution.lastNodeExecuted || '?') + ': ' + message + (execution.url ? ' ' + execution.url : ''),
} }];`));
  wf.add('postgres', 'Log error', pgCall('log_event', '$json.event'), pg);
  wf.add('postgres', 'Settings', pgQuery('select crm.get_settings() as settings'), pg);
  wf.add('if', 'Alert webhook set?', ifTrueParams("={{ Boolean(($json.settings.alerts || {}).webhook_url) }}"));
  wf.add('http', 'Alert developer', {
    method: 'POST',
    url: '={{ $json.settings.alerts.webhook_url }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $('Describe').first().json.text, content: $('Describe').first().json.text }) }}",
    options: { timeout: 10000 },
  }, { onError: 'continueRegularOutput' });

  wf.chain('On workflow error', 'Describe', 'Log error', 'Settings', 'Alert webhook set?');
  wf.connect('Alert webhook set?', 'Alert developer', { output: 0 });
  return wf;
}
