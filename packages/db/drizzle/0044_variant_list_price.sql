ALTER TABLE "product_variants" ADD COLUMN "list_price" numeric;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_list_price_allowed" CHECK (
        "product_variants"."list_price" IS NULL OR (
          "product_variants"."list_price" >= 0
          AND scale("product_variants"."list_price") <= 2
          AND "product_variants"."list_price" < 1000000000000000000
        )
      );
--> statement-breakpoint
GRANT UPDATE (list_price) ON TABLE public.product_variants TO polaris_pr11_runtime;
