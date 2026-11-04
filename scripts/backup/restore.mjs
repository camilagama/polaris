#!/usr/bin/env node
// Restore drill of a sealed backup into an empty database of a disposable Neon branch (docs/runbooks/backup.md). It
// runs the logical restore of docs/runbooks/deletion-ledger-restore.md (steps 2, 2b and the checks of step 5) and
// compares the restored database with the manifest taken in the snapshot of the dump: row count of every table,
// migrations, function ACLs, row security, policies and the deletion ledger.
//
//   node scripts/backup/restore.mjs --archive <file.tar.age> --identity <age identity> [--sha256 <hex>]
//     [--workdir <directory>] [--keep-workdir]
//
// The connection is only the libpq variables of the target (PGHOST, PGDATABASE, PGUSER, PGPASSWORD or ~/.pgpass,
// PGSSLMODE=verify-full), never a URL. The target database must be empty and carry the comment
// `polaris.environment=restore-drill`. The report has counts, hashes and check names only; the decrypted files and
// pg_restore's stderr (which can quote rows) stay in a 0700 directory that is removed at the end.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARCHIVE_ENTRIES,
  aclAsRoles,
  aclEntries,
  aclFindings,
  RESTORE_ENVIRONMENT,
  referenceFindings,
  restoreOutcome,
  targetFindings,
  validManifest,
} from "./restore-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE_SQL = join(here, "sql", "reference.sql");
const DIGEST = /^[0-9a-f]{64}$/;
const VERSION_MAJOR = /\b(\d+)(?:\.\d+)+\b/;
const BACKUP_READER = "polaris_backup_reader";
const CONNECTION_STRING = /[=]|:\/\//;
const POOLER_HOST = /-pooler(\.|$)/;

const TARGET_SQL = `SET search_path = pg_catalog;
SELECT jsonb_build_object(
  'database', current_database(),
  'comment', shobj_description(d.oid, 'pg_database'),
  'session_marker', coalesce(current_setting('polaris.environment', true), ''),
  'bypass', (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'relations', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
                   AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')),
  'owner_roles', (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'polaris\\_%\\_owner')
)::text
  FROM pg_database d WHERE d.datname = current_database();`;

// deletion-ledger-restore.md, step 2.1; the backup login is left out: nothing of the restore needs to become it
const PREPARE_SQL = `DO $grant$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\\_%' AND rolname <> '${BACKUP_READER}' LOOP
    EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE', r);
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\\_%\\_owner' LOOP
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
  END LOOP;
END
$grant$;`;

// step 2b.3: the role grants are of the cluster, so they are revoked on every way out, a failed restore included
const REVOKE_SQL = `DO $revoke$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\\_%\\_owner' LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\\_%' AND rolname <> '${BACKUP_READER}' LOOP
    EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
  END LOOP;
END
$revoke$;
SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
 WHERE r.rolname LIKE 'polaris\\_%' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND m.set_option;`;

const PSQL = [
  "--no-psqlrc",
  "--quiet",
  "--no-align",
  "--tuples-only",
  "--set=ON_ERROR_STOP=1",
];

class DrillError extends Error {}

function refuse(message) {
  throw new DrillError(message);
}

/** Runs a program with the inherited environment; resolves with its exit code and output, never rejects on a code. */
export function runProgram(command, args, { input, interactive } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [interactive ? "inherit" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      if (interactive) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    );
    if (!interactive) {
      child.stdin.end(input ?? "");
    }
  });
}

function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function connectionFindings(env) {
  const findings = [];
  for (const name of ["PGHOST", "PGDATABASE"]) {
    if (!env[name]) {
      findings.push(`${name} is not set`);
    }
  }
  if (CONNECTION_STRING.test(env.PGDATABASE ?? "")) {
    findings.push(
      "PGDATABASE must be a database name, not a connection string"
    );
  }
  if (env.PGSSLMODE !== "verify-full") {
    findings.push("PGSSLMODE must be verify-full");
  }
  if (POOLER_HOST.test(env.PGHOST ?? "")) {
    findings.push("use the direct host, not the pooler");
  }
  return findings;
}

function drill(run, workdir) {
  const ok = async (step, command, args, options) => {
    const result = await run(command, args, options);
    if (result.code !== 0) {
      refuse(`${step} failed (exit ${result.code})`);
    }
    return result.stdout;
  };
  const sql = (step, text) =>
    ok(step, "psql", [...PSQL, "--file=-"], { input: text });
  const json = async (step, text) => {
    const lines = (await sql(step, text)).trim().split("\n");
    return JSON.parse(lines.at(-1) ?? "null");
  };
  return { json, ok, sql, workdir };
}

async function toolsMajor(run) {
  const [restore, psql, age] = await Promise.all([
    run("pg_restore", ["--version"]),
    run("psql", ["--version"]),
    run("age", ["--version"]),
  ]);
  const majors = {};
  for (const [tool, result] of [
    ["pg_restore", restore],
    ["psql", psql],
  ]) {
    const major = Number(VERSION_MAJOR.exec(result.stdout)?.[1]);
    if (result.code !== 0 || !(major >= 18)) {
      refuse(`${tool} 18 or newer is required`);
    }
    majors[tool] = major;
  }
  if (age.code !== 0) {
    refuse("age is required");
  }
  return majors;
}

