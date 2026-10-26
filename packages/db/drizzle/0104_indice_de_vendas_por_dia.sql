-- Index for the daily sales series and the period summary (t393; Filipe's review of the daily series). Both read
-- `sales` by organization and a range of `occurred_on`; with only `sales_organization_confirmed_idx` the planner scans
-- every sale of the organization and filters the dates afterwards, so the cost grew with the store's whole history.
-- Expand only (ADR 0096): one new index; no column, constraint or function is changed, and the previous Worker neither
-- needs nor notices it.
-- CREATE INDEX holds a SHARE lock (reads go on, writes to `sales` wait) while it builds. The table is small before
-- go-live, so the build is brief; the lock_timeout makes the migration fail, instead of queueing every sale behind it,
-- if the lock is not had in 10 s.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE INDEX "sales_organization_occurred_on_idx" ON "sales" USING btree ("organization_id","occurred_on");--> statement-breakpoint
RESET lock_timeout;
