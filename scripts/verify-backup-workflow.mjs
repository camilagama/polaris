import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The backup workflow (ADR 0099) has one job per environment with the same steps. A job that copies the other
 * with a name left behind would dump one database into the other's bucket or seal it to the other's key, and the
 * logs of a public repository would not say so. This check fails when:
 * - the workflow has other jobs than `staging` and `production`, or a trigger other than `schedule` and
 *   `workflow_dispatch` (the jobs hold secrets);
 * - a job's switch, Environment, concurrency group, database marker, bucket, key file or issue label is not its own
 *   environment's;
 * - a job lacks a line that keeps the dump from reading the database or leaving the runner wrongly (the key and hash
 *   checks of the recipients, the seal, the bucket the upload uses, no credentials left in the checkout);
 * - a job names the other environment anywhere;
 * - the steps of the two jobs differ in anything but those names.
 */

export const ENVIRONMENTS = {
  production: {
    bucket: "polaris-backup",
    enabled: "PRODUCTION_BACKUP_ENABLED",
    environment: "production-backup",
    group: "deploy-production",
    label: "backup-production",
    recipients: "ops/backup/recipients-production.txt",
  },
  staging: {
    bucket: "polaris-backup-staging",
    enabled: "STAGING_BACKUP_ENABLED",
    environment: "staging-backup",
    group: "deploy-staging",
    label: "backup-staging",
    recipients: "ops/backup/recipients-staging.txt",
  },
};

const JOB_ID = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const TOP_KEY = /^([A-Za-z_-]+):/;
const ALLOWED_TRIGGERS = ["schedule", "workflow_dispatch"];
const SWITCH_LINE = /^ {4}if:/;
const BUCKET_LINE = /^ {6}BACKUP_BUCKET:/;
const TRIGGER_LINE = /^ {2}([A-Za-z_]+):/;

/** Lines of a top-level block (`on`, `jobs`) without its header, up to the next top-level key. */
function topBlock(lines, key) {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => TOP_KEY.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The jobs of the `jobs` block, each with its own lines, in file order. */
function readJobs(lines) {
  const block = topBlock(lines, "jobs") ?? [];
  const jobs = [];
  for (const line of block) {
    const id = JOB_ID.exec(line);
    if (id) {
      jobs.push({ id: id[1], lines: [] });
    } else if (jobs.length > 0) {
      jobs.at(-1).lines.push(line);
    }
  }
  return jobs.map((job) => ({ id: job.id, text: job.lines.join("\n") }));
}

/** The job's steps and settings with every name that belongs to an environment replaced by a placeholder. */
function normalized(text, config) {
  return text
    .split("\n")
    .map((line) => {
      if (SWITCH_LINE.test(line)) {
        return "    if: @switch@";
      }
      if (BUCKET_LINE.test(line)) {
        return "      BACKUP_BUCKET: @bucket@";
      }
      return line
        .replaceAll(config.recipients, "@recipients@")
        .replaceAll(/staging|production/g, "@env@")
        .replaceAll(/STAGING|PRODUCTION/g, "@ENV@");
    })
    .join("\n");
}

// Identical in both jobs, so comparing the jobs with each other would not notice both losing one of them.
export const REQUIRED_LINES = [
  "          persist-credentials: false",
  `          if ! grep -Eq '^age1[02-9ac-hj-np-z]{58}$' "$RECIPIENTS"; then`,
  "          actual=$(sha256sum \"$RECIPIENTS\" | cut -d' ' -f1)",
  '          if [ -z "$EXPECTED" ] || [ "$actual" != "$EXPECTED" ]; then',
  '        run: bash scripts/backup/seal.sh /dev/shm/polaris-backup "$RECIPIENTS" "$RUNNER_TEMP/$STAMP.tar.age"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the line is workflow text, an Actions expression, not a template
  "          R2_BACKUP_BUCKET: ${{ env.BACKUP_BUCKET }}",
];

function expectedLines(env, config) {
  return [
    `    if: vars.${config.enabled} == 'true' && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || inputs.environment == '${env}')`,
    `    environment: ${config.environment}`,
    `      group: ${config.group}`,
    `      BACKUP_ENVIRONMENT: ${env}`,
    `      BACKUP_BUCKET: ${config.bucket}`,
    `      RECIPIENTS: ${config.recipients}`,
    ...REQUIRED_LINES,
  ];
}

function jobProblems(env, text) {
  const config = ENVIRONMENTS[env];
  const other = env === "staging" ? "production" : "staging";
  const lines = text.split("\n");
  const problems = [];
  for (const expected of expectedLines(env, config)) {
    if (!lines.includes(expected)) {
      problems.push(`${env}: missing the line \`${expected.trim()}\``);
    }
  }
  const labels = [...text.matchAll(/--label (\S+)/g)].map((match) => match[1]);
  if (labels.length === 0 || labels.some((label) => label !== config.label)) {
    problems.push(
      `${env}: the issue label must be ${config.label} everywhere, found ${labels.join(", ") || "none"}`
    );
  }
  if (new RegExp(other, "i").test(text)) {
    problems.push(`${env}: names ${other}`);
  }
  return problems;
}

function triggerProblems(lines) {
  const block = topBlock(lines, "on");
  if (block === null) {
    return ["the workflow has no `on` block"];
  }
  const triggers = block
    .map((line) => TRIGGER_LINE.exec(line)?.[1])
    .filter(Boolean);
  const extra = triggers.filter((name) => !ALLOWED_TRIGGERS.includes(name));
  const missing = ALLOWED_TRIGGERS.filter((name) => !triggers.includes(name));
  return [
    ...extra.map((name) => `the trigger ${name} is not allowed`),
    ...missing.map((name) => `the trigger ${name} is missing`),
  ];
}

function driftProblem(staging, production) {
  const left = normalized(staging.trimEnd(), ENVIRONMENTS.staging).split("\n");
  const right = normalized(production.trimEnd(), ENVIRONMENTS.production).split(
    "\n"
  );
  const at = left.findIndex((text, index) => text !== right[index]);
  if (at === -1 && left.length === right.length) {
    return [];
  }
  const line = at === -1 ? Math.min(left.length, right.length) : at;
  return [
    `the steps of staging and production differ at line ${line + 1} of the job: \`${(left[line] ?? "").trim()}\` against \`${(right[line] ?? "").trim()}\``,
  ];
}

/** The problems of the workflow text, empty when it is sound. */
export function findBackupWorkflowProblems(text) {
  const lines = text.split("\n");
  const problems = triggerProblems(lines);
  if (!lines.includes("permissions: {}")) {
    problems.push("the workflow must start with `permissions: {}`");
  }
  const jobs = readJobs(lines);
  const ids = jobs.map((job) => job.id);
  if (ids.join(",") !== "staging,production") {
    problems.push(
      `the jobs must be staging and production, in that order, found ${ids.join(", ") || "none"}`
    );
    return problems;
  }
  const [staging, production] = jobs;
  problems.push(
    ...jobProblems("staging", staging.text),
    ...jobProblems("production", production.text),
    ...driftProblem(staging.text, production.text)
  );
  return problems;
}

export const WORKFLOW_PATH = ".github/workflows/backup.yml";

function main() {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const file = resolve(root, WORKFLOW_PATH);
  if (!existsSync(file)) {
    console.log(`${WORKFLOW_PATH} is not in the repository: nothing to check`);
    return;
  }
  const problems = findBackupWorkflowProblems(readFileSync(file, "utf8"));
  for (const problem of problems) {
    console.error(`backup workflow: ${problem}`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("backup workflow: staging and production jobs agree");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
