-- Least-privilege access for n8n. Run as the schema owner (mashsip_admin) after every migration.
--
-- mashsip_bot (n8n's database credential) can call the API functions below and nothing else:
-- no table reads, no writes outside those functions, no DDL. If n8n were compromised, the
-- database would still only accept the operations the bot legitimately performs.

revoke all on all tables in schema crm from public;
revoke all on all sequences in schema crm from public;
revoke execute on all functions in schema crm from public;

grant usage on schema crm to mashsip_bot;

grant execute on function
  crm.get_settings(jsonb),
  crm.cache_catalog(jsonb),
  crm.config_problems(jsonb),
  crm.ingest_inbound(jsonb),
  crm.get_customer(jsonb),
  crm.get_owner(jsonb),
  crm.set_opt_out(jsonb),
  crm.log_outbound(jsonb),
  crm.apply_status(jsonb),
  crm.recent_transcript(jsonb),
  crm.pending_inbound(jsonb),
  crm.create_order(jsonb),
  crm.customer_orders(jsonb),
  crm.cancel_order(jsonb),
  crm.set_order_location(jsonb),
  crm.set_delivery_note(jsonb),
  crm.advance_order(jsonb),
  crm.payment_duplicates(jsonb),
  crm.record_payment(jsonb),
  crm.decide_payment(jsonb),
  crm.save_lead(jsonb),
  crm.open_escalation(jsonb),
  crm.dismiss_escalation(jsonb),
  crm.start_takeover(jsonb),
  crm.touch_takeover(jsonb),
  crm.end_takeover(jsonb),
  crm.log_event(jsonb),
  crm.orders_due_for_reminder(jsonb),
  crm.mark_reminded(jsonb),
  crm.housekeeping(jsonb)
to mashsip_bot;
