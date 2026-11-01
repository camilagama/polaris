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
import {
  ATTEMPTS,
  checkWorker,
  runWrangler,
  STAGING_WORKERS,
  verifyDeployedSha,
  WRANGLER_TIMEOUT_MS,
} from "./verify-deployed-sha.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const WEB_VERSION = "11111111-1111-4111-8111-111111111111";
const CATALOG_VERSION = "22222222-2222-4222-8222-222222222222";
const noPause = () => Promise.resolve();

const deployment = (versions) => ({ id: "d", versions });
const single = (id) => deployment([{ percentage: 100, version_id: id }]);
const version = (id, message) => ({
  annotations: message === undefined ? {} : { "workers/message": message },
  id,
});

/** A host that serves `SHA` on both Workers; `override` replaces one Worker's answer by its name. */
function fakeWrangler(override = {}) {
  const calls = [];
  const fn = (app, worker, args) => {
    calls.push({ app, args, worker });
    const ids = {
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

  it("passes when both Workers serve a single version whose message is the commit", async () => {
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
      ]
    );
  });

  it("only ever asks about the two staging Workers, by the names written in the script", () => {
    expect(STAGING_WORKERS).toEqual([
      { app: "web", worker: "polaris-web-staging" },
      { app: "catalog", worker: "polaris-catalog-staging" },
    ]);
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

  it("reports a read that keeps failing by its class only, after three attempts", async () => {
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
    ).toHaveLength(3);
  });

  it("keeps a mismatch after the retries, so a stale deployment never passes", async () => {
    const wrangler = fakeWrangler({
      "polaris-web-staging": { version: version(WEB_VERSION, OTHER) },
    });
    const pause = vi.fn(noPause);
    expect(await verifyDeployedSha(SHA, wrangler, pause)).toHaveLength(1);
    expect(pause).toHaveBeenCalledTimes(2);
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

  const run = (headSha) =>
    spawnSync(process.execPath, ["scripts/verify-deployed-sha.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        CALLS_LOG: join(bin, "calls.log"),
        HEAD_SHA: headSha,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

  it("reads each Worker through wrangler in its app directory and exits 0 when both carry the commit", () => {
    const result = run(SHA);
    expect(result.stdout).toBe(
      "ok polaris-web-staging: active version is 0123456789ab\nok polaris-catalog-staging: active version is 0123456789ab\n"
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
    ]);
    expect(calls[0]).toBe(
      "apps/web --no-install wrangler deployments status --json --name polaris-web-staging"
    );
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
      const started = Date.now();
      await expect(
        runWrangler("web", "polaris-web-staging", ["x"], 300)
      ).rejects.toThrow("wrangler was stopped (SIGKILL)");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      process.env.PATH = path;
    }
    const pid = Number(readFileSync(join(bin, "child.pid"), "utf8"));
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  it("keeps the worst case of the whole check at about 260 s, as the runbook says", () => {
    const pauseMs = 5000;
    const callsPerTry = 2;
    const perWorker =
      ATTEMPTS * callsPerTry * WRANGLER_TIMEOUT_MS + (ATTEMPTS - 1) * pauseMs;
    expect(WRANGLER_TIMEOUT_MS).toBe(20_000);
    expect(STAGING_WORKERS.length * perWorker).toBe(260_000);
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
