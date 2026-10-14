ALTER TABLE "sales" RENAME COLUMN "client_created_at" TO "recorded_at";--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "occurred_on" date;--> statement-breakpoint
ALTER TABLE public.sales NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.sales AS sale
SET occurred_on = ((sale.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE organization.timezone)::date
FROM public.organizations AS organization
WHERE organization.id = sale.organization_id;--> statement-breakpoint
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "occurred_on" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "confirmed_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
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
  v_payments integer;
  v_payment_amount numeric;
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

  SELECT sale.command_id, sale.item_count, sale.adjustment_count, sale.occurred_on
  INTO v_command_id, v_item_count, v_adjustment_count, v_occurred_on
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

  SELECT count(*), max(payment.amount)
  INTO v_payments, v_payment_amount
  FROM public.sale_payments AS payment
  WHERE payment.organization_id = NEW.organization_id
    AND payment.sale_id = v_sale_id;
  IF v_payments <> 1 OR v_payment_amount <> v_subtotal - v_discounts + v_additions THEN
    RAISE EXCEPTION 'confirmed sale needs one payment equal to the total due'
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
$function$;
