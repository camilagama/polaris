// The pure part of the restore drill (scripts/backup/restore.mjs): what counts as an acceptable pg_restore, how the
// ACL entries are replayed as their owners, and the comparison of the restored database with the manifest of the
// backup. Every message names a check, never a value of the database.

export const RESTORE_ENVIRONMENT = "restore-drill";
export const RESTORE_MARKER = `polaris.environment=${RESTORE_ENVIRONMENT}`;
export const ARCHIVE_ENTRIES = ["dump", "manifest.json", "roles.sql"];
export const BACKUP_ENVIRONMENTS = ["production", "staging"];
const MIN_OWNER_ROLES = 21;
const PURGE_OWNER = "polaris_purge_owner";
const PURGE_RUNTIMES = "polaris_privacy_runtime";

const PLATFORM_DEFAULT_ACL =
  /^Command was: ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin\b/;
const RESTRICT = /^\\restrict [A-Za-z0-9]+$/;
const UNRESTRICT = /^\\unrestrict [A-Za-z0-9]+$/;
const ACL_ENTRY = /^[0-9]+; [0-9]+ [0-9]+ ACL /;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KNOWN_LINES = [
  /^pg_restore: while PROCESSING TOC:$/,
  /^pg_restore: from TOC entry \d+; \d+ \d+ DEFAULT ACL /,
  /^pg_restore: warning: errors ignored on restore: \d+$/,
];

/**
 * The two outcomes the runbook accepts (deletion-ledger-restore.md, step 2): rc 0 with nothing on stderr, or rc 1
 * whose only errors are the `ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin` Neon refuses. Anything else, a warning
 * included, refuses.
 */
export function restoreOutcome(rc, stderr) {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  if (rc === 0) {
    return lines.length === 0
      ? { errors: 0, ok: true, platform: 0 }
      : { errors: 0, ok: false, platform: 0, reason: "rc 0 with output" };
  }
  let errors = 0;
  let platform = 0;
  let unknown = 0;
  for (const line of lines) {
    if (line.startsWith("pg_restore: error: ")) {
      errors += 1;
    } else if (PLATFORM_DEFAULT_ACL.test(line)) {
      platform += 1;
    } else if (!KNOWN_LINES.some((known) => known.test(line))) {
      unknown += 1;
    }
  }
  const ok = rc === 1 && errors > 0 && errors === platform && unknown === 0;
  return ok
    ? { errors, ok, platform }
    : {
        errors,
        ok,
        platform,
        reason: `rc ${rc}, ${errors} error(s), ${platform} of cloud_admin, ${unknown} other line(s)`,
      };
}

export function aclEntries(listing) {
  return listing.split("\n").filter((line) => ACL_ENTRY.test(line));
}

/**
 * The ACL script of `pg_restore -L acl.lst --use-set-session-authorization` rewritten to SET ROLE, which the
 * preparation allows the login (deletion-ledger-restore.md, step 2b.1). Refuses when a line the login cannot run is left.
 */
