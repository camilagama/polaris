-- The outbox of the activation series (ADR 0106): the billing runtime records the event of a tip's notice in the
-- transaction that records the notice. Expand only (ADR 0096): one new policy; nothing is dropped, altered or recreated,
-- the five INSERT columns the runtime has on `event_outbox` (0101) are enough, and the policy of `billing.notice` is
-- untouched. As that one: only this type, only pending and untouched, the body with the notice's ID and nothing else,
-- the key the body names, and a notice of the same store, found by its primary key (a malformed ID is a refusal).
-- The policy takes a lock on the table: a lock not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE POLICY event_outbox_billing_runtime_insert_activation_notice ON public.event_outbox
  AS PERMISSIVE FOR INSERT TO polaris_billing_runtime
  WITH CHECK (type = 'activation.notice' AND status = 'pending' AND attempts = 0
    AND (event - 'noticeId') = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(event -> 'noticeId') = 'string'
    AND idempotency_key = type || ':' || (event ->> 'noticeId')
    AND EXISTS (SELECT 1 FROM public.activation_notices AS n
                 WHERE n.id = (CASE WHEN event_outbox.event ->> 'noticeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN (event_outbox.event ->> 'noticeId')::uuid END)
                   AND n.organization_id = event_outbox.organization_id));--> statement-breakpoint
RESET lock_timeout;
