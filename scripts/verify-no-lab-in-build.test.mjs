import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BUILD_DIR,
  findLabProblems,
  LAB_BUILD_FOLDER,
  LAB_MESSAGES,
  LAB_MODULES,
  LAB_ROUTES,
  LAB_SOURCE_DIRECTORIES,
  NAME_PATTERN,
} from "./verify-no-lab-in-build.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(root, "scripts/verify-no-lab-in-build.mjs");
const webSource = path.join(root, "apps/web/src");

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A production-shaped build: the shell, a few screen chunks and a source map that holds main.tsx as text. */
function fakeBuild(extra = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "no-lab-build-"));
  directories.push(directory);
  const files = {
    "client/assets/index-AbC123.js": `const a="/entrar";const b="/vendas";aria-labelledby;export{a,b}`,
    "client/assets/index-AbC123.js.map": JSON.stringify({
      sources: ["../../src/main.tsx", "../../src/app-shell/app.tsx"],
      sourcesContent: [
        `import("./offline-poc/runtime-lab"); pathname === "/offline-runtime-lab"; "Falha ao abrir o laboratório do runtime"`,
        "export const App = 1;",
      ],
      version: 3,
    }),
    "client/assets/products-page-Xy9.js": `export default function Products(){return "Produtos"}`,
    "client/index.html":
      "<!doctype html><script src=/assets/index-AbC123.js></script>",
    "polaris_web_production/index.js": `export default {fetch(){return new Response("ok")}}`,
    ...extra,
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

const problemsOf = (directory) => findLabProblems(directory).problems;

describe("a build without a lab", () => {
  it("passes, and the main.tsx text inside a source map does not count", () => {
    const { problems, scanned } = findLabProblems(fakeBuild());
    expect(problems).toEqual([]);
    expect(scanned).toBe(5);
  });

  it("is what the command line says: exit 0 and the count of files", () => {
    const run = spawnSync(process.execPath, [script, fakeBuild()], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Lab-free build check passed: 5 files");
  });
});

describe("a build with a lab fails", () => {
  it("fails for a chunk named after a lab, which is how the bundler names the lab's own chunk", () => {
    const build = fakeBuild({
      "client/assets/runtime-lab-DOjOZrXW.js":
        "export const RuntimeLab = () => null;",
    });
    expect(problemsOf(build)).toEqual([
      "client/assets/runtime-lab-DOjOZrXW.js: the file is named after the lab runtime-lab",
    ]);
  });

  it("fails with exit 1 and names the file on the command line", () => {
    const build = fakeBuild({
      "client/assets/screens-lab-CVQsZVoZ.js": "export const ScreensLab = 1;",
    });
    const run = spawnSync(process.execPath, [script, build], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Lab-free build check failed (1):");
    expect(run.stderr).toContain("screens-lab-CVQsZVoZ.js");
  });

  it("fails for a lab inlined into another chunk, found by its route", () => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js": `if(location.pathname==="/offline-outbox-lab")render()`,
    });
    expect(problemsOf(build)).toEqual([
      "client/assets/index-AbC123.js: carries the lab route /offline-outbox-lab",
    ]);
  });

  it("fails for a lab inlined into another chunk, found by its error screen", () => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js": `h1("Falha ao abrir o laboratório da saída")`,
    });
    expect(problemsOf(build)).toEqual([
      'client/assets/index-AbC123.js: carries the lab message "Falha ao abrir o laboratório"',
    ]);
  });

  it("fails for a lab stylesheet", () => {
    const build = fakeBuild({
      "client/assets/lab-page-8srusQcS.css": "body{}",
    });
    expect(problemsOf(build)).toEqual([
      "client/assets/lab-page-8srusQcS.css: the file is named after the lab lab-page",
    ]);
  });

  it("fails for a source map that lists a module of a lab directory, even one with a common name", () => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js.map": JSON.stringify({
        sources: ["../../src/main.tsx", "../../src/offline-poc/runtime.ts"],
        sourcesContent: ["", ""],
        version: 3,
      }),
    });
    expect(problemsOf(build)).toEqual([
      "client/assets/index-AbC123.js.map: source map lists the lab module ../../src/offline-poc/runtime.ts",
    ]);
  });

  it("fails for a source map the check cannot read", () => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js.map": "{not json",
    });
    expect(problemsOf(build)).toEqual([
      "client/assets/index-AbC123.js.map: source map is not valid JSON, so its sources cannot be checked",
    ]);
  });

  it("fails for a lab in the Worker bundle too", () => {
    const build = fakeBuild({
      "polaris_web_production/index.js": `import "./sale-lab-server"`,
    });
    expect(problemsOf(build)).toEqual([
      "polaris_web_production/index.js: carries the lab module name sale-lab-server",
    ]);
  });

  it.each(LAB_ROUTES)("catches the planted route %s", (route) => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js": `a.pathname==="${route}"`,
    });
    expect(problemsOf(build)).toHaveLength(1);
  });

  it.each(LAB_MODULES)("catches the planted chunk of %s", (name) => {
    const build = fakeBuild({ [`client/assets/${name}-Hash123.js`]: "x" });
    expect(problemsOf(build)).toHaveLength(1);
  });

  it.each(LAB_MODULES)("catches the planted text of %s", (name) => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js": `import("./${name}")`,
    });
    expect(problemsOf(build)).toHaveLength(1);
  });

  it.each(LAB_MESSAGES)("catches the planted message %s", (message) => {
    const build = fakeBuild({
      "client/assets/index-AbC123.js": `h1("${message}")`,
    });
    expect(problemsOf(build)).toHaveLength(1);
  });

  it.each(LAB_SOURCE_DIRECTORIES)(
    "catches a source of the %s directory in a map",
    (directory) => {
      const build = fakeBuild({
        "client/assets/index-AbC123.js.map": JSON.stringify({
          sources: [`../../src/${directory}/anything.ts`],
          version: 3,
        }),
      });
      expect(problemsOf(build)).toHaveLength(1);
    }
  );
});

