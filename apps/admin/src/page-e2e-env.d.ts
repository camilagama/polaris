// What `cloudflare:workers` gives the page's end-to-end test (page.workerd-db.test.ts), typed with the browser's
// library: the page under test is browser code, so this test is checked by tsconfig.page-e2e.json and not with the
// Workers types of the rest of src/ (the two libraries declare the same globals).
declare module "cloudflare:workers" {
  // the bindings of vitest.workers-db.config.ts the test reads: the simulated Access and the gate's fixture
  export const env: {
    ACCESS_AUDIENCE: string;
    ACCESS_TEAM_DOMAIN: string;
    TEST_ACCESS_KEY_ID: string;
    TEST_ACCESS_PRIVATE_JWK: string;
    TEST_FIXTURE?: string;
  };
  export const exports: {
    default: {
      fetch: (input: string, init?: RequestInit) => Promise<Response>;
    };
  };
}
