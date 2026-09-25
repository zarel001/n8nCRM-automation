# n8nCRM-automation

WhatsApp AI agent + CRM for **Mash & Sip Co.** ([storefront](https://whatsapp-storefront-psi.vercel.app)), built on n8n 2.40, the official WhatsApp Cloud API, Claude and Postgres. It implements the storefront's [bot contract](https://github.com/zarel001/Whatsapp-storefront/blob/claude/modest-dirac-kz7n8y/docs/whatsapp-bot-contract.md) and adds support, lead capture and hand-offs.

## What it does

| Customer does | Bot does |
|---|---|
| Taps **Order** on the site (`Order: Cinnamon 250ml x2` / `Name: …`) | Creates the order (priced by the database from the site's catalog), replies with total + Mobile Money instructions + *Cancel* / *Talk to a person* buttons |
| Sends a MoMo screenshot | Claude reads it (it isn't told the expected values); code checks amount, recipient, reused transaction or image, timing and signs of editing. **The owner approves with one tap**, and the customer is told it's being checked |
| — owner taps **Approve** | Order marked paid; customer is asked for a location pin |
| Shares a location (or types an address) | Owner gets a delivery card with *On the way* / *Delivered* buttons, which notify the customer |
| Asks anything / orders in chat / "where's my order?" / party order | Claude agent with six tools, each bound to the sender (see [security](docs/security.md)) |
| Types **human** (or the agent decides) | Owner alerted; *Take over chat* relays messages both ways through the business number; `/done` hands back |
| Sends a voice note, video… | Polite "please type" (voice is out of scope for v1) |

Every hour: sync the catalog from the storefront, send one payment reminder (only inside the 24 h window), expire unpaid orders after 48 h, apply retention, flag missing settings.

## Architecture

```
 customer ─▶ WhatsApp ─▶ Meta ──HTTPS──▶ Caddy ──▶ gate ──▶ n8n ──▶ Postgres (crm.* API)
                                      (TLS)   (HMAC check,   │  (13 workflows)
 owner (personal WhatsApp) ◀── alerts / buttons ◀────────────┤
                                                             ├──▶ Claude (agent + screenshot reading)
 storefront /api/catalog ◀──── hourly price sync ────────────┘
```

- **gate/**: about 200 dependency-free lines that verify Meta's signature before anything reaches n8n. n8n's own webhook and editor are never public.
- **Postgres CRM**: every state change is a `SECURITY DEFINER` function; n8n's database role can only call those functions.
- **Workflows** are generated from `src/workflows/*.mjs`, and Code nodes inline the unit-tested modules from `src/lib/`. Don't hand-edit `workflows/*.json`.

## Repository

| Path | What |
|---|---|
| `src/lib/` | Tested logic: webhook parsing, storefront order contract, payment pre-checks, routing, message copy, templates, agent prompt |
| `src/workflows/` → `workflows/` | Workflow definitions → generated n8n JSON (`npm run build`) |
| `prompts/agent-system.md` | The agent's instructions (filled from settings at runtime) |
| `db/` | Schema/functions (`migrations/`), least-privilege grants (`roles.sql`), first-run settings (`seed/`) |
| `gate/` | Webhook gate (Node 22, no dependencies) + Dockerfile |
| `infra/` | Docker Compose for Oracle Always Free (arm64), Caddyfile, `.env.example`, VM hardening script |
| `scripts/` | `bootstrap.sh`, `update.sh`, `backup.sh`, credentials + template helpers, workflow builder |
| `templates/` | WhatsApp message templates to submit to Meta |
| `tests/` | Unit, database (as the restricted role) and end-to-end (real n8n + mocked Meta/Claude) |

## Run it locally

Windows (WSL2 + Docker Desktop + VS Code), macOS or Linux: [docs/local.md](docs/local.md).

```bash
npm run demo             # no accounts: WhatsApp and Claude simulated, plays a full customer journey
npm run local:whatsapp   # Meta's free test number + real Claude, through a temporary Cloudflare tunnel
```

## Tests

```bash
npm install
npm test            # 45 unit + gate tests
npm run check       # workflows/*.json match the source
npm run test:db     # 13 tests against Postgres (Docker)
npm run test:e2e    # 15 scenarios through gate → n8n 2.40.7 → Postgres, Meta + Claude mocked (Docker, ~4 min)
```

## Deploy

[docs/setup.md](docs/setup.md): Oracle VM → Meta app (test number) → secrets + `./scripts/bootstrap.sh` → webhook → settings → templates → test. The bot stays on Meta's test number for now; going live on a real number is a later step ([§9](docs/setup.md#9-later-go-live-on-a-real-number)). Operations: [docs/runbook.md](docs/runbook.md).

## Decisions

- **Official Cloud API, on Meta's free test number for now.** 055 886 6617 stays in the WhatsApp Business app until launch ([setup §9](docs/setup.md#9-later-go-live-on-a-real-number)), which moves it to the API for good (no coexistence). Either way, the owner approves payments and takes over chats from a personal number.
- **The owner approves every payment.** Screenshots are easy to fake; the bot does the reading and checking, the owner taps.
- **Claude `claude-opus-5`** for the agent (adaptive thinking, medium effort, prompt caching) and for reading screenshots. `claude-sonnet-5` costs about 60% less per token; change it on the *Claude* node and in `settings.ai.vision_model`.
- **No vector database.** The FAQ fits in the prompt. Facts left empty in settings are never guessed; the agent hands off instead.

## Costs (monthly, rough)

| Item | Cost |
|---|---|
| Oracle Always Free (A1, 2 OCPU / 12 GB) | $0. Upgrade the account to Pay-As-You-Go (still $0 within free limits) so idle instances aren't reclaimed |
| WhatsApp | Test number: free, no payment method needed. On a real number from Oct 1, 2026: 1,000 free service messages per number per month, then Ghana's per-message rate; templates are billed per message |
| Claude | Only AI work costs money: checkout messages, buttons and location pins are handled without it. Roughly $0.03–0.08 per agent reply and $0.02–0.04 per screenshot read on Opus 5; about 40% of that on Sonnet 5 |
