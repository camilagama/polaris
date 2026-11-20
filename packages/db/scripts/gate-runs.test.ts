import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AS_SUPERUSER,
  assertCiOwnerSetup,
  assertSuperuserCasesProved,
  checkCiOwnerSetup,
  copyDatabaseName,
  databaseAclStatements,
  drainQueue,
  GATE_WORKERS,
  gateWorkers,
  inheritedEnvironment,
  planGateRuns,
  runMarkers,
  runsOf,
  runsSerially,
  runThenCleanUp,
  SERIAL_GATES,
  SUPERUSER_RUN_FOLLOWS,
  urlForDatabase,
} from "./gate-runs";

const OWNER_IS_SUPERUSER = /and the owner is a superuser/;
const WORKERS_RANGE = /must be a whole number from 1 to 8/;
const WORKERS_NEON = /for a local Postgres only/;
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

describe("planGateRuns", () => {
  const gates = [
    { name: "rls-forced-catalog" },
    { name: "sales-aggregate" },
    { name: "audit-retention", superuser: "also" as const },
    { name: "expenses" },
    { name: "plain-only", superuser: "only" as const },
    { name: "web-worker" },
  ];
  const labels = (runs: { run: { label: string } }[]) =>
    runs.map(({ run }) => run.label);

  it("keeps every run serial, in order, with one worker", () => {
    const plan = planGateRuns(gates, true, 1);
    expect(plan.parallel).toEqual([]);
    expect(labels(plan.serial)).toEqual([
      "rls-forced-catalog",
      "sales-aggregate",
      "audit-retention",
      "audit-retention (superuser)",
      "expenses",
      "plain-only",
      "web-worker",
    ]);
  });

  it("queues only the gates outside SERIAL_GATES without a superuser need", () => {
    const plan = planGateRuns(gates, true, 4);
    expect(labels(plan.parallel)).toEqual(["sales-aggregate", "expenses"]);
    expect(labels(plan.serial)).toEqual([
      "rls-forced-catalog",
      "audit-retention",
      "audit-retention (superuser)",
      "plain-only",
      "web-worker",
    ]);
  });

  it("keeps a gate with a superuser need serial without the superuser URL", () => {
    expect(runsSerially("plain-only", "only")).toBe(true);
    expect(labels(planGateRuns(gates, false, 4).serial)).toContain(
      "plain-only"
    );
  });
});

describe("gateWorkers", () => {
  it("is 4 locally and 1 against Neon by default", () => {
    expect(gateWorkers({}, true)).toBe(4);
    expect(gateWorkers({}, false)).toBe(1);
    expect(gateWorkers({ [GATE_WORKERS]: "" }, true)).toBe(4);
  });

  it("takes a whole number from 1 to 8 locally", () => {
    expect(gateWorkers({ [GATE_WORKERS]: "1" }, true)).toBe(1);
    expect(gateWorkers({ [GATE_WORKERS]: "8" }, true)).toBe(8);
    for (const raw of ["0", "9", "2.5", "-1", "abc", " 3"]) {
      expect(() => gateWorkers({ [GATE_WORKERS]: raw }, true)).toThrow(
        WORKERS_RANGE
      );
    }
  });

  it("refuses more than one worker against Neon", () => {
    expect(gateWorkers({ [GATE_WORKERS]: "1" }, false)).toBe(1);
    expect(() => gateWorkers({ [GATE_WORKERS]: "2" }, false)).toThrow(
      WORKERS_NEON
    );
  });
});

describe("copyDatabaseName and urlForDatabase", () => {
  it("points the URL at the copy and keeps the rest", () => {
    expect(copyDatabaseName("polaris_gate", 3)).toBe("polaris_gate_p3");
    expect(
      urlForDatabase(
        "postgresql://owner:secret@localhost:5432/polaris_gate?sslmode=disable",
        "polaris_gate_p3"
      )
    ).toBe(
      "postgresql://owner:secret@localhost:5432/polaris_gate_p3?sslmode=disable"
    );
  });
});

describe("drainQueue", () => {
  it("runs one item at a time per worker and keeps the order of the items", async () => {
    const running = new Set<number>();
    const seen: number[][] = [];
    let peak = 0;
    const gates: Array<() => void> = [];
    const results = drainQueue([10, 20, 30, 40, 50], 2, (item, worker) => {
      expect(running.has(worker)).toBe(false);
      running.add(worker);
      peak = Math.max(peak, running.size);
      seen.push([item, worker]);
      return new Promise<string>((resolve) => {
        gates.push(() => {
          running.delete(worker);
          resolve(`${item}@${worker}`);
        });
      });
    });
    // the first item a worker finishes frees it for the next one of the queue
    for (let step = 0; step < 5; step += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each item is released only after the queue handed it out
      await expect.poll(() => gates.length).toBeGreaterThan(0);
      gates.shift()?.();
    }
    const out = await results;
    expect(peak).toBe(2);
    expect(out.map((entry) => entry.split("@")[0])).toEqual([
      "10",
      "20",
      "30",
      "40",
      "50",
    ]);
    expect(seen.slice(0, 2)).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });

  it("uses no more workers than items and returns nothing for no items", async () => {
    const workers = new Set<number>();
    await drainQueue([1], 4, (_item, worker) => {
      workers.add(worker);
      return Promise.resolve();
    });
    expect([...workers]).toEqual([1]);
    expect(await drainQueue([], 4, () => Promise.resolve(1))).toEqual([]);
  });

  it("lets the other workers end before a rejection propagates", async () => {
    const finished: number[] = [];
    await expect(
      drainQueue([1, 2, 3], 2, async (item) => {
        if (item === 1) {
          throw new Error("broken runner");
        }
        await Promise.resolve();
        finished.push(item);
      })
    ).rejects.toThrow("broken runner");
    expect(finished).toEqual([2, 3]);
  });
});

