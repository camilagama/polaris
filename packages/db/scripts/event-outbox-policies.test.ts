import { describe, expect, it } from "vitest";
import {
  expectedOutboxPolicies,
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

describe("sortedOutboxPolicies", () => {
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

  it("refuses an extra policy and a missing one", () => {
    const extra = [
      ...expected(),
      { cmd: "INSERT", name: "event_outbox_extra", roles: [runtime] },
    ];
    expect(sortedOutboxPolicies(extra)).not.toEqual(sortedExpected());
    expect(sortedOutboxPolicies(expected().slice(1))).not.toEqual(
      sortedExpected()
    );
  });
});
