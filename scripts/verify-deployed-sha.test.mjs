import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonc } from "./lib/wrangler-config.mjs";
import {
  API_CALLS_PER_TRY,
  API_TIMEOUT_MS,
  ATTEMPTS,
  checkWorker,
  cleanStderr,
  PAUSES_MS,
  PRODUCTION_WORKERS,
  RETRY_WINDOW_MS,
  readApiDeployments,
  readApiVersion,
  runWrangler,
  STAGING_WORKERS,
  verifyDeployedSha,
  WRANGLER_CALLS_PER_TRY,
  WRANGLER_TIMEOUT_MS,
  workersFromArgs,
  worstCaseMs,
} from "./verify-deployed-sha.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const WEB_VERSION = "11111111-1111-4111-8111-111111111111";
const CATALOG_VERSION = "22222222-2222-4222-8222-222222222222";
const ADMIN_VERSION = "33333333-3333-4333-8333-333333333333";
const noPause = () => Promise.resolve();

/** A clock that only moves when the check pauses or a read takes `readMs`, so no test sleeps. */
function fakeClock(readMs = 0) {
  let elapsed = 0;
  const pauses = [];
  return {
    now: () => elapsed,
    pause: (ms) => {
      pauses.push(ms);
      elapsed += ms;
      return Promise.resolve();
    },
    pauses,
    read: () => {
      elapsed += readMs;
    },
    waited: () => pauses.reduce((sum, ms) => sum + ms, 0),
  };
}

/** Serves `OTHER` on the web Worker until its `rightFrom`-th pair of reads, then `SHA` (never, when 0). */
function lateWrangler(clock, rightFrom) {
  let deploymentReads = 0;
  return (app, worker, args) => {
    if (args[0] === "deployments") {
      clock.read();
      if (worker === "polaris-web-staging") {
        deploymentReads += 1;
      }
    }
    const late =
      worker === "polaris-web-staging" &&
      (rightFrom === 0 || deploymentReads < rightFrom);
    return fakeWrangler(
      late ? { [worker]: { version: version(WEB_VERSION, OTHER) } } : {}
    )(app, worker, args);
  };
}

const deployment = (versions) => ({ id: "d", versions });
const single = (id) => deployment([{ percentage: 100, version_id: id }]);
const version = (id, message) => ({
  annotations: message === undefined ? {} : { "workers/message": message },
  id,
});

/** A host that serves `SHA` on the three Workers; `override` replaces one Worker's answer by its name. */
function fakeWrangler(override = {}) {
  const calls = [];
  const fn = (app, worker, args) => {
    calls.push({ app, args, worker });
    const ids = {
      "polaris-admin-staging": ADMIN_VERSION,
      "polaris-catalog-staging": CATALOG_VERSION,
      "polaris-web-staging": WEB_VERSION,
    };
    const id = ids[worker];
    const answers = {
      deployment: single(id),
      version: version(id, SHA),
      ...override[worker],
    };
    return Promise.resolve(
      args[0] === "deployments" ? answers.deployment : answers.version
    );
  };
  fn.calls = calls;
  return fn;
}

