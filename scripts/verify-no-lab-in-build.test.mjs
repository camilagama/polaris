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
const webRoot = path.join(root, "apps/web");
const webSource = path.join(webRoot, "src");
const LAB_BUILD_CONFIGS = ["vite.offline.config.ts"];

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
    "offline-poc/assets/runtime-lab-DOjOZrXW.js":
      'a.pathname==="/offline-runtime-lab"',
    "offline-poc/index.html":
      "<!doctype html><script src=/assets/x.js></script>",
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

const VITE_CONFIG = /^vite.*\.ts$/;
const LAB_WORD = /offline-poc|ui-gallery/;
const LAB_ROUTE_LITERAL = /["'`]\/(?:offline|ui)(?:-|["'`])/;
const RECOGNIZED_LAB_FORMS = [
  /pathname\s*===\s*"[^"]+"/g,
  /import\(\s*"\.\/(?:offline-poc|ui-gallery)\/[^"]+"/g,
  /import\.meta\.env\.MODE === "offline-poc"/g,
];

/** Lines of the source that name a lab folder in a way the other checks do not read (static import, startsWith, another comparison, a variable). */
function unrecognizedLabMentions(source) {
  let rest = source;
  for (const form of RECOGNIZED_LAB_FORMS) {
    rest = rest.replace(form, "");
  }
  return rest
    .split("\n")
    .filter((line) => LAB_WORD.test(line) || LAB_ROUTE_LITERAL.test(line));
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MODULE_REFERENCE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(?:\/\*[\s\S]*?\*\/\s*)?(["'`])([^"'`]+)\1/g;
const GLOB_ARGUMENTS = /\bimport\.meta\.glob(?:Eager)?\s*\(([^)]*)\)/g;
const QUOTED = /(["'`])([^"'`]+)\1/g;
const LAB_SEGMENT = new RegExp(
  `(?:^|/)(?:${LAB_SOURCE_DIRECTORIES.join("|")})(?:/|$)`
);

function sourceFilesOf(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map((entry) =>
      path
        .relative(directory, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/")
    )
    .sort();
}

function referencesToLabs(file, text) {
  const globbed = [...text.matchAll(GLOB_ARGUMENTS)].flatMap((glob) =>
    [...glob[1].matchAll(QUOTED)].map((match) => match[2])
  );
  return [
    ...[...text.matchAll(MODULE_REFERENCE)].map((match) => match[2]),
    ...globbed,
  ].filter((specifier) => {
    const resolved = specifier.startsWith(".")
      ? path.posix.join(path.posix.dirname(file), specifier)
      : path.posix.normalize(specifier);
    return LAB_SEGMENT.test(resolved);
  });
}

/**
 * Files of the source tree outside the lab folders (and outside `exempt`, exact paths) that import something of a
 * lab folder: static, dynamic, `require`, a Vite glob, by `./`, by `../` or through an alias that spells the folder.
 */
function labImportsOutsideLabs(files, exempt = []) {
  return Object.entries(files)
    .filter(
      ([file]) =>
        !(exempt.includes(file) || LAB_SEGMENT.test(file)) &&
        SOURCE_FILE.test(file)
    )
    .flatMap(([file, text]) =>
      referencesToLabs(file, text).map(
        (specifier) => `${file}: imports the lab module ${specifier}`
      )
    );
}

/** Config text that names a lab folder: an alias, a path or a glob that points the build at a lab. */
function labFolderInConfig(file, text) {
  const hit = new RegExp(LAB_SOURCE_DIRECTORIES.join("|")).exec(text);
  return hit ? [`${file}: names the lab folder ${hit[0]}`] : [];
}

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

  it("finds no mention of a lab folder in main.tsx outside the forms the checks above read", () => {
    expect(unrecognizedLabMentions(mainSource)).toEqual([]);
  });

  it("imports no lab from a file of the source tree outside the lab folders", () => {
    const files = Object.fromEntries(
      sourceFilesOf(webSource).map((file) => [
        file,
        readFileSync(path.join(webSource, file), "utf8"),
      ])
    );
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(labImportsOutsideLabs(files, ["main.tsx"])).toEqual([]);
  });

  it("needs the exemption of main.tsx, which does import the labs on demand", () => {
    expect(
      labImportsOutsideLabs({ "main.tsx": mainSource }, []).length
    ).toBeGreaterThan(0);
  });

  it("names no lab folder in the production configs or in tsconfig.json (aliases, paths, globs)", () => {
    const configs = readdirSync(webRoot)
      .filter((name) => VITE_CONFIG.test(name))
      .sort();
    expect(configs).toEqual([
      "vite.config.ts",
      "vite.offline.config.ts",
      "vite.pwa.config.ts",
      "vite.ui.ts",
      "vitest.workers-db.config.ts",
    ]);
    const problems = [
      ...configs.filter((name) => !LAB_BUILD_CONFIGS.includes(name)),
      "tsconfig.json",
    ].flatMap((name) =>
      labFolderInConfig(name, readFileSync(path.join(webRoot, name), "utf8"))
    );
    expect(problems).toEqual([]);
  });

  it("keeps the exempt lab build config naming the lab, so the exemption still has a reason", () => {
    expect(
      labFolderInConfig(
        "vite.offline.config.ts",
        readFileSync(path.join(webRoot, "vite.offline.config.ts"), "utf8")
      ).length
    ).toBeGreaterThan(0);
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

describe("labImportsOutsideLabs", () => {
  const clean = {
    "app-shell/app.tsx":
      'import { Button } from "@/ui/button";\nimport { x } from "../lib/x";',
    "offline-poc/runtime-lab.tsx": 'import { y } from "./runtime";',
    "ui-gallery/ui-gallery.tsx": 'import { z } from "../offline-poc/runtime";',
  };

  it("passes today's shape: labs import each other, nothing else reaches them", () => {
    expect(labImportsOutsideLabs(clean)).toEqual([]);
  });

  it("exempts only the exact files listed", () => {
    const files = { ...clean, "main.tsx": 'await import("./offline-poc/a");' };
    expect(labImportsOutsideLabs(files, ["main.tsx"])).toEqual([]);
    expect(labImportsOutsideLabs(files, ["other/main.tsx"])).toEqual([
      "main.tsx: imports the lab module ./offline-poc/a",
    ]);
  });

  it.each([
    [
      'import { Lab } from "./offline-poc/runtime-lab";',
      "app-shell/a.tsx",
      "./offline-poc/runtime-lab",
      "static by ./",
    ],
    [
      'import { Lab } from "../offline-poc/runtime-lab";',
      "app-shell/a.tsx",
      "../offline-poc/runtime-lab",
      "static by ../",
    ],
    [
      'import "../ui-gallery/ui-gallery";',
      "sales/a.tsx",
      "../ui-gallery/ui-gallery",
      "side-effect import",
    ],
    [
      'export { Lab } from "../../offline-poc/runtime-lab";',
      "sales/deep/a.ts",
      "../../offline-poc/runtime-lab",
      "re-export",
    ],
    [
      'const m = await import(\n  "../offline-poc/runtime-lab"\n);',
      "sales/a.ts",
      "../offline-poc/runtime-lab",
      "dynamic across lines",
    ],
    [
      ["const m = import(`../offline-poc/", "$", "{name}`);"].join(""),
      "sales/a.ts",
      ["../offline-poc/", "$", "{name}"].join(""),
      "template literal",
    ],
    [
      'import { Lab } from "@/lib/../offline-poc/runtime-lab";',
      "sales/a.tsx",
      "@/lib/../offline-poc/runtime-lab",
      "alias plus ../",
    ],
    [
      'import { G } from "src/ui-gallery/ui-gallery";',
      "sales/a.tsx",
      "src/ui-gallery/ui-gallery",
      "path from the source root",
    ],
    [
      'const m = require("../offline-poc/runtime");',
      "sales/a.js",
      "../offline-poc/runtime",
      "require",
    ],
    [
      'const all = import.meta.glob(["./a/*.ts", "../offline-poc/*.tsx"]);',
      "sales/a.ts",
      "../offline-poc/*.tsx",
      "Vite glob, second of a list",
    ],
    [
      'const m = import(/* @vite-ignore */ "../offline-poc/x");',
      "sales/a.ts",
      "../offline-poc/x",
      "dynamic with a comment before the path",
    ],
    [
      'const w = new Worker(new URL("../offline-poc/w.ts", import.meta.url));',
      "sales/a.ts",
      "../offline-poc/w.ts",
      "new URL",
    ],
    [
      'const all = import.meta.glob("../offline-poc/*.tsx");',
      "sales/a.ts",
      "../offline-poc/*.tsx",
      "Vite glob",
    ],
    [
      'import { Lab } from "../offline-poc";',
      "sales/a.tsx",
      "../offline-poc",
      "folder index",
    ],
  ])("fails on %s in %s", (line, file, specifier) => {
    expect(labImportsOutsideLabs({ [file]: line })).toEqual([
      `${file}: imports the lab module ${specifier}`,
    ]);
  });

  it("does not take a word that only looks like a lab folder for one", () => {
    const files = {
      "sales/a.tsx":
        'import { x } from "../offline/offline-sale";\nimport { g } from "./my-ui-gallery-ish";',
    };
    expect(labImportsOutsideLabs(files)).toEqual([]);
  });
});

describe("labFolderInConfig", () => {
  it("passes a config that aliases only the app folders", () => {
    const text =
      'alias: { "@/ui": fileURLToPath(new URL("./src/ui", import.meta.url)) }';
    expect(labFolderInConfig("vite.ui.ts", text)).toEqual([]);
  });

  it.each([
    'alias: { "@lab": fileURLToPath(new URL("./src/offline-poc", import.meta.url)) }',
    'resolve: { alias: [{ find: "@g", replacement: path.resolve(__dirname, "src/ui-gallery") }] }',
    '"paths": { "@lab/*": ["./src/offline-poc/*"] }',
  ])("fails on %s", (text) => {
    expect(labFolderInConfig("vite.config.ts", text)).toHaveLength(1);
  });
});

describe("unrecognizedLabMentions", () => {
  it("accepts the forms the drift checks read", () => {
    const source = [
      'const on = import.meta.env.MODE === "offline-poc";',
      'const route = window.location.pathname === "/offline-poc";',
      'const { Lab } = await import("./offline-poc/runtime-lab");',
      'const { Gallery } = await import(\n  "./ui-gallery/ui-gallery"\n);',
    ].join("\n");
    expect(unrecognizedLabMentions(source)).toEqual([]);
  });

  it.each([
    ['import { Lab } from "./offline-poc/runtime-lab";', "static import"],
    ['if (location.pathname.startsWith("/offline-poc")) {}', "startsWith"],
    [
      'const same = window.location.pathname == "/offline-poc";',
      "loose comparison",
    ],
    [
      ["const { Lab } = await import(`./offline-poc/", "$", "{name}`);"].join(
        ""
      ),
      "template import",
    ],
    ['const folder = "ui-gallery";', "variable"],
    [
      'if (location.pathname.startsWith("/offline-runtime-lab")) {}',
      "startsWith of a route without the folder name",
    ],
    ['if (location.pathname.startsWith("/offline-")) {}', "short prefix"],
    ['if (location.pathname.startsWith("/ui")) {}', "bare ui prefix"],
    ['if (["/ui-galeria"].includes(location.pathname)) {}', "route in a list"],
    ['switch (path) { case "/offline-poc": break; }', "switch case"],
  ])("fails on %s (%s)", (line) => {
    expect(unrecognizedLabMentions(line)).toEqual([line]);
  });
});
