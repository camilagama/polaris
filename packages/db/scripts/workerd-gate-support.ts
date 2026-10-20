import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdminPool } from "./sales-gate-support";
import { temporaryRuntimeUrl } from "./sales-gate-support";
import {
  type SuiteExpectation,
  suiteSummaryProblems,
} from "./workerd-suite-summary";

/**
 * What the gates of the Workers harness with a database (`web-worker`, `catalog-worker`) share: the temporary
 * database logins, and the Vitest run of a root config inside `workerd` with only the environment it needs.
 * (`admin-worker` predates it and keeps its own copy.)
 */
export const repositoryRoot = fileURLToPath(
  new URL("../../..", import.meta.url)
);
const VITEST_TIMEOUT_MS = 5 * 60_000;
const failureLine =
  /FAIL|Error|expected|Expected|Received|✗|×|Tests |Test Files/;
const lineBreak = /\r?\n/;
const urlPattern = /postgres(?:ql)?:\/\/\S+/gi;

export interface TemporaryLogins {
  /** A login that is a member of `group`; returns the URL the Worker's Hyperdrive will carry. */
  login: (group: string, prefix: string) => Promise<string>;
  /** Drops every login this object made; one that fails to go must not leave the others, and is named. */
  drop: () => Promise<void>;
}

export function temporaryLogins(
  owner: { pool: AdminPool },
  adminUrl: string
): TemporaryLogins {
  const made: [string, string][] = [];
  return {
    async drop() {
      for (const [role, group] of made) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
          await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
          await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
        } catch {
          // the login has a random password and the database is disposable, but a leftover is said, never silent
          console.error(`gate cleanup: the login ${role} was not dropped`);
        }
      }
    },
    async login(group, prefix) {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      made.push([role, group]);
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      return temporaryRuntimeUrl(adminUrl, role, password);
    },
  };
}

export interface RunResult {
  code: number;
  /** The lines that say what failed: the runner of the gates shows only the last lines of a gate. */
  digest: string[];
  /** Every line, with the URLs of databases redacted. */
  lines: string[];
}

/**
 * Runs `vitest run --config <config>` from the root with only the variables the run needs, in its own process group.
 * Besides the exit code, the JSON report must show the tests the gate expects, every one passed: a skipped or todo test,
 * or a suite that ran fewer tests, turns the run into a failure (code 1) with the reason in the digest.
 */
export function runWorkerdVitest(
  config: string,
  environment: Record<string, string>,
  expectation: SuiteExpectation
): Promise<RunResult> {
  // before the promise, so a temporary directory that cannot be made is the error of the gate, which still drops its logins
  const reportDirectory = mkdtempSync(join(tmpdir(), "polaris-workerd-"));
  return new Promise((resolve) => {
    const lines: string[] = [];
    const reportFile = join(reportDirectory, "report.json");
    const child = spawn(
      process.execPath,
      [
        "run",
        "vitest",
        "run",
        "--config",
        config,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportFile}`,
      ],
      {
        cwd: repositoryRoot,
        // only what the run needs: not the owner URL of the database, which the gate holds
        env: {
          ...Object.fromEntries(
            ["CI", "HOME", "LANG", "PATH", "TMPDIR"].flatMap((name) =>
              process.env[name] === undefined ? [] : [[name, process.env[name]]]
            )
          ),
          ...environment,
        },
        // its own process group, so the timeout takes workerd down with it
        detached: true,
      }
    );
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString().split(lineBreak)) {
        if (line.trim()) {
          lines.push(line.replace(urlPattern, "[redacted]"));
        }
      }
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    }, VITEST_TIMEOUT_MS);
    const readReport = (): string => {
      try {
        return readFileSync(reportFile, "utf8");
      } catch {
        return "";
      }
    };
    child.on("error", () => {
      // the process did not start (no `bun` on the path): the gate fails and still drops its logins
      clearTimeout(timer);
      rmSync(reportDirectory, { force: true, recursive: true });
      resolve({ code: 1, digest: ["the Vitest process did not start"], lines });
    });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => {
      clearTimeout(timer);
      // the report only matters when the run says it passed: otherwise the failure is already what to read
      const problems =
        code === 0 ? suiteSummaryProblems(readReport(), expectation) : [];
      rmSync(reportDirectory, { force: true, recursive: true });
      const digest = [
        ...lines.filter((line) => failureLine.test(line)).slice(-30),
        ...problems,
      ];
      lines.push(...problems);
      resolve({
        code: problems.length > 0 ? 1 : (code ?? 1),
        digest,
        lines,
      });
    });
  });
}

/**
 * The failure of a suite, said for the runner of the gates (which shows only the last lines of a gate): the digest of
 * what failed, or every line with POLARIS_WORKERD_GATE_VERBOSE=1, and an error that names how to get the whole output.
 */
export function workerdSuiteFailure(label: string, result: RunResult): Error {
  const verbose = process.env.POLARIS_WORKERD_GATE_VERBOSE === "1";
  for (const line of verbose ? result.lines : result.digest) {
    console.error(verbose ? line : line.slice(0, 220));
  }
  return new Error(
    `The ${label} suite failed inside workerd (the lines above).${
      verbose
        ? ""
        : " For the whole output of the run, run the gate again with POLARIS_WORKERD_GATE_VERBOSE=1."
    }`
  );
}
