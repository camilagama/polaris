-- Review round (Gate 4 checkpoint): ledger integrity, tombstone compensation,
-- column-level grants, size/rate limits and function hardening.
--
-- Constraints, functions, triggers and grants below are SQL-only: drizzle-kit
-- does not track them, so the Drizzle schema only mirrors the new column.

-- 1. Ledger order. `created_at` is the transaction start, so a transaction that
--    waited for the product lock can carry an earlier created_at than a movement
--    that committed before it. variant_sequence follows confirmation order: a
--    BEFORE INSERT trigger numbers each variant's movements 1, 2, 3... while the
--    caller holds the balance row lock; the unique index turns any unserialized
--    writer into an error instead of a silently wrong order.
ALTER TABLE "stock_movements" ADD COLUMN "variant_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE public.stock_movements DISABLE TRIGGER stock_movements_append_only;--> statement-breakpoint
ALTER TABLE public.stock_movements NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.stock_movements AS movement
SET variant_sequence = ordered.sequence
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY organization_id, variant_id ORDER BY created_at, id
         ) AS sequence
  FROM public.stock_movements
) AS ordered
WHERE ordered.id = movement.id;--> statement-breakpoint
ALTER TABLE public.stock_movements FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stock_movements ENABLE TRIGGER stock_movements_append_only;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_variant_sequence_unique" ON "stock_movements" USING btree ("organization_id","variant_id","variant_sequence");--> statement-breakpoint
CREATE FUNCTION public.assign_stock_movement_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  SELECT COALESCE(max(movement.variant_sequence), 0) + 1
  INTO NEW.variant_sequence
  FROM public.stock_movements AS movement
  WHERE movement.organization_id = NEW.organization_id
    AND movement.variant_id = NEW.variant_id;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assign_stock_movement_sequence() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER stock_movements_assign_sequence
BEFORE INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.assign_stock_movement_sequence();--> statement-breakpoint

-- 2. The balance is a projection of the ledger: at commit, every variant touched
--    by a movement or by a balance write must satisfy quantity = sum(deltas).
--    The runtime still has UPDATE(quantity, ...), so this is what makes
--    "no direct balance mutation" a database guarantee instead of a convention.
CREATE FUNCTION public.check_inventory_balance_matches_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_balance integer;
  v_ledger bigint;
BEGIN
  SELECT balance.quantity INTO v_balance
  FROM public.inventory_balances AS balance
  WHERE balance.organization_id = NEW.organization_id
    AND balance.variant_id = NEW.variant_id;

  SELECT COALESCE(sum(movement.quantity_delta), 0) INTO v_ledger
  FROM public.stock_movements AS movement
  WHERE movement.organization_id = NEW.organization_id
    AND movement.variant_id = NEW.variant_id;

  IF COALESCE(v_balance, 0) <> v_ledger THEN
    RAISE EXCEPTION 'inventory balance must equal the sum of its ledger movements'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_balance_matches_ledger';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.check_inventory_balance_matches_ledger() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventory_balances_match_ledger
AFTER INSERT OR UPDATE ON public.inventory_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_inventory_balance_matches_ledger();--> statement-breakpoint
-- Named to sort after the sale_* completeness triggers, so those report first.
CREATE CONSTRAINT TRIGGER stock_movements_sync_with_balance
AFTER INSERT ON public.stock_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_inventory_balance_matches_ledger();--> statement-breakpoint

-- 3. Cancelling a sale whose product was removed afterwards. A removed product
--    has frozen, zero stock, so its items take no units back: the cancellation
--    is recorded without a movement for them. Every other item must still be
--    inverted by exactly one movement.
CREATE OR REPLACE FUNCTION public.check_sale_cancellation_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_cancellation_id uuid;
  v_cancellation_command uuid;
  v_sale_id uuid;
  v_sale_command uuid;
  v_expected integer;
  v_movements integer;
