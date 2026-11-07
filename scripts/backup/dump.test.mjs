import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const DUMP = join(here, "dump.sh");
const PASSWORD = "pw-fixed-for-tests-9f31";
const VERBOSE_FLAG = /(^| )-v( |$)|--verbose/;
const SNAPSHOT = "00000003-00000002-1";

const FAKES = {
  pg_dump: `#!/usr/bin/env bash
echo "pg_dump $*" >> "$FAKE_LOG"
case "$1" in
  --version) echo "pg_dump (PostgreSQL) \${FAKE_DUMP_MAJOR:-18}.1"; exit 0 ;;
esac
for a in "$@"; do case "$a" in --file=*) printf 'dump-bytes' > "\${a#--file=}" ;; esac; done
`,
  pg_dumpall: `#!/usr/bin/env bash
echo "pg_dumpall $*" >> "$FAKE_LOG"
for a in "$@"; do case "$a" in --file=*) printf 'CREATE ROLE x;' > "\${a#--file=}" ;; esac; done
`,
  pg_restore: `#!/usr/bin/env bash
echo "pg_restore $*" >> "$FAKE_LOG"
echo "4000; 0 0 ACL - SCHEMA public postgres"
echo "200; 1259 5 TABLE public a postgres"
`,
  psql: `#!/usr/bin/env bash
echo "psql $*" >> "$FAKE_LOG"
for a in "$@"; do
  case "$a" in
    --file=*) printf '%s' "$FAKE_PREFLIGHT"; exit 0 ;;
  esac
done
while IFS= read -r line; do
  case "$line" in
    *pg_export_snapshot*) echo 00000003-00000002-1 ;;
    *to_char*) echo 2026-11-04T06:22:00Z ;;
    *server_version_num*) echo 180006 ;;
    '\\i '*) echo '{"tables":{"public.a":1}}' ;;
    '\\q') exit 0 ;;
  esac
done
`,
  stdbuf: `#!/usr/bin/env bash
shift
exec "$@"
`,
};

describe("dump.sh", () => {
  let base;
  let out;
  let log;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dump-test-"));
    const bin = join(base, "bin");
    out = join(base, "out");
    log = join(base, "calls.log");
    await Promise.all([mkdir(bin), mkdir(out)]);
    await Promise.all(
      Object.entries(FAKES).map(async ([name, body]) => {
        await writeFile(join(bin, name), body);
        await chmod(join(bin, name), 0o755);
      })
    );
    await writeFile(log, "");
  });

  afterEach(async () => {
    await rm(base, { force: true, recursive: true });
  });

  const run = (extraEnv = {}) =>
    new Promise((resolve) => {
      execFile(
        "bash",
        [DUMP, out],
        {
          env: {
            BACKUP_ENVIRONMENT: "staging",
            FAKE_LOG: log,
            FAKE_PREFLIGHT: "",
            HOME: base,
            PATH: `${join(base, "bin")}${delimiter}${process.env.PATH}`,
            PGDATABASE: "polaris",
            PGHOST: "ep-quiet-sun.sa-east-1.aws.neon.tech",
            PGPASSWORD: PASSWORD,
            PGSSLMODE: "verify-full",
            PGUSER: "polaris_backup_reader",
            ...extraEnv,
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? error.code : 0, stderr, stdout })
      );
    });
  const calls = async () => (await readFile(log, "utf8")).split("\n");

  it("writes a valid manifest and calls the tools with the snapshot", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok: pg_dump");
    expect(result.stdout).toContain("ok: roles");

    const manifest = JSON.parse(
      await readFile(join(out, "manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      environment: "staging",
      format: 1,
      pg_dump_major: 18,
      reference: { tables: { "public.a": 1 } },
      server_version_num: 180_006,
      snapshot_at: "2026-11-04T06:22:00Z",
    });
    expect((await readdir(out)).sort()).toEqual([
      "dump",
      "manifest.json",
      "roles.sql",
    ]);

    const lines = await calls();
    const dump = lines.find((line) => line.startsWith("pg_dump --format"));
    expect(dump).toContain(`--snapshot=${SNAPSHOT}`);
    expect(dump).toContain("--format=custom");
    expect(dump).toContain(`--file=${out}/dump`);
    expect(dump).not.toMatch(VERBOSE_FLAG);
    const roles = lines.find((line) => line.startsWith("pg_dumpall"));
    expect(roles).toContain("--no-role-passwords");
    expect(roles).toContain("--database=polaris");
  });

  it("never prints the password", async () => {
    const ok = await run();
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(PASSWORD);
    const refused = await run({ PGSSLMODE: "require" });
    expect(`${refused.stdout}${refused.stderr}`).not.toContain(PASSWORD);
    expect((await calls()).join("\n")).not.toContain(PASSWORD);
  });

  it("stops before any dump when the preflight reports a failure", async () => {
    const result = await run({
      FAKE_PREFLIGHT: "login: superuser",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refused: login: superuser");
    const lines = await calls();
    expect(lines.some((line) => line.startsWith("pg_dump --format"))).toBe(
      false
    );
    expect(lines.some((line) => line.startsWith("pg_dumpall"))).toBe(false);
    expect(await readdir(out)).toEqual([]);
  });

  it.each([
    [
      "a pooler host",
      { PGHOST: "ep-quiet-sun-pooler.sa-east-1.aws.neon.tech" },
      "pooler",
    ],
    ["a missing PGSSLMODE", { PGSSLMODE: "" }, "verify-full"],
    [
      "BACKUP_ENVIRONMENT=dev",
      { BACKUP_ENVIRONMENT: "dev" },
      "staging or production",
    ],
    [
      "a URI in PGDATABASE",
      { PGDATABASE: "postgresql://u@h/db" },
      "connection string",
    ],
    ["PGOPTIONS", { PGOPTIONS: "-c role=x" }, "PGOPTIONS"],
  ])("refuses %s without running a tool", async (_name, change, text) => {
    const result = await run(change);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(text);
    expect((await calls()).some((line) => line.startsWith("psql"))).toBe(false);
    expect(await readdir(out)).toEqual([]);
  });

  it("refuses a pg_dump older than 18", async () => {
    const result = await run({ FAKE_DUMP_MAJOR: "16" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pg_dump 16 is older than 18");
    expect((await calls()).some((line) => line.startsWith("psql"))).toBe(false);
  });
});
