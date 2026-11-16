import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseJsonc,
  STAGING_ADMIN_HOST,
  STAGING_CATALOG_ORIGIN,
  STAGING_WEB_ORIGIN,
  stringsOf,
  WORKERS,
} from "./verify-staging-isolation.mjs";

/**
 * Static check of the production deploy workflow, read as text against the staging one. It fails when the
 * production workflow:
 * - runs on anything but `workflow_dispatch`, has workflow-wide permissions, or a job runs without the variable
 *   `PRODUCTION_DEPLOY_ENABLED` being "true" or outside main;
 * - names staging (the word, a staging host or an id of `env.staging` in a `wrangler.jsonc`);
 * - reads a secret in a job without `environment: production`, or has no such job;
 * - loses the order: the build (`build:ui` last) before the deploy job, which needs it; in that job the build check,
 *   the marker and owner check, the migrations and the read-only check before the first `wrangler deploy`, and the
 *   deployed version check after the web and the catalog are published;
 * - drifts from staging in what both must do the same way: the pinned actions, `persist-credentials: false`, the
 *   install, the build commands and the legal variables, the CI jobs required, the artifact paths and the steps
 *   that take the artifact and look for the offline labs.
 *
 * Until the workflow is applied under `.github/workflows/`, the candidate lives next to this script
 * (`deploy-production.workflow.yml`); exactly one of the two must exist.
 */

const WORKFLOWS = ".github/workflows";
export const PRODUCTION_WORKFLOW = `${WORKFLOWS}/deploy-production.yml`;
export const PRODUCTION_CANDIDATE = "scripts/deploy-production.workflow.yml";
export const STAGING_WORKFLOW = `${WORKFLOWS}/deploy-staging.yml`;

/** Steps that both workflows carry under the same name and with the same `run`. */
export const SHARED_STEPS = [
  "Take only the build output from the artifact",
  "No offline lab in the build",
];

const ENABLED = "vars.PRODUCTION_DEPLOY_ENABLED == 'true'";
const ON_MAIN = "github.ref == 'refs/heads/main'";
const CLOUDFLARE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const TOP_KEY = /^([A-Za-z_][\w-]*):/;
const JOB_KEY = /^ {2}([A-Za-z_][\w-]*):\s*$/;
const STEP_START = /^ {6}- /;
const STEP_FIELD = /^ {6}(?:- | {2})([\w-]+):\s?(.*)$/;
const USES = /^\s*(?:- )?uses:\s*([^@\s]+)@(\S+)/;
const LEADING_SPACE = /^\s*/;
const NON_SPACE = /\S/;
const SPACES = /\s+/g;
const BRACKETS = /[[\]]/g;
const TRIGGER_KEY = /^ {2}([\w-]+):/;
const STAGING_WORD = /staging/i;
const COMMENT_LINE = /^\s*#/;
const LEGAL_VARIABLE = /^\s+VITE_LEGAL_[A-Z_]+: .*$/;
const WRANGLER_DEPLOY = "wrangler deploy";

function topLevelBlock(lines, key) {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) {
    return [];
  }
  const end = lines.findIndex(
    (line, index) => index > start && TOP_KEY.test(line)
  );
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function blockText(lines, index, indent) {
  const block = [];
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next];
    if (line.trim() !== "" && line.search(NON_SPACE) <= indent) {
      break;
    }
    block.push(line);
  }
  const margin = Math.min(
    ...block
      .filter((line) => line.trim() !== "")
      .map((line) => line.match(LEADING_SPACE)[0].length)
  );
  return block
    .map((line) => line.slice(margin))
    .join("\n")
    .trimEnd();
}

function parseSteps(lines) {
  const steps = [];
  let current = null;
  lines.forEach((line, index) => {
    if (STEP_START.test(line)) {
      current = { lines: [], name: "", run: "" };
      steps.push(current);
    }
    if (current === null) {
      return;
    }
    current.lines.push(line);
    const field = STEP_FIELD.exec(line);
    if (field?.[1] === "name") {
      current.name = field[2].trim();
    }
    if (field?.[1] === "run") {
      current.run =
        field[2].trim() === "|" ? blockText(lines, index, 8) : field[2].trim();
    }
  });
  return steps;
}

