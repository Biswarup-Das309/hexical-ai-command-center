-- Idempotent repair for the additive Runtime OS migration. It preserves all
-- source ledgers and repairs only canonical projections / stale runtime rows.
begin;

update public.hexical_entitlements
set status = 'expired', updated_at = now()
where status in ('active', 'trialing', 'grace')
  and enterprise_unlimited is false
  and current_period_end is not null
  and current_period_end < now();

update public.hexical_runtime_execution_ledger
set state = 'expired', finished_at = coalesce(finished_at, now()),
    diagnostics = diagnostics || jsonb_build_object('repair_reason', 'stale_runtime_record'), updated_at = now()
where state in ('leased', 'starting', 'running', 'streaming')
  and updated_at < now() - interval '1 hour';

commit;
