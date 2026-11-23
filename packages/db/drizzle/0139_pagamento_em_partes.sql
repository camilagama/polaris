-- A sale paid in parts (ADR 0107): from one to three parts of a sale, in the order the merchant typed them (position 0
-- to 2), that add up exactly to the total due. Expand only (ADR 0096): the Worker of the previous version writes one
-- payment without a position and a header without a count, and the defaults (position 0, one part) keep what it writes
-- valid; the rows already written take the same defaults, with no backfill. The unique index on the position takes the
-- place of the one-payment index, so a second payment written the old way (at position 0) is still refused.
--
-- The confirmation trigger keeps its checks of items, adjustments and stock as they were; only the payment check
-- changes: the rows of the sale are as many as the header declares, their positions run from 0 with no gap, their sum is
-- the total due in exact numeric, and with more than one part each part is above zero (a sale of total zero keeps one
-- part of zero). Every refusal keeps the constraint name `sales_confirmation_payment_complete`.
--
-- A data export holds every column of these tables, so the reader of a closed organization's export gets SELECT on the
-- two new columns, column by column, as every exported column has (migration 0085).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "position" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_position_allowed" CHECK ("sale_payments"."position" BETWEEN 0 AND 2);--> statement-breakpoint
CREATE UNIQUE INDEX "sale_payments_organization_sale_position_unique" ON "sale_payments" USING btree ("organization_id","sale_id","position");--> statement-breakpoint
DROP INDEX "sale_payments_organization_sale_unique";--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "payment_count" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_payment_count_allowed" CHECK ("sales"."payment_count" BETWEEN 1 AND 3);--> statement-breakpoint
GRANT SELECT (position) ON TABLE public.sale_payments TO polaris_closed_export_reader;--> statement-breakpoint
GRANT SELECT (payment_count) ON TABLE public.sales TO polaris_closed_export_reader;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.check_sale_confirmation_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sale_id uuid;
  v_command_id uuid;
  v_occurred_on date;
  v_item_count integer;
  v_adjustment_count integer;
  v_items integer;
  v_items_max_position integer;
  v_subtotal numeric;
  v_adjustments integer;
  v_adjustments_max_position integer;
  v_discounts numeric;
  v_additions numeric;
  v_payment_count integer;
  v_payments integer;
  v_payments_max_position integer;
  v_payments_total numeric;
  v_payments_not_positive integer;
  v_movements integer;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    v_sale_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'stock_movements' THEN
    IF NEW.command_id IS NULL THEN
      RAISE EXCEPTION 'sale stock movement requires its sale command'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_requires_confirmed_sale';
    END IF;
    SELECT sale.id INTO v_sale_id
    FROM public.sales AS sale
    WHERE sale.organization_id = NEW.organization_id
      AND sale.command_id = NEW.command_id;
    IF v_sale_id IS NULL THEN
      RAISE EXCEPTION 'sale stock movement has no confirmed sale'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_requires_confirmed_sale';
    END IF;
  ELSE
    v_sale_id := NEW.sale_id;
  END IF;

  SELECT sale.command_id, sale.item_count, sale.adjustment_count, sale.occurred_on, sale.payment_count
  INTO v_command_id, v_item_count, v_adjustment_count, v_occurred_on, v_payment_count
  FROM public.sales AS sale
  WHERE sale.organization_id = NEW.organization_id
    AND sale.id = v_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmed sale header is missing'
      USING ERRCODE = '23514', CONSTRAINT = 'sales_confirmation_complete';
  END IF;

  SELECT count(*), max(item.position), COALESCE(sum(item.charged_unit_price * item.quantity), 0)
  INTO v_items, v_items_max_position, v_subtotal
  FROM public.sale_items AS item
  WHERE item.organization_id = NEW.organization_id
    AND item.sale_id = v_sale_id;
  IF v_items <> v_item_count OR v_items_max_position <> v_item_count - 1 THEN
    RAISE EXCEPTION 'confirmed sale items do not match the header'
      USING ERRCODE = '23514', CONSTRAINT = 'sales_confirmation_items_complete';
  END IF;

  SELECT
    count(*),
    max(adjustment.position),
    COALESCE(sum(adjustment.amount) FILTER (WHERE adjustment.kind = 'discount'), 0),
    COALESCE(sum(adjustment.amount) FILTER (WHERE adjustment.kind <> 'discount'), 0)
  INTO v_adjustments, v_adjustments_max_position, v_discounts, v_additions
  FROM public.sale_adjustments AS adjustment
  WHERE adjustment.organization_id = NEW.organization_id
    AND adjustment.sale_id = v_sale_id;
  IF v_adjustments <> v_adjustment_count
    OR (v_adjustments > 0 AND v_adjustments_max_position <> v_adjustment_count - 1) THEN
    RAISE EXCEPTION 'confirmed sale adjustments do not match the header'
      USING ERRCODE = '23514', CONSTRAINT = 'sales_confirmation_adjustments_complete';
  END IF;

  SELECT
    count(*),
    max(payment.position),
    COALESCE(sum(payment.amount), 0),
    count(*) FILTER (WHERE payment.amount <= 0)
  INTO v_payments, v_payments_max_position, v_payments_total, v_payments_not_positive
  FROM public.sale_payments AS payment
  WHERE payment.organization_id = NEW.organization_id
    AND payment.sale_id = v_sale_id;
  IF v_payments <> v_payment_count
    OR v_payments_max_position <> v_payment_count - 1
    OR v_payments_total <> v_subtotal - v_discounts + v_additions
    OR (v_payment_count > 1 AND v_payments_not_positive > 0) THEN
    RAISE EXCEPTION 'confirmed sale needs its declared payment parts adding up to the total due'
      USING ERRCODE = '23514', CONSTRAINT = 'sales_confirmation_payment_complete';
  END IF;

  SELECT count(*) INTO v_movements
  FROM public.stock_movements AS movement
  WHERE movement.organization_id = NEW.organization_id
    AND movement.command_id = v_command_id;
  IF v_movements <> v_item_count OR EXISTS (
    SELECT 1
    FROM public.sale_items AS item
    WHERE item.organization_id = NEW.organization_id
      AND item.sale_id = v_sale_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.stock_movements AS movement
        WHERE movement.organization_id = item.organization_id
          AND movement.command_id = v_command_id
          AND movement.command_index = item.position
          AND movement.movement_type = 'sale'
          AND movement.occurred_on = v_occurred_on
          AND movement.product_id = item.product_id
          AND movement.variant_id = item.variant_id
          AND movement.quantity_delta = -item.quantity
          AND movement.unit_cost IS NOT DISTINCT FROM item.unit_cost
      )
  ) THEN
    RAISE EXCEPTION 'confirmed sale stock movements do not match its items'
      USING ERRCODE = '23514', CONSTRAINT = 'sales_confirmation_stock_complete';
  END IF;

  RETURN NULL;
END;
$function$;--> statement-breakpoint
RESET lock_timeout;
