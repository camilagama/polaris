import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import { harnessHyperdrives } from "../../scripts/workerd-harness.mjs";

/**
 * The Catalog Worker's server side, real, inside workerd, against the PostgreSQL of the `database` job (T-121b).
 * Started only by the `catalog-worker` gate (vitest.catalog-worker.config.ts at the root), which makes the login of
 * the public catalog role and the fixtures and hands them over through the environment; started alone it stops.
 * The wrangler file of the app is read as it is (its Hyperdrive and its bucket); the origin variable it leaves to each environment is given here, and only the
 * connection string is replaced, through the host guard.
 */
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: this project runs only through the catalog-worker gate (bun run --filter @polaris/db gates:ci catalog-worker).`
    );
  }
  return value;
}

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          CATALOG_ORIGIN: "https://catalogo.test",
          TEST_CATALOG_FIXTURE: requiredEnvironment(
            "POLARIS_CATALOG_WORKER_FIXTURE"
          ),
        },
        // every connection goes through the host guard: loopback or the job's service, and only with CI=true
        hyperdrives: harnessHyperdrives({
          CATALOG_HYPERDRIVE: requiredEnvironment(
            "POLARIS_CATALOG_WORKER_CATALOG_HYPERDRIVE_URL"
          ),
        }),
        // the Worker has no network in the harness
        outboundService: () =>
          new Response("no network in the harness", { status: 502 }),
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // each read opens its own connection (SCRAM) through the local Hyperdrive
    hookTimeout: 60_000,
    include: ["src/**/*.workerd-db.test.ts"],
    name: "catalog-workerd-db",
    silent: "passed-only",
    testTimeout: 60_000,
  },
});
