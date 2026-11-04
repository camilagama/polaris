import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDrill } from "./restore.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE_SQL = await readFile(
  join(here, "sql", "reference.sql"),
  "utf8"
);

const PLATFORM_STDERR = `pg_restore: while PROCESSING TOC:
pg_restore: from TOC entry 4100; 826 16390 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES cloud_admin
pg_restore: error: could not execute query: ERROR:  permission denied to change default privileges
Command was: ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON TABLES TO neon_superuser WITH GRANT OPTION;
pg_restore: warning: errors ignored on restore: 1
`;

const reference = () => ({
  foreign_owner_definers: 0,
  function_acl_hash: "hash-a",
  ledger_not_reapplied: 0,
  ledger_rows: 3,
  migrations: { count: 5, last_created_at: 10, last_hash: "m5" },
  owner_roles: 20,
  permissive_public_policies: 0,
  polaris_roles_bypassing_rls: [],
  policies: { count: 4, hash: "p" },
  public_executable_definers: 0,
  public_schema_acl: "acl-public",
  purge_functions: [],
  rls_tables: { forced: 7, hash: "r", tables: 7 },
  tables: { "public.customers": 41_234, "public.sales": 98_765 },
});

const manifest = () => ({
  environment: "staging",
  format: 1,
  pg_dump_major: 18,
  reference: reference(),
  snapshot_at: "2026-11-04T06:22:00Z",
});

const target = () => ({
  bypass: true,
  comment: "polaris.environment=restore-drill",
  database: "drill",
  owner_roles: 20,
  relations: 0,
  session_marker: "",
});

const ENV = {
  PGDATABASE: "drill",
  PGHOST: "ep-quiet-sun.sa-east-1.aws.neon.tech",
  PGSSLMODE: "verify-full",
};

const ARCHIVE_BYTES = "sealed bytes";
const ARCHIVE_SHA256 = createHash("sha256").update(ARCHIVE_BYTES).digest("hex");

const entry = (name) => `-rw------- 0/0 123 2026-11-04 06:22 ${name}`;
const TAR_LISTING = `${["dump", "manifest.json", "roles.sql"].map(entry).join("\n")}\n`;

const ACL_LISTING = [
  "; Archive created",
  "4000; 0 0 ACL - SCHEMA public postgres",
  "200; 1259 5 TABLE public a postgres",
].join("\n");

function flagValue(args, name) {
  return args[args.indexOf(name) + 1];
}

function fakeRun(overrides = {}) {
  const calls = [];
  const state = {
    calls,
    directory: undefined,
    grantFailure: { code: 0, stderr: "" },
    manifest: manifest(),
    pgRestore: { code: 0, stderr: "" },
    restored: reference(),
    revoke: "0",
    tarCalls: [],
    target: target(),
    ...overrides,
  };
  const psql = (input) => {
    if (input.includes("polaris.environment")) {
      calls.push("psql:target");
      return JSON.stringify(state.target);
    }
    if (input.includes("$grant$")) {
      calls.push("psql:grant");
      return "";
    }
    if (input.includes("$revoke$")) {
      calls.push("psql:revoke");
      return state.revoke;
    }
    if (input === REFERENCE_SQL) {
      calls.push("psql:reference");
      return JSON.stringify(state.restored);
    }
    calls.push("psql:acl");
    return "";
  };
  const pgRestore = async (args) => {
    if (args[0] === "--version") {
      return { code: 0, stderr: "", stdout: "pg_restore (PostgreSQL) 18.1\n" };
    }
    if (args[0] === "--list") {
      calls.push("pg_restore:list");
      return { code: 0, stderr: "", stdout: ACL_LISTING };
    }
    if (args[0] === "--use-list") {
      calls.push("pg_restore:acl-script");
      await writeFile(
        flagValue(args, "--file"),
        "\\restrict abc123\nSET SESSION AUTHORIZATION 'polaris_x_owner';\nGRANT SELECT ON TABLE a TO b;\nRESET SESSION AUTHORIZATION;\n\\unrestrict abc123\n"
      );
      return { code: 0, stderr: "", stdout: "" };
    }
    calls.push("pg_restore:restore");
    return { ...state.pgRestore, stdout: "" };
  };
  const tar = async (args) => {
    state.tarCalls.push(args);
    if (args[0] === "--list") {
      return {
        code: 0,
        stderr: "",
        stdout: state.tarListing ?? TAR_LISTING,
      };
    }
    state.directory = flagValue(args, "--directory");
    await Promise.all([
      writeFile(
        join(state.directory, "manifest.json"),
        JSON.stringify(state.manifest)
      ),
      writeFile(join(state.directory, "dump"), "dump"),
      writeFile(join(state.directory, "roles.sql"), "roles"),
    ]);
    return { code: 0, stderr: "", stdout: "" };
  };
  const run = async (command, args, options) => {
    if (command === "psql") {
      if (args[0] === "--version") {
        return { code: 0, stderr: "", stdout: "psql (PostgreSQL) 18.1\n" };
      }
      if (state.grantFailure.code !== 0 && options.input.includes("$grant$")) {
        calls.push("psql:grant");
        return { ...state.grantFailure, stdout: "" };
      }
      return { code: 0, stderr: "", stdout: psql(options.input) };
    }
    if (command === "pg_restore") {
      return pgRestore(args);
    }
    if (command === "age") {
      if (args[0] === "--version") {
        return { code: 0, stderr: "", stdout: "1.2.0\n" };
      }
      calls.push("age");
      await writeFile(flagValue(args, "--output"), "plain tar");
      return { code: 0, stderr: "", stdout: "" };
    }
    if (command === "tar") {
      return tar(args);
    }
    throw new Error(`unexpected program ${command}`);
  };
  return { run, state };
}

