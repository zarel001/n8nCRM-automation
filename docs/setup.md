# Setup

About 2 hours end to end, plus Meta's review time for templates and business verification.

> **Deadline:** if the business already has a WhatsApp API account, add a payment method in WhatsApp Manager → Billing **before 30 Sept 2026**. From 1 Oct 2026 Meta stops delivering replies for accounts without one.

## 1. Oracle Cloud VM

1. Create an Oracle Cloud account and pick a home region that has Ampere A1 capacity.
2. **Recommended:** upgrade the account to *Pay As You Go*. Always Free resources stay free, and idle instances on free-only accounts can be reclaimed: a quiet WhatsApp bot uses under 20% CPU/RAM, which is Oracle's idle threshold.
3. Create an instance: **Ubuntu 24.04**, shape **VM.Standard.A1.Flex, 2 OCPU / 12 GB** (the current Always Free maximum), 50 GB boot volume, your SSH key.
4. VCN → Security List → ingress: TCP **80** and **443** from `0.0.0.0/0`; SSH **22** from your IP if you can.
5. SSH in, then:
   ```bash
   git clone https://github.com/zarel001/n8nCRM-automation.git
   sudo bash n8nCRM-automation/infra/oracle/setup-vm.sh   # Docker, firewall 80/443, SSH keys-only, auto security updates
   exit                                                   # log back in so the docker group applies
   ```

## 2. Hostname

Meta needs HTTPS with a real certificate; Caddy gets one from Let's Encrypt automatically.

- With a domain: add an **A record**, e.g. `wa.mashsip.com → <VM public IP>`.
- Without one: use `<ip-with-dashes>.sslip.io`, e.g. `129-146-12-34.sslip.io`.

## 3. Meta app (start on the free test number)

1. **business.facebook.com**: create the business portfolio. Start business verification now; it takes days and raises sending limits.
2. **developers.facebook.com** → *Create app* → type *Business* → add the **WhatsApp** product. You get a test number.
3. *WhatsApp → API Setup*: add test recipients: **the owner's personal number** and **a different phone for playing the customer** (the owner's number is treated as the owner, so orders from it won't work). A test number can message at most 5 verified numbers. Note the **Phone number ID** and the **WhatsApp Business Account ID**.
4. **Permanent token**: Business settings → Users → *System users* → Add (Admin) → *Assign assets*: the app and the WhatsApp account (full control) → *Generate token* with `whatsapp_business_messaging` + `whatsapp_business_management`, expiry **Never**.
5. App settings → Basic → **App secret**.
6. WhatsApp Manager → **Billing**: add a payment method.

## 4. Secrets and first start

```bash
cd n8nCRM-automation
cp infra/.env.example infra/.env && chmod 600 infra/.env
openssl rand -hex 32        # run once per generated secret
nano infra/.env             # hostname, generated secrets, the Meta values from step 3, your Anthropic API key
```

Put **`N8N_ENCRYPTION_KEY`** and **`BACKUP_PASSPHRASE`** in a password manager. Without the key, a restored database can't decrypt any credential.

```bash
./scripts/bootstrap.sh      # database, credentials, 13 workflows, gate, TLS
```

Re-run `bootstrap.sh` whenever you change a token in `.env`; it updates the credentials in place.

## 5. Connect the webhook

1. Meta app → *WhatsApp → Configuration → Webhook*: Callback URL `https://<PUBLIC_HOST>/webhook/whatsapp`, Verify token = your `META_VERIFY_TOKEN` → *Verify and save* → subscribe the **messages** field.
2. Subscribe the app to the WhatsApp account (needed for real numbers):
   ```bash
   curl -X POST "https://graph.facebook.com/v26.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>"
   ```

## 6. Settings

Business facts and IDs live in the database. Anything the assistant tells customers comes from here, and it won't guess what's missing.

```bash
docker compose -f infra/docker-compose.yml exec postgres psql -U postgres -d mashsip
```
```sql
set role mashsip_admin;
select crm.put_setting('{"key":"owner","value":{"wa_id":"233XXXXXXXXX","name":"<owner first name>"}}');   -- owner's PERSONAL number
select crm.put_setting('{"key":"momo","value":{"number":"055 886 6617","name":"Mash & Sip Co.","network":"MTN MoMo"}}');
select crm.put_setting('{"key":"whatsapp","value":{"graph_base_url":"https://graph.facebook.com","graph_version":"v26.0","phone_number_id":"<PHONE_NUMBER_ID>","template_language":"en"}}');
select crm.put_setting('{"key":"business","value":{
  "hours":"Mon–Sat, 8am–7pm", "delivery_areas":"…", "delivery_fee":"…", "delivery_time":"…",
  "storage":"Keep refrigerated", "shelf_life":"…", "pickup":null,
  "extra_faq":[{"q":"Is it halal?","a":"…"}]}}');
select crm.put_setting('{"key":"alerts","value":{"webhook_url":"https://discord.com/api/webhooks/…"}}');  -- optional: your alerts
select crm.config_problems();   -- must return []
```

Confirm the MoMo number and account name with the owner; they appear in every order confirmation.

## 7. Message templates

Templates are the only way to message someone whose 24-hour window is closed. The owner's alerts rely on them whenever she hasn't messaged the bot that day.

```bash
set -a; . infra/.env; set +a
node scripts/create-templates.mjs          # submits the 6 text templates
```

Create **`payment_check`** by hand in WhatsApp Manager → *Message templates* → *Create*: category *Utility*, language *English*, header **Image** (upload any sample screenshot), body and two *Quick reply* buttons exactly as in `templates/whatsapp-templates.json`.

Approval usually takes minutes to hours. Until then, alerts reach the owner only if she has messaged the business number in the last 24 h, so send "hi" from her phone before each test session.

## 8. Test on the test number

The site links to the real number, so from the "customer" phone send the checkout text to the **test number** yourself:

```
Order: Cinnamon 250ml x2
Name: Test Customer
```

Walk through:
- [ ] Order confirmation with total, MoMo details and buttons.
- [ ] Screenshot → "confirming your payment"; the owner gets the screenshot + Approve/Reject.
- [ ] Approve → location request → send a pin → the owner gets the delivery card → *On the way* → *Delivered*.
- [ ] Questions ("Do you deliver to Tema?", "what flavours?"), "where is my order?", "I need 60 bottles for a wedding".
- [ ] "human" → *Take over chat* → messages relay both ways → `/done`.
- [ ] "STOP" / "START", a voice note, "cancel".

## 9. Go live with 055 886 6617

Not using coexistence means the number leaves the WhatsApp Business app for good.

1. Business verification approved, payment method set, templates approved.
2. On the phone that has 055 886 6617: export any chats worth keeping; they don't move to the API.
3. WhatsApp Business app → Settings → Account → **Delete account** for that number.
4. WhatsApp Manager → Phone numbers → **Add phone number** → 055 886 6617, display name "Mash & Sip Co." → verify by SMS or voice → set a two-step PIN (store it).
5. Update `whatsapp.phone_number_id` (step 6) with the new number's ID; repeat step 5.2 if needed.
6. Place a real order from the site. The site already links to 233558866617, so the storefront needs no change.

Before launch, also: add a privacy notice to the site (orders, chats and payment screenshots are processed by this bot, with Anthropic as a processor), and check the business's registration with Ghana's Data Protection Commission (Data Protection Act, 2012).
