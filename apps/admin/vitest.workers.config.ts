import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import {
  closedHyperdriveConnectionString,
  harnessHyperdrives,
} from "../../scripts/workerd-harness.mjs";

/**
 * The Admin Worker, real, inside workerd (T-121a). No database: the Hyperdrive
 * points to a closed loopback port, so a query fails closed. The wrangler file
 * is the app's own, untouched; only the bindings the test needs are added here.
 * Cloudflare Access is simulated: a key pair made at start-up (nothing stored),
 * the public half served as the team's JWKS by `outboundService`, the private
 * half handed to the test only to sign tokens.
 */
const TEAM_DOMAIN = "polaris-test.cloudflareaccess.com";
/** A team whose key endpoint is down, for the "keys unavailable" answer. */
const DOWN_TEAM_DOMAIN = "polaris-down.cloudflareaccess.com";
const AUDIENCE = "a".repeat(64);
const KEY_ID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KEY_ID };

// The Worker imports the page's script and sheet, which `build:ui` makes and git does not keep: build them first.
execFileSync("bun", ["run", "build:ui"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  stdio: "inherit",
});

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ACCESS_AUDIENCE: AUDIENCE,
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          TEST_ACCESS_DOWN_TEAM_DOMAIN: DOWN_TEAM_DOMAIN,
          TEST_ACCESS_KEY_ID: KEY_ID,
          TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk),
        },
        // overrides the app's `localConnectionString` (a PostgreSQL port a developer machine may have open)
        hyperdrives: harnessHyperdrives({
          ADMIN_HYPERDRIVE: closedHyperdriveConnectionString,
        }),
        // the only network the Worker has: the Access key endpoint, for the test team
        outboundService: (request) => {
          const url = new URL(request.url);
          if (
            url.protocol === "https:" &&
            url.pathname === "/cdn-cgi/access/certs"
          ) {
            if (url.hostname === TEAM_DOMAIN) {
              return Response.json({ keys: [publicJwk] });
            }
            if (url.hostname === DOWN_TEAM_DOMAIN) {
              return new Response("down", { status: 500 });
            }
          }
          return new Response("no network in the harness", { status: 502 });
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.workerd.test.ts"],
    name: "admin-workerd",
  },
});
