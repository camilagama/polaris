import { describe, expect, it } from "vitest";
import {
  CLOSED_EXPORT_POLICIES_SQL,
  closedExportPolicyQual,
  isClosedExportPolicyQual,
  POLICY_READ_SEARCH_PATH_SQL,
  type PolicyReadPool,
  readClosedExportPolicies,
} from "./closed-export-policy-qual";

const REAL =
  "(organization_id = ( SELECT closed_export_organization() AS closed_export_organization))";
const REAL_ORGANIZATIONS =
  "(id = ( SELECT closed_export_organization() AS closed_export_organization))";
const INNER =
  "organization_id = ( SELECT closed_export_organization() AS closed_export_organization)";

describe("isClosedExportPolicyQual", () => {
  it("accepts the qual PostgreSQL returns, per table", () => {
    expect(closedExportPolicyQual("sales")).toBe(REAL);
    expect(closedExportPolicyQual("organizations")).toBe(REAL_ORGANIZATIONS);
    expect(isClosedExportPolicyQual("sales", REAL)).toBe(true);
    expect(isClosedExportPolicyQual("organizations", REAL_ORGANIZATIONS)).toBe(
      true
    );
  });

  it("accepts different whitespace between the same tokens", () => {
    expect(
      isClosedExportPolicyQual(
        "sales",
        "(organization_id  =\n( SELECT  closed_export_organization()  AS closed_export_organization))"
      )
    ).toBe(true);
  });

  it.each([
    ["true OR the right qual", `(true OR ${REAL})`],
    ["true OR the inner condition", `(true OR (${INNER}))`],
    ["the right qual OR true", `(${REAL} OR true)`],
    ["the inner condition OR true", `((${INNER}) OR true)`],
    ["the right qual AND something else", `(${REAL} AND other_thing)`],
    ["the inner condition AND something else", `((${INNER}) AND (x = 1))`],
    ["a bare true", "true"],
    ["a prefix before the right qual", `true OR ${REAL}`],
    ["a suffix after the right qual", `${REAL} OR true`],
    ["a semicolon after the right qual", `${REAL};`],
  ])("rejects %s", (_name, qual) => {
    expect(isClosedExportPolicyQual("sales", qual)).toBe(false);
  });

  it("rejects a widened qual on organizations, whose column is id", () => {
    const inner = REAL_ORGANIZATIONS.slice(1, -1);
    expect(
      isClosedExportPolicyQual("organizations", `(true OR (${inner}))`)
    ).toBe(false);
    expect(
      isClosedExportPolicyQual("organizations", `((${inner}) OR true)`)
    ).toBe(false);
  });

  it("rejects another column, another function and another table's column", () => {
    expect(
      isClosedExportPolicyQual(
        "sales",
        REAL.replace("organization_id", "created_by")
      )
    ).toBe(false);
    expect(
      isClosedExportPolicyQual(
        "sales",
        REAL.replaceAll("closed_export_organization", "other_scope")
      )
    ).toBe(false);
    expect(isClosedExportPolicyQual("sales", REAL_ORGANIZATIONS)).toBe(false);
    expect(isClosedExportPolicyQual("organizations", REAL)).toBe(false);
    expect(isClosedExportPolicyQual("sales", "")).toBe(false);
  });
});

const QUALIFIED_ORGANIZATION_SCOPE = REAL.replace(
  "closed_export_organization()",
  "public.closed_export_organization()"
);

function fakeServer(sessionSearchPath: string, failOn?: "select" | "rollback") {
  const statements: string[] = [];
  const released: (Error | undefined)[] = [];
  let searchPath = sessionSearchPath;
  const pool: PolicyReadPool = {
    connect: () =>
      Promise.resolve({
        query: <T>(text: string) => {
          statements.push(text);
          if (text === POLICY_READ_SEARCH_PATH_SQL) {
            searchPath = "pg_catalog, public";
          }
          if (text === CLOSED_EXPORT_POLICIES_SQL) {
            if (failOn === "select") {
              return Promise.reject(new Error("select failed"));
            }
            const qual = searchPath.includes("public")
              ? REAL
              : QUALIFIED_ORGANIZATION_SCOPE;
            return Promise.resolve({
              rows: [{ cmd: "SELECT", qual, tablename: "sales" }] as T[],
            });
          }
          if (text === "ROLLBACK" && failOn === "rollback") {
            return Promise.reject(new Error("connection lost"));
          }
          return Promise.resolve({ rows: [] as T[] });
        },
        release: (error?: Error) => {
          released.push(error);
        },
      }),
  };
  return { pool, released, statements };
}

describe("readClosedExportPolicies", () => {
  it.each([['"$user", public'], ["pg_catalog"], ["audit, pg_catalog"]])(
    "gives the same verdict with the default session search_path and with others (%s)",
    async (sessionPath) => {
      const server = fakeServer(sessionPath);
      const rows = await readClosedExportPolicies(server.pool, "reader");
      expect(rows.map((row) => row.qual)).toEqual([REAL]);
      expect(
        rows.every((row) => isClosedExportPolicyQual(row.tablename, row.qual))
      ).toBe(true);
    }
  );

  it("would see another text, and refuse it, if the path were not pinned", () => {
    expect(
      isClosedExportPolicyQual("sales", QUALIFIED_ORGANIZATION_SCOPE)
    ).toBe(false);
  });

  it("pins the path inside a read-only transaction that is always rolled back and released", async () => {
    const server = fakeServer("pg_catalog");
    await readClosedExportPolicies(server.pool, "reader");
    expect(server.statements).toEqual([
      "BEGIN READ ONLY",
      POLICY_READ_SEARCH_PATH_SQL,
      CLOSED_EXPORT_POLICIES_SQL,
      "ROLLBACK",
    ]);
    expect(server.released).toEqual([undefined]);
  });

  it("rolls back and releases when the select fails", async () => {
    const server = fakeServer("pg_catalog", "select");
    await expect(
      readClosedExportPolicies(server.pool, "reader")
    ).rejects.toThrow("select failed");
    expect(server.statements.at(-1)).toBe("ROLLBACK");
    expect(server.released).toEqual([undefined]);
  });

  it("gives the connection back as broken when the rollback fails", async () => {
    const server = fakeServer("pg_catalog", "rollback");
    await readClosedExportPolicies(server.pool, "reader");
    expect(server.released).toHaveLength(1);
    expect(server.released[0]?.message).toBe("connection lost");
  });
});