describe("the deployed version check", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when the three Workers serve a single version whose message is the commit", async () => {
    const wrangler = fakeWrangler();
    expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([]);
    expect(wrangler.calls.map(({ args, worker }) => [worker, ...args])).toEqual(
      [
        ["polaris-web-staging", "deployments", "status", "--json"],
        ["polaris-web-staging", "versions", "view", WEB_VERSION, "--json"],
        ["polaris-catalog-staging", "deployments", "status", "--json"],
        [
          "polaris-catalog-staging",
          "versions",
          "view",
          CATALOG_VERSION,
          "--json",
        ],
        ["polaris-admin-staging", "deployments", "status", "--json"],
        ["polaris-admin-staging", "versions", "view", ADMIN_VERSION, "--json"],
      ]
    );
  });

  it("only ever asks about the three staging Workers, by the names of env.staging in their wrangler.jsonc", () => {
    const stagingName = (app) =>
      parseJsonc(
        readFileSync(
          new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url),
          "utf8"
        )
      ).env.staging.name;
    expect(STAGING_WORKERS).toEqual([
      { app: "web", worker: stagingName("web") },
      { app: "catalog", worker: stagingName("catalog") },
      { app: "admin", worker: stagingName("admin") },
    ]);
    expect(STAGING_WORKERS.map(({ worker }) => worker)).toEqual([
      "polaris-web-staging",
      "polaris-catalog-staging",
      "polaris-admin-staging",
    ]);
  });

  it("asks about the production Workers by the names of env.production in their wrangler.jsonc", () => {
    const productionName = (app) =>
      parseJsonc(
        readFileSync(
          new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url),
          "utf8"
        )
      ).env.production.name;
    expect(PRODUCTION_WORKERS).toEqual([
      { app: "web", worker: productionName("web") },
      { app: "catalog", worker: productionName("catalog") },
    ]);
    expect(PRODUCTION_WORKERS.map(({ worker }) => worker)).toEqual([
      "polaris-web",
      "polaris-catalog",
    ]);
  });

  it("picks the Workers by --env and refuses anything else instead of falling back", () => {
    expect(workersFromArgs([])).toBe(STAGING_WORKERS);
    expect(workersFromArgs(["--env", "staging"])).toBe(STAGING_WORKERS);
    expect(workersFromArgs(["--env", "production"])).toBe(PRODUCTION_WORKERS);
    for (const args of [
      ["--env"],
      ["--env", "Production"],
      ["--env", "constructor"],
      ["--env", "production", "--env", "staging"],
      ["production"],
      ["--env=production"],
    ]) {
      expect(workersFromArgs(args)).toBeNull();
    }
  });

  it("fails naming the Worker when its version carries another commit, and still checks the other", async () => {
    const wrangler = fakeWrangler({
      "polaris-web-staging": { version: version(WEB_VERSION, OTHER) },
    });
    expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([
      "polaris-web-staging: the active version carries the commit fedcba987654, expected the commit 0123456789ab",
    ]);
    expect(
      wrangler.calls.some(({ worker }) => worker === "polaris-catalog-staging")
    ).toBe(true);
  });

  it("fails on a catalog that did not move, with the web updated", async () => {
    const wrangler = fakeWrangler({
      "polaris-catalog-staging": { version: version(CATALOG_VERSION, OTHER) },
    });
    const failures = await verifyDeployedSha(SHA, wrangler, noPause);
    expect(failures).toHaveLength(1);
    expect(failures[0].startsWith("polaris-catalog-staging:")).toBe(true);
  });

  it("fails on an Admin that did not move, with the web and the catalog updated", async () => {
    const wrangler = fakeWrangler({
      "polaris-admin-staging": { version: version(ADMIN_VERSION, OTHER) },
    });
    expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([
      "polaris-admin-staging: the active version carries the commit fedcba987654, expected the commit 0123456789ab",
    ]);
  });

  it("fails on an Admin with no message, a split or a version read back that is not the active one", async () => {
    const cases = [
      [
        { version: version(ADMIN_VERSION, undefined) },
        "the active version carries no message, expected the commit 0123456789ab",
      ],
      [
        {
          deployment: deployment([
            { percentage: 50, version_id: ADMIN_VERSION },
            { percentage: 50, version_id: WEB_VERSION },
          ]),
        },
        "the active deployment is not a single version (2 versions listed)",
      ],
      [
        {
          deployment: deployment([
            { percentage: 90, version_id: ADMIN_VERSION },
          ]),
        },
        "the active version does not take 100% of the traffic",
      ],
      [
        { version: version(WEB_VERSION, SHA) },
        "the version read back is not the active one",
      ],
    ];
    for (const [answer, reason] of cases) {
      const wrangler = fakeWrangler({ "polaris-admin-staging": answer });
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([
        `polaris-admin-staging: ${reason}`,
      ]);
    }
  });

  it("does not echo a message that is not a commit SHA, and treats a prefix or a case change as a mismatch", async () => {
    const injected = "::error::forged\nline";
    for (const message of [
      injected,
      SHA.slice(0, 12),
      SHA.toUpperCase(),
      "",
      ` ${SHA}`,
    ]) {
      const wrangler = fakeWrangler({
        "polaris-web-staging": { version: version(WEB_VERSION, message) },
      });
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await verifyDeployedSha(SHA, wrangler, noPause);
      expect(failures).toHaveLength(1);
      expect(failures[0]).not.toContain("::error");
      expect(failures[0]).not.toContain("forged");
    }
    const wrangler = fakeWrangler({
      "polaris-web-staging": { version: version(WEB_VERSION, undefined) },
    });
    expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([
      "polaris-web-staging: the active version carries no message, expected the commit 0123456789ab",
    ]);
  });

  it("fails when the active deployment is a split or has no single version at 100%", async () => {
    const cases = [
      [
        deployment([
          { percentage: 50, version_id: WEB_VERSION },
          { percentage: 50, version_id: CATALOG_VERSION },
        ]),
        "the active deployment is not a single version (2 versions listed)",
      ],
      [
        deployment([{ percentage: 90, version_id: WEB_VERSION }]),
        "the active version does not take 100% of the traffic",
      ],
      [
        deployment([{ percentage: 100, version_id: "--name=other" }]),
        "the active version has no valid id",
      ],
      [
        {},
        "the active deployment is not a single version (no versions listed)",
      ],
      [
        null,
        "the active deployment is not a single version (no versions listed)",
      ],
    ];
    for (const [shape, reason] of cases) {
      const wrangler = fakeWrangler({
        "polaris-web-staging": { deployment: shape },
      });
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([
        `polaris-web-staging: ${reason}`,
      ]);
      // an id that is not a UUID never reaches the command line
      expect(
        wrangler.calls.some(({ args }) => args.includes("--name=other"))
      ).toBe(false);
    }
  });

  it("fails when the version read back is not the active one", async () => {
    const wrangler = fakeWrangler({
      "polaris-web-staging": { version: version(CATALOG_VERSION, SHA) },
    });
    expect(await verifyDeployedSha(SHA, wrangler, noPause)).toEqual([
      "polaris-web-staging: the version read back is not the active one",
    ]);
  });

  it("retries a read that fails and passes when a later attempt answers, pausing between them", async () => {
    let first = true;
    const pause = vi.fn(noPause);
    const wrangler = (app, worker, args) => {
      if (first && worker === "polaris-web-staging") {
        first = false;
        return Promise.reject(new Error("secret detail"));
      }
      return fakeWrangler()(app, worker, args);
    };
    expect(await verifyDeployedSha(SHA, wrangler, pause)).toEqual([]);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("reports a read that keeps failing by its class only, after every attempt", async () => {
    const wrangler = vi.fn((app, worker, args) =>
      worker === "polaris-catalog-staging"
        ? Promise.reject(new TypeError("token abc123"))
        : fakeWrangler()(app, worker, args)
    );
    const failures = await verifyDeployedSha(SHA, wrangler, noPause);
    expect(failures).toEqual([
      "polaris-catalog-staging: could not read the deployment (TypeError)",
    ]);
    expect(
      wrangler.mock.calls.filter(
        ([, worker]) => worker === "polaris-catalog-staging"
      )
    ).toHaveLength(ATTEMPTS);
  });

  it("keeps a mismatch after the whole window, so a stale deployment never passes", async () => {
    const clock = fakeClock();
    const wrangler = lateWrangler(clock, 0);
    const failures = await verifyDeployedSha(
      SHA,
      wrangler,
      clock.pause,
      STAGING_WORKERS,
      clock.now
    );
    expect(failures).toEqual([
      "polaris-web-staging: the active version carries the commit fedcba987654, expected the commit 0123456789ab",
    ]);
    expect(clock.pauses).toEqual(PAUSES_MS);
    expect(clock.waited()).toBe(RETRY_WINDOW_MS);
    expect(clock.waited()).toBeLessThanOrEqual(75_000);
  });

  it("passes when the right commit shows up only on the 4th read, pausing 5, 10 and 15 s", async () => {
    const clock = fakeClock();
    const wrangler = lateWrangler(clock, 4);
    expect(
      await verifyDeployedSha(
        SHA,
        wrangler,
        clock.pause,
        STAGING_WORKERS,
        clock.now
      )
    ).toEqual([]);
    expect(clock.pauses).toEqual([5000, 10_000, 15_000]);
  });

  it("gives each Worker its own window, so a slow first one does not take the retries of the next", async () => {
    const clock = fakeClock();
    let catalogReads = 0;
    const wrangler = (app, worker, args) => {
      if (worker === "polaris-catalog-staging" && args[0] === "deployments") {
        catalogReads += 1;
      }
      const ids = {
        "polaris-catalog-staging": CATALOG_VERSION,
        "polaris-web-staging": WEB_VERSION,
      };
      const stale =
        worker === "polaris-web-staging" ||
        (worker === "polaris-catalog-staging" && catalogReads < 4);
      return fakeWrangler(
        stale ? { [worker]: { version: version(ids[worker], OTHER) } } : {}
      )(app, worker, args);
    };
    const failures = await verifyDeployedSha(
      SHA,
      wrangler,
      clock.pause,
      STAGING_WORKERS,
      clock.now
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].startsWith("polaris-web-staging:")).toBe(true);
    expect(clock.waited()).toBe(RETRY_WINDOW_MS + 5000 + 10_000 + 15_000);
  });

  it("stops retrying once reads that take long have used the window, and cuts the last pause to what is left", async () => {
    const clock = fakeClock(12_000);
    const wrangler = lateWrangler(clock, 0);
    const failures = await verifyDeployedSha(
      SHA,
      wrangler,
      clock.pause,
      [STAGING_WORKERS[0]],
      clock.now
    );
    expect(failures).toHaveLength(1);
    expect(clock.pauses).toEqual([5000, 10_000, 9000]);
    expect(clock.now()).toBe(72_000);
  });

  it("logs each attempt with the Worker, what it read and the seconds since the start", async () => {
    const clock = fakeClock();
    const wrangler = lateWrangler(clock, 3);
    await verifyDeployedSha(
      SHA,
      wrangler,
      clock.pause,
      [STAGING_WORKERS[0]],
      clock.now
    );
    const lines = console.log.mock.calls.map(([line]) => line);
    expect(lines).toEqual([
      `try 1/${ATTEMPTS} polaris-web-staging: the active version carries the commit fedcba987654, expected the commit 0123456789ab (0 s since the check started)`,
      `try 2/${ATTEMPTS} polaris-web-staging: the active version carries the commit fedcba987654, expected the commit 0123456789ab (5 s since the check started)`,
      `try 3/${ATTEMPTS} polaris-web-staging: active version is 0123456789ab (15 s since the check started)`,
      "ok polaris-web-staging: active version is 0123456789ab",
    ]);
  });

  it("pins the schedule of the pauses and of the window", () => {
    expect(PAUSES_MS).toEqual([5000, 10_000, 15_000, 30_000]);
    expect(ATTEMPTS).toBe(5);
    expect(RETRY_WINDOW_MS).toBe(60_000);
  });

  it("refuses an expected commit that is not a full lowercase SHA, before any read", async () => {
    const wrangler = fakeWrangler();
    for (const bad of [
      undefined,
      "",
      "main",
      SHA.slice(0, 12),
      SHA.toUpperCase(),
      `${SHA}\n`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await verifyDeployedSha(bad, wrangler, noPause)).toEqual([
        "HEAD_SHA is not a full commit SHA (40 lowercase hex characters)",
      ]);
    }
    expect(wrangler.calls).toEqual([]);
  });

  it("checks one Worker on its own", async () => {
    expect(
      await checkWorker(STAGING_WORKERS[0], SHA, fakeWrangler())
    ).toBeNull();
  });
});