describe("runDrill", () => {
  let base;
  let archive;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "restore-test-"));
    archive = join(base, "backup.tar.age");
    await writeFile(archive, ARCHIVE_BYTES);
  });

  afterEach(async () => {
    await rm(base, { force: true, recursive: true });
  });

  const options = (extra = {}) => ({
    archive,
    environment: "staging",
    identity: "identity.txt",
    sha256: ARCHIVE_SHA256,
    workdir: base,
    ...extra,
  });
  const leftovers = async () =>
    (await readdir(base)).filter((name) => name.startsWith("polaris-restore-"));

  it("restores, prepares before pg_restore, revokes after the ACL check and reports no per-table count", async () => {
    const { run, state } = fakeRun();
    const report = await runDrill(options(), { env: ENV, run });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([]);
    expect(report.tables).toBe(2);
    expect(report.rows).toBe(41_234 + 98_765);
    expect(report.target).toBe("restore-drill");
    expect(report.environment).toBe("staging");
    expect(report.ledger_rows).toBe(3);
    expect(report.migrations).toBe(5);
    const text = JSON.stringify(report);
    expect(text).not.toContain("public.sales");
    expect(text).not.toContain("98765");
    expect(text).not.toContain("41234");

    const order = state.calls;
    expect(order.indexOf("psql:grant")).toBeGreaterThan(
      order.indexOf("psql:target")
    );
    expect(order.indexOf("pg_restore:restore")).toBeGreaterThan(
      order.indexOf("psql:grant")
    );
    const aclCheck = order.indexOf("psql:reference");
    expect(order.indexOf("psql:acl")).toBeLessThan(aclCheck);
    expect(order.indexOf("psql:revoke")).toBeGreaterThan(aclCheck);
    expect(order.at(-1)).toBe("psql:reference");
    expect(await leftovers()).toEqual([]);
  });

  it("lists the archive verbosely and extracts without the archive's permissions", async () => {
    const { run, state } = fakeRun();
    await runDrill(options(), { env: ENV, run });
    const listing = state.tarCalls.find((args) => args[0] === "--list");
    const extraction = state.tarCalls.find((args) => args[0] === "--extract");
    expect(listing).toContain("--verbose");
    expect(extraction).toContain("--no-same-permissions");
    expect(extraction).toContain("--no-same-owner");
  });

  it("accepts the cloud_admin default privilege errors of pg_restore", async () => {
    const { run } = fakeRun({
      pgRestore: { code: 1, stderr: PLATFORM_STDERR },
    });
    const report = await runDrill(options(), { env: ENV, run });
    expect(report.ok).toBe(true);
    expect(report.restore.platformErrors).toBe(1);
    expect(report.restore.rc).toBe(1);
  });

  it("refuses a target marked staging without preparing or restoring", async () => {
    const { run, state } = fakeRun({
      target: { ...target(), comment: "polaris.environment=staging" },
    });
    await expect(runDrill(options(), { env: ENV, run })).rejects.toThrow(
      "target refused"
    );
    expect(state.calls).not.toContain("psql:grant");
    expect(state.calls).not.toContain("pg_restore:restore");
    expect(state.calls).not.toContain("psql:revoke");
    expect(await leftovers()).toEqual([]);
  });

  it("revokes even when pg_restore is refused", async () => {
    const { run, state } = fakeRun({
      pgRestore: { code: 1, stderr: "pg_restore: error: boom\n" },
    });
    await expect(runDrill(options(), { env: ENV, run })).rejects.toThrow(
      "pg_restore not accepted"
    );
    expect(state.calls).toContain("psql:grant");
    expect(state.calls.at(-1)).toBe("psql:revoke");
  });

  it("refuses when the revocation leaves grants", async () => {
    const { run } = fakeRun({ revoke: "1" });
    await expect(runDrill(options(), { env: ENV, run })).rejects.toThrow(
      "SET grants left"
    );
  });

  it("refuses a --sha256 that does not match before running age", async () => {
    const { run, state } = fakeRun();
    await expect(
      runDrill(options({ sha256: "0".repeat(64) }), { env: ENV, run })
    ).rejects.toThrow("does not match --sha256");
    expect(state.calls).not.toContain("age");
  });

  it("refuses a --sha256 that is not 64 hex characters", async () => {
    const { run } = fakeRun();
    await expect(
      runDrill(options({ sha256: "abc" }), { env: ENV, run })
    ).rejects.toThrow("--sha256 must be the 64 hex characters");
  });

  it("refuses a run without --sha256 before running age", async () => {
    const { run, state } = fakeRun();
    await expect(
      runDrill(options({ sha256: undefined }), { env: ENV, run })
    ).rejects.toThrow("--sha256 must be the 64 hex characters");
    expect(state.calls).not.toContain("age");
    expect(await leftovers()).toEqual([]);
  });

  it("refuses a manifest of another environment than --environment before touching the target", async () => {
    const { run, state } = fakeRun();
    await expect(
      runDrill(options({ environment: "production" }), { env: ENV, run })
    ).rejects.toThrow("manifest is not valid: environment");
    expect(state.calls).not.toContain("psql:target");
    expect(await leftovers()).toEqual([]);
  });

  it.each([
    [
      "a symbolic link",
      "lrwxrwxrwx 0/0 0 2026-11-04 06:22 dump -> /etc/passwd",
    ],
    ["a hard link", "hrwxrwxrwx 0/0 0 2026-11-04 06:22 dump link to roles.sql"],
    ["a directory", "drwx------ 0/0 0 2026-11-04 06:22 dump"],
    ["a bare name", "dump"],
  ])("refuses an archive entry that is %s", async (_name, line) => {
    const { run, state } = fakeRun({
      tarListing: `${line}\n${entry("manifest.json")}\n${entry("roles.sql")}\n`,
    });
    await expect(runDrill(options(), { env: ENV, run })).rejects.toThrow(
      "does not hold exactly"
    );
    expect(state.tarCalls.some((args) => args[0] === "--extract")).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it("names the first line of psql's stderr when the preparation fails", async () => {
    const { run, state } = fakeRun({
      grantFailure: {
        code: 3,
        stderr: "ERROR:  permission denied to grant role\nDETAIL:  more\n",
      },
    });
    const failure = runDrill(options(), { env: ENV, run });
    await expect(failure).rejects.toThrow("preparation (step 2.1) failed");
    await expect(failure).rejects.toThrow("exit 3");
    await expect(failure).rejects.toThrow(
      "ERROR:  permission denied to grant role"
    );
    await expect(failure).rejects.not.toThrow("DETAIL");
    expect(state.calls).not.toContain("pg_restore:restore");
    expect(state.calls.at(-1)).toBe("psql:revoke");
  });

  it.each([
    ["PGSSLMODE", { PGSSLMODE: "require" }, "verify-full"],
    [
      "a URI in PGDATABASE",
      { PGDATABASE: "postgresql://u@h/db" },
      "connection string",
    ],
    [
      "a pooler host",
      { PGHOST: "ep-quiet-sun-pooler.sa-east-1.aws.neon.tech" },
      "pooler",
    ],
    ["a missing PGHOST", { PGHOST: "" }, "PGHOST is not set"],
    ["PGOPTIONS", { PGOPTIONS: "-c role=postgres" }, "PGOPTIONS must be empty"],
    ["PGSERVICE", { PGSERVICE: "prod" }, "PGSERVICE must be empty"],
    [
      "PGSERVICEFILE",
      { PGSERVICEFILE: "/tmp/service.conf" },
      "PGSERVICEFILE must be empty",
    ],
  ])("refuses %s before running any program", async (_name, change, text) => {
    const { run, state } = fakeRun();
    const seen = [];
    const spy = (command, args, runOptions) => {
      seen.push(command);
      return run(command, args, runOptions);
    };
    await expect(
      runDrill(options(), { env: { ...ENV, ...change }, run: spy })
    ).rejects.toThrow(text);
    expect(seen).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("refuses an archive with an unexpected entry", async () => {
    const { run } = fakeRun({
      tarListing: `${TAR_LISTING}${entry("extra")}\n`,
    });
    await expect(runDrill(options(), { env: ENV, run })).rejects.toThrow(
      "exactly dump, manifest.json and roles.sql"
    );
    expect(await leftovers()).toEqual([]);
  });

  it("keeps the working directory with keepWorkdir", async () => {
    const { run, state } = fakeRun();
    await runDrill(options({ keepWorkdir: true }), { env: ENV, run });
    expect(existsSync(state.directory)).toBe(true);
    expect(await leftovers()).toHaveLength(1);
  });

  it("answers ok false and names the check when the final reference differs", async () => {
    const restored = reference();
    restored.tables["public.sales"] = 1;
    const { run, state } = fakeRun({ restored });
    const report = await runDrill(options(), { env: ENV, run });
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(["table public.sales: row count differs"]);
    expect(state.calls.at(-1)).toBe("psql:reference");
  });
});
