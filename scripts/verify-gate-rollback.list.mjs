/**
 * The bare `ROLLBACK` each gate script (under `packages/db/scripts/` or `apps/web/scripts/`) may send to `query(` (`verify-gate-rollback.mjs`). Each entry was in the tree
 * before the rule and keeps its exact count, so the list only goes down: a file that moves to `rollbackAndRelease`
 * or `rollbackQuietly` (`packages/db/scripts/gate-roles.ts`) lowers or drops its entry in the same change. A new
 * entry says why a failed ROLLBACK must fail the gate.
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste arquivo, troque o ROLLBACK solto por rollbackAndRelease ou rollbackQuietly";

export const GATE_ROLLBACK_LIST = {
  "apps/web/scripts/organization-purge-automatic-checks.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/scripts/verify-access-log-login-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/scripts/verify-activation-sweep-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/scripts/verify-organization-purge-gate.ts": {
    count: 9,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/scripts/verify-password-hash-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/billing-current-charge-reconcile.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/bootstrap-rls-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/closed-export-policy-qual.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/concurrency-support.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/measure-period-summary.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/measure-plan-read.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/prepare-tenant-context-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/rls-gate-fixture.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/sales-gate-support.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/tenant-entry-gate-checks.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-access-log-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-account-key-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-activation-candidates-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-activation-funnel-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-activation-returns-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-admin-support-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-audit-retention-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-auth-tables-row-security-gate.ts": {
    count: 5,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-billing-notices-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-billing-self-service-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-billing-trial-claims-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-catalog-size-ceilings-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-closed-organization-readonly-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-customers-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-dead-letter-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-definer-hardening-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-definer-owners-gate.ts": {
    count: 4,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-gate2-runtime.ts": {
    count: 16,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-inventory-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-legal-acceptance-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-login-lock-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-media-derivatives-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-media-gate.ts": {
    count: 4,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-media-upload-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-migrations-without-superuser-gate.ts": {
    count: 6,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-organization-closure-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-outbox-dispatcher-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-period-summary-sql-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-product-cover-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-renewal-cancellation-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-review-hardening-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-rls-forced-catalog-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-rls-gate.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-tenant-context-gate.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/db/scripts/verify-unverified-user-purge-gate.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
};