async function openArchive(step, options, dir) {
  const plain = join(dir, "backup.tar");
  await step.ok(
    "age decryption",
    "age",
    [
      "--decrypt",
      "--identity",
      options.identity,
      "--output",
      plain,
      options.archive,
    ],
    { interactive: true }
  );
  const listed = (
    await step.ok("tar listing", "tar", ["--list", "--file", plain])
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(listed) !== JSON.stringify(ARCHIVE_ENTRIES)) {
    refuse(
      "the archive does not hold exactly dump, manifest.json and roles.sql"
    );
  }
  await step.ok("tar extraction", "tar", [
    "--extract",
    "--no-same-owner",
    "--file",
    plain,
    "--directory",
    dir,
  ]);
  await rm(plain);
  return validManifest(
    JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))
  );
}

async function restoreAndReplayAcls(step, run, env, dir, origin) {
  const dump = join(dir, "dump");
  const restored = await run("pg_restore", [
    `--dbname=${env.PGDATABASE}`,
    "--no-password",
    dump,
  ]);
  await writeFile(join(dir, "restore.err"), restored.stderr, { mode: 0o600 });
  const outcome = restoreOutcome(restored.code, restored.stderr);
  if (!outcome.ok) {
    refuse(`pg_restore not accepted (${outcome.reason})`);
  }
  const listing = await step.ok("pg_restore listing", "pg_restore", [
    "--list",
    dump,
  ]);
  const acl = aclEntries(listing);
  if (acl.length === 0) {
    refuse("the dump has no ACL entry");
  }
  await writeFile(join(dir, "acl.lst"), `${acl.join("\n")}\n`, { mode: 0o600 });
  await step.ok("ACL script", "pg_restore", [
    "--use-list",
    join(dir, "acl.lst"),
    "--use-set-session-authorization",
    "--file",
    join(dir, "acl.sql"),
    dump,
  ]);
  const roleSql = aclAsRoles(await readFile(join(dir, "acl.sql"), "utf8"));
  await step.sql("ACL replay", roleSql);
  const reference = await readFile(REFERENCE_SQL, "utf8");
  const findings = aclFindings(origin, await step.json("ACL check", reference));
  if (findings.length > 0) {
    refuse(`ACL check (step 2b.2): ${findings.join("; ")}`);
  }
  return {
    aclEntries: acl.length,
    platformErrors: outcome.platform,
    rc: restored.code,
  };
}

/** The drill; `run` is injected so the order of the steps (preparation before, revocation always) is testable. */
export async function runDrill(
  options,
  { env = process.env, run = runProgram } = {}
) {
  const connection = connectionFindings(env);
  if (connection.length > 0) {
    refuse(connection.join("; "));
  }
  const majors = await toolsMajor(run);
  if (options.sha256 !== undefined) {
    if (!DIGEST.test(options.sha256)) {
      refuse("--sha256 must be 64 hex characters");
    }
    if ((await sha256Of(options.archive)) !== options.sha256) {
      refuse("the archive does not match --sha256");
    }
  }
  const dir = await mkdtemp(
    join(options.workdir ?? tmpdir(), "polaris-restore-")
  );
  const step = drill(run, dir);
  try {
    const manifest = await openArchive(step, options, dir);
    if (majors.pg_restore < manifest.pg_dump_major) {
      refuse("pg_restore is older than the pg_dump of the backup");
    }
    const target = await step.json("target check", TARGET_SQL);
    const findings = targetFindings(target, env.PGDATABASE, manifest);
    if (findings.length > 0) {
      refuse(`target refused: ${findings.join("; ")}`);
    }
    const restored = await prepared(step, () =>
      restoreAndReplayAcls(step, run, env, dir, manifest.reference)
    );
    const final = await step.json(
      "final check",
      await readFile(REFERENCE_SQL, "utf8")
    );
    const differences = referenceFindings(manifest.reference, final);
    return {
      checks: differences,
      environment: manifest.environment,
      ok: differences.length === 0,
      restore: restored,
      rows: Object.values(final.tables ?? {}).reduce(
        (sum, rows) => sum + rows,
        0
      ),
      snapshot_at: manifest.snapshot_at,
      tables: Object.keys(final.tables ?? {}).length,
      target: RESTORE_ENVIRONMENT,
    };
  } finally {
    if (!options.keepWorkdir) {
      await rm(dir, { force: true, recursive: true });
    }
  }
}

async function prepared(step, body) {
  let result;
  let failure;
  try {
    await step.sql("preparation (step 2.1)", PREPARE_SQL);
    result = await body();
  } catch (error) {
    failure = error;
  }
  const remaining = (
    await step.sql("revocation (step 2b.3)", REVOKE_SQL)
  ).trim();
  if (remaining !== "0") {
    const before =
      failure instanceof DrillError ? ` (after: ${failure.message})` : "";
    refuse(`SET grants left on polaris_* roles after the revocation${before}`);
  }
  if (failure) {
    throw failure;
  }
  return result;
}

function parseArgs(args) {
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const options = {
    archive: value("--archive"),
    identity: value("--identity"),
    keepWorkdir: args.includes("--keep-workdir"),
    sha256: value("--sha256"),
    workdir: value("--workdir"),
  };
  if (!(options.archive && options.identity)) {
    refuse(
      "usage: restore.mjs --archive <file.tar.age> --identity <age identity> [--sha256 <hex>] [--workdir <dir>] [--keep-workdir]"
    );
  }
  return options;
}

async function main() {
  try {
    const report = await runDrill(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(
      `restore drill refused: ${error instanceof DrillError ? error.message : "unexpected failure"}`
    );
    if (!(error instanceof DrillError)) {
      console.error(error instanceof Error ? error.name : "unknown");
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
