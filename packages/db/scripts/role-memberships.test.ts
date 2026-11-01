import { describe, expect, it } from "vitest";
import {
  foldRoleMemberships,
  type RoleMembershipRow,
} from "./role-memberships";

const row = (over: Partial<RoleMembershipRow> = {}): RoleMembershipRow => ({
  admin_option: false,
  granted: "reader",
  inherit_option: false,
  member: "privacy_runtime",
  set_option: true,
  ...over,
});

describe("foldRoleMemberships", () => {
  it("leaves no row as no row, so a missing grant still fails the comparison", () => {
    expect(foldRoleMemberships([])).toEqual([]);
  });

  it("leaves a single grant as it is", () => {
    expect(foldRoleMemberships([row()])).toEqual([row()]);
  });

  it("folds the same membership granted by two roles into one", () => {
    expect(foldRoleMemberships([row(), row()])).toEqual([row()]);
  });

  it.each([
    ["INHERIT", { inherit_option: true }],
    ["ADMIN", { admin_option: true }],
  ] as const)("keeps %s when any one grantor gave it", (_name, extra) => {
    const [folded, ...rest] = foldRoleMemberships([row(), row(extra), row()]);
    expect(rest).toEqual([]);
    expect(folded).toEqual(row(extra));
  });

  it("holds SET if any grantor gave it", () => {
    expect(foldRoleMemberships([row({ set_option: false }), row()])).toEqual([
      row(),
    ]);
  });

  it("keeps different pairs apart, in order of first appearance", () => {
    const other = row({ granted: "other" });
    const another = row({ member: "someone" });
    expect(foldRoleMemberships([other, row(), another, row(), other])).toEqual([
      other,
      row(),
      another,
    ]);
  });

  it("does not mistake two pairs whose names join to the same text", () => {
    const a = row({ granted: "b_c", member: "a" });
    const b = row({ granted: "c", member: "a_b" });
    expect(foldRoleMemberships([a, b])).toEqual([a, b]);
  });
});
