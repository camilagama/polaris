import { describe, expect, it } from "vitest";
import {
  aclAsRoles,
  aclEntries,
  aclFindings,
  referenceFindings,
  restoreOutcome,
  targetFindings,
  validManifest,
} from "./restore-lib.mjs";

const PLATFORM_STDERR = `pg_restore: while PROCESSING TOC:
pg_restore: from TOC entry 4100; 826 16390 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES cloud_admin
pg_restore: error: could not execute query: ERROR:  permission denied to change default privileges
Command was: ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO neon_superuser WITH GRANT OPTION;
pg_restore: from TOC entry 4101; 826 16391 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES cloud_admin
pg_restore: error: could not execute query: ERROR:  permission denied to change default privileges
Command was: ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON TABLES TO neon_superuser WITH GRANT OPTION;
pg_restore: warning: errors ignored on restore: 2
`;

const purgeFunctions = () => [
  {
    function: "public.count_purges_held_back()",
    owner: "polaris_purge_owner",
    public_execute: false,
    runtimes_with_execute: "polaris_privacy_runtime",
  },
  {
    function: "public.count_purges_stalled_without_progress(integer, integer)",
    owner: "polaris_purge_owner",
    public_execute: false,
    runtimes_with_execute: "polaris_privacy_runtime",
  },
];