BEGIN
  IF TG_TABLE_NAME = 'stock_movements' THEN
    IF NEW.command_id IS NULL THEN
      RAISE EXCEPTION 'cancellation stock movement requires its cancellation command'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_cancellation_requires_cancellation';
    END IF;
    SELECT cancellation.id, cancellation.command_id, cancellation.sale_id
    INTO v_cancellation_id, v_cancellation_command, v_sale_id
    FROM public.sale_cancellations AS cancellation
    WHERE cancellation.organization_id = NEW.organization_id
      AND cancellation.command_id = NEW.command_id;
    IF v_cancellation_id IS NULL THEN
      RAISE EXCEPTION 'cancellation stock movement has no sale cancellation'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_cancellation_requires_cancellation';
    END IF;
  ELSE
    v_cancellation_id := NEW.id;
    v_cancellation_command := NEW.command_id;
    v_sale_id := NEW.sale_id;
  END IF;

  -- Serialize with the application-level compensation lock (same key) so the
  -- checks below also hold for writers that skip the repository.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('polaris.sale.compensation:' || v_sale_id::text, 0)
  );

  SELECT sale.command_id INTO v_sale_command
  FROM public.sales AS sale
  WHERE sale.organization_id = NEW.organization_id
    AND sale.id = v_sale_id;
  IF NOT FOUND OR v_sale_command = v_cancellation_command THEN
    RAISE EXCEPTION 'cancellation needs its own command distinct from the sale command'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_command_distinct';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sale_returns AS sale_return
    WHERE sale_return.organization_id = NEW.organization_id
      AND sale_return.sale_id = v_sale_id
  ) THEN
    RAISE EXCEPTION 'a sale with returns cannot be cancelled as a whole'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_sale_has_no_returns';
  END IF;

  SELECT count(*) INTO v_expected
  FROM public.sale_items AS item
  WHERE item.organization_id = NEW.organization_id
    AND item.sale_id = v_sale_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.organization_id = item.organization_id
        AND product.id = item.product_id
        AND product.deleted_at IS NOT NULL
    );

  SELECT count(*) INTO v_movements
  FROM public.stock_movements AS movement
  WHERE movement.organization_id = NEW.organization_id
    AND movement.command_id = v_cancellation_command;
  IF v_movements <> v_expected OR EXISTS (
    SELECT 1
    FROM public.sale_items AS item
    WHERE item.organization_id = NEW.organization_id
      AND item.sale_id = v_sale_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.products AS product
        WHERE product.organization_id = item.organization_id
          AND product.id = item.product_id
          AND product.deleted_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.stock_movements AS movement
        WHERE movement.organization_id = item.organization_id
          AND movement.command_id = v_cancellation_command
          AND movement.command_index = item.position
          AND movement.movement_type = 'sale_cancellation'
          AND movement.product_id = item.product_id
          AND movement.variant_id = item.variant_id
          AND movement.quantity_delta = item.quantity
          AND movement.unit_cost IS NOT DISTINCT FROM item.unit_cost
      )
  ) THEN
    RAISE EXCEPTION 'sale cancellation stock movements must invert every sale item of a live product'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_stock_complete';
  END IF;

  RETURN NULL;
END;
$function$;--> statement-breakpoint

