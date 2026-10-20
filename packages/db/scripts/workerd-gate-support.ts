import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdminPool } from "./sales-gate-support";
import { temporaryRuntimeUrl } from "./sales-gate-support";

/**
 * What the gates of the Workers harness (`admin-worker`, `web-worker`, `catalog-worker`) share: the temporary
 * database logins, and the Vitest run of a root config inside `workerd` with only the environment it needs.
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
  /** Drops every login this object made; one that fails to go must not leave the others. */
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
        // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
        await owner.pool
          .query(`REVOKE "${group}" FROM "${role}"`)
          .catch(() => undefined);
        await owner.pool
          .query(`DROP ROLE IF EXISTS "${role}"`)
          .catch(() => undefined);
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

/** Runs `vitest run --config <config>` from the root with only the variables the run needs, in its own process group. */
export function runWorkerdVitest(
  config: string,
  environment: Record<string, string>
): Promise<RunResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const child = spawn(
      process.execPath,
      ["run", "vitest", "run", "--config", config],
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
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    }, VITEST_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        digest: lines.filter((line) => failureLine.test(line)).slice(-30),
        lines,
      });
    });
  });
}