describe("the script as the workflow runs it", () => {
  const root = new URL("..", import.meta.url).pathname;
  let bin;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "verify-deployed-sha-"));
    const fakeBunx = `#!/bin/sh
echo "$(basename "$(dirname "$PWD")")/$(basename "$PWD") $*" >> "$CALLS_LOG"
echo "::error::stderr of wrangler" >&2
case "$*" in
  *polaris-web-staging*) id=${WEB_VERSION} ;;
  *polaris-catalog-staging*) id=${CATALOG_VERSION} ;;
  *polaris-admin-staging*) id=${ADMIN_VERSION} ;;
  *"--name polaris-web") id=${WEB_VERSION} ;;
  *"--name polaris-catalog") id=${CATALOG_VERSION} ;;
  *) echo "unexpected worker" >&2; exit 2 ;;
esac
case "$*" in
  "--no-install wrangler deployments status --json --name "*)
    printf '{"versions":[{"percentage":100,"version_id":"%s"}]}' "$id" ;;
  "--no-install wrangler versions view $id --json --name "*)
    printf '{"id":"%s","annotations":{"workers/message":"${SHA}"}}' "$id" ;;
  *) echo "unexpected command" >&2; exit 2 ;;
esac
`;
    writeFileSync(join(bin, "bunx"), fakeBunx);
    chmodSync(join(bin, "bunx"), 0o755);
  });
  afterEach(() => {
    rmSync(bin, { force: true, recursive: true });
  });

  const withoutTimes = (text) =>
    text
      .replace(/ \(\d+ s since the check started\)/g, "")
      .replace(/^polaris-[a-z-]+: the API read failed .*\n/gm, "");

  const run = (headSha, args = []) =>
    spawnSync(process.execPath, ["scripts/verify-deployed-sha.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        CALLS_LOG: join(bin, "calls.log"),
        HEAD_SHA: headSha,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

  it("reads each Worker through wrangler in its app directory and exits 0 when the three carry the commit", () => {
    const result = run(SHA);
    expect(withoutTimes(result.stdout)).toBe(
      "try 1/5 polaris-web-staging: active version is 0123456789ab\nok polaris-web-staging: active version is 0123456789ab\ntry 1/5 polaris-catalog-staging: active version is 0123456789ab\nok polaris-catalog-staging: active version is 0123456789ab\ntry 1/5 polaris-admin-staging: active version is 0123456789ab\nok polaris-admin-staging: active version is 0123456789ab\n"
    );
    expect(result.status).toBe(0);
    const calls = readFileSync(join(bin, "calls.log"), "utf8")
      .trim()
      .split("\n");
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "apps/web",
      "apps/web",
      "apps/catalog",
      "apps/catalog",
      "apps/admin",
      "apps/admin",
    ]);
    expect(calls[4]).toBe(
      "apps/admin --no-install wrangler deployments status --json --name polaris-admin-staging"
    );
    expect(calls[0]).toBe(
      "apps/web --no-install wrangler deployments status --json --name polaris-web-staging"
    );
  });

  it("with --env production reads only the production Workers", () => {
    const result = run(SHA, ["--env", "production"]);
    expect(withoutTimes(result.stdout)).toBe(
      "try 1/5 polaris-web: active version is 0123456789ab\nok polaris-web: active version is 0123456789ab\ntry 1/5 polaris-catalog: active version is 0123456789ab\nok polaris-catalog: active version is 0123456789ab\n"
    );
    expect(result.status).toBe(0);
    const calls = readFileSync(join(bin, "calls.log"), "utf8")
      .trim()
      .split("\n");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => !call.includes("staging"))).toBe(true);
    expect(calls[2]).toBe(
      "apps/catalog --no-install wrangler deployments status --json --name polaris-catalog"
    );
  });

  it("exits 1 for an unknown environment without calling wrangler", () => {
    const result = run(SHA, ["--env", "prod"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: verify-deployed-sha.mjs");
    expect(existsSync(join(bin, "calls.log"))).toBe(false);
  });

  it("stops a wrangler that hangs, together with the process it started", async () => {
    writeFileSync(
      join(bin, "bunx"),
      `#!/bin/sh
sleep 30 &
echo $! > "${join(bin, "child.pid")}"
wait
`
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const started = performance.now();
      await expect(
        runWrangler("web", "polaris-web-staging", ["x"], 300)
      ).rejects.toThrow("wrangler was stopped (SIGKILL)");
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      process.env.PATH = path;
    }
    const pid = Number(readFileSync(join(bin, "child.pid"), "utf8"));
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  it("keeps the worst case of the whole check at 360 s, as the runbook says", () => {
    expect(WRANGLER_TIMEOUT_MS).toBe(20_000);
    expect(API_TIMEOUT_MS).toBe(10_000);
    expect(worstCaseMs(STAGING_WORKERS)).toBe(360_000);
    expect(worstCaseMs(STAGING_WORKERS.length)).toBe(360_000);
  });

  it("makes as many wrangler calls per try as the worst case counts", async () => {
    const wranglerJson = vi.fn(async (_app, _worker, args) =>
      args[0] === "deployments"
        ? single(WEB_VERSION)
        : version(WEB_VERSION, SHA)
    );
    expect(await checkWorker(STAGING_WORKERS[0], SHA, wranglerJson)).toBeNull();
    expect(wranglerJson).toHaveBeenCalledTimes(WRANGLER_CALLS_PER_TRY);
  });

  it("worstCaseMs grows with the Workers, the window and the calls of the last try", () => {
    const perWorker =
      RETRY_WINDOW_MS +
      API_CALLS_PER_TRY * API_TIMEOUT_MS +
      WRANGLER_CALLS_PER_TRY * WRANGLER_TIMEOUT_MS;
    expect(perWorker).toBe(120_000);
    expect(worstCaseMs(5)).toBe(5 * perWorker);
    expect(worstCaseMs(0)).toBe(0);
  });

  it("never passes what wrangler wrote on stderr to its own output", () => {
    const result = run(SHA);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("::error::");
  });

  it("exits 1 with a clear message for a HEAD_SHA that is not a commit, without calling wrangler", () => {
    const result = run("main");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Deployed version check failed (1).");
    expect(existsSync(join(bin, "calls.log"))).toBe(false);
  });
});

const LINE_STARTING_WITH_COMMAND = /^::/m;
const TOKEN = "cfut_SECRETSECRETSECRETSECRET1234";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

/**
 * The deployments list of the API: newest first, one deployment at 100% of `id`. The deployment carries no message
 * (as in the real API, where `--message` is stored on the version).
 */
const apiList = (id) => [
  { id: "d", versions: [{ percentage: 100, version_id: id }] },
];

const IDS = {
  "polaris-admin-staging": ADMIN_VERSION,
  "polaris-catalog-staging": CATALOG_VERSION,
  "polaris-web-staging": WEB_VERSION,
};

/** The API readers of a host that serves `message` on the version of every Worker (`override` replaces the version). */
function fakeApi(message = SHA, override = {}) {
  const calls = [];
  const api = {
    calls,
    deployments: vi.fn((worker) => {
      calls.push(["deployments", worker]);
      return Promise.resolve(override.list ?? apiList(IDS[worker]));
    }),
    version: vi.fn((worker, id) => {
      calls.push(["version", worker, id]);
      return Promise.resolve(override.version ?? version(id, message));
    }),
  };
  return api;
}

describe("the read through the Cloudflare API", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes on the first API read, taking the message from the version and not calling wrangler", async () => {
    const wrangler = fakeWrangler();
    const api = fakeApi(SHA);
    expect(
      await verifyDeployedSha(
        SHA,
        wrangler,
        noPause,
        STAGING_WORKERS,
        () => 0,
        api
      )
    ).toEqual([]);
    expect(api.calls).toEqual(
      STAGING_WORKERS.flatMap(({ worker }) => [
        ["deployments", worker],
        ["version", worker, IDS[worker]],
      ])
    );
    expect(wrangler.calls).toEqual([]);
  });

  it("ignores a message on the deployment: only the one on the version decides", async () => {
    const wrangler = fakeWrangler();
    const api = fakeApi(SHA, {
      list: [
        {
          annotations: { "workers/message": OTHER },
          id: "d",
          versions: [{ percentage: 100, version_id: WEB_VERSION }],
        },
      ],
    });
    expect(
      await checkWorker(STAGING_WORKERS[0], SHA, wrangler, api)
    ).toBeNull();
    expect(wrangler.calls).toEqual([]);
  });

  it("falls back to wrangler when the deployments read fails, and says so without the API's words", async () => {
    const wrangler = fakeWrangler();
    const api = {
      deployments: vi.fn(() =>
        Promise.reject(new Error("token abc123 leaked"))
      ),
      version: vi.fn(),
    };
    expect(
      await verifyDeployedSha(
        SHA,
        wrangler,
        noPause,
        [STAGING_WORKERS[0]],
        () => 0,
        api
      )
    ).toEqual([]);
    expect(api.version).not.toHaveBeenCalled();
    expect(wrangler.calls).toHaveLength(WRANGLER_CALLS_PER_TRY);
    const lines = console.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain("the API read failed (Error)");
    expect(lines).not.toContain("abc123");
  });

  it("falls back to wrangler when the version read fails", async () => {
    const wrangler = fakeWrangler();
    const api = {
      ...fakeApi(SHA),
      version: vi.fn(() => Promise.reject(new Error("down"))),
    };
    expect(
      await checkWorker(STAGING_WORKERS[0], SHA, wrangler, api)
    ).toBeNull();
    expect(wrangler.calls).toHaveLength(WRANGLER_CALLS_PER_TRY);
  });

  it("falls back to wrangler when the API version carries no message", async () => {
    const wrangler = fakeWrangler();
    expect(
      await checkWorker(STAGING_WORKERS[0], SHA, wrangler, fakeApi(""))
    ).toBeNull();
    expect(wrangler.calls).toHaveLength(WRANGLER_CALLS_PER_TRY);
  });

  it("fails when the version the API returns is not the active one", async () => {
    const wrangler = fakeWrangler();
    const api = fakeApi(SHA, { version: version(CATALOG_VERSION, SHA) });
    expect(await checkWorker(STAGING_WORKERS[0], SHA, wrangler, api)).toBe(
      "the version read back is not the active one"
    );
    expect(wrangler.calls).toEqual([]);
  });

  it("fails with the usual message when every API read carries another commit, never asking wrangler", async () => {
    const clock = fakeClock();
    const wrangler = fakeWrangler();
    const api = fakeApi(OTHER);
    const failures = await verifyDeployedSha(
      SHA,
      wrangler,
      clock.pause,
      [STAGING_WORKERS[0]],
      clock.now,
      api
    );
    expect(failures).toEqual([
      "polaris-web-staging: the active version carries the commit fedcba987654, expected the commit 0123456789ab",
    ]);
    expect(api.version).toHaveBeenCalledTimes(ATTEMPTS);
    expect(clock.pauses).toEqual(PAUSES_MS);
    expect(wrangler.calls).toEqual([]);
  });

  it("retries the API read and passes when the commit shows up late", async () => {
    const clock = fakeClock();
    let reads = 0;
    const api = {
      deployments: (worker) => Promise.resolve(apiList(IDS[worker])),
      version: (_worker, id) => {
        reads += 1;
        return Promise.resolve(version(id, reads < 3 ? OTHER : SHA));
      },
    };
    expect(
      await verifyDeployedSha(
        SHA,
        fakeWrangler(),
        clock.pause,
        [STAGING_WORKERS[0]],
        clock.now,
        api
      )
    ).toEqual([]);
    expect(clock.pauses).toEqual([5000, 10_000]);
  });

  it("fails on a split, a partial share or an id that is not a UUID in the API list, before reading a version", async () => {
    const cases = [
      [
        [
          {
            versions: [
              { percentage: 50, version_id: WEB_VERSION },
              { percentage: 50, version_id: CATALOG_VERSION },
            ],
          },
        ],
        "the active deployment is not a single version (2 versions listed)",
      ],
      [
        [{ versions: [{ percentage: 90, version_id: WEB_VERSION }] }],
        "the active version does not take 100% of the traffic",
      ],
      [
        [{ versions: [{ percentage: 100, version_id: "--name=other" }] }],
        "the active version has no valid id",
      ],
    ];
    const apis = cases.map(([list]) => fakeApi(SHA, { list }));
    const reasons = await Promise.all(
      cases.map((_case, index) =>
        checkWorker(STAGING_WORKERS[0], SHA, fakeWrangler(), apis[index])
      )
    );
    expect(reasons).toEqual(cases.map(([, reason]) => reason));
    for (const api of apis) {
      expect(api.version).not.toHaveBeenCalled();
    }
  });

  it("does not echo a message that is not a commit SHA", async () => {
    const reason = await checkWorker(
      STAGING_WORKERS[0],
      SHA,
      fakeWrangler(),
      fakeApi("::error::forged")
    );
    expect(reason).toBe(
      "the active version carries a message that is not a commit SHA, expected the commit 0123456789ab"
    );
  });
});

