import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import config from "../playwright.pwa.config";
import {
  VISUAL_IMAGE,
  VISUAL_PLATFORM,
  VISUAL_PROJECT,
  VISUAL_WS_ENV,
  playwrightCoreDir,
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

function stopContainer(container: string) {
  capture("docker", ["stop", "--time", "2", container]);
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
    // the native placeholder of date inputs follows the process locale, not the `locale` of the context;
    // the image sets LC_ALL, which wins over LANG
    "--env",
    "LANG=pt_BR.UTF-8",
    "--env",
    "LC_ALL=pt_BR.UTF-8",
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
  try {
    await waitListening(container);
  } catch (error) {
    stopContainer(container);
    throw error;
  }
  console.log(
    `visual: ${VISUAL_IMAGE} (${VISUAL_PLATFORM}) pulled in ${((pulled - started) / 1000).toFixed(1)} s, listening in ${((Date.now() - pulled) / 1000).toFixed(1)} s`
  );
  return { container, wsEndpoint: `ws://127.0.0.1:${port}${path}` };
}

/** Playwright as a child the launcher can outlive: a signal to the launcher stops the container before it exits. */
function playwright(extra: string[], env = process.env, container?: string) {
  const child = spawn(
    "playwright",
    ["test", "--config", "playwright.pwa.config.ts", ...args, ...extra],
    { env, stdio: "inherit" }
  );
  const onSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
    if (container) {
      stopContainer(container);
    }
    process.exit(1);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

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
    const code = await playwright(
      ["--update-snapshots=changed"],
      { ...process.env, [VISUAL_WS_ENV]: browser.wsEndpoint },
      browser.container
    );
    const changed = spawnSync(
      "git",
      ["status", "--porcelain", "--", "e2e-pwa/ui-visual.e2e.ts-snapshots"],
      { encoding: "utf8" }
    ).stdout;
    console.log(`TMPDUMP-LIST\n${changed}TMPDUMP-LIST-END`);
    for (const line of changed.split("\n").filter(Boolean)) {
      const file = line.slice(3);
      const data = readFileSync(`../../${file}`).toString("base64");
      console.log(`TMPDUMP-BEGIN ${file}`);
      for (let at = 0; at < data.length; at += 3000) {
        console.log(`TMPDUMP ${data.slice(at, at + 3000)}`);
      }
      console.log("TMPDUMP-END");
    }
    return code;
  } finally {
    stopContainer(browser.container);
  }
}

process.exit(await main());
