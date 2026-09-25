# Run it on your machine

Both modes run the production stack in Docker: Postgres, n8n 2.40.7 with all 13 workflows, and the webhook gate.

| | `npm run demo` | `npm run local:whatsapp` |
|---|---|---|
| WhatsApp | Simulated | Meta's free test number, with your real phones |
| Claude | Simulated with keyword rules | Real, using your API key |
| Accounts needed | None | A Meta developer app and an Anthropic API key |
| Cost | $0 | Claude usage only: about $0.03–0.08 per AI reply |
| Reachable from the internet | Nothing | Only the gate, through a temporary Cloudflare tunnel |

## 1. One-time setup (Windows)

Everything runs inside WSL2 (Ubuntu on Windows), and VS Code connects to it.

1. **PowerShell as administrator:** `wsl --install -d Ubuntu`, then reboot. Open **Ubuntu** from the Start menu and create a Linux user.
2. **Docker Desktop:** install it, then go to *Settings → Resources → WSL integration*, turn on **Ubuntu**, and click *Apply & restart*.
3. **VS Code:** install it on Windows, then add the **WSL** extension (`ms-vscode-remote.remote-wsl`).
4. **In the Ubuntu terminal:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git gh
   gh auth login                                  # GitHub.com → HTTPS → log in with a browser
   gh repo clone zarel001/n8nCRM-automation ~/n8nCRM-automation
   cd ~/n8nCRM-automation
   git checkout claude/dazzling-feynman-7318ra    # until PR #1 is merged
   npm ci
   code .
   ```
   VS Code opens with **WSL: Ubuntu** in the bottom-left corner. Accept the recommended extensions.

Keep the clone in your Linux home (`~/`), not under `/mnt/c/…`. It's much faster there, and it keeps the Linux line endings and file permissions the scripts need.

On macOS or Linux, skip the WSL steps and follow the rest as written.

## 2. Demo (no accounts)

```bash
npm run demo
```

The first run downloads about 1 GB of images, which takes a few minutes. The script then starts the stack plus a simulator for Meta, Claude and the storefront, and plays a full conversation. It prints each message:

```
🙋🏾 Akosua:
   Order: Cinnamon 250ml x2
   Name: Akosua Mensah

🤖 → Akosua:
   Thanks, Akosua! 🧡 Here's your order:

   *Order MS-9F9D*
   2 × Cinnamon 250ml — GHS 80.00
   *Total: GHS 80.00*
   …
   [ Cancel order ] [ Talk to a person ]