const reference = () => ({
  foreign_owner_definers: 0,
  function_acl_hash: "hash-a",
  ledger_not_reapplied: 0,
  ledger_rows: 3,
  migrations: { count: 5, last_created_at: 10, last_hash: "m5" },
  owner_roles: 21,
  permissive_public_policies: 0,
  polaris_roles_bypassing_rls: [],
  policies: { count: 4, hash: "p" },
  public_executable_definers: 0,
  public_schema_acl: "acl-public",
  purge_functions: purgeFunctions(),
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

describe("restoreOutcome", () => {
  it("accepts rc 0 with nothing on stderr", () => {
    expect(restoreOutcome(0, "")).toMatchObject({ ok: true });
    expect(restoreOutcome(0, "\n  \n")).toMatchObject({ ok: true });
  });

  it("refuses rc 0 with a warning", () => {
    const outcome = restoreOutcome(0, "pg_restore: warning: something\n");
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("rc 0");
  });

  it("accepts rc 1 whose only errors are the cloud_admin default privileges", () => {
    expect(restoreOutcome(1, PLATFORM_STDERR)).toEqual({
      errors: 2,
      ok: true,
      platform: 2,
    });
  });

  it("refuses rc 1 with another error", () => {
    const stderr = `${PLATFORM_STDERR}pg_restore: error: could not execute query: ERROR:  relation "x" already exists\nCommand was: CREATE TABLE x ();\n`;
    expect(restoreOutcome(1, stderr).ok).toBe(false);
  });

  it("refuses rc 1 with an unknown line", () => {
    const outcome = restoreOutcome(1, `${PLATFORM_STDERR}something odd\n`);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("1 other line(s)");
  });

  it("refuses rc 1 with no error at all", () => {
    expect(restoreOutcome(1, "").ok).toBe(false);
  });

  it("refuses rc 2 even with the platform errors", () => {
    expect(restoreOutcome(2, PLATFORM_STDERR).ok).toBe(false);
  });
});

describe("aclEntries", () => {
  it("keeps the ACL entries and not the DEFAULT ACL ones", () => {
    const listing = [
      "; Archive created at 2026-11-04",
      "4000; 0 0 ACL - SCHEMA public postgres",
      "4100; 826 16390 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES x",
      "4200; 0 0 ACL public FUNCTION f() polaris_owner",
      "200; 1259 5 TABLE public a postgres",
    ].join("\n");
    expect(aclEntries(listing)).toEqual([
      "4000; 0 0 ACL - SCHEMA public postgres",
      "4200; 0 0 ACL public FUNCTION f() polaris_owner",
    ]);
  });
});

describe("aclAsRoles", () => {
  it("rewrites the three session authorization commands", () => {
    const sql = [
      "\\restrict abc123",
      "SET SESSION AUTHORIZATION 'polaris_sales_owner';",
      "GRANT SELECT ON TABLE a TO x;",
      "RESET SESSION AUTHORIZATION;",
      "SET SESSION AUTHORIZATION 'pg_database_owner';",
      "GRANT USAGE ON SCHEMA public TO y;",
      "\\unrestrict abc123",
    ].join("\n");
    expect(aclAsRoles(sql)).toBe(
      [
        "\\restrict abc123",
        "SET ROLE 'polaris_sales_owner';",
        "GRANT SELECT ON TABLE a TO x;",
        "RESET ROLE;",
        "RESET ROLE;",
        "GRANT USAGE ON SCHEMA public TO y;",
        "\\unrestrict abc123",
      ].join("\n")
    );
  });

  it("refuses when SESSION AUTHORIZATION is left in the middle of a line", () => {
    expect(() =>
      aclAsRoles(
        "\\restrict abc123\nGRANT x; SET SESSION AUTHORIZATION 'a';\n\\unrestrict abc123\n"
      )
    ).toThrow("login cannot run");
  });

  it("refuses a script without \\restrict", () => {
    expect(() => aclAsRoles("GRANT SELECT ON TABLE a TO x;\n")).toThrow(
      "guarded by \\restrict"
    );
  });

  it.each([
    ["a shell escape", "\\! rm -rf /"],
    ["a reconnection", "\\connect other"],
  ])("refuses %s even under \\restrict", (_name, line) => {
    const sql = `\\restrict abc123\n${line}\nGRANT SELECT ON TABLE a TO x;\n\\unrestrict abc123\n`;
    expect(() => aclAsRoles(sql)).toThrow("guarded by \\restrict");
  });

  it("refuses a \\restrict key that is not alphanumeric", () => {
    expect(() =>
      aclAsRoles("\\restrict a-b\nGRANT SELECT ON TABLE a TO x;\n")
    ).toThrow("guarded by \\restrict");
  });
});

describe("validManifest", () => {
  it("accepts a complete manifest", () => {
    const value = manifest();
    expect(validManifest(value, "staging")).toBe(value);
  });

  it.each([
    ["format", (m) => Object.assign(m, { format: 2 }), "format"],
    [
      "environment",
      (m) => Object.assign(m, { environment: "dev" }),
      "environment",
    ],
    [
      "snapshot_at",
      (m) => Object.assign(m, { snapshot_at: "yesterday" }),
      "snapshot_at",
    ],
    [
      "pg_dump_major",
      (m) => Object.assign(m, { pg_dump_major: 16 }),
      "pg_dump_major",
    ],
    [
      "reference.tables",
      (m) => Object.assign(m.reference, { tables: {} }),
      "reference.tables",
    ],
    [
      "reference.ledger_rows",
      (m) => {
        m.reference.ledger_rows = undefined;
        return m;
      },
      "reference.ledger_rows",
    ],
    [
      "reference.purge_functions",
      (m) => Object.assign(m.reference, { purge_functions: null }),
      "reference.purge_functions",
    ],
  ])("refuses a wrong %s and names it", (_name, change, field) => {
    expect(() => validManifest(change(manifest()), "staging")).toThrow(field);
  });

  it("refuses a manifest without a reference", () => {
    expect(() =>
      validManifest({ ...manifest(), reference: undefined }, "staging")
    ).toThrow("reference.tables");
  });

  it("refuses a manifest of another environment than the expected one", () => {
    expect(() => validManifest(manifest(), "production")).toThrow(
      "environment"
    );
    expect(() =>
      validManifest({ ...manifest(), environment: "production" }, "staging")
    ).toThrow("environment");
    const production = { ...manifest(), environment: "production" };
    expect(validManifest(production, "production")).toBe(production);
  });
});

describe("targetFindings", () => {
  const good = () => ({
    bypass: true,
    comment: "polaris.environment=restore-drill",
    database: "drill",
    owner_roles: 21,
    relations: 0,
    session_marker: "",
  });
  const findings = (target) => targetFindings(target, "drill", manifest());

  it("accepts an empty, marked database with the owner roles", () => {
    expect(findings(good())).toEqual([]);
    expect(findings({ ...good(), session_marker: "restore-drill" })).toEqual(
      []
    );
  });

  it.each([
    ["wrong database", { database: "other" }, "PGDATABASE"],
    [
      "staging comment",
      { comment: "polaris.environment=staging" },
      "polaris.environment=restore-drill",
    ],
    [
      "session of another environment",
      { session_marker: "staging" },
      "session",
    ],
    ["no bypass", { bypass: false }, "bypass row security"],
    ["not empty", { relations: 3 }, "not empty"],
    ["different owner roles", { owner_roles: 5 }, "owner roles"],
  ])("refuses %s", (_name, change, text) => {
    const result = findings({ ...good(), ...change });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain(text);
  });
});

describe("aclFindings", () => {
  it("passes a restored ACL equal to the origin", () => {
    expect(aclFindings(reference(), reference())).toEqual([]);
  });

  it("flags definers executable by PUBLIC", () => {
    const restored = { ...reference(), public_executable_definers: 1 };
    expect(aclFindings(reference(), restored)).toEqual([
      "SECURITY DEFINER functions executable by PUBLIC",
    ]);
  });

  it("flags a different function ACL hash", () => {
    const restored = { ...reference(), function_acl_hash: "other" };
    expect(aclFindings(reference(), restored)).toEqual([
      "function ACL hash differs from the backup",
    ]);
  });

  it("flags a purge function with the wrong owner", () => {
    const restored = reference();
    restored.purge_functions[0].owner = "postgres";
    const found = aclFindings(reference(), restored);
    expect(found).toContain("purge functions differ from the backup");
    expect(found.some((text) => text.includes("count_purges_held_back"))).toBe(
      true
    );
  });

  it("flags a purge function executable by PUBLIC even when the origin says so too", () => {
    const origin = reference();
    origin.purge_functions[1].public_execute = true;
    const restored = structuredClone(origin);
    const found = aclFindings(origin, restored);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("count_purges_stalled_without_progress");
  });

  it("flags a purge function absent in both the origin and the restore", () => {
    const origin = reference();
    origin.purge_functions[1] = {
      function:
        "public.count_purges_stalled_without_progress(integer, integer)",
      owner: null,
      public_execute: null,
      runtimes_with_execute: null,
    };
    const found = aclFindings(origin, structuredClone(origin));
    expect(found).toHaveLength(1);
    expect(
      found[0].startsWith(
        "purge function public.count_purges_stalled_without_progress(integer, integer) is not polaris_purge_owner"
      )
    ).toBe(true);
  });

  it("flags a purge function absent only in the restore", () => {
    const origin = reference();
    const restored = reference();
    restored.purge_functions[1] = {
      function: restored.purge_functions[1].function,
      owner: null,
      public_execute: null,
      runtimes_with_execute: null,
    };
    expect(aclFindings(origin, restored)).toContain(
      "purge functions differ from the backup"
    );
  });
});

describe("referenceFindings", () => {
  it("passes a restored database equal to the reference", () => {
    expect(referenceFindings(reference(), reference())).toEqual([]);
  });

  it("flags the table whose count differs by name, without the numbers", () => {
    const restored = reference();
    restored.tables["public.sales"] = 98_764;
    expect(referenceFindings(reference(), restored)).toEqual([
      "table public.sales: row count differs",
    ]);
  });

  it("flags a missing table and an extra table", () => {
    const missing = reference();
    missing.tables = { "public.customers": 41_234 };
    expect(referenceFindings(reference(), missing)).toEqual([
      "table public.sales missing",
    ]);
    const extra = reference();
    extra.tables["public.extra"] = 1;
    expect(referenceFindings(reference(), extra)).toEqual([
      "table public.extra not in the backup",
    ]);
  });

  it.each([
    ["function ACL hash", { function_acl_hash: "x" }, "function ACL hash"],
    ["public schema ACL", { public_schema_acl: "x" }, "ACL of schema public"],
    [
      "rls tables",
      { rls_tables: { forced: 6, hash: "r2", tables: 7 } },
      "forced row security",
    ],
    ["policies", { policies: { count: 3, hash: "p2" } }, "policies differ"],
    [
      "permissive policies",
      { permissive_public_policies: 1 },
      "permissive policies",
    ],
    [
      "bypass roles",
      { polaris_roles_bypassing_rls: ["polaris_x"] },
      "bypass row security",
    ],
    ["ledger not reapplied", { ledger_not_reapplied: 2 }, "without effect"],
    ["ledger rows", { ledger_rows: 4 }, "row count differs"],
    [
      "migrations",
      { migrations: { count: 6, last_created_at: 11, last_hash: "m6" } },
      "migrations differ",
    ],
    ["owner roles", { owner_roles: 20 }, "owner roles"],
    ["foreign definers", { foreign_owner_definers: 1 }, "not polaris_*_owner"],
  ])("flags %s", (_name, change, text) => {
    const found = referenceFindings(reference(), { ...reference(), ...change });
    expect(found.some((entry) => entry.includes(text))).toBe(true);
  });

  it("flags a purge function with the wrong owner or PUBLIC execute", () => {
    const wrongOwner = reference();
    wrongOwner.purge_functions[0].owner = "postgres";
    expect(referenceFindings(reference(), wrongOwner).length).toBeGreaterThan(
      0
    );
    const exposed = reference();
    exposed.purge_functions[0].public_execute = true;
    expect(referenceFindings(reference(), exposed).length).toBeGreaterThan(0);
  });

  it("flags an absent purge function that is absent in the origin too", () => {
    const origin = reference();
    origin.purge_functions[0] = {
      function: origin.purge_functions[0].function,
      owner: null,
      public_execute: null,
      runtimes_with_execute: null,
    };
    const found = referenceFindings(origin, structuredClone(origin));
    expect(found).toHaveLength(1);
    expect(
      found[0].startsWith(
        "purge function public.count_purges_held_back() is not polaris_purge_owner"
      )
    ).toBe(true);
  });

  it.each([
    ["zero", { count: 0, last_created_at: 10, last_hash: "m5" }],
    ["missing", undefined],
  ])("flags a restored database with %s migrations", (_name, migrations) => {
    const origin = reference();
    origin.migrations = migrations;
    const restored = reference();
    restored.migrations = migrations;
    expect(referenceFindings(origin, restored)).toEqual([
      "no migration in the restored database",
    ]);
  });

  it("never puts a row count in a message", () => {
    const restored = reference();
    restored.tables = { "public.extra": 22_222, "public.sales": 11_111 };
    const text = referenceFindings(reference(), restored).join("\n");
    for (const count of ["98765", "41234", "11111", "22222"]) {
      expect(text).not.toContain(count);
    }
    expect(text).toContain("public.sales");
  });
});
