import { describe, expect, it } from "vitest";
import {
  expectedOutboxPolicies,
  OUTBOX_POLICIES_SQL,
  type OutboxPolicyRow,
  sortedOutboxPolicies,
} from "./event-outbox-policies";

const runtime = "polaris_pr11_runtime";
const expected = () => expectedOutboxPolicies(runtime);
const rename = (from: string, to: string): OutboxPolicyRow[] =>
  expected().map((row) => (row.name === from ? { ...row, name: to } : row));
const sortedExpected = () => sortedOutboxPolicies(expected());

describe("expectedOutboxPolicies", () => {
  it("has a unique name for every policy, so two policies of one command and role are told apart", () => {
    const names = expected().map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("holds the two billing runtime insert policies under their own names", () => {
    const billing = expected().filter(
      (row) =>
        row.cmd === "INSERT" && row.roles[0] === "polaris_billing_runtime"
    );
    expect(billing.map((row) => row.name).sort()).toEqual([
      "event_outbox_billing_runtime_insert_activation_notice",
      "event_outbox_billing_runtime_insert_notice",
    ]);
  });
});

describe("OUTBOX_POLICIES_SQL", () => {
  it("reads the oid 0 that TO PUBLIC stores in polroles as the role public, beside the names from pg_roles", () => {
    expect(OUTBOX_POLICIES_SQL).toContain(
      "|| CASE WHEN '0'::oid = ANY (polroles) THEN ARRAY['public'] ELSE ARRAY[]::text[] END AS roles"
    );
    expect(OUTBOX_POLICIES_SQL).toContain(
      "ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY (polroles))"
    );
  });
});

describe("sortedOutboxPolicies", () => {
  it("shows a policy granted to public as public, not as an empty role, and refuses it", () => {
    const [first] = expected();
    if (!first) {
      throw new Error("the expected list is empty");
    }
    const everyone = [
      ...expected(),
      { ...first, name: "event_outbox_to_public", roles: ["public"] },
    ];
    const shown = sortedOutboxPolicies(everyone).find(
      (row) => row.name === "event_outbox_to_public"
    );
    expect(shown?.roles).toBe("public");
    expect(sortedOutboxPolicies(everyone)).not.toEqual(sortedExpected());
  });

  it("does not depend on the order the catalog returns", () => {
    expect(sortedOutboxPolicies([...expected()].reverse())).toEqual(
      sortedExpected()
    );
  });

  it("refuses a policy that vanished while another was duplicated, which keeps the count", () => {
    const duplicated = rename(
      "event_outbox_billing_runtime_insert_activation_notice",
      "event_outbox_billing_runtime_insert_notice"
    );
    expect(duplicated).toHaveLength(expected().length);
    expect(sortedOutboxPolicies(duplicated)).not.toEqual(sortedExpected());
  });

  it("refuses a renamed policy, whichever it is", () => {
    for (const row of expected()) {
      expect(
        sortedOutboxPolicies(rename(row.name, `${row.name}_x`))
      ).not.toEqual(sortedExpected());
    }
  });

  it("refuses a policy moved to another command or another role", () => {
    const moved = expected().map((row, index) =>
      index === 0 ? { ...row, cmd: "UPDATE" } : row
    );
    const regranted = expected().map((row, index) =>
      index === 0 ? { ...row, roles: [runtime] } : row
    );
    expect(sortedOutboxPolicies(moved)).not.toEqual(sortedExpected());
    expect(sortedOutboxPolicies(regranted)).not.toEqual(sortedExpected());
  });

  it("refuses a policy that is RESTRICTIVE with the same name, command and role, whichever it is", () => {
    for (const row of expected()) {
      const restrictive = expected().map((other) =>
        other.name === row.name
          ? { ...other, kind: "RESTRICTIVE" as const }
          : other
      );
      expect(sortedOutboxPolicies(restrictive)).not.toEqual(sortedExpected());
    }
  });

  it("refuses a RESTRICTIVE policy added as an extra row beside the one of the same name, command and role", () => {
    const [first] = expected();
    if (!first) {
      throw new Error("the expected list is empty");
    }
    const beside = [...expected(), { ...first, kind: "RESTRICTIVE" as const }];
    expect(sortedOutboxPolicies(beside)).not.toEqual(sortedExpected());
  });

  it("holds only PERMISSIVE policies, as the migrations create them", () => {
    expect(new Set(expected().map((row) => row.kind))).toEqual(
      new Set(["PERMISSIVE"])
    );
  });

  it("refuses an extra policy and a missing one", () => {
    const extra = [
      ...expected(),
      {
        cmd: "INSERT",
        kind: "PERMISSIVE" as const,
        name: "event_outbox_extra",
        roles: [runtime],
      },
    ];
    expect(sortedOutboxPolicies(extra)).not.toEqual(sortedExpected());
    expect(sortedOutboxPolicies(expected().slice(1))).not.toEqual(
      sortedExpected()
    );
  });
});
