import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findHyperdriveProblems,
  findIsolationProblems,
  parseJsonc,
  WORKERS,
} from "./verify-staging-isolation.mjs";

const PLACEHOLDER = /PLACEHOLDER/;
const PLACEHOLDER_GLOBAL = /PLACEHOLDER[-a-z]*/g;

const readConfig = (app) =>
  parseJsonc(
    readFileSync(
      new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url),
      "utf8"
    )
  );

// a fake 32-hex id, distinct per placeholder, so the filled-in config is what the responsible would write
const fakeId = (text) => {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) % 0xff_ff_ff;
  }
  return hash.toString(16).padStart(6, "0").repeat(6).slice(0, 32);
};

const fill = (value) => {
  if (typeof value === "string") {
    if (!PLACEHOLDER.test(value)) {
      return value;
    }
    return value.startsWith("https://")
      ? value.replace(PLACEHOLDER_GLOBAL, "example")
      : fakeId(value);
  }
  if (Array.isArray(value)) {
    return value.map(fill);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item)])
    );
  }
  return value;
};

/** The repository configs with the staging placeholders filled in, as after the responsible's step. */
const filledEntries = () =>
  WORKERS.map((app) => {
    const config = readConfig(app);
    config.env.staging = fill(config.env.staging);
    return { app, config };
  });

const entryOf = (entries, app) => entries.find((entry) => entry.app === app);

describe("the staging isolation check", () => {
  it("refuses the repository config while the staging values are placeholders", () => {
    const problems = findIsolationProblems(
      WORKERS.map((app) => ({ app, config: readConfig(app) }))
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.includes("placeholder"))).toBe(
      true
    );
    expect(problems).toContain(
      "web: env.staging: account_id is still a placeholder"
    );
    expect(problems).toContain(
      "catalog: env.staging: hyperdrive[0].id is still a placeholder"
    );
  });

  it("passes once every staging placeholder is a real value", () => {
    expect(findIsolationProblems(filledEntries())).toEqual([]);
  });

  it("refuses a top level that could deploy something", () => {
    const entries = filledEntries();
    const web = entryOf(entries, "web").config;
    web.name = "polaris-web";
    web.workers_dev = true;
    web.hyperdrive[0].id = "0123456789abcdef0123456789abcdef";
    web.r2_buckets[0].bucket_name = "polaris-media";
    expect(findIsolationProblems(entries)).toEqual([
      'web: top level: name "polaris-web" must end in -local (the top level is never deployed)',
      "web: top level: workers_dev must be false",
      "web: top level: Hyperdrive HYPERDRIVE must be local-only",
      "web: top level: bucket of MEDIA_BUCKET must end in -local",
    ]);
  });

  it("refuses a missing environment", () => {
    const entries = filledEntries();
    entryOf(entries, "catalog").config.env.production = undefined;
    expect(findIsolationProblems(entries)).toContain(
      "catalog: env.staging and env.production must both be declared"
    );
  });

  it("refuses a staging environment without the queue consumers or a variable production lacks", () => {
    const entries = filledEntries();
    const web = entryOf(entries, "web").config;
    web.env.staging.queues.consumers =
      web.env.staging.queues.consumers.slice(1);
    web.env.production.vars.CATALOG_ORIGIN = undefined;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production lacks vars.CATALOG_ORIGIN, which env.staging sets",
      "web: env.staging lacks consumer:polaris-critical (bindings are not inherited)",
    ]);
  });

  it("refuses a staging environment that lacks a binding of the top level", () => {
    const entries = filledEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.ratelimits = staging.ratelimits.slice(1);
    staging.images = undefined;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging lacks ratelimit:AUTH_RATE_LIMITER (bindings are not inherited)",
      "web: env.staging lacks images:IMAGES (bindings are not inherited)",
    ]);
  });

  it("refuses a staging Worker name that does not end in -staging", () => {
    const entries = filledEntries();
    entryOf(entries, "catalog").config.env.staging.name = "polaris-catalog";
    expect(findIsolationProblems(entries)).toEqual([
      'catalog: env.staging: name "polaris-catalog" must end in -staging, or the deploy would publish another Worker',
    ]);
  });

  it("refuses staging resources shared with production or with the top level", () => {
    const entries = filledEntries();
    const web = entryOf(entries, "web").config;
    web.env.production.hyperdrive[0].id = web.env.staging.hyperdrive[0].id;
    web.env.staging.ratelimits[0].namespace_id = "901016";
    web.env.production.account_id = web.env.staging.account_id;
    const problems = findIsolationProblems(entries);
    expect(problems).toContain(
      `web: env.staging hyperdrive "${web.env.staging.hyperdrive[0].id}" is also used by web env.production`
    );
    expect(problems).toContain(
      'web: env.staging namespaces "901016" is also used by web env.production'
    );
    expect(problems).toContain(
      `web: env.staging accounts "${web.env.staging.account_id}" is also used by web env.production`
    );
  });

  it("refuses a staging queue or bucket that does not say staging", () => {
    const entries = filledEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.queues.producers[0].queue = "polaris-critical";
    staging.r2_buckets[0].bucket_name = "polaris-media";
    const problems = findIsolationProblems(entries);
    expect(problems).toContain(
      "web: env.staging: queue polaris-critical must be polaris-<lane>-staging"
    );
    expect(problems).toContain(
      "web: env.staging: bucket of MEDIA_BUCKET must be polaris-media-staging"
    );
  });

  it("refuses a binding kind staging does not use, a route and a non-staging URL", () => {
    const entries = filledEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.services = [{ binding: "PROD", service: "polaris-web" }];
    staging.kv_namespaces = [{ binding: "KV", id: "x" }];
    staging.durable_objects = { bindings: [{ class_name: "X", name: "X" }] };
    staging.routes = [{ custom_domain: true, pattern: "app.example.com" }];
    staging.vars.BETTER_AUTH_BASE_URL = "https://app.example.com";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging: durable_objects is not used by staging",
      "web: env.staging: kv_namespaces is not used by staging",
      "web: env.staging: services is not used by staging",
      "web: env.staging: staging has no routes, only workers.dev",
      "web: env.staging: vars.BETTER_AUTH_BASE_URL must be the workers.dev URL of the staging Worker",
    ]);
  });

  it("accepts the empty binding lists a generated wrangler.json writes", () => {
    const entries = filledEntries().map((entry) => ({
      ...entry,
      built: {
        ...entry.config.env.staging,
        durable_objects: { bindings: [] },
        kv_namespaces: [],
        targetEnvironment: "staging",
      },
    }));
    expect(findIsolationProblems(entries)).toEqual([]);
  });

  it("refuses two staging roles on the same Hyperdrive configuration", () => {
    const entries = filledEntries();
    const web = entryOf(entries, "web").config.env.staging;
    const catalog = entryOf(entries, "catalog").config.env.staging;
    catalog.hyperdrive[0].id = web.hyperdrive[0].id;
    expect(findIsolationProblems(entries)).toEqual([
      "catalog: env.staging Hyperdrive CATALOG_HYPERDRIVE shares its id with web HYPERDRIVE",
    ]);
  });

  it("refuses previews, a missing environment marker and password sign-in in staging", () => {
    const entries = filledEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.preview_urls = true;
    staging.vars.POLARIS_ENVIRONMENT = "production";
    staging.vars.EMAIL_PASSWORD_AUTH_ENABLED = "true";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging: preview_urls must be false (no Cloudflare Previews)",
      'web: env.staging: vars.POLARIS_ENVIRONMENT must be "staging"',
      'web: env.staging: password sign-in must stay off in staging (EMAIL_PASSWORD_AUTH_ENABLED "false")',
    ]);
  });

  it("refuses an Admin reachable in staging", () => {
    const entries = filledEntries();
    const { staging } = entryOf(entries, "admin").config.env;
    staging.workers_dev = true;
    staging.routes = [{ custom_domain: true, pattern: "admin.example.com" }];
    staging.vars.ACCESS_AUDIENCE = "aud";
    staging.hyperdrive = [
      { binding: "ADMIN_HYPERDRIVE", id: "abcdefabcdefabcdefabcdefabcdefab" },
    ];
    expect(findIsolationProblems(entries)).toEqual([
      "admin: env.staging: staging has no routes, only workers.dev",
      "admin: env.staging: the Admin is not exposed in staging (workers_dev must be false)",
      "admin: env.staging: the Admin has no Access application in staging",
      "admin: env.staging: the Admin has no database binding in staging",
    ]);
  });

  describe("on the built wrangler.json", () => {
    const built = (config) => ({
      ...config.env.staging,
      targetEnvironment: "staging",
    });

    it("passes when the build resolved env.staging", () => {
      const entries = filledEntries().map((entry) => ({
        ...entry,
        built: built(entry.config),
      }));
      expect(findIsolationProblems(entries)).toEqual([]);
    });

    it("refuses a missing build, a build of another environment or bindings that differ", () => {
      const entries = filledEntries().map((entry) => ({
        ...entry,
        built: built(entry.config),
      }));
      entryOf(entries, "web").built = null;
      const catalog = entryOf(entries, "catalog");
      catalog.built = {
        ...catalog.built,
        name: "polaris-catalog",
        r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "other-staging" }],
        targetEnvironment: "production",
      };
      expect(findIsolationProblems(entries)).toEqual([
        "web: no staging build found (run the build with CLOUDFLARE_ENV=staging first)",
        'catalog: built wrangler.json: name "polaris-catalog" must end in -staging, or the deploy would publish another Worker',
        "catalog: built wrangler.json: bucket of MEDIA_BUCKET must be polaris-media-staging",
        'catalog: built wrangler.json targets "production", not staging',
        "catalog: built wrangler.json bindings differ from env.staging",
      ]);
    });
  });
});

