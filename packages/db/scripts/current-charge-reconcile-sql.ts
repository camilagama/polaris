/**
 * The charge of the period in force recomputed from the ledger (ADR 0104, §7), for every record with a link: the
 * applied `charge_succeeded` of the same store and the same link (provider and reference) whose `periodEndsAt` is the
 * latest. The period goes through the ISO instant check of `readOwnerCommandRecord` and `pg_input_is_valid` before
 * it is cast, so a text that is not an instant (even one shaped like it, "2026-02-31T…") counts as no period and never
 * aborts the migration; the order is by the instant, never by the text. The amount is the fact's (`amount`, BRL, two
 * places, positive), else the first charge's when that fact is the first charge (the price the checkout sent, as
 * `recordFirstCharge`), else null: never the catalog's price. Of two facts with the same latest period, the one with
 * an amount wins. Then the rule of `currentChargeAfter`: a stored charge of the same period (within the day of
 * `samePeriod`) or a later one keeps its event and period and only gets a missing amount; an older one is replaced.
 * Only a row that changes is written, so running it again writes nothing. Migration 0118 runs this
 * same statement; `current-charge-reconcile-sql.test.ts` holds the two together.
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
latest AS (
  SELECT DISTINCT ON (charges.organization_id)
         charges.organization_id, charges.event_id, charges.period_ends_at, charges.amount
    FROM charges
   WHERE charges.period_ends_at IS NOT NULL
   ORDER BY charges.organization_id, charges.period_ends_at DESC, charges.amount IS NULL, charges.received_at, charges.event_id
),
decided AS (
  SELECT latest.organization_id,
         CASE WHEN kept.kept THEN COALESCE(billing.current_charge_amount, latest.amount) ELSE latest.amount END AS amount,
         CASE WHEN kept.kept THEN billing.current_charge_period_ends_at ELSE latest.period_ends_at END AS period_ends_at,
         CASE WHEN kept.kept THEN billing.current_charge_event_id ELSE latest.event_id END AS event_id
    FROM latest
    JOIN public.organization_billing AS billing ON billing.organization_id = latest.organization_id
   CROSS JOIN LATERAL (
     SELECT billing.current_charge_event_id IS NOT NULL
            AND billing.current_charge_period_ends_at >= latest.period_ends_at - interval '1 day' AS kept
   ) AS kept
)
UPDATE public.organization_billing AS billing
   SET current_charge_amount = decided.amount,
       current_charge_period_ends_at = decided.period_ends_at,
       current_charge_event_id = decided.event_id
  FROM decided
 WHERE billing.organization_id = decided.organization_id
   AND (billing.current_charge_amount, billing.current_charge_period_ends_at, billing.current_charge_event_id)
       IS DISTINCT FROM (decided.amount, decided.period_ends_at, decided.event_id)`;
