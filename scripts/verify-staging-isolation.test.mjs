import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findHyperdriveProblems,
  findIsolationProblems,
  parseJsonc,
  WORKERS,
} from "./verify-staging-isolation.mjs";

const SITE_KEY = /^0x[A-Za-z0-9_-]+$/;

const readConfig = (app) =>
  parseJsonc(
    readFileSync(
      new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url),
      "utf8"
    )
  );

/** The repository configs as they are: staging filled in with the ids of the real resources. */
const repositoryEntries = () =>
  WORKERS.map((app) => ({ app, config: readConfig(app) }));

const entryOf = (entries, app) => entries.find((entry) => entry.app === app);

describe("the staging isolation check", () => {
  it("passes on the repository config: no staging value is a placeholder", () => {
    expect(findIsolationProblems(repositoryEntries())).toEqual([]);
  });

  it("refuses a staging value that goes back to a placeholder", () => {
    const entries = repositoryEntries();
    entryOf(entries, "web").config.env.staging.account_id =
      "PLACEHOLDER-staging-account-id";
    entryOf(entries, "catalog").config.env.staging.hyperdrive[0].id =
      "PLACEHOLDER-staging-hyperdrive-catalog";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging: account_id is still a placeholder",
      "catalog: env.staging: hyperdrive[0].id is still a placeholder",
    ]);
  });

  it("refuses a top level that could deploy something", () => {
    const entries = repositoryEntries();
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
    const entries = repositoryEntries();
    entryOf(entries, "catalog").config.env.production = undefined;
    expect(findIsolationProblems(entries)).toContain(
      "catalog: env.staging and env.production must both be declared"
    );
  });

  it("refuses a staging environment without the queue consumers or a variable production lacks", () => {
    const entries = repositoryEntries();
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
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.ratelimits = staging.ratelimits.slice(1);
    staging.images = undefined;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging lacks ratelimit:AUTH_RATE_LIMITER (bindings are not inherited)",
      "web: env.staging lacks images:IMAGES (bindings are not inherited)",
    ]);
  });

  it("refuses a staging Worker name that does not end in -staging", () => {
    const entries = repositoryEntries();
    entryOf(entries, "catalog").config.env.staging.name = "polaris-catalog";
    expect(findIsolationProblems(entries)).toEqual([
      'catalog: env.staging: name "polaris-catalog" must end in -staging, or the deploy would publish another Worker',
    ]);
  });

  it("refuses staging resources shared with production or with the top level", () => {
    const entries = repositoryEntries();
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
    const entries = repositoryEntries();
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
    const entries = repositoryEntries();
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
      "web: env.staging: staging has no routes (the web Custom Domain is managed outside the config)",
      "web: env.staging: vars.BETTER_AUTH_BASE_URL must be exactly https://dash.araute.app",
    ]);
  });

  it("accepts only the staging web host, exactly, with workers.dev off", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    expect(staging.vars.BETTER_AUTH_BASE_URL).toBe("https://dash.araute.app");
    expect(staging.workers_dev).toBe(false);
    expect(findIsolationProblems(entries)).toEqual([]);
    for (const url of [
      "https://other.araute.app",
      "https://dash.araute.app.evil.example",
      "http://dash.araute.app",
      "https://dash.araute.app/",
      "https://dash.araute.app/path",
      "https://user:pw@dash.araute.app",
      "https://dash.araute.app:8443",
      "https://DASH.araute.app",
      "https://polaris-web-staging.polaris-pr11-gate.workers.dev",
    ]) {
      staging.vars.BETTER_AUTH_BASE_URL = url;
      expect(findIsolationProblems(entries), url).toEqual([
        "web: env.staging: vars.BETTER_AUTH_BASE_URL must be exactly https://dash.araute.app",
      ]);
    }
  });

  it("refuses workers.dev on for the staging web, since the origin check takes one origin", () => {
    const entries = repositoryEntries();
    entryOf(entries, "web").config.env.staging.workers_dev = true;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging: workers_dev must be false (the origin check accepts only https://dash.araute.app)",
    ]);
  });

  it("keeps the catalog of staging on workers.dev only", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    for (const url of [
      "https://dash.araute.app",
      "https://polaris-catalog-staging.example.workers.dev/x",
      "http://polaris-catalog-staging.example.workers.dev",
    ]) {
      staging.vars.CATALOG_ORIGIN = url;
      expect(findIsolationProblems(entries), url).toEqual([
        "web: env.staging: vars.CATALOG_ORIGIN must be the workers.dev URL of the staging catalog Worker",
      ]);
    }
  });

  it("refuses a production host equal to the staging one", () => {
    const entries = repositoryEntries();
    const { production } = entryOf(entries, "web").config.env;
    production.vars.BETTER_AUTH_BASE_URL = "https://dash.araute.app";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production vars.BETTER_AUTH_BASE_URL must not use the host of staging",
    ]);
    production.vars.BETTER_AUTH_BASE_URL = "https://DASH.araute.app:444/x";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production vars.BETTER_AUTH_BASE_URL must not use the host of staging",
    ]);
    production.vars.BETTER_AUTH_BASE_URL = "https://dash.araute.app./";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production vars.BETTER_AUTH_BASE_URL must not use the host of staging",
    ]);
    production.vars.CATALOG_ORIGIN =
      "https://polaris-catalog-staging.polaris-pr11-gate.workers.dev";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production vars.BETTER_AUTH_BASE_URL must not use the host of staging",
      "web: env.production vars.CATALOG_ORIGIN must not use the host of staging",
    ]);
    production.vars.BETTER_AUTH_BASE_URL = "https://app.example.com";
    production.vars.CATALOG_ORIGIN = "https://catalog.example.com";
    expect(findIsolationProblems(entries)).toEqual([]);
  });

  it("accepts the empty binding lists a generated wrangler.json writes", () => {
    const entries = repositoryEntries().map((entry) => ({
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
    const entries = repositoryEntries();
    const web = entryOf(entries, "web").config.env.staging;
    const catalog = entryOf(entries, "catalog").config.env.staging;
    catalog.hyperdrive[0].id = web.hyperdrive[0].id;
    expect(findIsolationProblems(entries)).toEqual([
      "catalog: env.staging Hyperdrive CATALOG_HYPERDRIVE shares its id with web HYPERDRIVE",
    ]);
  });

  it("refuses previews and a missing environment marker in staging", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.preview_urls = true;
    staging.vars.POLARIS_ENVIRONMENT = "production";
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging: preview_urls must be false (no Cloudflare Previews)",
      'web: env.staging: vars.POLARIS_ENVIRONMENT must be "staging"',
    ]);
  });

  it("accepts password sign-in in staging with the sender on araute.app", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    expect(staging.vars.EMAIL_PASSWORD_AUTH_ENABLED).toBe("true");
    for (const sender of [
      "Polaris (staging) <nao-responda@araute.app>",
      "nao-responda@araute.app",
      "Polaris <Nao-Responda@ARAUTE.APP>",
    ]) {
      staging.vars.AUTH_EMAIL_FROM = sender;
      expect(findIsolationProblems(entries)).toEqual([]);
    }
  });

  it("refuses password sign-in in staging with a sender outside araute.app", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    const problem =
      "web: env.staging: password sign-in in staging needs vars.AUTH_EMAIL_FROM on @araute.app";
    for (const sender of [
      "Polaris <nao-responda@example.com>",
      "nao-responda@evil-araute.app",
      "nao-responda@araute.app.evil.com",
      "nao-responda@dash.araute.app",
      "Polaris <nao-responda@araute.app.evil.com>",
      "evil@example.com <nao-responda@araute.app>",
      "Polaris <nao-responda@araute.app> <a@example.com>",
      "",
    ]) {
      staging.vars.AUTH_EMAIL_FROM = sender;
      expect(findIsolationProblems(entries), sender).toEqual([problem]);
    }
    staging.vars.AUTH_EMAIL_FROM = undefined;
    expect(findIsolationProblems(entries)).toEqual([problem]);
  });

  // Every variable of staging must exist in production too (another guard), so the test sets both.
  const setReplyTo = (entries, replyTo) => {
    const { staging, production } = entryOf(entries, "web").config.env;
    if (replyTo === undefined) {
      Reflect.deleteProperty(staging.vars, "AUTH_EMAIL_REPLY_TO");
      return;
    }
    staging.vars.AUTH_EMAIL_REPLY_TO = replyTo;
    production.vars.AUTH_EMAIL_REPLY_TO = "";
  };

  it("accepts the reply-to of staging absent, empty or on araute.app", () => {
    const entries = repositoryEntries();
    for (const replyTo of [
      undefined,
      "",
      "  ",
      "ajuda@araute.app",
      "Polaris <Ajuda@ARAUTE.APP>",
    ]) {
      setReplyTo(entries, replyTo);
      expect(findIsolationProblems(entries), String(replyTo)).toEqual([]);
    }
  });

  it("refuses a reply-to of staging outside araute.app", () => {
    const entries = repositoryEntries();
    const problem =
      "web: env.staging: password sign-in in staging needs vars.AUTH_EMAIL_REPLY_TO absent, empty or on @araute.app";
    for (const replyTo of [
      "ajuda@example.com",
      "ajuda@evil-araute.app",
      "ajuda@araute.app.evil.com",
      "ajuda@dash.araute.app",
      "Polaris <ajuda@araute.app.evil.com>",
      "evil@example.com <ajuda@araute.app>",
      "Polaris <ajuda@araute.app> <a@example.com>",
    ]) {
      setReplyTo(entries, replyTo);
      expect(findIsolationProblems(entries), replyTo).toEqual([problem]);
    }
  });

  it("does not check the reply-to while the password is off in staging", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.vars.EMAIL_PASSWORD_AUTH_ENABLED = "false";
    setReplyTo(entries, "ajuda@example.com");
    expect(findIsolationProblems(entries)).toEqual([]);
  });

  it("accepts staging with the password off and refuses a value that is neither true nor false", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.vars.EMAIL_PASSWORD_AUTH_ENABLED = "false";
    expect(findIsolationProblems(entries)).toEqual([]);
    staging.vars.EMAIL_PASSWORD_AUTH_ENABLED = "yes";
    expect(findIsolationProblems(entries)).toEqual([
      'web: env.staging: vars.EMAIL_PASSWORD_AUTH_ENABLED must be "true" or "false"',
    ]);
  });

  it("accepts the protection against abuse on in staging, with the public key of the widget", () => {
    const { staging } = entryOf(repositoryEntries(), "web").config.env;
    expect(staging.vars.AUTH_ABUSE_PROTECTION_ENABLED).toBe("true");
    expect(staging.vars.TURNSTILE_SITE_KEY).toMatch(SITE_KEY);
    expect(findIsolationProblems(repositoryEntries())).toEqual([]);
  });

  it("refuses the protection on without the site key, and a flag that is neither true nor false", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "web").config.env;
    staging.vars.TURNSTILE_SITE_KEY = "  ";
    expect(findIsolationProblems(entries)).toEqual([
      'web: env.staging: vars.AUTH_ABUSE_PROTECTION_ENABLED "true" needs vars.TURNSTILE_SITE_KEY (the public key of the staging widget)',
    ]);
    staging.vars.AUTH_ABUSE_PROTECTION_ENABLED = "false";
    expect(findIsolationProblems(entries)).toEqual([]);
    staging.vars.AUTH_ABUSE_PROTECTION_ENABLED = "yes";
    expect(findIsolationProblems(entries)).toEqual([
      'web: env.staging: vars.AUTH_ABUSE_PROTECTION_ENABLED must be "true" or "false"',
    ]);
  });

  it("refuses production using the widget key of staging", () => {
    const entries = repositoryEntries();
    const { production, staging } = entryOf(entries, "web").config.env;
    production.vars.TURNSTILE_SITE_KEY = staging.vars.TURNSTILE_SITE_KEY;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production vars.TURNSTILE_SITE_KEY must not be the widget key of staging",
    ]);
  });

  it.each([
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "3x00000000000000000000FF",
  ])("refuses the Cloudflare test key %s as the staging site key", (key) => {
    const entries = repositoryEntries();
    entryOf(entries, "web").config.env.staging.vars.TURNSTILE_SITE_KEY = key;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.staging: vars.TURNSTILE_SITE_KEY is a Cloudflare test key (prefix 1x, 2x or 3x); use the key of the real widget",
    ]);
  });

  it.each([
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "3x00000000000000000000FF",
  ])("refuses the Cloudflare test key %s as the production site key", (key) => {
    const entries = repositoryEntries();
    entryOf(entries, "web").config.env.production.vars.TURNSTILE_SITE_KEY = key;
    expect(findIsolationProblems(entries)).toEqual([
      "web: env.production vars.TURNSTILE_SITE_KEY is a Cloudflare test key (prefix 1x, 2x or 3x); use the key of the real widget",
    ]);
  });

  it("refuses an Admin reachable in staging", () => {
    const entries = repositoryEntries();
    const { staging } = entryOf(entries, "admin").config.env;
    staging.workers_dev = true;
    staging.routes = [{ custom_domain: true, pattern: "admin.example.com" }];
    staging.vars.ACCESS_AUDIENCE = "aud";
    staging.hyperdrive = [
      { binding: "ADMIN_HYPERDRIVE", id: "abcdefabcdefabcdefabcdefabcdefab" },
    ];
    expect(findIsolationProblems(entries)).toEqual([
      "admin: env.staging: staging has no routes (the web Custom Domain is managed outside the config)",
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
      const entries = repositoryEntries().map((entry) => ({
        ...entry,
        built: built(entry.config),
      }));
      expect(findIsolationProblems(entries)).toEqual([]);
    });

    it("refuses a missing build, a build of another environment or bindings that differ", () => {
      const entries = repositoryEntries().map((entry) => ({
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
