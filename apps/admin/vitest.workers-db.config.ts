import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import { harnessHyperdrives } from "../../scripts/workerd-harness.mjs";

/**
 * The Admin Worker, real, inside workerd, against the PostgreSQL of the `database` job (T-127a). Started only by
 * the `admin-worker` gate (vitest.admin-worker.config.ts at the root), which makes the database logins and the
 * fixtures and hands them over through the environment; started alone it stops, so it never guesses a database.
 * Cloudflare Access is simulated exactly as in vitest.workers.config.ts: a key pair made at start-up, nothing
 * stored, the public half served as the team's JWKS by `outboundService`, the private half given to the test only.
 * This file, like the other Vitest configs, is the only place the simulation is wired: the wrangler file of the
 * app is read as it is, and a test fails if the simulation shows up anywhere that could be deployed.
 */
const AUDIENCE = "a".repeat(64);
const KEY_ID = "test-key-1";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: this project runs only through the admin-worker gate (bun run --filter @polaris/db gates:ci admin-worker).`
    );
  }
  return value;
}

const fixture = requiredEnvironment("POLARIS_ADMIN_WORKER_FIXTURE");
// the gate wrote the principals under this team's issuer, so the team is its to name
const TEAM_DOMAIN = (JSON.parse(fixture) as { teamDomain: string }).teamDomain;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KEY_ID };

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ACCESS_AUDIENCE: AUDIENCE,
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          TEST_ACCESS_KEY_ID: KEY_ID,
          TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk),
          TEST_FIXTURE: fixture,
        },
        // every connection goes through the host guard: loopback or the job's service, and only with CI=true
        hyperdrives: harnessHyperdrives({
          ADMIN_BILLING_HYPERDRIVE: requiredEnvironment(
            "POLARIS_ADMIN_WORKER_BILLING_URL"
          ),
          ADMIN_HYPERDRIVE: requiredEnvironment(
            "POLARIS_ADMIN_WORKER_ADMIN_URL"
          ),
        }),
        // the only network the Worker has: the Access key endpoint, for the test team
        outboundService: (request) => {
          const url = new URL(request.url);
          if (
            url.protocol === "https:" &&
            url.hostname === TEAM_DOMAIN &&
            url.pathname === "/cdn-cgi/access/certs"
          ) {
            return Response.json({ keys: [publicJwk] });
          }
          return new Response("no network in the harness", { status: 502 });
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.workerd-db.test.ts"],
    name: "admin-workerd-db",
  },
});
