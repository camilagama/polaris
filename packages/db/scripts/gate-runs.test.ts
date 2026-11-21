import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
      return new Promise<string>((settle) => {
        gates.push(() => {
          running.delete(worker);
          settle(`${item}@${worker}`);
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

// What a gate does, in its script or in a gate helper it imports, that reaches past its database: a role granted to
// the session user, or a read of the roles, memberships, locks or backends of the whole cluster.
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
  [
    "creates, alters or drops a database",
    /(CREATE|ALTER|DROP) DATABASE|ALTER SYSTEM/,
  ],
];

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;

// the code without its block and whole-line comments, which name statements the code never runs
function withoutComments(source: string): string {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

function clusterTouches(source: string): string[] {
  const code = withoutComments(source);
  return CLUSTER_TOUCHES.filter(([, pattern]) => pattern.test(code)).map(
    ([touch]) => touch
  );
}

const RELATIVE_IMPORT = /from "(\.{1,2}\/[^"]+)"/g;

/**
 * The gate's script and every gate helper it reaches through relative imports, transitively: the files under a
 * `scripts` folder (the product code under `src` is what the gates test, not how they reach the cluster).
 */
function gateSources(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (found.has(file) || !existsSync(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    found.set(file, text);
    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      const target = resolve(dirname(file), specifier as string);
      const withExtension = target.endsWith(".ts") ? target : `${target}.ts`;
      if (withExtension.includes(`${sep}scripts${sep}`)) {
        pending.push(withExtension);
      }
    }
  }
  return found;
}

// Gate helpers read by hand, with the touches they have: what they reach stays inside the gate's database (or, for
// gate-roles.ts, the definitions, whose callers are scanned where they call them). Exact, so a change to one fails here.
const HELPERS_READ: Readonly<Record<string, string[]>> = {
  // the observer of a race reads pg_stat_activity only `WHERE datname = current_database()`, and pg_roles and
  // pg_has_role of its own user for pg_read_all_stats
  "concurrency-support.ts": [
    "reads memberships",
    "reads roles",
    "reads or ends backends",
  ],
  "gate-roles.ts": ["grants a role to the session user", "reads memberships"],
};

function touchesOf(entry: string): string[] {
  const touches = new Set<string>();
  for (const [file, text] of gateSources(entry)) {
    if (
      !(
        dirname(file) === SCRIPTS_DIR &&
        Object.hasOwn(HELPERS_READ, basename(file))
      )
    ) {
      for (const touch of clusterTouches(text)) {
        touches.add(touch);
      }
    }
  }
  return CLUSTER_TOUCHES.map(([touch]) => touch).filter((touch) =>
    touches.has(touch)
  );
}

// The parallel gates whose touches stay inside their own database, each read against the code: exact, so a gate that
// stops touching leaves the list and one that touches more fails.
const PARALLEL_DESPITE: Readonly<Record<string, string[]>> = {
  // event-outbox-policies.ts names the roles of the outbox's policies through pg_roles; it lists no other role
  "event-outbox": ["reads roles"],
  // pg_stat_activity of its own temporary login
  "home-writes": ["reads or ends backends"],
  // pg_roles of the two outbox roles by name; pg_stat_activity of its own temporary login
  "outbox-dispatcher": ["reads roles", "reads or ends backends"],
  // pg_roles of named roles; ALTER ROLE of its own temporary login (its time zone)
  "review-hardening": ["reads roles", "alters a role"],
};

const GATE_TUPLE = /\[\s*"([a-z0-9-]+)",\s*"([^"]+\.ts)",?\s*\]/g;
const GATE_OBJECT = /name: "([a-z0-9-]+)",\s*script: "([^"]+\.ts)"/g;
const SUITE_CI = /\bci: \[([^\]]*)\]/;
const QUOTED_NAME = /"([a-z0-9-]+)"/g;
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER = readFileSync(join(SCRIPTS_DIR, "run-gates.ts"), "utf8");

function gateScripts(): Map<string, string> {
  const found = new Map<string, string>();
  for (const pattern of [GATE_TUPLE, GATE_OBJECT]) {
    for (const [, name, script] of RUNNER.matchAll(pattern)) {
      found.set(name as string, join(SCRIPTS_DIR, script as string));
    }
  }
  return found;
}

