// Types for the Workers harness with a database (`*.workerd-db.test.ts`): what only the gate's Vitest config adds.
// biome-ignore lint/style/noNamespace: the Workers types are extended by merging into the global Cloudflare namespace
declare namespace Cloudflare {
  interface Env {
    /** Test only (the billing role's login), for the billing commands. */
    ADMIN_BILLING_HYPERDRIVE?: Hyperdrive;
    /** Test only: what the gate made in the database (JSON): the principals' subjects, the organizations, the customers. */
    TEST_FIXTURE?: string;
  }
}
