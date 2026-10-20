// Types for the Workers harness (`*.workerd.test.ts`): what `cloudflare:workers` exposes in a test.
// biome-ignore lint/style/noNamespace: the Workers types are extended by merging into the global Cloudflare namespace
declare namespace Cloudflare {
  interface Env {
    ACCESS_AUDIENCE: string;
    ACCESS_TEAM_DOMAIN: string;
    ADMIN_HYPERDRIVE: Hyperdrive;
    /** Test only: a team whose key endpoint answers 500. */
    TEST_ACCESS_DOWN_TEAM_DOMAIN: string;
    TEST_ACCESS_KEY_ID: string;
    /** Test only: signs the simulated Access tokens; never in a wrangler file. */
    TEST_ACCESS_PRIVATE_JWK: string;
  }
  interface Exports {
    default: Fetcher;
  }
}