/** The jobs of a workflow as `{ id, text, lines, steps }`, read by indentation (two spaces per level). */
export function parseJobs(text) {
  const lines = topLevelBlock(text.split("\n"), "jobs");
  const jobs = [];
  for (const line of lines) {
    const key = JOB_KEY.exec(line);
    if (key) {
      jobs.push({ id: key[1], lines: [] });
    } else if (jobs.length > 0) {
      jobs.at(-1).lines.push(line);
    }
  }
  return jobs.map((job) => ({
    ...job,
    steps: parseSteps(job.lines),
    text: job.lines.join("\n"),
  }));
}

function triggersOf(text) {
  return topLevelBlock(text.split("\n"), "on")
    .map((line) => TRIGGER_KEY.exec(line)?.[1])
    .filter(Boolean);
}

function jobIf(job) {
  const index = job.lines.findIndex((line) => line.startsWith("    if:"));
  if (index === -1) {
    return "";
  }
  const inline = job.lines[index].slice("    if:".length).trim();
  return inline === ">-" || inline === "|"
    ? blockText(job.lines, index, 4).replace(SPACES, " ")
    : inline;
}

function needsOf(job) {
  const line = job.lines.find((item) => item.startsWith("    needs:")) ?? "";
  return line
    .slice("    needs:".length)
    .replace(BRACKETS, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function environmentOf(job) {
  const line = job.lines.find((item) => item.startsWith("    environment:"));
  return line ? line.slice("    environment:".length).trim() : null;
}

/** Every id and host that belongs to staging: the strings of `env.staging` that are Cloudflare ids, and the fixed hosts. */
export function stagingMarkers(configs) {
  const ids = configs.flatMap((config) =>
    stringsOf(config.env?.staging ?? {})
      .map(([, value]) => value)
      .filter((value) => CLOUDFLARE_ID.test(value))
  );
  const hosts = [STAGING_WEB_ORIGIN, STAGING_CATALOG_ORIGIN].map(
    (origin) => new URL(origin).host
  );
  return [...new Set([...ids, ...hosts, STAGING_ADMIN_HOST])];
}

function checkShape(text, jobs, problems) {
  const triggers = triggersOf(text);
  if (triggers.join(",") !== "workflow_dispatch") {
    problems.push(
      `the workflow must run on workflow_dispatch only (it has: ${triggers.join(", ") || "none"})`
    );
  }
  if (text.includes("pull_request_target")) {
    problems.push("the workflow must never mention pull_request_target");
  }
  if (!text.split("\n").includes("permissions: {}")) {
    problems.push(
      "the workflow must start with no permissions (permissions: {})"
    );
  }
  if (jobs.length === 0) {
    problems.push("the workflow has no job");
  }
  for (const job of jobs) {
    const condition = jobIf(job);
    if (!(condition.includes(ENABLED) && condition.includes(ON_MAIN))) {
      problems.push(
        `job ${job.id}: its if must require ${ENABLED} and ${ON_MAIN}`
      );
    }
  }
}

function checkNoStaging(text, markers, problems) {
  if (STAGING_WORD.test(text)) {
    problems.push("the workflow names staging");
  }
  for (const marker of markers) {
    if (text.includes(marker)) {
      problems.push(`the workflow carries ${marker}, which belongs to staging`);
    }
  }
}

function checkEnvironment(jobs, problems) {
  const protectedJobs = jobs.filter(
    (job) => environmentOf(job) === "production"
  );
  if (protectedJobs.length === 0) {
    problems.push("no job runs in the protected environment: production");
  }
  for (const job of jobs) {
    const environment = environmentOf(job);
    if (environment !== null && environment !== "production") {
      problems.push(`job ${job.id}: environment must be production`);
    }
    if (job.text.includes("secrets.") && environment !== "production") {
      problems.push(
        `job ${job.id}: reads a secret outside the production environment`
      );
    }
  }
}

function indexIn(text, needle) {
  const index = text.indexOf(needle);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function checkOrder(jobs, problems) {
  const runs = (job) => job.steps.map((step) => codeLines(step.run)).join("\n");
  const builder = jobs.find((job) => runs(job).includes("build:ui"));
  const deployer = jobs.find((job) => runs(job).includes(WRANGLER_DEPLOY));
  if (!(builder && deployer)) {
    problems.push(
      "the workflow must build the Admin page (build:ui) and run wrangler deploy"
    );
    return;
  }
  if (
    jobs.indexOf(builder) >= jobs.indexOf(deployer) ||
    !needsOf(deployer).includes(builder.id)
  ) {
    problems.push(
      `the order build:ui -> deploy is lost: job ${deployer.id} must come after and need job ${builder.id}`
    );
  }
  const { text } = deployer;
  const sequence = [
    ["node scripts/verify-production-build.mjs", "the production build check"],
    ["production:verify-database before-migrate", "the marker and owner check"],
    ["@polaris/db db:migrate", "the migrate step"],
    ["production:verify-database after-migrate", "the read-only check"],
    ["cd apps/web && bunx --no-install wrangler deploy", "the web deploy"],
    [
      "cd apps/catalog && bunx --no-install wrangler deploy",
      "the catalog deploy",
    ],
    [
      "node scripts/verify-deployed-sha.mjs --env production",
      "the deployed version check",
    ],
    [
      "cd apps/admin && bunx --no-install wrangler deploy --env production",
      "the Admin deploy",
    ],
  ];
  let previous = -1;
  for (const [needle, label] of sequence) {
    const index = indexIn(text, needle);
    if (index === Number.POSITIVE_INFINITY) {
      problems.push(`job ${deployer.id}: ${label} is missing (${needle})`);
    } else if (index < previous) {
      problems.push(`job ${deployer.id}: ${label} is out of order`);
    }
    previous = Math.max(
      previous,
      index === Number.POSITIVE_INFINITY ? -1 : index
    );
  }
  if (
    indexIn(text, WRANGLER_DEPLOY) < indexIn(text, "@polaris/db db:migrate")
  ) {
    problems.push(
      `job ${deployer.id}: a wrangler deploy runs before the migrations`
    );
  }
}

function pinsOf(text) {
  const pins = new Map();
  for (const line of text.split("\n")) {
    const uses = USES.exec(line);
    if (uses) {
      pins.set(uses[1], [...(pins.get(uses[1]) ?? []), uses[2]]);
    }
  }
  return pins;
}

function checkoutsWithoutPersistFalse(jobs) {
  return jobs.flatMap((job) =>
    job.steps
      .filter((step) =>
        step.lines.some((line) => line.includes("actions/checkout@"))
      )
      .filter(
        (step) =>
          !step.lines.some(
            (line) => line.trim() === "persist-credentials: false"
          )
      )
      .map(() => job.id)
  );
}

function stepNamed(jobs, name) {
  return jobs.flatMap((job) => job.steps).filter((step) => step.name === name);
}

function codeLines(run) {
  return run
    .split("\n")
    .filter((line) => line.trim() !== "" && !COMMENT_LINE.test(line))
    .join("\n");
}

function buildStep(jobs) {
  return jobs
    .flatMap((job) => job.steps)
    .find((step) => step.run.includes("build:ui"));
}

function requiredJobsBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) =>
    line.includes(
      'jobs=$(gh api --paginate "repos/$REPOSITORY/actions/runs/$RUN_ID/jobs"'
    )
  );
  if (start === -1) {
    return "";
  }
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === "done"
  );
  return lines
    .slice(start, end === -1 ? lines.length : end + 1)
    .map((line) => line.trim())
    .join("\n");
}

