CREATE TABLE "rls_poc_operations" (
	"organization_id" text NOT NULL,
	"token" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "rls_poc_operations_pk" PRIMARY KEY("organization_id","token")
);

ALTER TABLE "rls_poc_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rls_poc_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "rls_poc_operations_organization_isolation"
ON "rls_poc_operations"
FOR ALL
TO PUBLIC
USING (
	"organization_id" = current_setting('app.organization_id', true)
)
WITH CHECK (
	"organization_id" = current_setting('app.organization_id', true)
);

GRANT USAGE ON SCHEMA public TO polaris_pr11_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
ON "rls_poc_operations"
TO polaris_pr11_runtime;
