import { describe, expect, it } from "vitest";
import {
  type OwnerRoleRow,
  ownerAttributeFindings,
} from "./owner-role-attributes";

const clean = (rolname: string): OwnerRoleRow => ({
  rolbypassrls: false,
  rolcanlogin: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolname,
  rolreplication: false,
  rolsuper: false,
});

describe("the attributes of the owner and runtime-reachable roles", () => {
  it("reports nothing for roles that are NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOBYPASSRLS", () => {
    expect(
      ownerAttributeFindings([
        clean("polaris_billing_owner"),
        clean("polaris_purge_owner"),
      ])
    ).toEqual([]);
  });

  it("reports nothing when there is no role", () => {
    expect(ownerAttributeFindings([])).toEqual([]);
  });

  it.each([
    ["rolcanlogin", "LOGIN"],
    ["rolsuper", "SUPERUSER"],
    ["rolcreaterole", "CREATEROLE"],
    ["rolcreatedb", "CREATEDB"],
    ["rolreplication", "REPLICATION"],
    ["rolbypassrls", "BYPASSRLS"],
  ] as const)("names the role and %s as %s", (column, attribute) => {
    expect(
      ownerAttributeFindings([
        clean("polaris_billing_owner"),
        { ...clean("polaris_purge_owner"), [column]: true },
      ])
    ).toEqual([`polaris_purge_owner: ${attribute}`]);
  });

  it("lists every attribute of every role that has one", () => {
    expect(
      ownerAttributeFindings([
        { ...clean("polaris_a_owner"), rolbypassrls: true, rolcanlogin: true },
        { ...clean("polaris_b_owner"), rolcreatedb: true },
      ])
    ).toEqual([
      "polaris_a_owner: LOGIN",
      "polaris_a_owner: BYPASSRLS",
      "polaris_b_owner: CREATEDB",
    ]);
  });

  it("does not ask LOGIN of the roles it is told may log in, and asks the rest", () => {
    const login = { ...clean("polaris_app"), rolcanlogin: true };
    expect(ownerAttributeFindings([login], new Set(["polaris_app"]))).toEqual(
      []
    );
    expect(
      ownerAttributeFindings(
        [{ ...login, rolcreatedb: true }],
        new Set(["polaris_app"])
      )
    ).toEqual(["polaris_app: CREATEDB"]);
    expect(ownerAttributeFindings([login])).toEqual(["polaris_app: LOGIN"]);
  });
});
