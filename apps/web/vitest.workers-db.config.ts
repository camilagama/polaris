import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import { harnessHyperdrives } from "../../scripts/workerd-harness.mjs";

/**
 * The Web Worker, real, inside workerd, against the PostgreSQL of the `database` job (T-121b). Started only by the
 * `web-worker` gate (vitest.web-worker.config.ts at the root), which makes one login per Hyperdrive binding and the
 * fixtures and hands them over through the environment; started alone it stops, so it never guesses a database.
 * The wrangler file of the app is read as it is: its bindings (the seven Hyperdrive, the queues, the bucket, the
 * rate limiters) are the ones deployed, and only the connection strings are replaced, through the host guard.
 * The platform's queue consumers of the wrangler file stay in the simulation (they cannot be left out without
 * editing that file), so the test sends nothing the platform could deliver to them: the messages the Worker
 * produces are recorded, not forwarded, and the probe of a real producer is delayed an hour. The test hands the
 * Worker its `queue` and `scheduled` events itself, so no message is processed behind its back, after the run,
 * against a database about to go.
 */
const BINDINGS = [
  "AUTH_HYPERDRIVE",
  "BILLING_HYPERDRIVE",
  "HYPERDRIVE",
  "MEDIA_CLEANUP_HYPERDRIVE",
  "ONBOARDING_HYPERDRIVE",
  "OUTBOX_HYPERDRIVE",
  "PRIVACY_HYPERDRIVE",
] as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: this project runs only through the web-worker gate (bun run --filter @polaris/db gates:ci web-worker).`
    );
  }
  return value;
}

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          TEST_WEB_FIXTURE: requiredEnvironment("POLARIS_WEB_WORKER_FIXTURE"),
        },
        // every connection goes through the host guard: loopback or the job's service, and only with CI=true
        hyperdrives: harnessHyperdrives(
          Object.fromEntries(
            BINDINGS.map((binding) => [
              binding,
              requiredEnvironment(`POLARIS_WEB_WORKER_${binding}_URL`),
            ])
          )
        ),
        // the Worker has no network in the harness: a call to a provider or to Cloudflare is a failure of the test
        outboundService: () =>
          new Response("no network in the harness", { status: 502 }),
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // each request and each job opens its own connections (SCRAM) through the local Hyperdrive
    hookTimeout: 60_000,
    include: ["worker/**/*.workerd-db.test.ts"],
    name: "web-workerd-db",
    // the Worker logs through its own logger and the pools it closes report an error each: only a failing test shows them
    silent: "passed-only",
    testTimeout: 60_000,
  },
});
