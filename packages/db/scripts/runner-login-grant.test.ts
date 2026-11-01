import { describe, expect, it } from "vitest";
import {
  type RunnerLoginGrantRow,
  runnerLoginState,
} from "./runner-login-grant";

const grant = (
  overrides: Partial<RunnerLoginGrantRow> = {}
): RunnerLoginGrantRow => ({
  admin: false,
  bypassRls: false,
  canLogin: true,
  createDb: false,
  createRole: false,
  inherit: true,
  replication: false,
  set: true,
  superuser: false,
  ...overrides,
});

describe("runnerLoginState", () => {
  it("returns the membership as it is for one grant", () => {
    expect(runnerLoginState([grant()])).toEqual([grant()]);
  });

  it("treats the same grant by two grantors as one membership", () => {
    expect(runnerLoginState([grant(), grant()])).toEqual([grant()]);
  });

  it("keeps INHERIT and SET when only one of the grantors gives them", () => {
    expect(
      runnerLoginState([
        grant({ inherit: false, set: true }),
        grant({ inherit: true, set: false }),
      ])
    ).toEqual([grant()]);
  });

  it("returns nothing when the grant does not exist, so the comparison fails", () => {
    expect(runnerLoginState([])).toEqual([]);
  });

  it("does not hide an option the runner must not have", () => {
    expect(runnerLoginState([grant(), grant({ admin: true })])).toEqual([
      grant({ admin: true }),
    ]);
    expect(runnerLoginState([grant({ inherit: false, set: false })])).toEqual([
      grant({ inherit: false, set: false }),
    ]);
  });

  it("keeps the login attributes of the role", () => {
    expect(
      runnerLoginState([grant({ superuser: true }), grant({ superuser: true })])
    ).toEqual([grant({ superuser: true })]);
  });
});
