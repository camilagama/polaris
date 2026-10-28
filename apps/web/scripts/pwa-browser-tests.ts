import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname } from "node:path";
import config from "../playwright.pwa.config";
import {
  VISUAL_IMAGE,
  VISUAL_PLATFORM,
  VISUAL_PROJECT,
  VISUAL_WS_ENV,
} from "./visual-browser";

/**
 * `bun run test:pwa` and `test:visual[:update]`: `playwright test --config playwright.pwa.config.ts` with the arguments
 * given, and, when the run includes the visual project, the browser server of the pinned image started before and
 * stopped after (`docker run`). The CI step of the offline gate calls `test:pwa` as it always did, so the visual spec
 * runs in that job with no change to the workflow. A run that needs the image and has no docker fails in the CI; on a
 * machine without docker, a run of every project goes on without the visual one and says so.
 */

const OTHER_PROJECTS = (config.projects ?? [])
  .map((project) => project.name ?? "")
  .filter((name) => name !== VISUAL_PROJECT);

const args = process.argv.slice(2);

/** The projects named on the command line (`--project=x` or `--project x`); none means all of them. */
function namedProjects(list: string[]) {
  const named: string[] = [];
  list.forEach((arg, index) => {
    const next = list[index + 1];
    if (arg.startsWith("--project=")) {
      named.push(arg.slice("--project=".length));
    } else if (arg === "--project" && next) {
      named.push(next);
    }
  });
  return named;
}

const named = namedProjects(args);
const visualAsked = named.includes(VISUAL_PROJECT);
const visualRuns = named.length === 0 || visualAsked;

function run(command: string, commandArgs: string[], env = process.env) {
  return spawnSync(command, commandArgs, { env, stdio: "inherit" }).status;
}

function capture(command: string, commandArgs: string[]) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
}

const hasDocker = () => capture("docker", ["version"]).status === 0;

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port"))
      );
    });
  });
}

/** The playwright-core of the lockfile, mounted read-only in the container: its server speaks the client's protocol. */
function playwrightCoreDir() {
  const require = createRequire(import.meta.url);
  const test = require.resolve("@playwright/test/package.json");
  return dirname(
    createRequire(test).resolve("playwright-core/package.json", {
      paths: [
        dirname(
          require.resolve("playwright/package.json", { paths: [dirname(test)] })
        ),
      ],
    })
  );
}

async function waitListening(container: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const logs = capture("docker", ["logs", container]).output;
    if (logs.includes("Listening on")) {
      return;
    }
    if (capture("docker", ["inspect", container]).status !== 0) {
      throw new Error(`the browser server of the image stopped:\n${logs}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling the log, one look at a time
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the browser server of the image did not listen in 60 s");
}

async function startImageBrowser() {
  const started = Date.now();
  if (
    run("docker", [
      "pull",
      "--quiet",
      "--platform",
      VISUAL_PLATFORM,
      VISUAL_IMAGE,
    ]) !== 0
  ) {
    throw new Error(`docker pull ${VISUAL_IMAGE} failed`);
  }
  const pulled = Date.now();
  const port = await freePort();
  const path = `/${randomBytes(12).toString("hex")}`;
  const container = `polaris-visual-${port}`;
  const status = run("docker", [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--name",
    container,
    "--platform",
    VISUAL_PLATFORM,
    // the browser opens the static server of the tests on the runner's 127.0.0.1
    "--network",
    "host",
    "--ipc",
    "host",
    "--user",
    "pwuser",
    "--volume",
    `${playwrightCoreDir()}:/pw:ro`,
    VISUAL_IMAGE,
    "node",
    "/pw/cli.js",
    "run-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--path",
    path,
  ]);
  if (status !== 0) {
    throw new Error("docker run of the browser server failed");
  }
  await waitListening(container);
  console.log(
    `visual: ${VISUAL_IMAGE} (${VISUAL_PLATFORM}) pulled in ${((pulled - started) / 1000).toFixed(1)} s, listening in ${((Date.now() - pulled) / 1000).toFixed(1)} s`
  );
  return { container, wsEndpoint: `ws://127.0.0.1:${port}${path}` };
}

const playwright = (extra: string[], env = process.env) =>
  run(
    "playwright",
    ["test", "--config", "playwright.pwa.config.ts", ...args, ...extra],
    env
  ) ?? 1;

async function main() {
  if (!visualRuns) {
    return playwright([]);
  }
  if (!hasDocker()) {
    if (process.env.CI || visualAsked) {
      console.error(
        `visual: the project ${VISUAL_PROJECT} needs docker (the browser of ${VISUAL_IMAGE}).`
      );
      return 1;
    }
    console.warn(
      `visual: no docker here, so ${VISUAL_PROJECT} did NOT run (it runs in the CI, or with docker: bun run test:visual).`
    );
    return playwright(OTHER_PROJECTS.map((project) => `--project=${project}`));
  }
  const browser = await startImageBrowser();
  try {
    const status = playwright([], {
      ...process.env,
      [VISUAL_WS_ENV]: browser.wsEndpoint,
    });
    dumpNewBaselines();
    return status;
  } finally {
    capture("docker", ["stop", "--time", "2", browser.container]);
  }
}

// TEMPORARY: prints the baselines this run wrote, so they can be taken from the job log (no artifact upload).
function dumpNewBaselines() {
  if (!process.env.CI) {
    return;
  }
  const listing = capture("git", [
    "ls-files",
    "--others",
    "--",
    "e2e-pwa/ui-visual.e2e.ts-snapshots",
  ]);
  const files = listing.output
    .split("\n")
    .filter((line) => line.endsWith(".png"));
  if (files.length === 0) {
    return;
  }
  const archive = spawnSync("tar", ["-czf", "-", ...files], {
    maxBuffer: 268_435_456,
  });
  const text = archive.stdout.toString("base64");
  console.log(`T470-BASELINES-BEGIN ${files.length}`);
  for (let index = 0; index < text.length; index += 4000) {
    console.log(`T470B ${text.slice(index, index + 4000)}`);
  }
  console.log("T470-BASELINES-END");
}

process.exit(await main());
