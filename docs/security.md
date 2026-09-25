# Security and privacy

| Threat | Controls | Tested in |
|---|---|---|
| Forged or malformed webhooks | The gate verifies `X-Hub-Signature-256` (HMAC-SHA256, timing-safe), accepts JSON only, caps bodies at 1 MB and forwards with a shared token. n8n's webhook requires that token and isn't reachable from the internet | `gate/server.test.js`, e2e |
| n8n vulnerabilities (six critical CVEs in Q1 2026, incl. unauthenticated RCE via webhooks/forms) | Editor bound to 127.0.0.1 (SSH tunnel only); webhook behind the gate; Form nodes, Execute Command and SSH nodes disabled; public API and community packages off; env access from nodes blocked; task runners isolate Code nodes; **SSRF protection on**, so workflows can't reach private addresses such as the cloud metadata service; image pinned, update path in the runbook | compose smoke test |
| Database abuse through n8n | n8n's role `mashsip_bot` can only EXECUTE the `crm.*` API functions (`SECURITY DEFINER`, `search_path=''`), with no table reads or DDL. Postgres is on an internal network with no published port | `tests/db` (permission checks) |
| Fake payment screenshots | The owner approves every payment. The model reads the screenshot without knowing the expected amount or recipient; code compares. Reused transaction IDs and identical images across orders are flagged, and approval is refused if the transaction was already approved elsewhere. Timing and editing signs are flagged | unit, db, e2e |
| Prompt injection / social engineering | Every tool gets `customer_id` from the workflow, never from the model; nothing can change prices, grant discounts or confirm payments; totals are computed in the database; customer text is delimited and treated as data; the agent is restricted to the business (Meta's 2026 policy) | e2e (tool scoping), prompt |
| Seeing or changing another customer's order | All lookups, cancellations and delivery details are keyed by the sender; order codes alone unlock nothing | db |
| Injection via the checkout message | Names are sanitised on the site and again by the bot; the parser accepts one order line | unit |
| Secrets | Tokens live encrypted in n8n (`N8N_ENCRYPTION_KEY`), never in workflow JSON or git; `.env` is mode 600; the Meta app secret is only in the gate | — |
| Outages / lost messages | When n8n is down the gate returns 503 and Meta retries; duplicates are dropped by message ID; failed sends and workflow errors alert the developer | e2e |

## Personal data

- **Stored:** WhatsApp number or ID, profile name, name given at checkout, messages, orders, delivery location, payment screenshots with the extracted fields.
- **Retention** (`settings.retention`): screenshots 30 days, messages 180 days, n8n execution logs 7 days. Orders and leads are kept as business records.
- **Processors:** Meta (WhatsApp), Anthropic (Claude; API data isn't used for training by default), Oracle (hosting).
- **Customer rights:** export or delete a customer's rows on request (`crm.customers` cascades to messages, orders, payments).
- **Backups** are encrypted when `BACKUP_PASSPHRASE` is set.

## Responsible AI

- The first reply to every new customer says it's an AI assistant and how to reach a person.
- **human** always reaches the owner; complaints, drink problems and refunds are handed off, not handled by the AI.
- The bot never states facts that aren't in settings; missing facts trigger a hand-off.
- No marketing messages are sent. Reminders go only to a customer's own unpaid order, once, inside their 24-hour window. **STOP** is honoured.
