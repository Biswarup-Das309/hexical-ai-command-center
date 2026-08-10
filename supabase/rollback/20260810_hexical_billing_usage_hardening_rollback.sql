-- Billing rollback. Run only after disabling payment checkout/webhook traffic.
-- The default is non-destructive: functions are removed, audit/payment data
-- is retained for investigation. Drop statements are intentionally commented.

drop function if exists public.process_payment_webhook(text, text, text, text, bigint, integer);
drop function if exists public.increment_usage(text, integer, numeric);
drop function if exists public.release_reservation(uuid);
drop function if exists public.reserve_budget(text, text, numeric);

-- To remove the tables after exporting them, run manually and individually:
-- drop table public.hexical_payment_events;
-- drop table public.user_usage_logs;
-- drop table public.hexical_budget_reservations;
-- drop table public.hexical_usage_counters;
-- drop table public.hexical_ai_budget_config;