describe("SERIAL_GATES against the gates' code", () => {
  const scripts = gateScripts();

  it("reads every gate of the runner: each name the runner declares, and every gate of the ci suite", () => {
    const declared = [...RUNNER.matchAll(/name: "([a-z0-9-]+)"/g)].length;
    const tuples = [...RUNNER.matchAll(GATE_TUPLE)].length;
    expect(scripts.size).toBe(declared + tuples);
    const ci = [
      ...(SUITE_CI.exec(RUNNER)?.[1] ?? "").matchAll(QUOTED_NAME),
    ].map(([, name]) => name as string);
    expect(ci.length).toBeGreaterThan(80);
    expect(ci.filter((name) => !scripts.has(name))).toEqual([]);
    for (const script of scripts.values()) {
      expect(existsSync(script), script).toBe(true);
    }
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
      "creates, alters or drops a database",
    ]);
    expect(clusterTouches("SELECT 1 FROM public.sales")).toEqual([]);
    expect(
      clusterTouches(
        "/** the marker `ALTER DATABASE … SET` stores */\n  // pg_locks is not read here\nconst x = 1;"
      )
    ).toEqual([]);
    expect(
      clusterTouches('const sql = "SELECT 1"; // then FROM pg_locks')
    ).toEqual(["reads locks"]);
  });

  it("finds a touch in a helper the gate imports, and skips the product code", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-runs-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "scripts", "verify-x-gate.ts"),
        'import { check } from "./x-checks";\nimport { repo } from "../src/repo";\n'
      );
      writeFileSync(
        join(root, "scripts", "x-checks.ts"),
        'import { more } from "./x-more";\nexport const check = 1;\n'
      );
      writeFileSync(
        join(root, "scripts", "x-more.ts"),
        "await withGateRole(client, ROLE, work);\n"
      );
      writeFileSync(join(root, "src", "repo.ts"), "SELECT 1 FROM pg_locks\n");
      expect(touchesOf(join(root, "scripts", "verify-x-gate.ts"))).toEqual([
        "grants a role to the session user",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    expect(
      [...gateSources(scripts.get("read-models") as string).keys()].map(
        (file) => basename(file)
      )
    ).toContain("user-organizations-gate-checks.ts");
  });

  it("has the touches of the helpers read by hand exactly as listed", () => {
    const read: Record<string, string[]> = {};
    for (const helper of Object.keys(HELPERS_READ)) {
      read[helper] = clusterTouches(
        readFileSync(join(SCRIPTS_DIR, helper), "utf8")
      );
    }
    expect(read).toEqual(HELPERS_READ);
  });

  it("leaves in the parallel queue only gates whose touches were read and listed", () => {
    const touching: Record<string, string[]> = {};
    for (const [name, script] of scripts) {
      if (Object.hasOwn(SERIAL_GATES, name)) {
        continue;
      }
      const touches = touchesOf(script);
      if (touches.length > 0) {
        touching[name] = touches;
      }
    }
    expect(touching).toEqual(PARALLEL_DESPITE);
  });
});

