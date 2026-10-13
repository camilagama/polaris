ALTER TABLE "sales" ADD COLUMN "adjustment_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "client_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "item_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "occurred_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_item_count_positive" CHECK ("sales"."item_count" >= 1);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_adjustment_count_nonnegative" CHECK ("sales"."adjustment_count" >= 0);--> statement-breakpoint
CREATE POLICY "sale_adjustments_current_tenant_insert" ON "sale_adjustments" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sale_adjustments"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_adjustments"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_adjustments"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_items_current_tenant_insert" ON "sale_items" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sale_items"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_items"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_items"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_payments_current_tenant_insert" ON "sale_payments" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sale_payments"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_payments"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_payments"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sales_current_tenant_insert" ON "sales" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sales"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sales"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sales"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
CREATE FUNCTION public.check_sale_confirmation_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sale_id uuid;
  v_command_id uuid;
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

  SELECT sale.command_id, sale.item_count, sale.adjustment_count
  INTO v_command_id, v_item_count, v_adjustment_count
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
REVOKE ALL ON FUNCTION public.check_sale_confirmation_complete() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_confirmation_complete
AFTER INSERT ON public.sales
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_confirmation_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_items_confirmation_complete
AFTER INSERT ON public.sale_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_confirmation_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_adjustments_confirmation_complete
AFTER INSERT ON public.sale_adjustments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_confirmation_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_payments_confirmation_complete
AFTER INSERT ON public.sale_payments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_confirmation_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stock_movements_sale_requires_confirmed_sale
AFTER INSERT ON public.stock_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.movement_type = 'sale')
EXECUTE FUNCTION public.check_sale_confirmation_complete();--> statement-breakpoint
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sales, public.sale_items, public.sale_adjustments, public.sale_payments FROM PUBLIC, polaris_pr11_runtime;
GRANT SELECT, INSERT ON TABLE public.sales, public.sale_items, public.sale_adjustments, public.sale_payments TO polaris_pr11_runtime;
