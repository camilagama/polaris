-- Size ceilings in code points, the same numbers as MAX_PRODUCT_OPTION_VALUE_LENGTH (80) and MAX_PRODUCT_VARIANT_SKU_LENGTH (64)
-- in the domain: char_length counts characters, not bytes or UTF-16 units, like the domain's code point count.
-- Expand only (ADR 0096): two CHECKs, each added NOT VALID and validated right after. The migrator runs every pending
-- migration in one transaction, so the ACCESS EXCLUSIVE lock of ADD CONSTRAINT is held until the commit and the VALIDATE
-- scan runs under it: reads and writes of the two tables wait for the whole db:migrate. The tables are small before the
-- go-live; later, a person counts the rows above the ceilings first. The domain and the contract already refuse longer
-- values; a Worker older than that would now get a check violation instead of storing one, and none is in production.
-- A legacy row above a ceiling fails the VALIDATE and rolls the whole migration back: shortening a seller's SKU or option
-- value is a decision for a person, never for a migration. A NULL sku stays accepted (the column is nullable).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_name_max_length" CHECK (char_length("product_option_values"."name") <= 80) NOT VALID;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sku_max_length" CHECK ("product_variants"."sku" IS NULL OR char_length("product_variants"."sku") <= 64) NOT VALID;--> statement-breakpoint
ALTER TABLE "product_option_values" VALIDATE CONSTRAINT "product_option_values_name_max_length";--> statement-breakpoint
ALTER TABLE "product_variants" VALIDATE CONSTRAINT "product_variants_sku_max_length";--> statement-breakpoint
RESET lock_timeout;