function artifactPaths(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "path: |");
  return start === -1
    ? ""
    : blockText(lines, start, lines[start].search(NON_SPACE));
}

function checkPins(production, staging, problems) {
  const stagingPins = pinsOf(staging);
  for (const [action, refs] of pinsOf(production)) {
    const expected = stagingPins.get(action);
    if (!expected) {
      problems.push(`drift: ${action} is not used by the staging deploy`);
      continue;
    }
    if (refs.some((ref) => ref !== expected[0])) {
      problems.push(`drift: ${action} is not pinned like the staging deploy`);
    }
  }
}

function checkSharedSteps(productionJobs, stagingJobs, problems) {
  for (const name of SHARED_STEPS) {
    const ours = stepNamed(productionJobs, name);
    const theirs = stepNamed(stagingJobs, name);
    if (ours.length === 0 || theirs.length === 0) {
      problems.push(`drift: the step "${name}" must be in both workflows`);
      continue;
    }
    if (ours.some((step) => step.run !== theirs[0].run)) {
      problems.push(
        `drift: the step "${name}" differs from the staging deploy`
      );
    }
  }
}

function checkDrift(production, staging, problems) {
  const productionJobs = parseJobs(production);
  const stagingJobs = parseJobs(staging);
  checkPins(production, staging, problems);
  if (checkoutsWithoutPersistFalse(productionJobs).length > 0) {
    problems.push("drift: every checkout must have persist-credentials: false");
  }
  const installs = (jobs) =>
    jobs.filter((job) =>
      job.steps.some((step) => step.run === "bun install --frozen-lockfile")
    ).length;
  if (installs(productionJobs) !== installs(stagingJobs)) {
    problems.push(
      "drift: bun install --frozen-lockfile must run in the same jobs as in the staging deploy"
    );
  }
  checkSharedSteps(productionJobs, stagingJobs, problems);
  const ourBuild = buildStep(productionJobs);
  const theirBuild = buildStep(stagingJobs);
  if (
    !(ourBuild && theirBuild) ||
    codeLines(ourBuild.run) !== codeLines(theirBuild.run)
  ) {
    problems.push("drift: the build commands differ from the staging deploy");
  }
  const legal = (step) =>
    (step?.lines ?? []).filter((line) => LEGAL_VARIABLE.test(line)).join("\n");
  if (legal(ourBuild) === "" || legal(ourBuild) !== legal(theirBuild)) {
    problems.push(
      "drift: the VITE_LEGAL_* variables of the build differ from the staging deploy"
    );
  }
  const required = requiredJobsBlock(production);
  if (required === "" || required !== requiredJobsBlock(staging)) {
    problems.push(
      "drift: the CI jobs required before the deploy differ from the staging deploy"
    );
  }
  if (artifactPaths(production) !== artifactPaths(staging)) {
    problems.push(
      "drift: the paths of the build artifact differ from the staging deploy"
    );
  }
}