describe("databaseAclStatements", () => {
  it("gives nothing for the default ACL", () => {
    expect(databaseAclStatements("copy", "neondb_owner", null)).toEqual([]);
  });

  it("starts from no privilege and grants the template's, quoted", () => {
    expect(
      databaseAclStatements('co"py', "neondb_owner", [
        {
          grantee: "PUBLIC",
          grantor: "owner",
          is_grantable: false,
          privilege_type: "CONNECT",
        },
        {
          grantee: "neondb_owner",
          grantor: "owner",
          is_grantable: false,
          privilege_type: "TEMPORARY",
        },
        {
          grantee: "polaris_x",
          grantor: "owner",
          is_grantable: true,
          privilege_type: "CREATE",
        },
      ])
    ).toEqual([
      'REVOKE ALL ON DATABASE "co""py" FROM PUBLIC, "neondb_owner"',
      'GRANT CONNECT ON DATABASE "co""py" TO PUBLIC',
      'GRANT TEMPORARY ON DATABASE "co""py" TO "neondb_owner"',
      'GRANT CREATE ON DATABASE "co""py" TO "polaris_x" WITH GRANT OPTION',
    ]);
  });
});

// What a gate does, in its own script, that reaches past its database: a role granted to the session user, or a read
// of the roles, memberships, locks or backends of the whole cluster.
const CLUSTER_TOUCHES: readonly [string, RegExp][] = [
  [
    "grants a role to the session user",
    /withGateRole|becomeGateRole|queryAsFunctionOwner|replaceFunctionAsOwner|TO\s+(SESSION_USER|CURRENT_USER)\b/i,
  ],
  ["reads memberships", /pg_auth_members|pg_has_role/],
  ["reads roles", /\bpg_roles\b|\bpg_authid\b/],
  ["alters a role", /ALTER ROLE/],
  ["reads locks", /\bpg_locks\b/],
  [
    "reads or ends backends",
    /pg_stat_activity|pg_terminate_backend|pg_cancel_backend/,
  ],
  ["creates or drops a database", /(CREATE|DROP) DATABASE|ALTER SYSTEM/],
];

function clusterTouches(source: string): string[] {
  return CLUSTER_TOUCHES.filter(([, pattern]) => pattern.test(source)).map(
    ([touch]) => touch
  );
}

// The parallel gates whose touches stay inside their own database, each read against the code: exact, so a gate that
// stops touching leaves the list and one that touches more fails.
const PARALLEL_DESPITE: Readonly<Record<string, string[]>> = {
  "home-writes": ["reads or ends backends"],
  "outbox-dispatcher": ["reads roles", "reads or ends backends"],
  "review-hardening": ["reads roles", "alters a role"],
};

const GATE_TUPLE = /\[\s*"([a-z0-9-]+)",\s*"([^"]+\.ts)",?\s*\]/g;
const GATE_OBJECT = /name: "([a-z0-9-]+)",\s*script: "([^"]+\.ts)"/g;

function gateScripts(): Map<string, string> {
  const source = readFileSync(join(SCRIPTS, "run-gates.ts"), "utf8");
  const found = new Map<string, string>();
  for (const pattern of [GATE_TUPLE, GATE_OBJECT]) {
    for (const [, name, script] of source.matchAll(pattern)) {
      found.set(name as string, script as string);
    }
  }
  return found;
}

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

describe("SERIAL_GATES against the gates' code", () => {
  const scripts = gateScripts();

  it("reads every gate of the runner", () => {
    expect(scripts.size).toBeGreaterThan(80);
    expect(scripts.get("rls-forced-catalog")).toBe(
      "verify-rls-forced-catalog-gate.ts"
    );
    expect(scripts.get("product-import")).toBe(
      "../../../apps/web/scripts/verify-product-import-gate.ts"
    );
  });

  it("names only gates of the runner", () => {
    expect(
      Object.keys(SERIAL_GATES).filter((name) => !scripts.has(name))
    ).toEqual([]);
  });

  it("finds a touch in a planted gate and none in a clean one", () => {
    expect(
      clusterTouches("await withGateRole(admin, OWNER, () => run());")
    ).toEqual(["grants a role to the session user"]);
    expect(clusterTouches("GRANT polaris_x TO session_user")).toEqual([
      "grants a role to the session user",
    ]);
    expect(
      clusterTouches("SELECT 1 FROM pg_catalog.pg_auth_members AS m")
    ).toEqual(["reads memberships"]);
    expect(clusterTouches("SELECT * FROM pg_locks")).toEqual(["reads locks"]);
    expect(clusterTouches("CREATE DATABASE x")).toEqual([
      "creates or drops a database",
    ]);
    expect(clusterTouches("SELECT 1 FROM public.sales")).toEqual([]);
  });

  it("leaves in the parallel queue only gates whose touches were read and listed", () => {
    const touching: Record<string, string[]> = {};
    for (const [name, script] of scripts) {
      if (Object.hasOwn(SERIAL_GATES, name)) {
        continue;
      }
      const touches = clusterTouches(
        readFileSync(join(SCRIPTS, script), "utf8")
      );
      if (touches.length > 0) {
        touching[name] = touches;
      }
    }
    expect(touching).toEqual(PARALLEL_DESPITE);
  });
});