// Any statement that creates a role, and the name right after it: a bare or quoted identifier, made of literal text and
// `${…}` interpolations. A name that is not there (`%I`, a concatenation) cannot be read, and is reported as such.
const ROLE_CREATION = /CREATE\s+(?:ROLE|USER|GROUP)\b/gi;
const ROLE_NAME = /^\s+(?:IF\s+NOT\s+EXISTS\s+)?"?((?:\$\{[^}]*\}|[\w$])+)/i;
const GENERATOR_CALL = /\b(?:randomUUID|randomBytes)\s*\(/;
const IDENTIFIER = /[A-Za-z_]\w*/g;
const DECLARATION = /^(?:const|let|var)\b/;

interface Assignment {
  index: number;
  value: string;
}

interface Group {
  inner: string;
  interpolation: boolean;
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

// The index just past the literal or bracket pair that opens at `from`, reading nested ones and escapes.
function skipPast(text: string, from: number): number {
  const open = text[from] as string;
  let at = from + 1;
  if (open === '"' || open === "'") {
    while (at < text.length && text[at] !== open) {
      at += text[at] === "\\" ? 2 : 1;
    }
    return at + 1;
  }
  if (open === "`") {
    while (at < text.length && text[at] !== "`") {
      if (text[at] === "\\") {
        at += 2;
      } else if (text.startsWith("${", at)) {
        at = skipPast(text, at + 1);
      } else {
        at += 1;
      }
    }
    return at + 1;
  }
  const close = OPENERS[open] as string;
  while (at < text.length && text[at] !== close) {
    const char = text[at] as string;
    at +=
      char in OPENERS || "\"'`".includes(char) ? skipPast(text, at) - at : 1;
  }
  return at + 1;
}

/**
 * The text of an expression with everything that is not at its top level blanked out (string and template text, and the
 * inside of brackets and interpolations, which come back as groups), so operators and calls can be read on what is left.
 */
function maskTopLevel(text: string): { flat: string; groups: Group[] } {
  const flat = text.split("");
  const groups: Group[] = [];
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) {
      flat[at] = " ";
    }
  };
  const interpolation = (from: number) => {
    const end = skipPast(text, from + 1);
    groups.push({ inner: text.slice(from + 2, end - 1), interpolation: true });
    blank(from, end);
    return end;
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] as string;
    if (text.startsWith("${", at)) {
      at = interpolation(at);
    } else if (char in OPENERS) {
      const end = skipPast(text, at);
      groups.push({ inner: text.slice(at + 1, end - 1), interpolation: false });
      blank(at + 1, end - 1);
      at = end;
    } else if (char === '"' || char === "'") {
      const end = skipPast(text, at);
      blank(at + 1, end - 1);
      at = end;
    } else if (char === "`") {
      let inside = at + 1;
      while (inside < text.length && text[inside] !== "`") {
        if (text[inside] === "\\") {
          blank(inside, inside + 2);
          inside += 2;
        } else if (text.startsWith("${", inside)) {
          inside = interpolation(inside);
        } else {
          blank(inside, inside + 1);
          inside += 1;
        }
      }
      at = inside + 1;
    } else {
      at += 1;
    }
  }
  return { flat: flat.join(""), groups };
}

function isTernaryQuestion(flat: string, at: number): boolean {
  return (
    flat[at] === "?" &&
    flat[at + 1] !== "?" &&
    flat[at + 1] !== "." &&
    flat[at - 1] !== "?"
  );
}

/**
 * The values an expression can take: both arms of a `?:` (its condition is not a value), and every operand of `||` or
 * `??`. Anything else is one value.
 */
function branchesOf(text: string): string[] {
  const { flat } = maskTopLevel(text);
  const question = [...flat].findIndex((_, at) => isTernaryQuestion(flat, at));
  if (question >= 0) {
    let nested = 0;
    for (let at = question + 1; at < flat.length; at += 1) {
      if (isTernaryQuestion(flat, at)) {
        nested += 1;
      } else if (flat[at] === ":") {
        if (nested === 0) {
          return [
            ...branchesOf(text.slice(question + 1, at)),
            ...branchesOf(text.slice(at + 1)),
          ];
        }
        nested -= 1;
      }
    }
    return branchesOf(text.slice(question + 1));
  }
  const operands: string[] = [];
  let from = 0;
  for (let at = 0; at < flat.length - 1; at += 1) {
    const pair = flat.slice(at, at + 2);
    if (pair === "||" || pair === "??") {
      operands.push(text.slice(from, at));
      from = at + 2;
      at += 1;
    }
  }
  operands.push(text.slice(from));
  return operands;
}

// The code with the text of its string and template literals blanked, same length, so a `role = 'x'` inside SQL is not
// read as an assignment.
function withoutLiterals(code: string): string {
  const chars = code.split("");
  let at = 0;
  while (at < code.length) {
    if ("\"'`".includes(code[at] as string)) {
      const end = Math.min(skipPast(code, at), code.length);
      for (let inside = at + 1; inside < end - 1; inside += 1) {
        chars[inside] = " ";
      }
      at = end;
    } else {
      at += 1;
    }
  }
  return chars.join("");
}

