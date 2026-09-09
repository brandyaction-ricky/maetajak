alter table public.copy_events
  drop constraint if exists copy_events_event_type_check;

alter table public.copy_events
  add constraint copy_events_event_type_check check (
    event_type = any (array[
      'MASTER_POSITION_CHANGED'::text,
      'TARGET_POSITION_CALCULATED'::text,
      'DELTA_ORDER_PLANNED'::text,
      'ORDER_SUBMITTED'::text,
      'ORDER_FILLED'::text,
      'ORDER_UNKNOWN'::text,
      'POSITION_SYNCED'::text,
      'MANUAL_OVERRIDE_DETECTED'::text,
      'SYMBOL_PAUSED'::text,
      'RISK_REDUCE_ONLY'::text,
      'MEMBER_HALTED'::text,
      'SYSTEM_HALTED'::text,
      'OPEN_ORDERS_CANCELLED'::text,
      'OPEN_ORDER_CANCEL_FAILED'::text,
      'ERROR'::text
    ])
  );