describe("readApiDeployments", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
  const answer = (body, status = 200) => ({
    json: () => Promise.resolve(body),
    ok: status >= 200 && status < 300,
    status,
  });
  const read = (fetchImpl, worker = "polaris-web-staging") =>
    readApiDeployments(worker, env, fetchImpl);

  it("asks GET /accounts/{account}/workers/scripts/{name}/deployments with the bearer token and returns the list", async () => {
    const list = apiList(WEB_VERSION);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(answer({ result: { deployments: list }, success: true }))
    );
    expect(await read(fetchImpl)).toEqual(list);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/polaris-web-staging/deployments`
    );
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses without a token or with an account id that is not 32 hex digits, before any request", async () => {
    const fetchImpl = vi.fn();
    for (const bad of [
      {},
      { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      { CLOUDFLARE_API_TOKEN: TOKEN },
      { CLOUDFLARE_ACCOUNT_ID: "../x", CLOUDFLARE_API_TOKEN: TOKEN },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      await expect(
        readApiDeployments("polaris-web-staging", bad, fetchImpl)
      ).rejects.toThrow("no token or account id for the API");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports the HTTP status only, never the body or the token", async () => {
    const fetchImpl = () =>
      Promise.resolve(answer({ errors: [{ message: TOKEN }] }, 403));
    const error = await read(fetchImpl).catch((caught) => caught);
    expect(error.message).toBe("the API answered HTTP 403");
    expect(error.message).not.toContain(TOKEN);
  });

  it("reports a network error, a body that is not JSON and an answer without a list in fixed words", async () => {
    const cases = [
      [() => Promise.reject(new Error(TOKEN)), "no answer from the API"],
      [
        () =>
          Promise.resolve({
            json: () => Promise.reject(new Error(TOKEN)),
            ok: true,
            status: 200,
          }),
        "the API did not answer JSON",
      ],
      [
        () => Promise.resolve(answer({ success: false })),
        "the API answer is not a success",
      ],
      [
        () => Promise.resolve(answer({ result: {}, success: true })),
        "the API answer has no deployments list",
      ],
      [
        () =>
          Promise.resolve(
            answer({ result: { deployments: [] }, success: true })
          ),
        "the API lists no deployment",
      ],
    ];
    for (const [fetchImpl, message] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      await expect(read(fetchImpl)).rejects.toThrow(message);
    }
  });
});

describe("readApiVersion", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
  const answer = (body, status = 200) => ({
    json: () => Promise.resolve(body),
    ok: status >= 200 && status < 300,
    status,
  });
  const read = (fetchImpl, id = WEB_VERSION) =>
    readApiVersion("polaris-web-staging", id, env, fetchImpl);

  it("asks GET /accounts/{account}/workers/scripts/{name}/versions/{id} with the bearer token and returns the version", async () => {
    const found = version(WEB_VERSION, SHA);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(answer({ result: found, success: true }))
    );
    expect(await read(fetchImpl)).toEqual(found);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/polaris-web-staging/versions/${WEB_VERSION}`
    );
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an id that is not a UUID before any request", async () => {
    const fetchImpl = vi.fn();
    for (const bad of ["../x", "--name=other", "", null]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      await expect(read(fetchImpl, bad)).rejects.toThrow(
        "the version id is not a UUID"
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports the HTTP status only and refuses an answer without a version", async () => {
    const forbidden = await read(() =>
      Promise.resolve(answer({ errors: [{ message: TOKEN }] }, 404))
    ).catch((caught) => caught);
    expect(forbidden.message).toBe("the API answered HTTP 404");
    await expect(
      read(() => Promise.resolve(answer({ result: null, success: true })))
    ).rejects.toThrow("the API answer has no version");
  });
});