// The assignments that can set the value `variable` has at `at`. Every plain assignment counts, wherever it is (inside a
// block that closed before `at`, or after it in a loop, it may still reach a variable declared outside), as does a
// `for (variable of|in …)` without a declaration. A declaration, and a loop that declares it, count only before `at` and
// while their block is open, so a same-named variable of another function is not read.
function visibleAssignments(
  variable: string,
  code: string,
  at: number
): Assignment[] {
  const text = withoutLiterals(code);
  const assignment = new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+)?(?<![.\w])${variable}\b(?:\s*:[^=;]+)?\s*(?:\|\||&&|\?\?)?=(?![=>])\s*([^;]*);`,
    "dg"
  );
  const loop = new RegExp(
    String.raw`\bfor\s*(?:await\s*)?\(\s*((?:const|let|var)\s+)?(?<![.\w])${variable}\s+(?:of|in)\b([^)]*)\)`,
    "dg"
  );
  const assignedBy = (match: RegExpMatchArray, group: number): Assignment => {
    const [start, stop] = (match.indices as RegExpIndicesArray)[group] as [
      number,
      number,
    ];
    return { index: match.index ?? 0, value: code.slice(start, stop) };
  };
  const stillOpen = (from: number, loopBody: boolean): boolean => {
    let depth = 0;
    let entered = false;
    for (const char of text.slice(from, at)) {
      if (char === "{") {
        depth += 1;
        entered = true;
      } else if (char === "}") {
        depth -= 1;
      } else if (char === ";" && loopBody && !entered) {
        return false;
      }
      if (depth < 0 || (loopBody && entered && depth === 0)) {
        return false;
      }
    }
    return true;
  };
  const assignments = [...text.matchAll(assignment)]
    .filter(
      (match) =>
        !DECLARATION.test(match[0]) ||
        (match.index < at && stillOpen(match.index + match[0].length, false))
    )
    .map((match) => assignedBy(match, 1));
  const loops = [...text.matchAll(loop)]
    .filter(
      (match) =>
        match[1] === undefined ||
        (match.index < at && stillOpen(match.index + match[0].length, true))
    )
    .map((match) => assignedBy(match, 2));
  return [...assignments, ...loops];
}

// A value is drawn when each value it can take calls a generator, or interpolates a variable whose every visible
// assignment is drawn. Only what is inside an interpolation is read as a variable.
function isDrawn(
  value: string,
  code: string,
  at: number,
  seen: ReadonlySet<string>,
  interpolated = false
): boolean {
  const branches = branchesOf(value);
  if (branches.length > 1) {
    return branches.every((branch) =>
      isDrawn(branch, code, at, seen, interpolated)
    );
  }
  const { flat, groups } = maskTopLevel(value);
  if (GENERATOR_CALL.test(flat)) {
    return true;
  }
  if (
    groups.some((group) =>
      isDrawn(group.inner, code, at, seen, interpolated || group.interpolation)
    )
  ) {
    return true;
  }
  if (!interpolated) {
    return false;
  }
  return (flat.match(IDENTIFIER) ?? []).some((name) => {
    const key = `${name}@${at}`;
    if (seen.has(key)) {
      return false;
    }
    const assignments = visibleAssignments(name, code, at);
    return (
      assignments.length > 0 &&
      assignments.every((assignment) =>
        isDrawn(
          assignment.value,
          code,
          assignment.index,
          new Set(seen).add(key)
        )
      )
    );
  });
}

/**
 * The roles a source creates under a name that two gates running at the same time would share: a literal name, a name
 * that cannot be read, or one that is not drawn, directly or through variables in scope in the same file, by `randomUUID`
 * or `randomBytes` (a parameter or an import is not followed, so it is reported too). A generator anywhere inside a call or
 * a bracket counts as drawing, and a destructuring assignment is not read.
 */
function fixedRoleNames(source: string): string[] {
  const code = withoutComments(source);
  const fixed: string[] = [];
  for (const creation of code.matchAll(ROLE_CREATION)) {
    const end = creation.index + creation[0].length;
    const name = ROLE_NAME.exec(code.slice(end))?.[1];
    if (name === undefined) {
      fixed.push("name not readable");
    } else if (!name.includes("${")) {
      fixed.push(name);
    } else if (!isDrawn(name, code, end, new Set())) {
      fixed.push(`name ${name}`);
    }
  }
  return fixed;
}

function fixedRoleNamesOf(entry: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [file, text] of gateSources(entry)) {
    const names = fixedRoleNames(text);
    if (names.length > 0) {
      found[basename(file)] = names;
    }
  }
  return found;
}

describe("CREATE ROLE with a fixed name outside SERIAL_GATES", () => {
  // `@{` stands for the interpolation of a template literal, which the linter refuses inside a string
  const planted = (...code: string[]) =>
    code.join("\n").replaceAll("@{", `$${"{"}`);

  it("finds a fixed name in a planted gate", () => {
    expect(fixedRoleNames("CREATE ROLE polaris_x NOLOGIN")).toEqual([
      "polaris_x",
    ]);
    expect(
      fixedRoleNames('query(`create role IF NOT EXISTS "gate_y" NOLOGIN`)')
    ).toEqual(["gate_y"]);
    expect(fixedRoleNames("CREATE\n  ROLE\n  gate_multiline")).toEqual([
      "gate_multiline",
    ]);
    expect(fixedRoleNames("CREATE USER gate_user LOGIN")).toEqual([
      "gate_user",
    ]);
    expect(fixedRoleNames("CREATE GROUP gate_group")).toEqual(["gate_group"]);
  });

  it("finds a name that is a variable not drawn, or not readable", () => {
    const fixed = (...code: string[]) => fixedRoleNames(planted(...code));
    expect(
      fixed('const role = "gate_z";', 'await q(`CREATE ROLE "@{role}" LOGIN`);')
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        "let login: string | undefined;",
        "login = `gate_@{randomUUID()}`;",
        "login = `fixed`;",
        "await q(`CREATE ROLE @{login}`);"
      )
    ).toEqual([planted("name @{login}")]);
    expect(
      fixed("async function f(name) { await q(`CREATE ROLE @{name}`); }")
    ).toEqual([planted("name @{name}")]);
    expect(
      fixed(
        'const suffix = "fixed";',
        "const role = `gate_@{suffix}`;",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        "const quoted = (name: string) => name;",
        'const prefix = "gate";',
        "await q(`CREATE ROLE @{quoted(prefix)}`);"
      )
    ).toEqual([planted("name @{quoted(prefix)}")]);
    expect(fixed("await q(`CREATE ROLE gate_@{prefix}`);")).toEqual([
      planted("name gate_@{prefix}"),
    ]);
    expect(
      fixed(
        "DO $$ BEGIN EXECUTE format('CREATE ROLE %I', 'gate_fixed'); END $$"
      )
    ).toEqual(["name not readable"]);
    expect(fixed("await q('CREATE ROLE ' + name);")).toEqual([
      "name not readable",
    ]);
    expect(fixed('await q("CREATE ROLE " + name);')).toEqual([
      "name not readable",
    ]);
  });

  it("reads a variable only where it is in scope", () => {
    expect(
      fixedRoleNames(
        planted(
          "async function drawn() {",
          "  const role = `gate_@{randomUUID()}`;",
          "  await q(`CREATE ROLE @{role}`);",
          "}",
          "async function given(role: string) {",
          "  await q(`CREATE ROLE @{role}`);",
          "}"
        )
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixedRoleNames(
        planted(
          "async function f() {",
          "  const role = `gate_@{randomUUID()}`;",
          "  if (ready) {",
          "    await q(`CREATE ROLE @{role}`);",
          "  }",
          "}"
        )
      )
    ).toEqual([]);
  });

  it("finds a name that a block gives a fixed value", () => {
    const fixed = (...code: string[]) => fixedRoleNames(planted(...code));
    const drawn = "let role = `g_@{randomUUID()}`;";
    expect(
      fixed(
        drawn,
        "if (reuse) {",
        '  role = "fixo";',
        "}",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        drawn,
        "for (const item of items) {",
        "  role = item;",
        "}",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        drawn,
        "try {",
        '  role = "fixo";',
        "} catch {",
        "  role = `g_@{randomUUID()}`;",
        "}",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        drawn,
        'if (reuse) role = "fixo";',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        drawn,
        "if (reuse) {",
        "  role = `h_@{randomUUID()}`;",
        "}",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([]);
    expect(
      fixed(
        "async function other() {",
        "  const role = 1;",
        "}",
        drawn,
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([]);
  });

  it("finds a name given a fixed value after the creation, by a compound assignment or by a loop", () => {
    const fixed = (...code: string[]) => fixedRoleNames(planted(...code));
    const drawn = "let role = `g_@{randomUUID()}`;";
    expect(
      fixed(
        drawn,
        "for (const name of names) {",
        "  await q(`CREATE ROLE @{role}`);",
        "  role = name;",
        "}"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        "async function make() {",
        "  await q(`CREATE ROLE @{role}`);",
        "}",
        drawn,
        'role = "fixo";'
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        "let role: string | undefined;",
        "if (ready) role = `g_@{randomUUID()}`;",
        'role ??= "fixo";',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(drawn, 'role ||= "fixo";', "await q(`CREATE ROLE @{role}`);")
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        drawn,
        "role ||= `h_@{randomUUID()}`;",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([]);
    expect(
      fixed(
        "let role: string;",
        "for (role of names) {",
        "  await q(`CREATE ROLE @{role}`);",
        "}"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        "for (const role of names) {",
        "  await q(`CREATE ROLE @{role}`);",
        "}"
      )
    ).toEqual([planted("name @{role}")]);
  });

  it("reports a plain assignment to the same name in another function, and ends on malformed text", () => {
    expect(
      fixedRoleNames(
        planted(
          "function a() {",
          "  let role: string;",
          '  role = "x";',
          "}",
          "function b() {",
          "  const role = `g_@{randomUUID()}`;",
          "  return q(`CREATE ROLE @{role}`);",
          "}"
        )
      )
    ).toEqual([planted("name @{role}")]);
    for (const code of [
      "const role = (reuse ? `a_@{randomUUID()}",
      'const role = "unclosed',
      "const role = `g_@{randomUUID()",
      "const role = [reuse ? 1 :",
      "const role = a ?",
      "const role = a ? b \\",
    ]) {
      expect(() =>
        fixedRoleNames(planted(code, "await q(`CREATE ROLE @{role}`);"))
      ).not.toThrow();
    }
  });

  it("does not read SQL text or a loop that closed as an assignment", () => {
    expect(
      fixedRoleNames(
        planted(
          "const role = `g_@{randomUUID()}`;",
          "await q(`CREATE ROLE @{role}`);",
          "await q(\"UPDATE memberships SET role = 'seller' WHERE id = $1\");",
          "await q(`UPDATE memberships SET role = 'owner'; SELECT 1`);",
          "for (const role of ROLES) {",
          "  await q(`GRANT @{role} TO x`);",
          "}"
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        planted(
          "const role = `g_@{randomUUID()}`;",
          "for (const role of ROLES) {",
          "  await q(`GRANT @{role} TO x`);",
          "}",
          "await q(`CREATE ROLE @{role}`);"
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        planted(
          "let role = `g_@{randomUUID()}`;",
          "for await (role of names) {",
          "  await q(`CREATE ROLE @{role}`);",
          "}"
        )
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixedRoleNames(
        planted(
          "const role = `g_@{randomUUID()}`;",
          "for (const role of names) await q(`CREATE ROLE @{role}`);"
        )
      )
    ).toEqual([planted("name @{role}")]);
  });

  it("finds a name drawn in only one branch of a value", () => {
    const fixed = (...code: string[]) => fixedRoleNames(planted(...code));
    expect(
      fixed(
        'const role = reuse ? "fixo" : `g_@{randomUUID()}`;',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        'const role = reuse ? `g_@{randomUUID()}` : "fixo";',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        'const role = a ? `g_@{randomUUID()}` : b ? `h_@{randomUUID()}` : "fixo";',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        'const role = given || "fixo" || `g_@{randomUUID()}`;',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed('const role = given ?? "fixo";', "await q(`CREATE ROLE @{role}`);")
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        'const role = `g_@{reuse ? "fixo" : randomUUID()}`;',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        'const role = "g_" + (reuse ? "fixo" : randomUUID());',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed("await q(`CREATE ROLE @{reuse ? shared : randomUUID()}`);")
    ).toEqual([planted("name @{reuse ? shared : randomUUID()}")]);
    expect(
      fixed(
        "const role = reuse",
        "  ? `g_@{randomUUID()}`",
        "  : `h_@{randomBytes(6).toString()}`;",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([]);
    expect(
      fixed(
        "const role = reuse?.name ?? `g_@{randomUUID()}`;",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        "const role = first ?? second ?? `g_@{randomUUID()}`;",
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
    expect(
      fixed(
        'const role = `g_@{randomUUID()}` || "fixo";',
        "await q(`CREATE ROLE @{role}`);"
      )
    ).toEqual([planted("name @{role}")]);
  });

  it("accepts a name drawn from randomUUID or randomBytes, directly or through a variable, and ignores comments", () => {
    expect(
      fixedRoleNames(
        planted(
          'const role = `@{prefix}_@{randomUUID().replaceAll("-", "")}`;',
          'await q(`CREATE ROLE "@{role}" LOGIN`);'
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        planted(
          "let login: string | undefined;",
          'const suffix = randomUUID().replaceAll("-", "");',
          "login = `gate_@{suffix}`;",
          "await q(`CREATE ROLE @{login}`);"
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        planted(
          "const login = `gate_@{randomBytes(6).toString()}`;",
          "await q(`CREATE ROLE @{login}`);"
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        planted(
          'const suffix = randomUUID().replaceAll("-", "");',
          "let login: string | undefined;",
          "login = `a_@{suffix}`;",
          "login = `b_@{suffix}`;",
          "await q(`CREATE ROLE @{login}`);"
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        planted(
          'await q(`CREATE ROLE "gate_@{randomUUID().replaceAll("-", "")}" LOGIN`);'
        )
      )
    ).toEqual([]);
    expect(
      fixedRoleNames(
        "// CREATE ROLE polaris_x\n/** CREATE ROLE gate_y */\nconst a = 1;"
      )
    ).toEqual([]);
  });

  it("finds the fixed names of the serial gates, so the scan is not empty", () => {
    const scripts = gateScripts();
    expect(
      fixedRoleNamesOf(scripts.get("migrations-without-superuser") as string)
    ).toHaveProperty(["verify-migrations-without-superuser-gate.ts"]);
    expect(
      fixedRoleNamesOf(scripts.get("definer-hardening") as string)
    ).toHaveProperty(["verify-definer-hardening-gate.ts"]);
  });

  it("finds a fixed name in a helper a planted gate imports", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-runs-"));
    try {
      mkdirSync(join(root, "scripts"));
      writeFileSync(
        join(root, "scripts", "verify-x-gate.ts"),
        'import { make } from "./x-roles";\n'
      );
      writeFileSync(
        join(root, "scripts", "x-roles.ts"),
        'await q("CREATE ROLE gate_shared NOLOGIN");\n'
      );
      expect(
        fixedRoleNamesOf(join(root, "scripts", "verify-x-gate.ts"))
      ).toEqual({ "x-roles.ts": ["gate_shared"] });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("leaves no fixed name in a gate of the parallel queue or in the helpers it imports", () => {
    const fixed: Record<string, Record<string, string[]>> = {};
    let scanned = 0;
    for (const [name, script] of gateScripts()) {
      if (Object.hasOwn(SERIAL_GATES, name)) {
        continue;
      }
      scanned += 1;
      const names = fixedRoleNamesOf(script);
      if (Object.keys(names).length > 0) {
        fixed[name] = names;
      }
    }
    expect(scanned).toBeGreaterThan(50);
    expect(fixed).toEqual({});
  });
});