/** Problems of the production workflow `production`, read against the staging workflow `staging`. */
export function findWorkflowProblems(production, staging, markers) {
  const problems = [];
  const jobs = parseJobs(production);
  checkShape(production, jobs, problems);
  checkNoStaging(production, markers, problems);
  checkEnvironment(jobs, problems);
  checkOrder(jobs, problems);
  checkDrift(production, staging, problems);
  return problems;
}

/** The file that holds the production workflow: the applied one, else the candidate; both or none is an error. */
export function productionWorkflowPath(root, exists = existsSync) {
  const applied = exists(resolve(root, PRODUCTION_WORKFLOW));
  const candidate = exists(resolve(root, PRODUCTION_CANDIDATE));
  if (applied === candidate) {
    throw new Error(
      `exactly one of ${PRODUCTION_WORKFLOW} and ${PRODUCTION_CANDIDATE} must exist (the patch moves the candidate)`
    );
  }
  return applied ? PRODUCTION_WORKFLOW : PRODUCTION_CANDIDATE;
}

export function readRepository(root) {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  return {
    markers: stagingMarkers(
      WORKERS.map((app) => parseJsonc(read(`apps/${app}/wrangler.jsonc`)))
    ),
    production: read(productionWorkflowPath(root)),
    staging: read(STAGING_WORKFLOW),
  };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { markers, production, staging } = readRepository(root);
  const problems = findWorkflowProblems(production, staging, markers);
  if (problems.length > 0) {
    console.error(`Production workflow check failed (${problems.length}):`);
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Production workflow check passed (${productionWorkflowPath(root)}).`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