export function aclAsRoles(sql) {
  const metaCommands = sql.split("\n").filter((line) => line.startsWith("\\"));
  const guarded =
    metaCommands.some((line) => RESTRICT.test(line)) &&
    metaCommands.every((line) => RESTRICT.test(line) || UNRESTRICT.test(line));
  if (!guarded) {
    throw new Error(
      "the ACL script must be guarded by \\restrict and carry no other psql meta-command"
    );
  }
  const rewritten = sql
    .replace(/^SET SESSION AUTHORIZATION /gm, "SET ROLE ")
    .replace(/^RESET SESSION AUTHORIZATION;/gm, "RESET ROLE;")
    .replace(/^SET ROLE 'pg_database_owner';/gm, "RESET ROLE;");
  if (
    rewritten.includes("SESSION AUTHORIZATION") ||
    rewritten.includes("SET ROLE 'pg_database_owner'")
  ) {
    throw new Error("the ACL script still has a command the login cannot run");
  }
  return rewritten;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function referenceShapeFindings(reference) {
  const findings = [];
  const tables = reference?.tables;
  if (
    !(tables && typeof tables === "object" && !Array.isArray(tables)) ||
    Object.keys(tables).length === 0 ||
    !Object.values(tables).every(isCount)
  ) {
    findings.push("tables");
  }
  for (const name of [
    "owner_roles",
    "foreign_owner_definers",
    "public_executable_definers",
    "permissive_public_policies",
    "ledger_not_reapplied",
    "ledger_rows",
  ]) {
    if (!isCount(reference?.[name])) {
      findings.push(name);
    }
  }
  for (const name of ["function_acl_hash", "public_schema_acl"]) {
    if (typeof reference?.[name] !== "string") {
      findings.push(name);
    }
  }
  if (!Array.isArray(reference?.purge_functions)) {
    findings.push("purge_functions");
  }
  return findings;
}

export function validManifest(manifest, expectedEnvironment) {
  const findings = [];
  if (manifest?.format !== 1) {
    findings.push("format");
  }
  if (
    !BACKUP_ENVIRONMENTS.includes(manifest?.environment) ||
    manifest.environment !== expectedEnvironment
  ) {
    findings.push("environment");
  }
  if (
    typeof manifest?.snapshot_at !== "string" ||
    !UTC_INSTANT.test(manifest.snapshot_at)
  ) {
    findings.push("snapshot_at");
  }
  if (!(isCount(manifest?.pg_dump_major) && manifest.pg_dump_major >= 18)) {
    findings.push("pg_dump_major");
  }
  findings.push(
    ...referenceShapeFindings(manifest?.reference).map(
      (name) => `reference.${name}`
    )
  );
  if (findings.length > 0) {
    throw new Error(`the manifest is not valid: ${findings.join(", ")}`);
  }
  return manifest;
}

/**
 * The database the drill restores into: empty, named as the connection says, marked `restore-drill` (never the
 * environment of the backup), read by a login that bypasses row security, with the owner roles of the backup.
 */
export function targetFindings(target, database, manifest) {
  const findings = [];
  if (target.database !== database) {
    findings.push("the connection is not on PGDATABASE");
  }
  if (target.comment !== RESTORE_MARKER) {
    findings.push(`the database comment is not exactly ${RESTORE_MARKER}`);
  }
  if (!["", RESTORE_ENVIRONMENT].includes(target.session_marker)) {
    findings.push("the session names another environment");
  }
  if (target.bypass !== true) {
    findings.push(
      "the login does not bypass row security (the counts would be zero)"
    );
  }
  if (target.relations !== 0) {
    findings.push("the database is not empty");
  }
  if (target.owner_roles !== manifest.reference.owner_roles) {
    findings.push(
      "the polaris_*_owner roles are not those of the backup (create them first)"
    );
  }
  return findings;
}

function purgeFunctionFindings(origin, restored) {
  const findings = [];
  if (JSON.stringify(origin) !== JSON.stringify(restored)) {
    findings.push("purge functions differ from the backup");
  }
  // both functions exist since migration 0110, and every backup this job takes is newer
  for (const row of restored ?? []) {
    if (
      row.owner !== PURGE_OWNER ||
      row.public_execute !== false ||
      row.runtimes_with_execute !== PURGE_RUNTIMES
    ) {
      findings.push(
        `purge function ${row.function} is not ${PURGE_OWNER}, without PUBLIC, executed only by ${PURGE_RUNTIMES}`
      );
    }
  }
  return findings;
}

/** Step 2b.2: the function ACLs, checked while the preparation is still granted. */
export function aclFindings(origin, restored) {
  const findings = [];
  if (restored.public_executable_definers !== 0) {
    findings.push("SECURITY DEFINER functions executable by PUBLIC");
  }
  if (restored.function_acl_hash !== origin.function_acl_hash) {
    findings.push("function ACL hash differs from the backup");
  }
  findings.push(
    ...purgeFunctionFindings(origin.purge_functions, restored.purge_functions)
  );
  return findings;
}

function tableFindings(origin, restored) {
  const names = new Set([
    ...Object.keys(origin.tables),
    ...Object.keys(restored.tables ?? {}),
  ]);
  const findings = [];
  for (const name of [...names].sort()) {
    if (!(name in (restored.tables ?? {}))) {
      findings.push(`table ${name} missing`);
    } else if (!(name in origin.tables)) {
      findings.push(`table ${name} not in the backup`);
    } else if (origin.tables[name] !== restored.tables[name]) {
      findings.push(`table ${name}: row count differs`);
    }
  }
  return findings;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Steps 2b.3 and 5: everything the restored database must reproduce of the backup, after the preparation is gone. */
export function referenceFindings(origin, restored) {
  const findings = [
    ...tableFindings(origin, restored),
    ...aclFindings(origin, restored),
  ];
  const checks = [
    [same(origin.migrations, restored.migrations), "migrations differ"],
    [
      (restored.migrations?.count ?? 0) > 0,
      "no migration in the restored database",
    ],
    [
      restored.owner_roles === origin.owner_roles &&
        restored.owner_roles >= MIN_OWNER_ROLES,
      `polaris_*_owner roles are not the ${MIN_OWNER_ROLES}+ of the backup`,
    ],
    [
      restored.foreign_owner_definers === 0,
      "SECURITY DEFINER functions owned by a role that is not polaris_*_owner",
    ],
    [
      restored.public_schema_acl === origin.public_schema_acl,
      "ACL of schema public differs",
    ],
    [
      same(origin.rls_tables, restored.rls_tables),
      "tables with forced row security differ",
    ],
    [same(origin.policies, restored.policies), "policies differ"],
    [
      restored.permissive_public_policies === 0,
      "permissive policies for PUBLIC",
    ],
    [
      same(restored.polaris_roles_bypassing_rls, []),
      "polaris_* roles that bypass row security",
    ],
    [
      restored.ledger_not_reapplied === 0,
      "deletion ledger entries without effect",
    ],
    [
      restored.ledger_rows === origin.ledger_rows,
      "deletion ledger row count differs",
    ],
  ];
  for (const [ok, finding] of checks) {
    if (!ok) {
      findings.push(finding);
    }
  }
  return findings;
}
