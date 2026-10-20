import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "./verify-staging-isolation.mjs";

/**
 * The production guard (T-127a, D2 of the Admin plan): the Admin Worker in production answers only to a request
 * that carries a valid Cloudflare Access token, and nothing public reaches it. The Worker half is proved by the
 * chain test (worker.workerd-db.test.ts: no token, a bad token, a stranger and a disabled operator are refused).
 * This file proves the deployment half from the wrangler file, which is what a deploy follows: no workers.dev
 * address, no preview URLs, no route of any kind, and the two Access variables set. Whether the real Access
 * application stands in front of the real hostname cannot be proved here: that is the go-live checklist
 * (docs/runbooks/release-checklist.md), item to block the release.
 */
const config = parseJsonc(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../apps/admin/wrangler.jsonc"
    ),
    "utf8"
  )
);

const PUBLIC_ROUTE_FIELD = /"custom_domain"|"pattern"/;
const NOT_BLANK = /\S/;
const ROUTE_KEYS = [
  "route",
  "routes",
  "custom_domain",
  "custom_domains",
  "zone_id",
  "zone_name",
];
const environments = [
  ["the top level (local development)", config],
  ["env.staging", config.env.staging],
  ["env.production", config.env.production],
];

describe("admin Worker production guard (wrangler file)", () => {
  it.each(environments)(
    "%s has no workers.dev address and no preview URLs",
    (_name, block) => {
      expect(block.workers_dev).toBe(false);
      expect(block.preview_urls).toBe(false);
    }
  );

  it.each(environments)("%s has no public route", (_name, block) => {
    for (const key of ROUTE_KEYS) {
      expect(Object.hasOwn(block, key), `${key} is set`).toBe(false);
    }
    expect(JSON.stringify(block)).not.toMatch(PUBLIC_ROUTE_FIELD);
  });

  it("deploys production under its own name, in production, with the Access team and audience set", () => {
    const { production } = config.env;
    expect(production.name).toBe("polaris-admin");
    expect(production.vars.POLARIS_ENVIRONMENT).toBe("production");
    expect(production.vars.ACCESS_TEAM_DOMAIN).toMatch(NOT_BLANK);
    expect(production.vars.ACCESS_AUDIENCE).toMatch(NOT_BLANK);
  });

  it("does not set the Access variables at the top level or in staging (a Worker without them answers 503, never unverified)", () => {
    expect(config.vars ?? {}).not.toHaveProperty("ACCESS_TEAM_DOMAIN");
    expect(config.env.staging.vars ?? {}).not.toHaveProperty(
      "ACCESS_TEAM_DOMAIN"
    );
    expect(config.env.staging.vars ?? {}).not.toHaveProperty("ACCESS_AUDIENCE");
  });

  it("would notice each way of opening the Worker (control case)", () => {
    const open = (change) => ({ ...config.env.production, ...change });
    expect(open({ workers_dev: true }).workers_dev).not.toBe(false);
    expect(open({ preview_urls: true }).preview_urls).not.toBe(false);
    expect(Object.hasOwn(open({ routes: [] }), "routes")).toBe(true);
    expect(Object.hasOwn(open({ route: "x" }), "route")).toBe(true);
  });
});
