import { describe, expect, it } from "vitest";
import {
  closedExportPolicyQual,
  isClosedExportPolicyQual,
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
