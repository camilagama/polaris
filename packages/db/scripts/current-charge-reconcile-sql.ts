/**
 * The charge of the period in force recomputed from the ledger (ADR 0104, §7), by the rule of `currentChargeAfter`.
 * Only applied `charge_succeeded` facts of the record's own link (provider and reference) count. The period goes
 * through the ISO instant check of `readOwnerCommandRecord` and `pg_input_is_valid` before it is cast, so a text that
 * is not an instant (even one shaped like it, "2026-02-31T…") counts as no period and never aborts the migration; the
 * order is by the instant, never by the text. The latest period is the cluster of facts within 24 hours of the
 * latest end (`samePeriod`): its first received fact gives the event and the period, as the first one processed
 * does, and its first amount fills the amount. An amount is the fact's (BRL, two places, positive), else the first
 * charge's when that fact is the first charge (the price the checkout sent, as `recordFirstCharge`), else null. A
 * stored charge of the link's own ledger in that period keeps its event and only gets a missing amount; one later
 * than it is kept whole; anything else (older, of an old link, or a link with no charge) is replaced or cleared.
 * Only a row that changes is written, so running it again writes nothing. Migration 0118 runs this same statement;
 * `current-charge-reconcile-sql.test.ts` holds the two together.
 */
export const CURRENT_CHARGE_RECONCILE_SQL = `WITH charges AS (
  SELECT billing.organization_id, charge.id AS event_id, charge.received_at,
         CASE
           WHEN (charge.fact ->> 'periodEndsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                AND pg_catalog.pg_input_is_valid(charge.fact ->> 'periodEndsAt', 'timestamptz')
           THEN (charge.fact ->> 'periodEndsAt')::timestamptz
         END AS period_ends_at,
         CASE
           WHEN charge.fact ->> 'currency' = 'BRL' AND (charge.fact ->> 'amount') ~ '^[0-9]{1,12}[.][0-9]{2}$'
                AND (charge.fact ->> 'amount') !~ '^0+[.]00$'
           THEN (charge.fact ->> 'amount')::numeric
           WHEN charge.id = billing.first_charge_event_id THEN billing.first_charge_amount
         END AS amount
    FROM public.organization_billing AS billing
    JOIN public.billing_events AS charge
      ON charge.organization_id = billing.organization_id
     AND charge.provider = billing.provider
     AND charge.provider_ref = billing.provider_ref
   WHERE billing.provider IS NOT NULL
     AND billing.provider_ref IS NOT NULL
     AND charge.status = 'applied'
     AND charge.fact_type = 'charge_succeeded'
),
latest_period AS (
  SELECT charges.organization_id, max(charges.period_ends_at) AS period_ends_at
    FROM charges
   WHERE charges.period_ends_at IS NOT NULL
   GROUP BY charges.organization_id
),
cluster AS (
  SELECT charges.*
    FROM charges
    JOIN latest_period ON latest_period.organization_id = charges.organization_id
   WHERE charges.period_ends_at >= latest_period.period_ends_at - interval '24 hours'
),
latest AS (
  SELECT DISTINCT ON (head.organization_id)
         head.organization_id, head.event_id, head.period_ends_at,
         (SELECT priced.amount FROM cluster AS priced
           WHERE priced.organization_id = head.organization_id AND priced.amount IS NOT NULL
           ORDER BY priced.received_at, priced.event_id LIMIT 1) AS amount
    FROM cluster AS head
   ORDER BY head.organization_id, head.received_at, head.event_id
),
decided AS (
  SELECT billing.organization_id,
         CASE WHEN latest.organization_id IS NULL THEN NULL
              WHEN stored.later THEN billing.current_charge_amount
              WHEN stored.same THEN COALESCE(billing.current_charge_amount, latest.amount)
              ELSE latest.amount END AS amount,
         CASE WHEN latest.organization_id IS NULL THEN NULL
              WHEN stored.later OR stored.same THEN billing.current_charge_period_ends_at
              ELSE latest.period_ends_at END AS period_ends_at,
         CASE WHEN latest.organization_id IS NULL THEN NULL
              WHEN stored.later OR stored.same THEN billing.current_charge_event_id
              ELSE latest.event_id END AS event_id
    FROM public.organization_billing AS billing
    LEFT JOIN latest ON latest.organization_id = billing.organization_id
   CROSS JOIN LATERAL (
     SELECT own.own AND billing.current_charge_period_ends_at > latest.period_ends_at + interval '24 hours' AS later,
            own.own AND billing.current_charge_period_ends_at BETWEEN latest.period_ends_at - interval '24 hours'
                                                                  AND latest.period_ends_at + interval '24 hours' AS same
       FROM (SELECT EXISTS (
               SELECT 1 FROM public.billing_events AS stored_charge
                WHERE stored_charge.id = billing.current_charge_event_id
                  AND stored_charge.organization_id = billing.organization_id
                  AND stored_charge.provider = billing.provider
                  AND stored_charge.provider_ref = billing.provider_ref
                  AND stored_charge.status = 'applied'
                  AND stored_charge.fact_type = 'charge_succeeded'
             ) AS own) AS own
   ) AS stored
   WHERE latest.organization_id IS NOT NULL
      OR billing.current_charge_period_ends_at IS NOT NULL
      OR billing.current_charge_event_id IS NOT NULL
      OR billing.current_charge_amount IS NOT NULL
)
UPDATE public.organization_billing AS billing
   SET current_charge_amount = decided.amount,
       current_charge_period_ends_at = decided.period_ends_at,
       current_charge_event_id = decided.event_id
  FROM decided
 WHERE billing.organization_id = decided.organization_id
   AND (billing.current_charge_amount, billing.current_charge_period_ends_at, billing.current_charge_event_id)
       IS DISTINCT FROM (decided.amount, decided.period_ends_at, decided.event_id)`;
