import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findWorkflowProblems,
  JOB_CONDITION,
  PRODUCTION_CANDIDATE,
  PRODUCTION_WORKFLOW,
  parseJobs,
  productionWorkflowPath,
  readRepository,
  SHARED_STEPS,
} from "./verify-production-workflow.mjs";

const root = new URL("..", import.meta.url).pathname;
const repository = readRepository(root);
const { markers, production, staging } = repository;

/** Replaces exactly one occurrence, so a mutation that stopped matching fails here instead of passing silently. */
function once(text, from, to) {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`expected one "${from}", found ${count}`);
  }
  return text.replace(from, to);
}

/** A GitHub expression, built so the source never holds a dollar sign right before a brace. */
const expression = (inner) => ["$", "{{ ", inner, " }}"].join("");

const problemsOf = (mutated, stagingText = staging) =>
  findWorkflowProblems(mutated, stagingText, markers);

describe("the production workflow check", () => {
  it("passes on the workflow of the repository, read against the staging deploy", () => {
    expect(problemsOf(production)).toEqual([]);
  });

  it("reads three jobs and the shared steps from both workflows", () => {
    expect(parseJobs(production).map((job) => job.id)).toEqual([
      "decide",
      "build",
      "deploy",
    ]);
    for (const text of [production, staging]) {
      const names = parseJobs(text).flatMap((job) =>
        job.steps.map((step) => step.name)
      );
      for (const name of SHARED_STEPS) {
        expect(names).toContain(name);
      }
    }
  });

  it("knows the ids and hosts of staging from the wrangler.jsonc", () => {
    expect(markers).toEqual(
      expect.arrayContaining([
        "dash.araute.app",
        "catalogo.araute.app",
        "admin.araute.app",
      ])
    );
    expect(markers.length).toBeGreaterThan(10);
  });

  it.each([
    ["push", "  push:\n    branches: [main]\n"],
    ["pull_request", "  pull_request:\n"],
    ["workflow_run", "  workflow_run:\n    workflows: [CI]\n"],
    ["schedule", "  schedule:\n    - cron: '0 3 * * *'\n"],
  ])("refuses the trigger %s", (trigger, block) => {
    const mutated = once(production, "on:\n", `on:\n${block}`);
    expect(problemsOf(mutated)).toContain(
      `the workflow must run on workflow_dispatch only (it has: ${trigger}, workflow_dispatch)`
    );
  });

  it("refuses any mention of pull_request_target", () => {
    const mutated = once(
      production,
      "permissions: {}\n",
      "permissions: {}\n# pull_request_target\n"
    );
    expect(problemsOf(mutated)).toEqual([
      "the workflow must never mention pull_request_target",
    ]);
  });

  it("refuses workflow-wide permissions", () => {
    const mutated = once(
      production,
      "permissions: {}\n",
      "permissions:\n  contents: write\n"
    );
    expect(problemsOf(mutated)).toContain(
      "the workflow must start with no permissions (permissions: {})"
    );
  });

  it("refuses a job that runs without the variable or outside main", () => {
    const withoutVariable = production.replace(
      "    if: >-\n      vars.PRODUCTION_DEPLOY_ENABLED == 'true' &&\n",
      "    if: >-\n"
    );
    expect(problemsOf(withoutVariable)).toEqual([
      `job decide: its if must be exactly ${JOB_CONDITION}`,
    ]);
    const anyBranch = production.replaceAll(
      " &&\n      github.ref == 'refs/heads/main'",
      ""
    );
    expect(problemsOf(anyBranch)).toEqual(
      ["decide", "build", "deploy"].map(
        (job) => `job ${job}: its if must be exactly ${JOB_CONDITION}`
      )
    );
    const widened = once(
      production,
      "      github.event_name == 'workflow_dispatch' &&\n      github.ref == 'refs/heads/main'\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n",
      "      github.event_name == 'workflow_dispatch' ||\n      github.ref == 'refs/heads/main'\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n"
    );
    expect(problemsOf(widened)).toEqual([
      `job build: its if must be exactly ${JOB_CONDITION}`,
    ]);
  });

  it("refuses a secret read in a job without the environment, however it is written", () => {
    const indexed = once(
      production,
      "          CLOUDFLARE_ENV: production\n",
      `          CLOUDFLARE_ENV: production\n          TOKEN: ${expression("secrets['PRODUCTION_CLOUDFLARE_API_TOKEN']")}\n`
    );
    expect(problemsOf(indexed)).toEqual([
      "job build: reads a secret outside the production environment",
    ]);
    const commented = once(
      production,
      "          CLOUDFLARE_ENV: production\n",
      "          CLOUDFLARE_ENV: production\n          # never secrets here\n"
    );
    expect(problemsOf(commented)).toEqual([]);
  });

  it("refuses a CI run that is not the one of this commit pushed to main", () => {
    const anyRun = once(
      production,
      "runs?head_sha=$HEAD_SHA&event=push&branch=main&status=success&per_page=1",
      "runs?status=success&per_page=1"
    );
    expect(problemsOf(anyRun)).toEqual([
      "the CI run must be looked up for this commit (RUN_ID query lacks head_sha=$HEAD_SHA, event=push, branch=main)",
    ]);
  });

  it("refuses a build without CLOUDFLARE_ENV: production or with a flag that stays off", () => {
    expect(
      problemsOf(once(production, "          CLOUDFLARE_ENV: production\n", ""))
    ).toEqual(["the build must set CLOUDFLARE_ENV: production"]);
    for (const flag of [
      "VITE_OFFLINE_RUNTIME_ENABLED",
      "VITE_CLIENT_ERRORS_ENABLED",
    ]) {
      expect(
        problemsOf(
          once(
            production,
            "          CLOUDFLARE_ENV: production\n",
            `          CLOUDFLARE_ENV: production\n          ${flag}: "true"\n`
          )
        )
      ).toEqual([`the build must not set ${flag} (off in production)`]);
    }
  });

  it("refuses the word staging, a staging host and a staging id", () => {
    expect(
      problemsOf(
        once(production, "name: Deploy production", "name: Deploy Staging")
      )
    ).toContain("the workflow names staging");
    expect(
      problemsOf(
        once(
          production,
          "permissions: {}\n",
          "permissions: {}\n# smoke at https://catalogo.araute.app\n"
        )
      )
    ).toEqual([
      "the workflow carries catalogo.araute.app, which belongs to staging",
    ]);
    const [id] = markers;
    expect(
      problemsOf(
        once(
          production,
          '      WRANGLER_SEND_METRICS: "false"\n',
          `      WRANGLER_SEND_METRICS: "false"\n      HYPERDRIVE: ${id}\n`
        )
      )
    ).toEqual([`the workflow carries ${id}, which belongs to staging`]);
  });

  it("refuses losing the protected environment, or a secret read outside it", () => {
    const unprotected = once(production, "    environment: production\n", "");
    expect(problemsOf(unprotected)).toEqual([
      "no job runs in the protected environment: production",
      "job deploy: reads a secret outside the production environment",
    ]);
    const otherEnvironment = once(
      production,
      "    environment: production\n",
      "    environment: prod\n"
    );
    expect(problemsOf(otherEnvironment)).toContain(
      "job deploy: environment must be production"
    );
    const secretInBuild = once(
      production,
      "          CLOUDFLARE_ENV: production\n",
      `          CLOUDFLARE_ENV: production\n          VITE_SENTRY_DSN: ${expression("secrets.SENTRY_DSN")}\n`
    );
    expect(problemsOf(secretInBuild)).toEqual([
      "job build: reads a secret outside the production environment",
    ]);
  });

  it("refuses losing the order build:ui -> deploy", () => {
    const withoutNeeds = once(
      production,
      "    needs: [decide, build]\n",
      "    needs: decide\n"
    );
    expect(problemsOf(withoutNeeds)).toEqual([
      "the order build:ui -> deploy is lost: job deploy must come after and need job build",
    ]);
    const withoutAdminPage = once(
      production,
      "          bun run --filter @polaris/admin build:ui\n",
      ""
    );
    expect(problemsOf(withoutAdminPage)).toContain(
      "the workflow must build the Admin page (build:ui) and run wrangler deploy"
    );
  });

  it("refuses losing the deployed version check, or running it for staging", () => {
    expect(
      problemsOf(
        once(
          production,
          "          node scripts/verify-deployed-sha.mjs --env production\n",
          ""
        )
      )
    ).toEqual([
      "job deploy: the deployed version check is missing (node scripts/verify-deployed-sha.mjs --env production)",
    ]);
    expect(
      problemsOf(
        once(
          production,
          "node scripts/verify-deployed-sha.mjs --env production",
          "node scripts/verify-deployed-sha.mjs"
        )
      )
    ).toEqual([
      "job deploy: the deployed version check is missing (node scripts/verify-deployed-sha.mjs --env production)",
    ]);
  });

  it("refuses a step of the sequence that is commented out, swallowed, conditional or not under set -e", () => {
    const sha =
      "          node scripts/verify-deployed-sha.mjs --env production\n";
    expect(
      problemsOf(
        once(
          production,
          sha,
          "          # node scripts/verify-deployed-sha.mjs --env production\n"
        )
      )
    ).toEqual([
      "job deploy: the deployed version check is missing (node scripts/verify-deployed-sha.mjs --env production)",
    ]);
    expect(
      problemsOf(
        once(
          production,
          sha,
          "          node scripts/verify-deployed-sha.mjs --env production || true\n"
        )
      )
    ).toEqual([
      "job deploy: the step of the web deploy, the catalog deploy, the deployed version check, the Admin deploy must not swallow a failure (|| or &)",
    ]);
    const after =
      "          bun run --filter @polaris/db production:verify-database after-migrate";
    expect(problemsOf(once(production, `${after}\n`, `${after} &\n`))).toEqual([
      "job deploy: the step of the marker and owner check, the migrate step, the read-only check must not swallow a failure (|| or &)",
    ]);
    expect(
      problemsOf(
        once(
          production,
          "      - name: Migrate the production database\n",
          "      - name: Migrate the production database\n        continue-on-error: true\n"
        )
      )
    ).toEqual([
      "job deploy: the step of the marker and owner check, the migrate step, the read-only check must have no if and no continue-on-error",
    ]);
    expect(
      problemsOf(
        once(
          production,
          "      - name: Deploy the production Workers\n",
          "      - name: Deploy the production Workers\n        if: false\n"
        )
      )
    ).toEqual([
      "job deploy: the step of the web deploy, the catalog deploy, the deployed version check, the Admin deploy must have no if and no continue-on-error",
    ]);
    const migrate = parseJobs(production)
      .flatMap((job) => job.steps)
      .find((step) => step.name === "Migrate the production database")
      .lines.join("\n");
    expect(
      problemsOf(
        once(
          production,
          migrate,
          migrate.replace("          set -euo pipefail\n", "")
        )
      )
    ).toEqual([
      "job deploy: the step of the marker and owner check, the migrate step, the read-only check must start with set -euo pipefail",
    ]);
  });

  it("refuses a deploy before the migrations and checks out of order", () => {
    const migrate =
      '          DATABASE_URL="$PRODUCTION_MIGRATOR_DATABASE_URL" bun run --filter @polaris/db db:migrate\n';
    const web = `${production
      .split("\n")
      .find((line) => line.includes("(cd apps/web && bunx"))}\n`;
    const swapped = once(
      once(production, migrate, "MIGRATE\n"),
      web,
      migrate
    ).replace("MIGRATE\n", web);
    expect(problemsOf(swapped)).toEqual(
      expect.arrayContaining([
        "job deploy: a wrangler deploy runs before the migrations",
      ])
    );
    const verifyAfterDeploy = once(
      once(
        production,
        "          bun run --filter @polaris/db production:verify-database before-migrate\n",
        ""
      ),
      "          node scripts/verify-deployed-sha.mjs --env production\n",
      "          node scripts/verify-deployed-sha.mjs --env production\n          bun run --filter @polaris/db production:verify-database before-migrate\n"
    );
    expect(problemsOf(verifyAfterDeploy)).toContain(
      "job deploy: the migrate step is out of order"
    );
  });

  it("refuses a check of the build that was dropped", () => {
    const withoutBuildCheck = production.replaceAll(
      "        run: node scripts/verify-production-build.mjs\n",
      "        run: echo skipped\n"
    );
    expect(problemsOf(withoutBuildCheck)).toContain(
      "job deploy: the production build check is missing (node scripts/verify-production-build.mjs)"
    );
  });

  describe("the guard against drift from the staging deploy", () => {
    it("refuses an action pinned to another commit, or one staging does not use", () => {
      const repinned = production.replaceAll(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@v7"
      );
      expect(problemsOf(repinned)).toEqual([
        "drift: actions/checkout is not pinned like the staging deploy",
      ]);
      const extra = once(
        production,
        "      - run: bun install --frozen-lockfile\n      - name: Build the production Workers\n",
        "      - run: bun install --frozen-lockfile\n      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809\n      - name: Build the production Workers\n"
      );
      expect(problemsOf(extra)).toEqual([
        "drift: actions/cache is not used by the staging deploy",
      ]);
    });

    it("follows staging when staging moves: a new pin there is drift here", () => {
      const stagingRepinned = staging.replaceAll(
        "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
        "oven-sh/setup-bun@1111111111111111111111111111111111111111"
      );
      expect(problemsOf(production, stagingRepinned)).toEqual([
        "drift: oven-sh/setup-bun is not pinned like the staging deploy",
      ]);
    });

    it("refuses a checkout that keeps the credentials", () => {
      const persisted = production.replace(
        "          persist-credentials: false\n",
        "          persist-credentials: true\n"
      );
      expect(problemsOf(persisted)).toEqual([
        "drift: every checkout must have persist-credentials: false",
      ]);
    });

    it.each(SHARED_STEPS)(
      "refuses the shared step %s changed on either side",
      (name) => {
        const changed = (text) => {
          const step = parseJobs(text)
            .flatMap((job) => job.steps)
            .find((item) => item.name === name);
          const original = step.lines.join("\n").trimEnd();
          const last = original.split("\n").at(-1);
          return once(
            text,
            original,
            `${original.slice(0, -last.length)}${last} && true`
          );
        };
        expect(problemsOf(changed(production))).toEqual([
          `drift: the step "${name}" differs from the staging deploy`,
        ]);
        expect(problemsOf(production, changed(staging))).toEqual([
          `drift: the step "${name}" differs from the staging deploy`,
        ]);
      }
    );

    it("keeps a comment written before the next step out of the step above it", () => {
      const planted = [
        "jobs:",
        "  build:",
        "    steps:",
        "      - name: First",
        "        run: echo one",
        "      # about the next step",
        "",
        "      # still about the next step",
        "      - name: Second",
        "        run: |",
        "          echo two",
        "          # inside the script",
        "      - name: Third",
        "        run: echo three",
      ].join("\n");
      const [first, second, third] = parseJobs(planted)[0].steps;
      expect(first.lines.join("\n").trimEnd()).toBe(
        "      - name: First\n        run: echo one"
      );
      expect(first.run).toBe("echo one");
      expect(second.lines.at(-1)).toBe("          # inside the script");
      expect(second.run).toBe("echo two\n# inside the script");
      expect(third.run).toBe("echo three");
    });

    // A comment after the step changes nothing in the `run` that is compared, so this case
    // passes with or without the `isStepBody` filter. What proves the filter is the parser case
    // above and the `No offline lab in the build` run of the `it.each` over the shared steps.
    it("compares the run of a shared step that has a comment right after it, equal and drifted", () => {
      const name = "No offline lab in the build";
      const commented = (text) =>
        once(
          text,
          "        run: node scripts/verify-no-lab-in-build.mjs\n",
          "        run: node scripts/verify-no-lab-in-build.mjs\n      # a note about the step that follows\n"
        );
      const drifted = (text) =>
        once(
          commented(text),
          "        run: node scripts/verify-no-lab-in-build.mjs\n",
          "        run: node scripts/verify-no-lab-in-build.mjs && true\n"
        );
      expect(problemsOf(commented(production), commented(staging))).toEqual([]);
      expect(problemsOf(drifted(production), commented(staging))).toEqual([
        `drift: the step "${name}" differs from the staging deploy`,
      ]);
    });

    it("refuses other build commands, other legal variables or another list of required CI jobs", () => {
      expect(
        problemsOf(
          once(
            production,
            "          bun run --filter @polaris/catalog build\n",
            "          bun run --filter @polaris/catalog build --mode development\n"
          )
        )
      ).toEqual(["drift: the build commands differ from the staging deploy"]);
      expect(
        problemsOf(
          once(
            production,
            `          VITE_LEGAL_DPO_EMAIL: ${expression("vars.LEGAL_DPO_EMAIL")}\n`,
            ""
          )
        )
      ).toEqual([
        "drift: the VITE_LEGAL_* variables of the build differ from the staging deploy",
      ]);
      expect(
        problemsOf(
          once(
            production,
            '"Checks (lint, types, knip, build, tests)" "PostgreSQL 18 gates"',
            '"Checks (lint, types, knip, build, tests)"'
          )
        )
      ).toEqual([
        "drift: the CI jobs required before the deploy differ from the staging deploy",
      ]);
    });

    it("refuses other artifact paths and an install missing from a job", () => {
      expect(
        problemsOf(
          once(
            production,
            "            apps/catalog/dist\n",
            "            apps/catalog\n"
          )
        )
      ).toEqual([
        "drift: the paths of the build artifact differ from the staging deploy",
      ]);
      const install = "      - run: bun install --frozen-lockfile\n";
      const withoutInstall = production.replace(install, "");
      expect(problemsOf(withoutInstall)).toContain(
        "drift: bun install --frozen-lockfile must run in the same jobs as in the staging deploy"
      );
    });
  });
});

describe("where the production workflow lives", () => {
  const at =
    (...present) =>
    (path) =>
      present.some((item) => path === resolve("/repo", item));

  it("is the applied workflow when it exists, else the candidate", () => {
    expect(productionWorkflowPath("/repo", at(PRODUCTION_WORKFLOW))).toBe(
      PRODUCTION_WORKFLOW
    );
    expect(productionWorkflowPath("/repo", at(PRODUCTION_CANDIDATE))).toBe(
      PRODUCTION_CANDIDATE
    );
  });

  it("refuses both or none: the patch moves the candidate, it never copies it", () => {
    expect(() =>
      productionWorkflowPath(
        "/repo",
        at(PRODUCTION_WORKFLOW, PRODUCTION_CANDIDATE)
      )
    ).toThrow("exactly one of");
    expect(() => productionWorkflowPath("/repo", at())).toThrow(
      "exactly one of"
    );
  });

  it("finds exactly one in the repository", () => {
    expect([PRODUCTION_WORKFLOW, PRODUCTION_CANDIDATE]).toContain(
      productionWorkflowPath(root)
    );
  });
});
