import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc, WORKERS } from "./lib/wrangler-config.mjs";
import { findProductionBuildProblems } from "./verify-production-build.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HYPERDRIVE_PLACEHOLDER = /^PLACEHOLDER-production-hyperdrive-(.+)$/;
const ORIGIN_PLACEHOLDER = /^https:\/\/PLACEHOLDER-production-(\w+)-origin$/;
const hex = (text, algorithm = "md5") =>
  createHash(algorithm).update(text).digest("hex");

const readConfig = (app) =>
  parseJsonc(
    readFileSync(
      new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url),
      "utf8"
    )
  );

/** What the responsible writes at the go-live in place of each placeholder of production. */
function fill(value) {
  if (typeof value !== "string" || !value.includes("PLACEHOLDER")) {
    return value;
  }
  if (value === "PLACEHOLDER-production-account-id") {
    return ACCOUNT;
  }
  const hyperdrive = HYPERDRIVE_PLACEHOLDER.exec(value);
  if (hyperdrive) {
    return hex(`hyperdrive-${hyperdrive[1]}`);
  }
  if (value === "PLACEHOLDER-production-access-audience") {
    return hex("audience", "sha256");
  }
  if (value === "PLACEHOLDER-production-team.cloudflareaccess.com") {
    return "polaris-producao.cloudflareaccess.com";
  }
  const origin = ORIGIN_PLACEHOLDER.exec(value);
  if (origin) {
    return `https://${origin[1]}.polaris.example`;
  }
  throw new Error(`no filling for ${value}`);
}

function filled(value) {
  if (Array.isArray(value)) {
    return value.map(filled);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, filled(item)])
    );
  }
  return fill(value);
}

/** The configs of the repository, with env.production as it is or filled in, and the build Vite generates from it. */
function entries({ fillProduction }) {
  return WORKERS.map((app) => {
    const config = readConfig(app);
    if (fillProduction) {
      config.env.production = filled(config.env.production);
    }
    const built =
      app === "admin"
        ? undefined
        : {
            ...structuredClone(config.env.production),
            targetEnvironment: "production",
            topLevelName: config.name,
          };
    return { app, built, config };
  });
}

const entryOf = (list, app) => list.find((entry) => entry.app === app);

describe("the production build check", () => {
  it("passes once every placeholder of production is filled in", () => {
    expect(
      findProductionBuildProblems(entries({ fillProduction: true }))
    ).toEqual([]);
    expect(
      findProductionBuildProblems(entries({ fillProduction: true }), ACCOUNT)
    ).toEqual([]);
  });

  it("fails closed on the repository as it is: production still has placeholders in every Worker", () => {
    const problems = findProductionBuildProblems(
      entries({ fillProduction: false })
    );
    for (const app of ["web", "catalog", "admin"]) {
      expect(problems).toContain(
        `${app}: ${app === "admin" ? "env.production" : "built wrangler.json"}: account_id is still a placeholder`
      );
    }
    expect(problems).toContain(
      "web: built wrangler.json: vars.BETTER_AUTH_BASE_URL is still a placeholder"
    );
    expect(problems).toContain(
      "admin: env.production: vars.ACCESS_AUDIENCE is still a placeholder"
    );
  });

  it("refuses a missing build, a build for another environment and a build that differs from env.production", () => {
    const list = entries({ fillProduction: true });
    entryOf(list, "web").built = null;
    const catalog = entryOf(list, "catalog");
    catalog.built.targetEnvironment = "staging";
    catalog.built.name = "polaris-catalog-staging";
    catalog.built.r2_buckets = [
      { binding: "MEDIA_BUCKET", bucket_name: "polaris-media-staging" },
    ];
    expect(findProductionBuildProblems(list)).toEqual([
      "web: no production build found (run the build with CLOUDFLARE_ENV=production first)",
      "catalog: built wrangler.json does not target production",
      "catalog: built wrangler.json has another name than env.production",
      "catalog: built wrangler.json bindings differ from env.production",
      "catalog: built wrangler.json: name must be the production one",
      "catalog: built wrangler.json: MEDIA_BUCKET uses polaris-media-staging, a resource of another environment",
    ]);
  });

  it("refuses a Hyperdrive id or an account that is not a Cloudflare id, and Workers in different accounts", () => {
    const list = entries({ fillProduction: true });
    const admin = entryOf(list, "admin");
    admin.config.env.production.hyperdrive[0].id = "admin-hyperdrive";
    admin.config.env.production.account_id = "fedcba9876543210fedcba9876543210";
    entryOf(list, "catalog").built.account_id = "not-an-account";
    entryOf(list, "catalog").config.env.production.account_id =
      "not-an-account";
    const problems = findProductionBuildProblems(list);
    expect(problems).toContain(
      "catalog: built wrangler.json: account_id is not a Cloudflare account id"
    );
    expect(problems).toContain(
      "admin: env.production: Hyperdrive ADMIN_HYPERDRIVE is not a Cloudflare id"
    );
    expect(problems).toContain(
      "the production Workers are not all in the same account"
    );
  });

  it("refuses an account other than CLOUDFLARE_ACCOUNT_ID", () => {
    expect(
      findProductionBuildProblems(
        entries({ fillProduction: true }),
        "fedcba9876543210fedcba9876543210"
      )
    ).toEqual([
      "the account of the production Workers is not CLOUDFLARE_ACCOUNT_ID",
    ]);
  });

  it("refuses previews, workers.dev and another POLARIS_ENVIRONMENT in what is published", () => {
    const list = entries({ fillProduction: true });
    entryOf(list, "web").built.preview_urls = true;
    entryOf(list, "web").built.vars.POLARIS_ENVIRONMENT = "staging";
    const problems = findProductionBuildProblems(list);
    expect(problems).toContain(
      "web: built wrangler.json: workers_dev and preview_urls must be false"
    );
    expect(problems).toContain(
      'web: built wrangler.json: vars.POLARIS_ENVIRONMENT must be "production"'
    );
  });

  it("keeps the static isolation check: production may not reach a host of staging", () => {
    const list = entries({ fillProduction: true });
    entryOf(list, "web").config.env.production.vars.CATALOG_ORIGIN =
      "https://catalogo.araute.app";
    entryOf(list, "web").built.vars.CATALOG_ORIGIN =
      "https://catalogo.araute.app";
    expect(
      findProductionBuildProblems(list).some((problem) =>
        problem.startsWith("web: env.production")
      )
    ).toBe(true);
  });

  it("refuses a build whose vars differ from env.production, such as a host of staging", () => {
    const list = entries({ fillProduction: true });
    entryOf(list, "web").built.vars.CATALOG_ORIGIN =
      "https://catalogo.araute.app";
    entryOf(list, "catalog").built.vars.ROUTE_TIMING_ALL = "true";
    expect(findProductionBuildProblems(list)).toEqual([
      "web: built wrangler.json vars differ from env.production",
      "catalog: built wrangler.json vars differ from env.production",
    ]);
  });

  it("refuses a Worker without env.production", () => {
    const list = entries({ fillProduction: true });
    entryOf(list, "admin").config.env.production = undefined;
    expect(findProductionBuildProblems(list)).toContain(
      "admin: env.production is missing"
    );
  });
});