describe("the lab build beside the production build", () => {
  const labFiles = {
    "offline-poc/index.html":
      "<!doctype html><script src=/assets/x.js></script>",
    "offline-poc/assets/runtime-lab-DOjOZrXW.js":
      'a.pathname==="/offline-runtime-lab"',
  };

  it("is not scanned at the top of the directory, where build:offline-poc writes it", () => {
    const { problems, scanned } = findLabProblems(fakeBuild(labFiles));
    expect(problems).toEqual([]);
    expect(scanned).toBe(5);
  });

  it("is scanned when it is the directory given, so the lab build still fails", () => {
    const build = fakeBuild(labFiles);
    expect(
      problemsOf(path.join(build, LAB_BUILD_FOLDER)).length
    ).toBeGreaterThan(0);
  });

  it("is scanned when a folder of that name sits inside the client or the Worker", () => {
    const client = fakeBuild({ "client/offline-poc/index.js": "x" });
    expect(problemsOf(client)).toEqual([
      "client/offline-poc/index.js: the file is named after the lab offline-poc",
    ]);
    const worker = fakeBuild({
      "polaris_web_production/offline-poc/index.js": "x",
    });
    expect(problemsOf(worker)).toHaveLength(1);
  });
});

describe("words that look like a lab and are not", () => {
  it("lets aria-labelledby, label, collab and the offline-sale chunks through", () => {
    const build = fakeBuild({
      "client/assets/label-field-Q1.js": "x",
      "client/assets/offline-sale-panels-AsaX.js": `"aria-labelledby";"label";"collab-page";"/offline-sale"`,
    });
    expect(problemsOf(build)).toEqual([]);
  });
});

describe("a directory that proves nothing fails", () => {
  it("fails when the directory does not exist", () => {
    const missing = path.join(tmpdir(), "no-lab-build-that-does-not-exist");
    expect(problemsOf(missing)).toEqual([
      `${missing}: no build found (run the production build of apps/web first)`,
    ]);
  });

  it("fails when the directory is empty", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "no-lab-empty-"));
    directories.push(empty);
    expect(problemsOf(empty)).toEqual([
      `${empty}: no index.html, so this is not the client build of apps/web`,
      `${empty}: no script found, so this is not a build of apps/web`,
    ]);
  });

  it("fails on the command line when the directory does not exist", () => {
    const run = spawnSync(
      "node",
      [script, path.join(tmpdir(), "no-lab-missing")],
      {
        encoding: "utf8",
      }
    );
    expect(run.status).toBe(1);
  });
});

describe("the list stays complete as the labs change", () => {
  const mainSource = readFileSync(path.join(webSource, "main.tsx"), "utf8");

  it("knows every route main.tsx answers for a lab", () => {
    const routes = [...mainSource.matchAll(/pathname === "([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(routes.length).toBeGreaterThan(0);
    expect([...LAB_ROUTES].sort()).toEqual([...new Set(routes)].sort());
  });

  it("knows every lab module main.tsx imports on demand", () => {
    const imported = [
      ...mainSource.matchAll(
        /import\(\s*"\.\/(?:offline-poc|ui-gallery)\/([^"]+)"/g
      ),
    ].map((match) => match[1]);
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) {
      expect(NAME_PATTERN.test(name), name).toBe(true);
    }
  });

  it("knows the error screen of every lazy import in main.tsx", () => {
    const messages = [
      ...mainSource.matchAll(
        /<h1>(Falha ao abrir[^<]+)<\/h1>|<main>(Carregando laboratório[^<…]+)/g
      ),
    ].map((match) => match[1] ?? match[2]);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(
        LAB_MESSAGES.some((known) => message.startsWith(known)),
        message
      ).toBe(true);
    }
  });

  it("names every file of the lab directories, or leaves it to the source map check", () => {
    const withCommonName = [];
    for (const directory of LAB_SOURCE_DIRECTORIES) {
      for (const file of readdirSync(path.join(webSource, directory))) {
        if (!NAME_PATTERN.test(file)) {
          withCommonName.push(`${directory}/${file}`);
        }
      }
    }
    expect(withCommonName.sort()).toEqual([
      "offline-poc/runtime.ts",
      "ui-gallery/chart-states.tsx",
    ]);
  });

  it("looks in the folder the production build writes", () => {
    expect(path.relative(root, DEFAULT_BUILD_DIR)).toBe("apps/web/dist");
  });
});