```

The conversation covers:
- an order
- a payment screenshot, which the owner approves
- a delivery pin, then *On the way*
- a question about delivery areas
- "where is my order?"
- a wedding order, saved as a lead
- "human", then the owner takes over the chat and hands it back

Then open **http://localhost:5678** in your Windows browser and create a local owner account (it stays on your machine). *Overview → Executions* shows every run, node by node.

- `npm run demo` runs it again. Each run uses a new simulated customer.
- `npm run demo:stop` stops the stack and keeps the data.
- `npm run demo:reset` deletes the containers and the database.

The simulated parts are Meta's API, Claude (canned replies chosen by keyword) and the storefront catalog. Everything else is the real code: the gate's signature check, every workflow and the CRM database.

## 3. Real WhatsApp on the test number

You need:
- **A Meta app with WhatsApp.** Follow [setup §3](setup.md#3-meta-app-start-on-the-free-test-number), steps 2, 3 and 5. The test number is free.
- **Two phones added as test recipients.** One is the owner and the other plays the customer.
- **An Anthropic API key.**

Use a separate Meta app for local testing. An app has only one webhook URL, so sharing it with production would send live traffic to your laptop.

1. Run `npm run local:whatsapp`. It creates `infra/.env.local` and stops.
2. Open `infra/.env.local` in VS Code and fill in the values below. The secrets are already generated. Put quotes around any value that contains spaces or `&`.

   | Key | Where to find it |
   |---|---|
   | `META_APP_SECRET` | *App settings → Basic → App secret* |
   | `WHATSAPP_ACCESS_TOKEN` | *WhatsApp → API Setup → Generate access token*. This token lasts 24 hours. For a token that doesn't expire, use the System User token from [setup §3](setup.md#3-meta-app-start-on-the-free-test-number), step 4 |
   | `WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID` | *WhatsApp → API Setup* |
   | `ANTHROPIC_API_KEY` | console.anthropic.com → *API keys* |
   | `OWNER_WA_ID` | The owner's phone: digits with the country code, e.g. `233241234567` |
3. Run `npm run local:whatsapp` again. It prints:
   ```
   Callback URL:  https://<random-words>.trycloudflare.com/webhook/whatsapp
   Verify token:  <from .env.local>
   ```
4. In the Meta app, go to *WhatsApp → Configuration → Webhook → Edit*. Paste both values, click *Verify and save*, then subscribe to the **messages** field.
5. From the **owner's** phone, send `/help` to the test number. This opens the owner's 24-hour window, so alerts arrive without approved templates.
6. From the **customer** phone, send the checkout text (`Order: Cinnamon 250ml x2` on one line, `Name: Test Customer` on the next). Then work through the checklist in [setup §8](setup.md#8-test-on-the-test-number).

Without business facts, the agent hands off questions about hours and delivery fees instead of guessing. To add them, open the database with `docker exec -it mashsip-local-postgres-1 psql -U postgres -d mashsip`, run `set role mashsip_admin;`, then run the `business` statement from [setup §6](setup.md#6-settings).

- The tunnel URL changes every time the tunnel restarts. After running `npm run local:whatsapp` again or restarting the machine, paste the new URL into Meta.
- To change a token, edit `infra/.env.local` and run `npm run local:whatsapp` again. This updates the n8n credentials.
- Only the gate is exposed through the tunnel. The n8n editor stays at http://localhost:5678.
- `npm run local:stop` stops the stack and keeps the data. `npm run local:reset` deletes the containers and the database but keeps `.env.local`.

The two modes use the same ports, so starting one stops the other.

## 4. Working in VS Code

- **Terminal → Run Task…** has *Demo: run / stop / reset*, *WhatsApp test: start / stop*, *Tests: unit / database / end-to-end* and *Build workflows*.
- The **Docker** extension's *Containers* view lists the `mashsip-demo-*` and `mashsip-local-*` containers. Right-click one to view its logs or open a shell.
- To change the bot, edit `src/` or `prompts/`, run `npm run build`, then run `npm run demo` or `npm run local:whatsapp`. Both re-import every workflow. Don't edit workflows in the n8n editor, because the next import overwrites them.
- Tests:
  - `npm test && npm run check` takes seconds.
  - `npm run test:db` takes under a minute.
  - `npm run test:e2e` takes about 3–4 minutes. Run `npm run demo:stop` first, because both use port 55999.
- **Database:** `docker exec -it mashsip-demo-postgres-1 psql -U postgres -d mashsip` opens it (use `mashsip-local-…` in WhatsApp mode). Then try:
  ```sql
  select * from crm.v_orders;
  select created_at, source, message, details from crm.ops_events order by id desc limit 20;  -- failures and warnings
  ```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker: command not found` in Ubuntu | In Docker Desktop, go to *Settings → Resources → WSL integration*, turn on Ubuntu, then click *Apply & restart* |
| `Docker is installed but not running` | Start Docker Desktop |
| `port is already allocated` (5678 or 8080) | Something else is using the port, such as another n8n. Stop it, or run `npm run demo:stop` or `npm run local:stop` |
| `$'\r': command not found` | The repo was cloned on the Windows side. Clone it again inside Ubuntu (`~/`) |
| The demo times out waiting for the bot | In http://localhost:5678, *Executions* shows the node that failed. Also check `docker logs mashsip-demo-n8n-1` |
| Meta can't verify the callback URL | Check that the URL ends in `/webhook/whatsapp` and that the verify token matches `infra/.env.local`. Then check `docker logs mashsip-local-gate-1` and `docker logs mashsip-local-tunnel-1` |
| The bot is silent on WhatsApp | Run `docker logs mashsip-local-gate-1`. `invalid signature` means `META_APP_SECRET` is wrong. If nothing is logged, the tunnel URL changed or *messages* isn't subscribed |
| The owner gets no alerts | The owner's number must be a test recipient, and the owner must message the test number first (the 24-hour window) |
| Error `131030` in `crm.ops_events` | Add that phone under *WhatsApp → API Setup → To* |
| Error `190` in `crm.ops_events` | The token expired. Paste a new one into `infra/.env.local`, then run `npm run local:whatsapp` |
