import { describe, expect, it } from "vitest";
import {
  AS_SUPERUSER,
  assertCiOwnerSetup,
  assertSuperuserCasesProved,
  checkCiOwnerSetup,
  inheritedEnvironment,
  runMarkers,
  runsOf,
  runThenCleanUp,
  SUPERUSER_RUN_FOLLOWS,
} from "./gate-runs";

const OWNER_IS_SUPERUSER = /and the owner is a superuser/;
const NO_RUN_AFTER = /superuser run after this one/;
const NOT_SUPERUSER = /not connected as a superuser/;
const CI_FIX =
  /set POLARIS_GATE_SUPERUSER_URL in the gates step and create the owner without superuser \(see \.github\/workflows\/ci\.yml/;

describe("runsOf", () => {
  it("runs every gate once as the owner without a superuser URL", () => {
    for (const need of [undefined, "only", "also"] as const) {
      expect(runsOf("g", need, false)).toEqual([
        { asSuperuser: false, label: "g", superuserRunFollows: false },
      ]);
    }
  });

  it("runs a gate with no need once as the owner with the URL", () => {
    expect(runsOf("g", undefined, true)).toEqual([
      { asSuperuser: false, label: "g", superuserRunFollows: false },
    ]);
  });

  it("runs an `only` gate once as the superuser", () => {
    expect(runsOf("g", "only", true)).toEqual([
      { asSuperuser: true, label: "g", superuserRunFollows: false },
    ]);
  });

  it("runs an `also` gate as the owner, then as the superuser", () => {
    expect(runsOf("g", "also", true)).toEqual([
      { asSuperuser: false, label: "g", superuserRunFollows: true },
      { asSuperuser: true, label: "g (superuser)", superuserRunFollows: false },
    ]);
  });
});

describe("runMarkers", () => {
  it("hands each run only its own marker", () => {
    expect(runsOf("g", "also", true).map(runMarkers)).toEqual([
      { [SUPERUSER_RUN_FOLLOWS]: "1" },
      { [AS_SUPERUSER]: "1" },
    ]);
    expect(runsOf("g", "only", true).map(runMarkers)).toEqual([
      { [AS_SUPERUSER]: "1" },
    ]);
    expect(runsOf("g", undefined, true).map(runMarkers)).toEqual([{}]);
  });
});

describe("assertSuperuserCasesProved", () => {
  it("accepts a superuser, in CI or not", () => {
    expect(() =>
      assertSuperuserCasesProved(true, "g", { CI: "true" })
    ).not.toThrow();
    expect(() => assertSuperuserCasesProved(true, "g", {})).not.toThrow();
  });

  it("accepts an owner run outside CI, as on Neon", () => {
    expect(() => assertSuperuserCasesProved(false, "g", {})).not.toThrow();
  });

  it("accepts an owner run in CI only when the superuser run follows", () => {
    expect(() =>
      assertSuperuserCasesProved(false, "g", {
        CI: "true",
        [SUPERUSER_RUN_FOLLOWS]: "1",
      })
    ).not.toThrow();
    expect(() =>
      assertSuperuserCasesProved(false, "g", { CI: "true" })
    ).toThrow(NO_RUN_AFTER);
  });

  it("refuses a superuser run that is not connected as one", () => {
    expect(() =>
      assertSuperuserCasesProved(false, "g", { [AS_SUPERUSER]: "1" })
    ).toThrow(NOT_SUPERUSER);
  });
});

describe("inheritedEnvironment", () => {
  it("keeps the shell's variables and drops the superuser URL and both run markers", () => {
    expect(
      inheritedEnvironment({
        [AS_SUPERUSER]: "1",
        PATH: "/bin",
        POLARIS_GATE_SUPERUSER_URL: "postgresql://postgres@localhost/x",
        [SUPERUSER_RUN_FOLLOWS]: "1",
      })
    ).toEqual({ PATH: "/bin" });
  });
});

describe("assertCiOwnerSetup", () => {
  const ok = {
    hasSuperuserUrl: true,
    isLocalCi: true,
    ownerIsSuperuser: false,
  };

  it("accepts the CI shape: the URL given and an owner that is not a superuser", () => {
    expect(() => assertCiOwnerSetup(ok)).not.toThrow();
  });

  it("refuses the CI without the URL, with an owner that is a superuser or not, naming the fix", () => {
    for (const ownerIsSuperuser of [true, false]) {
      expect(() =>
        assertCiOwnerSetup({ ...ok, hasSuperuserUrl: false, ownerIsSuperuser })
      ).toThrow(CI_FIX);
    }
  });

  it("refuses the CI with a superuser owner even with the URL", () => {
    expect(() => assertCiOwnerSetup({ ...ok, ownerIsSuperuser: true })).toThrow(
      CI_FIX
    );
  });

  it("changes nothing outside the CI", () => {
    for (const hasSuperuserUrl of [true, false]) {
      for (const ownerIsSuperuser of [true, false]) {
        expect(() =>
          assertCiOwnerSetup({
            hasSuperuserUrl,
            isLocalCi: false,
            ownerIsSuperuser,
          })
        ).not.toThrow();
      }
    }
  });
});

describe("checkCiOwnerSetup", () => {
  function probe(isSuperuser: boolean) {
    const calls: string[] = [];
    return {
      calls,
      ownerIsSuperuser: () => {
        calls.push("isSuperuser");
        return Promise.resolve(isSuperuser);
      },
    };
  }

  it("does not read the owner's flag outside the CI, with or without the URL", async () => {
    const withUrl = probe(true);
    const withoutUrl = probe(true);
    await checkCiOwnerSetup({
      hasSuperuserUrl: true,
      isLocalCi: false,
      ownerIsSuperuser: withUrl.ownerIsSuperuser,
    });
    await checkCiOwnerSetup({
      hasSuperuserUrl: false,
      isLocalCi: false,
      ownerIsSuperuser: withoutUrl.ownerIsSuperuser,
    });
    expect([withUrl.calls, withoutUrl.calls]).toEqual([[], []]);
  });

  it("reads the flag in the CI and keeps the refusals of assertCiOwnerSetup", async () => {
    const superuser = probe(true);
    await expect(
      checkCiOwnerSetup({
        hasSuperuserUrl: true,
        isLocalCi: true,
        ownerIsSuperuser: superuser.ownerIsSuperuser,
      })
    ).rejects.toThrow(CI_FIX);
    const missingUrl = probe(true);
    await expect(
      checkCiOwnerSetup({
        hasSuperuserUrl: false,
        isLocalCi: true,
        ownerIsSuperuser: missingUrl.ownerIsSuperuser,
      })
    ).rejects.toThrow(OWNER_IS_SUPERUSER);
    const plain = probe(false);
    await checkCiOwnerSetup({
      hasSuperuserUrl: true,
      isLocalCi: true,
      ownerIsSuperuser: plain.ownerIsSuperuser,
    });
    expect([superuser.calls, missingUrl.calls, plain.calls]).toEqual([
      ["isSuperuser"],
      ["isSuperuser"],
      ["isSuperuser"],
    ]);
  });
});

describe("runThenCleanUp", () => {
  it("keeps the error of the work when the clean-up fails too, and logs the clean-up's", async () => {
    const logged: unknown[] = [];
    const cleanupFailure = new Error("role does not exist");
    await expect(
      runThenCleanUp(
        () => Promise.reject(new Error("permission denied to create role")),
        () => Promise.reject(cleanupFailure),
        (error) => logged.push(error)
      )
    ).rejects.toThrow("permission denied to create role");
    expect(logged).toEqual([cleanupFailure]);
  });

  it("propagates a failed clean-up after work that succeeded", async () => {
    await expect(
      runThenCleanUp(
        () => Promise.resolve(1),
        () => Promise.reject(new Error("drop failed")),
        () => undefined
      )
    ).rejects.toThrow("drop failed");
  });

  it("returns the result and cleans up once", async () => {
    let cleanups = 0;
    const result = await runThenCleanUp(
      () => Promise.resolve("done"),
      () => {
        cleanups += 1;
        return Promise.resolve();
      },
      () => undefined
    );
    expect(result).toBe("done");
    expect(cleanups).toBe(1);
  });
});