describe("the remote Hyperdrive check", () => {
  const good = {
    caching: { disabled: true },
    origin: {
      host: "ep-staging.example.neon.tech",
      user: "polaris_staging_tenant",
    },
  };

  it("passes a configuration on the staging host, without caching and with a runtime login", () => {
    expect(
      findHyperdriveProblems("HYPERDRIVE", good, "ep-staging.example.neon.tech")
    ).toEqual([]);
  });

  it("refuses another host, caching on or the owner login", () => {
    expect(
      findHyperdriveProblems(
        "HYPERDRIVE",
        {
          caching: { disabled: false },
          origin: {
            host: "ep-production.example.neon.tech",
            user: "neondb_owner",
          },
        },
        "ep-staging.example.neon.tech"
      )
    ).toEqual([
      "HYPERDRIVE: Hyperdrive points to another host than the staging database, or to the pooler",
      "HYPERDRIVE: query caching must be disabled",
      "HYPERDRIVE: Hyperdrive must log in as a staging runtime login, never as the database owner",
    ]);
  });

  it("refuses to run without the expected host", () => {
    expect(findHyperdriveProblems("HYPERDRIVE", good, undefined)).toEqual([
      "STAGING_DATABASE_HOST is not set",
    ]);
  });
});

describe("the JSONC reader", () => {
  it("keeps // inside strings and drops comments and trailing commas", () => {
    expect(
      parseJsonc(`{
        // a comment
        "url": "postgresql://user@host/db", /* block */
        "list": [1, 2,],
      }`)
    ).toEqual({ list: [1, 2], url: "postgresql://user@host/db" });
  });
});