describe("the stderr of a failed wrangler", () => {
  it("is indented line by line, so no line of it starts a workflow command", () => {
    const stderr = cleanStderr(
      `::error::forged\nAuthentication error [code: 10000] with ${TOKEN}\nAuthorization: Bearer abc.def-123`,
      { CLOUDFLARE_API_TOKEN: TOKEN }
    );
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).not.toContain("abc.def-123");
    expect(stderr).toContain("Authentication error [code: 10000]");
    for (const line of stderr.split("\n")) {
      expect(line.startsWith("    wrangler: ")).toBe(true);
    }
  });

  it("redacts the exact token, Bearer values, token shapes and long secrets, and keeps the rest", () => {
    const text = [
      `token=${TOKEN}`,
      `plain ${TOKEN} here`,
      "Bearer sk-abcdef",
      "cfat_ABCDEFGHIJKLMNOPQRSTUVWX",
      "x".repeat(50),
      "A request to the Cloudflare API failed (code 10000)",
    ].join("\n");
    const out = cleanStderr(text, { CLOUDFLARE_API_TOKEN: TOKEN });
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("sk-abcdef");
    expect(out).not.toContain("ABCDEFGHIJKLMNOP");
    expect(out).not.toContain("xxxxxxxxxx");
    expect(out).toContain(
      "A request to the Cloudflare API failed (code 10000)"
    );
  });

  it("strips escape and control characters, keeps the tail of a long text and answers empty for nothing", () => {
    expect(cleanStderr("\u001b[31mred\u001b[0m\u0007bell", {})).toBe(
      "    wrangler: red bell"
    );
    const long = `${"a ".repeat(2000)}the end`;
    const out = cleanStderr(long, {});
    expect(out.endsWith("the end")).toBe(true);
    expect(out.length).toBeLessThan(1700);
    expect(cleanStderr("  \n ", {})).toBe("");
  });
});

