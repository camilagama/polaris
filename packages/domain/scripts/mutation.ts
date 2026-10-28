import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  FOLDERS,
  isComplete,
  parseDeadline,
  remainingMs,
  stateOfRun,
} from "./mutation-run";
import {
  type FolderReport,
  type FolderState,
  renderSummary,
} from "./mutation-summary";

/**
 * Runs Stryker one folder at a time (`bun scripts/mutation.ts [folder...]`).
 *
 * Each folder has its own incremental file and report, so the score is per
 * folder and the cache of one folder does not depend on the others.
 * MUTATION_DEADLINE_MINUTES (unset: no limit) ends the run before the job
 * timeout: Stryker saves what it already tested when it gets SIGTERM, so the
 * next night continues from there, and the steps that save the cache and the
 * report still have time. When a run over all four folders finishes them all,
 * it writes reports/complete: the nightly workflow skips the next night only
 * on that mark. The score and the survivors come out of the JSON reports and
 * go to the console and to GITHUB_STEP_SUMMARY.
 */

const REPORT_DIRECTORY = "reports/mutation";
const STRYKER_REPORT = `${REPORT_DIRECTORY}/mutation`;
const setupFilePattern = /^stryker-setup-\d+\.js$/;
const REPORT_EXTENSIONS = ["html", "json"];

function readReport(folder: string, state: FolderState): FolderReport {
  try {
    const text = readFileSync(`${REPORT_DIRECTORY}/${folder}.json`, "utf8");
    return { folder, report: JSON.parse(text), state };
  } catch {
    return { folder, report: null, state };
  }
}

// A run cut by the deadline leaves the runner's setup files behind.
function removeSetupFiles() {
  for (const entry of readdirSync(".")) {
    if (setupFilePattern.test(entry)) {
      rmSync(entry);
    }
  }
}

function runFolder(folder: string, timeout: number | undefined): FolderState {
  const run = spawnSync(
    "stryker",
    [
      "run",
      "--mutate",
      `src/${folder}/**/*.ts,!src/**/*.test.ts`,
      "--incrementalFile",
      `reports/stryker-incremental-${folder}.json`,
    ],
    { stdio: "inherit", timeout }
  );
  const timedOut =
    run.error !== undefined &&
    "code" in run.error &&
    run.error.code === "ETIMEDOUT";
  const state = stateOfRun({ status: run.status, timedOut });
  if (state !== "complete") {
    return state;
  }
  try {
    for (const extension of REPORT_EXTENSIONS) {
      copyFileSync(
        `${STRYKER_REPORT}.${extension}`,
        `${REPORT_DIRECTORY}/${folder}.${extension}`
      );
    }
  } catch {
    return "failed";
  }
  return state;
}

const requested = process.argv.slice(2);
const unknown = requested.filter((folder) => !FOLDERS.includes(folder));
if (unknown.length > 0) {
  console.error(
    `Unknown folder: ${unknown.join(", ")}. Valid: ${FOLDERS.join(", ")}.`
  );
  process.exit(2);
}
const deadline = parseDeadline(
  process.env.MUTATION_DEADLINE_MINUTES,
  Date.now()
);
if (deadline === "invalid") {
  console.error(
    "MUTATION_DEADLINE_MINUTES must be a positive number of minutes."
  );
  process.exit(2);
}

removeSetupFiles();
mkdirSync(REPORT_DIRECTORY, { recursive: true });
rmSync("reports/complete", { force: true });

const askedForAll = requested.length === 0;
const states = new Map<string, FolderState>();
for (const folder of askedForAll ? FOLDERS : requested) {
  for (const extension of REPORT_EXTENSIONS) {
    rmSync(`${REPORT_DIRECTORY}/${folder}.${extension}`, { force: true });
  }
  const remaining = remainingMs(deadline, Date.now());
  if (remaining !== null && remaining <= 0) {
    states.set(folder, "cut");
  } else {
    states.set(folder, runFolder(folder, remaining ?? undefined));
  }
  if (states.get(folder) === "cut") {
    console.log(`${folder}: out of time, left for the next run.`);
  }
}

removeSetupFiles();
// The report Stryker names `mutation.*` is the one of the last folder; the copies by folder are the ones kept.
for (const extension of REPORT_EXTENSIONS) {
  rmSync(`${STRYKER_REPORT}.${extension}`, { force: true });
}
if (isComplete([...states.values()], askedForAll)) {
  writeFileSync("reports/complete", "complete\n");
}

const summary = renderSummary(
  FOLDERS.map((folder) => {
    const state = states.get(folder);
    const report = readReport(folder, state ?? "complete");
    return state === undefined && report.report === null
      ? { ...report, state: "not-run" as const }
      : report;
  })
);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
process.exit([...states.values()].includes("failed") ? 1 : 0);
