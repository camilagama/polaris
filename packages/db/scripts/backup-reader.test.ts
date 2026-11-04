import { describe, expect, it } from "vitest";
import { type BackupReaderRow, backupReaderFindings } from "./backup-reader";

const documented = (): BackupReaderRow => ({
  members: [],
  memberships: [
    { admin: false, inherit: true, role: "pg_read_all_data", set: false },
  ],
  references: 0,
  rolbypassrls: true,
  rolcanlogin: true,
  rolconfig: ["default_transaction_read_only=on"],
  rolconnlimit: 2,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolreplication: false,
  rolsuper: false,
});

describe("the backup login accepted by the environment checks", () => {
  it("has no finding when it is exactly the documented one", () => {
    expect(backupReaderFindings(documented())).toEqual([]);
  });

  it("accepts other role settings next to the read-only one", () => {
    expect(
      backupReaderFindings({
        ...documented(),
        rolconfig: [
          "statement_timeout=10min",
          "default_transaction_read_only=on",
        ],
      })
    ).toEqual([]);
  });

  it.each([
    ["rolcanlogin", false, "not LOGIN"],
    ["rolsuper", true, "not NOSUPERUSER"],
    ["rolcreatedb", true, "not NOCREATEDB"],
    ["rolcreaterole", true, "not NOCREATEROLE"],
    ["rolreplication", true, "not NOREPLICATION"],
    ["rolbypassrls", false, "not BYPASSRLS"],
    ["rolinherit", true, "not NOINHERIT"],
  ] as const)("names %s = %s as %s", (column, value, finding) => {
    expect(backupReaderFindings({ ...documented(), [column]: value })).toEqual([
      finding,
    ]);
  });

  it("refuses another connection limit, unlimited included", () => {
    for (const rolconnlimit of [-1, 3]) {
      expect(backupReaderFindings({ ...documented(), rolconnlimit })).toEqual([
        "CONNECTION LIMIT is not 2",
      ]);
    }
  });

  it("refuses a login that is not read-only by default", () => {
    for (const rolconfig of [null, [], ["default_transaction_read_only=off"]]) {
      expect(backupReaderFindings({ ...documented(), rolconfig })).toEqual([
        "default_transaction_read_only is not on for the login",
      ]);
    }
  });

  it("refuses a membership besides pg_read_all_data, a runtime group included", () => {
    const row = documented();
    row.memberships.push({
      admin: false,
      inherit: true,
      role: "polaris_pr11_runtime",
      set: true,
    });
    expect(backupReaderFindings(row)).toEqual([
      "member of polaris_pr11_runtime, besides pg_read_all_data",
    ]);
  });

  it("checks pg_read_all_data wherever it sorts among the memberships", () => {
    const row = documented();
    row.memberships.unshift({
      admin: false,
      inherit: true,
      role: "neon_superuser",
      set: true,
    });
    expect(backupReaderFindings(row)).toEqual([
      "member of neon_superuser, besides pg_read_all_data",
    ]);
  });

  it("refuses a login without pg_read_all_data, or with another role in its place", () => {
    expect(backupReaderFindings({ ...documented(), memberships: [] })).toEqual([
      "not a member of pg_read_all_data",
    ]);
    expect(
      backupReaderFindings({
        ...documented(),
        memberships: [
          {
            admin: false,
            inherit: true,
            role: "pg_write_all_data",
            set: false,
          },
        ],
      })
    ).toEqual([
      "not a member of pg_read_all_data",
      "member of pg_write_all_data, besides pg_read_all_data",
    ]);
  });

  it.each([
    ["inherit", false],
    ["set", true],
    ["admin", true],
  ] as const)("refuses pg_read_all_data with %s = %s", (option, value) => {
    const row = documented();
    row.memberships = [
      {
        admin: false,
        inherit: true,
        role: "pg_read_all_data",
        set: false,
        [option]: value,
      },
    ];
    expect(backupReaderFindings(row)).toEqual([
      "pg_read_all_data must be granted WITH INHERIT TRUE, SET FALSE, ADMIN FALSE",
    ]);
  });

  it("refuses a role that can become the backup login", () => {
    expect(
      backupReaderFindings({
        ...documented(),
        members: ["polaris_staging_tenant"],
      })
    ).toEqual(["polaris_staging_tenant can become the backup login"]);
  });

  it("refuses a login that owns an object or is named by a grant or a policy", () => {
    expect(backupReaderFindings({ ...documented(), references: 1 })).toEqual([
      "owns objects or is named by a grant, policy or default privilege",
    ]);
  });
});