describe("the API read wired into the script", () => {
  const root = new URL("..", import.meta.url).pathname;
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-deployed-sha-api-"));
    writeFileSync(
      join(dir, "bunx"),
      `#!/bin/sh
echo called >> "${join(dir, "calls.log")}"
exit 1
`
    );
    chmodSync(join(dir, "bunx"), 0o755);
    writeFileSync(
      join(dir, "preload.mjs"),
      `globalThis.fetch = async (url, init) => {
  const worker = decodeURIComponent(String(url).split("/scripts/")[1].split("/")[0]);
  const ids = ${JSON.stringify(IDS)};
  console.log("GET " + String(url).replace(/^https:\\/\\/api\\.cloudflare\\.com\\/client\\/v4\\/accounts\\/[0-9a-f]+/, "") + " " + (init.headers.authorization === "Bearer ${TOKEN}"));
  const result = String(url).endsWith("/deployments")
    ? { deployments: [{ versions: [{ percentage: 100, version_id: ids[worker] }] }] }
    : { id: ids[worker], annotations: { "workers/message": "${SHA}" } };
  return { ok: true, status: 200, json: async () => ({ success: true, result }) };
};
`
    );
  });
  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("main reads the three Workers through the API with the token and never starts wrangler", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", join(dir, "preload.mjs"), "scripts/verify-deployed-sha.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          CLOUDFLARE_API_TOKEN: TOKEN,
          HEAD_SHA: SHA,
          PATH: `${dir}:${process.env.PATH}`,
        },
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "GET /workers/scripts/polaris-web-staging/deployments true"
    );
    expect(result.stdout).toContain(
      "GET /workers/scripts/polaris-admin-staging/deployments true"
    );
    expect(result.stdout).toContain(
      `GET /workers/scripts/polaris-admin-staging/versions/${ADMIN_VERSION} true`
    );
    expect(result.stdout).not.toContain("the API read failed");
    expect(result.stdout).not.toContain(TOKEN);
    expect(existsSync(join(dir, "calls.log"))).toBe(false);
  });
});

