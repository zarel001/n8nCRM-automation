-- First-run settings. Non-secret values only: tokens and API keys go into n8n credentials.
-- Re-running is safe (existing keys are kept). Change a value later with:
--   select crm.put_setting('{"key": "momo", "value": {"number": "...", "name": "..."}}');
-- `select crm.config_problems();` lists anything still missing.

insert into crm.settings (key, value) values
  ('brand', '{
     "name": "Mash & Sip Co.",
     "shortName": "Mash & Sip",
     "siteUrl": "https://whatsapp-storefront-psi.vercel.app",
     "city": "Accra",
     "timezone": "Africa/Accra"
   }'),

  -- The owner's PERSONAL WhatsApp number (not the business number), digits with country code.
  -- Payment checks, hand-offs and delivery alerts go here.
  ('owner', '{"wa_id": null, "name": "Owner"}'),

  -- Where customers send Mobile Money. Shown in every order confirmation.
  ('momo', '{"number": null, "name": null, "network": "MTN MoMo"}'),

  ('whatsapp', '{
     "graph_base_url": "https://graph.facebook.com",
     "graph_version": "v26.0",
     "phone_number_id": null,
     "template_language": "en"
   }'),

  -- Claude model that reads payment screenshots. (The chat agent's model is set on the
  -- "Claude" node in the "Flow · AI agent" workflow.)
  ('ai', '{
     "vision_model": "claude-opus-5",
     "anthropic_base_url": "https://api.anthropic.com"
   }'),

  ('catalog_url', '"https://whatsapp-storefront-psi.vercel.app/api/catalog"'),

  -- Facts the assistant may state. Anything left null, it will not guess: it says it will check
  -- with the team instead. Fill these in with the client.
  ('business', '{
     "hours": null,
     "delivery_areas": null,
     "delivery_fee": null,
     "delivery_time": null,
     "storage": null,
     "shelf_life": null,
     "pickup": null,
     "extra_faq": []
   }'),

  ('retention', '{"screenshot_days": 30, "message_days": 180, "expire_unpaid_hours": 48, "reminder_after_hours": 3}'),

  -- Optional: a Slack/Discord-compatible webhook for technical alerts to the developer.
  ('alerts', '{"webhook_url": null}')
on conflict (key) do nothing;

-- Fallback catalog (mirrors Whatsapp-storefront lib/site-config.ts) until /api/catalog is live.
-- The hourly housekeeping run replaces it with the live one.
insert into crm.settings (key, value) values ('catalog', '{
  "brand": {"name": "Mash & Sip Co.", "currency": "GHS"},
  "variants": [
    {"id": "original", "name": "Original", "ingredients": "Kenkey (fermented maize), milk, sugar",
     "copy": "The one Accra grew up on. Kenkey mashed smooth with milk and sugar — cold, creamy and just a little tangy."},
    {"id": "vanilla", "name": "Vanilla", "ingredients": "Kenkey, milk, vanilla, sugar",
     "copy": "Classic mashkey, softened with vanilla. Mellow, sweet and quietly indulgent."},
    {"id": "cinnamon", "name": "Cinnamon", "ingredients": "Kenkey, milk, cinnamon, sugar",
     "copy": "Ice-cold mashkey with a warm finish. Cinnamon gives every sip a gentle, lingering spice."},
    {"id": "peanut-butter", "name": "Peanut Butter", "ingredients": "Kenkey, milk, groundnut paste, sugar",
     "copy": "Mashkey meets roasted groundnut paste. Thick, nutty and filling enough to call it lunch."}
  ],
  "sizes": [
    {"label": "150ml", "price": 25, "note": "A little treat"},
    {"label": "250ml", "price": 40, "note": "The everyday sip"},
    {"label": "500ml", "price": 70, "note": "Made for sharing"}
  ],
  "maxQty": 24,
  "source": "seed"
}') on conflict (key) do nothing;
