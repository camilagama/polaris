// Types for the Workers harness with a database (`*.workerd-db.test.ts`): what `cloudflare:workers` exposes in a test.
// The bindings of the Worker itself are in env.d.ts.
// biome-ignore lint/style/noNamespace: the Workers types are extended by merging into the global Cloudflare namespace
declare namespace Cloudflare {
  interface Env {
    /** Test only: what the gate made (the login, a store that is shown and one that is not). */
    TEST_CATALOG_FIXTURE: string;
  }
  interface Exports {
    default: Fetcher;
  }
}