describe("the wrangler failure as the workflow runs it", () => {
  const root = new URL("..", import.meta.url).pathname;
  let bin;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "verify-deployed-sha-fail-"));
    writeFileSync(
      join(bin, "bunx"),
      `#!/bin/sh
echo "::error::forged by wrangler" >&2
echo "Authentication error with $CLOUDFLARE_API_TOKEN" >&2
exit 1
`
    );
    chmodSync(join(bin, "bunx"), 0o755);
  });
  afterEach(() => {
    rmSync(bin, { force: true, recursive: true });
  });

  it("shows the stderr of each failed try without the token, after the API read failed, and exits 1", () => {
    const script = join(bin, "run-once.mjs");
    writeFileSync(
      script,
      `import { verifyDeployedSha, runWrangler, STAGING_WORKERS } from ${JSON.stringify(
        new URL("./verify-deployed-sha.mjs", import.meta.url).href
      )};
const failures = await verifyDeployedSha(process.env.HEAD_SHA, runWrangler, async () => {}, [STAGING_WORKERS[0]], () => 0, { deployments: async () => { throw new Error("down"); } });
console.log(JSON.stringify(failures));
`
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        CLOUDFLARE_API_TOKEN: TOKEN,
        HEAD_SHA: SHA,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stdout).toContain(
      "try 1/5 polaris-web-staging: could not read the deployment (wrangler exited with code 1)"
    );
    expect(result.stdout).toContain(
      "    wrangler: Authentication error with [redacted]"
    );
    expect(result.stdout).toContain(
      "    wrangler: ::error::forged by wrangler"
    );
    expect(result.stdout).not.toMatch(LINE_STARTING_WITH_COMMAND);
    expect(result.stdout.match(/Authentication error/g)).toHaveLength(ATTEMPTS);
    expect(result.stdout).toContain(
      '["polaris-web-staging: could not read the deployment (wrangler exited with code 1)"]'
    );
  });
});
