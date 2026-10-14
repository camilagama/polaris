DROP POLICY "sale_items_current_tenant_insert" ON "sale_items";--> statement-breakpoint
DROP POLICY "sales_current_tenant_insert" ON "sales";--> statement-breakpoint
REVOKE INSERT ON TABLE public.sales, public.sale_items FROM polaris_pr11_runtime;
