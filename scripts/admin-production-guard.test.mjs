import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "./verify-staging-isolation.mjs";

/**
 * The production guard (T-127a, D2 of the Admin plan): the Admin Worker in production answers only to a request
 * that carries a valid Cloudflare Access token, and nothing public reaches it. The Worker half is proved by the
 * chain test (apps/admin/src/worker.workerd-db.test.ts: no token, a bad token, a stranger and a disabled operator
 * are refused) and by route-surface.test.ts (no route outside /api, every one refuses a request without a token).
 * This file proves the deployment half from the wrangler file, which is what a deploy follows: no workers.dev
 * address, no preview URLs, no route of any kind, nothing that serves files or swaps code before the Worker, and
 * the two Access variables set. The blocks are checked against a list of the keys they may carry, not a list of
 * the keys they may not: a key nobody thought of fails here and gets a review of this guard. Whether the real Access
 * application stands in front of the real hostname cannot be proved here: that is the go-live checklist
 * (docs/runbooks/README.md, item of the Admin, a blocking item).
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

const NOT_BLANK = /\S/;
const WORKER_ENTRY = "./src/worker.ts";
const ENVIRONMENTS = ["production", "staging"];
const ALLOWED_KEYS = {
  production: [
    "account_id",
    "hyperdrive",
    "name",
    "observability",
    "preview_urls",
    "vars",
    "workers_dev",
  ],
  staging: [
    "account_id",
    "name",
    "observability",
    "preview_urls",
    "vars",
    "workers_dev",
  ],
  top: [
    "$schema",
    "compatibility_date",
    "compatibility_flags",
    "env",
    "hyperdrive",
    "main",
    "name",
    "observability",
    "preview_urls",
    "rules",
    "workers_dev",
  ],
};
/**
 * The one module rule (corte admin-tela-v1, D-2): the page's script and sheet built by `build:ui` are embedded as text.
 * Any other rule could make a file into code the Worker runs, so the rule is checked whole.
 */
const PAGE_TEXT_RULES = [
  { fallthrough: false, globs: ["**/ui/generated/*.txt"], type: "Text" },
];

/** JSON with the keys of every object sorted, so the order a file writes them in does not matter. */
function sortedJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
}

/** What is wrong with a block of the wrangler file, as the guard sees it. */
function problemsOf(label, block, allowedKeys) {
  const problems = [];
  if (block.workers_dev !== false) {
    problems.push(`${label}: workers_dev must be false`);
  }
  if (block.preview_urls !== false) {
    problems.push(`${label}: preview_urls must be false`);
  }
  for (const key of Object.keys(block)) {
    if (!allowedKeys.includes(key)) {
      problems.push(
        `${label}: the key ${key} is not one the guard knows (routes, assets, alias, build, triggers, services... need a review of this guard)`
      );
    }
  }
  if (
    block.rules !== undefined &&
    sortedJson(block.rules) !== sortedJson(PAGE_TEXT_RULES)
  ) {
    problems.push(
      `${label}: the module rules must be only the page's text rule`
    );
  }
  if (block.main !== undefined && block.main !== WORKER_ENTRY) {
    problems.push(`${label}: main must be ${WORKER_ENTRY}`);
  }
  return problems;
}

function allProblems(wrangler) {
  const problems = [
    ...problemsOf("top level", wrangler, ALLOWED_KEYS.top),
    ...(wrangler.main === WORKER_ENTRY
      ? []
      : ["top level: main is not the Worker"]),
  ];
  if (
    JSON.stringify(Object.keys(wrangler.env ?? {}).sort()) !==
    JSON.stringify(ENVIRONMENTS.toSorted())
  ) {
    problems.push("env: only staging and production exist");
  }
  for (const name of ENVIRONMENTS) {
    problems.push(
      ...problemsOf(
        `env.${name}`,
        wrangler.env?.[name] ?? {},
        ALLOWED_KEYS[name]
      )
    );
  }
  return problems;
}

describe("admin Worker production guard (wrangler file)", () => {
  it("has no workers.dev address, no preview URLs, no route and no code swapped in, in any block", () => {
    expect(allProblems(config)).toEqual([]);
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

  describe("control: the guard notices each way of opening the Worker", () => {
    const withProduction = (change) => ({
      ...config,
      env: {
        ...config.env,
        production: { ...config.env.production, ...change },
      },
    });

    it("accepts the file as it is", () => {
      expect(allProblems(withProduction({}))).toEqual([]);
    });

    it.each([
      ["workers.dev on", { workers_dev: true }],
      ["preview URLs on", { preview_urls: true }],
      ["workers.dev left to its default", { workers_dev: undefined }],
      [
        "a route",
        { routes: [{ custom_domain: true, pattern: "admin.example.com" }] },
      ],
      ["a single route", { route: "admin.example.com/*" }],
      ["a custom domain", { custom_domains: ["admin.example.com"] }],
      [
        "static assets served before the Worker",
        { assets: { directory: "./public" } },
      ],
      ["another entry point", { main: "./src/other.ts" }],
      [
        "a module swapped at build time",
        { alias: { "./access-jwt": "./fake.ts" } },
      ],
      ["a build command", { build: { command: "x" } }],
      ["a cron trigger", { triggers: { crons: ["* * * * *"] } }],
      ["a service binding", { services: [{ binding: "X", service: "y" }] }],
    ])("refuses %s in env.production", (_name, change) => {
      expect(allProblems(withProduction(change)).length).toBeGreaterThan(0);
    });

    it("refuses an environment the guard does not know", () => {
      const extra = {
        ...config,
        env: { ...config.env, preview: { workers_dev: true } },
      };
      expect(allProblems(extra).length).toBeGreaterThan(0);
    });

    it.each([
      [
        "a rule that makes the page files code",
        [{ globs: ["**/ui/generated/*.txt"], type: "ESModule" }],
      ],
      [
        "a second rule",
        [...PAGE_TEXT_RULES, { globs: ["**/*.wasm"], type: "CompiledWasm" }],
      ],
      [
        "a wider glob",
        [{ fallthrough: false, globs: ["**/*.txt"], type: "Text" }],
      ],
    ])("refuses %s at the top level", (_name, rules) => {
      expect(allProblems({ ...config, rules }).length).toBeGreaterThan(0);
    });

    it("refuses a route at the top level or in staging", () => {
      expect(
        allProblems({ ...config, routes: ["x/*"] }).length
      ).toBeGreaterThan(0);
      expect(
        allProblems({
          ...config,
          env: {
            ...config.env,
            staging: { ...config.env.staging, routes: ["x/*"] },
          },
        }).length
      ).toBeGreaterThan(0);
    });
  });
});
