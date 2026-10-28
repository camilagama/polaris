// biome-ignore-all lint/performance/noAwaitInLoops: the server is probed once a second, in order
// `bun run test:lighthouse`: Lighthouse CI on a simulated phone over the production client (`dist/client`, from
// `bun run build`), three pages, three rounds each, the median of each metric (lighthouserc.json). It starts what
// the pages need, collects, asserts and saves the reports with `lhci`, prints the medians and what the LCP varies, and
// stops everything. A round that ran on a contended CPU is measured again (lighthouse-rounds.mjs). Nothing is uploaded:
// the reports stay in .lighthouseci/. Under Node (lhci and the catalog Worker need it), never under Bun.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  CONTENDED_BELOW,
  contendedByPage,
  readRounds,
  summaryTable,
  surplusFiles,
} from "./lighthouse-rounds.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const catalogRoot = fileURLToPath(new URL("../../catalog/", import.meta.url));
const reports = `${appRoot}.lighthouseci`;

/** The ports of lighthouserc.json: the client signed out, the client of the Início, the catalog; and the catalog's own Worker. */
const WEB_OUT = 4381;
const WEB_IN = 4382;
const CATALOG = 4383;
const CATALOG_WORKER = 5176;

if (process.versions.bun) {
  throw new Error("test:lighthouse runs under Node, not Bun.");
}
if (!existsSync(`${appRoot}dist/client/index.html`)) {
  throw new Error(
    "There is no production client in apps/web/dist/client: run `bun run build` first."
  );
}
const chrome = chromium.executablePath();
if (!existsSync(chrome)) {
  throw new Error(
    "The Chromium of Playwright is not installed: run `bunx playwright install chromium`."
  );
}
const rc = readFileSync(`${appRoot}lighthouserc.json`, "utf8");
for (const port of [WEB_OUT, WEB_IN, CATALOG]) {
  if (!rc.includes(`127.0.0.1:${port}`)) {
    throw new Error(
      `lighthouserc.json does not use the port ${port} of this script.`
    );
  }
}

const children = [];
function start(command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}
const stop = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(130);
  });
}

async function waitFor(url, what) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${what} did not answer at ${url} in 2 minutes.`);
}

/** The catalog over fixture stores, the build its own browser test uses, in the Worker runtime (Node 24). */
async function startCatalog() {
  const vite = `${catalogRoot}node_modules/vite/bin/vite.js`;
  const env = {
    POLARIS_CATALOG_E2E: "1",
    VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
  };
  const built = spawnSync(
    process.execPath,
    [vite, "build", "--mode", "fixture-data", "--outDir", "dist-fixture"],
    { cwd: catalogRoot, env: { ...process.env, ...env }, stdio: "inherit" }
  );
  if (built.status !== 0) {
    throw new Error("The build of the catalog fixture failed.");
  }
  start(
    process.execPath,
    [
      vite,
      "preview",
      "--mode",
      "fixture-data",
      "--outDir",
      "dist-fixture",
      "--host",
      "127.0.0.1",
      "--port",
      String(CATALOG_WORKER),
      "--strictPort",
    ],
    catalogRoot,
    env
  );
  await waitFor(`http://127.0.0.1:${CATALOG_WORKER}/robots.txt`, "The catalog");
}

async function startServers() {
  const servers = start(
    "bun",
    [
      "scripts/lighthouse-servers.ts",
      String(WEB_OUT),
      String(WEB_IN),
      String(CATALOG),
      String(CATALOG_WORKER),
    ],
    appRoot
  );
  servers.stderr.pipe(process.stderr);
  await new Promise((done, fail) => {
    servers.stdout.on("data", (chunk) => {
      if (String(chunk).startsWith("ready")) {
        done();
      }
    });
    servers.on("exit", () => fail(new Error("The fake servers stopped.")));
  });
}

const cli = fileURLToPath(import.meta.resolve("@lhci/cli/src/cli.js"));
/** One `lhci` command over lighthouserc.json; the exit status is lhci's. */
const lhci = (...args) =>
  spawnSync(process.execPath, [cli, ...args, "--config=lighthouserc.json"], {
    cwd: appRoot,
    env: { ...process.env, CHROME_PATH: chrome },
    stdio: "inherit",
  }).status ?? 1;

/** Rounds that ran while a neighbor held the CPU are measured again, up to this many times. */
const EXTRA_ATTEMPTS = 3;

function collect() {
  let status = lhci("collect");
  for (
    let attempt = 0;
    status === 0 && attempt < EXTRA_ATTEMPTS;
    attempt += 1
  ) {
    const again = contendedByPage(readRounds(reports));
    if (again.size === 0) {
      break;
    }
    process.stdout.write(
      `Rodadas com a CPU disputada (benchmarkIndex abaixo de ${CONTENDED_BELOW * 100}% do melhor): repetindo ${[...again.values()].reduce((sum, count) => sum + count, 0)}.\n`
    );
    for (const [url, count] of again) {
      status ||= lhci(
        "collect",
        "--additive",
        `--url=${url}`,
        `--numberOfRuns=${count}`
      );
    }
  }
  return status;
}

function keepFastestRounds() {
  for (const file of surplusFiles(readRounds(reports))) {
    rmSync(`${reports}/${file}`);
    rmSync(`${reports}/${file.replace(".json", ".html")}`, { force: true });
  }
}

function summarize() {
  const rounds = readRounds(reports);
  if (rounds.length === 0) {
    return;
  }
  const text = summaryTable(rounds);
  process.stdout.write(`\n${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Lighthouse (celular simulado)\n\n${text}\n`
    );
  }
}

let status = 1;
try {
  await startCatalog();
  await startServers();
  status = collect();
  if (status === 0) {
    keepFastestRounds();
    status = lhci("assert") || lhci("upload");
  }
  summarize();
} finally {
  stop();
}
process.exit(status);