-- 4. Column-level UPDATE for the tenant runtime. Table-wide UPDATE also let it
--    rewrite id, version or created_at; the repositories only ever set these
--    columns. (organization_id was already pinned by the policies' WITH CHECK.)
REVOKE UPDATE ON TABLE public.products FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (name, description, category_id, archived_at, deleted_at, updated_at, version, variants_configured_at)
  ON TABLE public.products TO polaris_pr11_runtime;--> statement-breakpoint
REVOKE UPDATE ON TABLE public.categories FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (name, archived_at, deleted_at, updated_at)
  ON TABLE public.categories TO polaris_pr11_runtime;--> statement-breakpoint
REVOKE UPDATE ON TABLE public.customers FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (name, phone, email, notes, archived_at, updated_at, version)
  ON TABLE public.customers TO polaris_pr11_runtime;--> statement-breakpoint
REVOKE UPDATE ON TABLE public.payment_profiles FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (name, archived_at, updated_at, version)
  ON TABLE public.payment_profiles TO polaris_pr11_runtime;--> statement-breakpoint
REVOKE UPDATE ON TABLE public.payment_profile_rules FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (archived_at, updated_at)
  ON TABLE public.payment_profile_rules TO polaris_pr11_runtime;--> statement-breakpoint

-- 5. Size and range limits at the database, matching the domain and contract.
ALTER TABLE public.customers ADD CONSTRAINT customers_text_limits CHECK (
  char_length(name) <= 200
  AND (phone IS NULL OR char_length(phone) <= 40)
  AND (email IS NULL OR char_length(email) <= 254)
  AND (notes IS NULL OR char_length(notes) <= 2000)
);--> statement-breakpoint
ALTER TABLE public.products ADD CONSTRAINT products_text_limits CHECK (
  char_length(name) <= 200
  AND (description IS NULL OR char_length(description) <= 5000)
);--> statement-breakpoint
ALTER TABLE public.organizations ADD CONSTRAINT organizations_name_limit CHECK (
  char_length(name) <= 128
);--> statement-breakpoint
ALTER TABLE public.payment_profile_rules ADD CONSTRAINT payment_profile_rules_rate_and_days_limits CHECK (
  (processing_fee_percentage IS NULL OR processing_fee_percentage <= 100)
  AND (anticipation_fee_percentage IS NULL OR anticipation_fee_percentage <= 100)
  AND (expected_settlement_days IS NULL OR expected_settlement_days <= 3650)
);--> statement-breakpoint
ALTER TABLE public.sale_adjustments ADD CONSTRAINT sale_adjustments_rate_limit CHECK (
  percentage IS NULL OR percentage <= 100
);--> statement-breakpoint
ALTER TABLE public.sale_payments ADD CONSTRAINT sale_payments_rate_and_days_limits CHECK (
  (processing_fee_percentage_snapshot IS NULL OR processing_fee_percentage_snapshot <= 100)
  AND (anticipation_fee_percentage_snapshot IS NULL OR anticipation_fee_percentage_snapshot <= 100)
  AND (expected_settlement_days_snapshot IS NULL OR expected_settlement_days_snapshot <= 3650)
);--> statement-breakpoint

-- 6. A media asset's storage key must be the key its own upload command builds
--    (organization, command and fingerprint segments), so a bug cannot point one
--    tenant's asset at another tenant's object. NOT VALID keeps any legacy row;
--    every new row is checked.
ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_storage_key_matches_asset CHECK (
  storage_key ~ '^media/v2/[^/]+/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}/[0-9a-f-]{36}\.webp$'
  AND split_part(storage_key, '/', 3) = organization_id
  AND split_part(storage_key, '/', 5) = upload_command_id::text
  AND split_part(storage_key, '/', 6) = input_fingerprint
) NOT VALID;--> statement-breakpoint

-- 7. Hardening of the functions created before the later migrations fixed this:
--    a pinned search_path for every non-definer function in public, and no
--    EXECUTE for PUBLIC. (Trigger functions are not called directly; this only
--    removes the default grant.)
DO $hardening$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT proc.oid::regprocedure AS signature
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace_info ON namespace_info.oid = proc.pronamespace
    WHERE namespace_info.nspname = 'public'
      AND proc.prokind = 'f'
      AND NOT proc.prosecdef
      AND (
        proc.proconfig IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM unnest(proc.proconfig) AS setting WHERE setting LIKE 'search_path=%'
        )
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', v_function.signature);
  END LOOP;

  FOR v_function IN
    SELECT proc.oid::regprocedure AS signature
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace_info ON namespace_info.oid = proc.pronamespace
    WHERE namespace_info.nspname = 'public'
      AND proc.prokind = 'f'
      AND has_function_privilege('public', proc.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_function.signature);
  END LOOP;
END
$hardening$;
