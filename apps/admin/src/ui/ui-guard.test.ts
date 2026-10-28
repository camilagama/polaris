import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * What the Admin page's script may not do, checked three ways (corte admin-tela-v1, AC-6, AC-7, AC-11, AC-12 and
 * AC-13; D-1 of the security review): the Biome guard on apps/admin/ui refuses each planted violation, the built
 * script carries none of the sinks and calls only the routes of this cut, and the sheet loads nothing. The page's
 * policy (Trusted Types `'none'`) is the browser's own refusal; this is the one that runs on every pull request.
 */

const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const app = join(repository, "apps/admin");
const ui = join(app, "ui");

const out = mkdtempSync(join(tmpdir(), "polaris-admin-guard-"));
execFileSync(
  "bun",
  [
    "build",
    "./ui/main.ts",
    "--target=browser",
    "--format=esm",
    "--minify",
    `--outfile=${join(out, "admin.js")}`,
  ],
  { cwd: app, stdio: "pipe" }
);
const bundle = readFileSync(join(out, "admin.js"), "utf8");
const sheet = readFileSync(join(ui, "admin.css"), "utf8");
afterAll(() => rmSync(out, { force: true, recursive: true }));

/** Sinks and outside channels the script must not carry, by the name the browser gives them. */
const SCRIPT_FORBIDDEN: readonly [string, RegExp][] = [
  ["innerHTML", /innerHTML/],
  ["outerHTML", /outerHTML/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /\.write(ln)?\(/],
  ["eval", /\beval\(/],
  ["Function constructor", /\bFunction\(/],
  ["setTimeout", /setTimeout/],
  ["setInterval", /setInterval/],
  ["localStorage", /localStorage/],
  ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/],
  ["cookie", /\.cookie\b/],
  ["sendBeacon", /sendBeacon/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/],
  ["console", /console\./],
  ["an absolute URL", /\b(https?|wss?):\/\//],
  [
    "a style or script element",
    /createElement(NS)?\([^)]*["'](style|script)["']/,
  ],
  ["a style property", /\.style\b/],
];

const API_PATH = /\/api\/[a-z-]+/g;
const SHEET_LOADS = /@import|url\(|@font-face|https?:/i;
/** The routes of this part of the cut (AC-6): who the operator is, the search and the diagnostics. */
const ROUTES_OF_THIS_CUT = ["/api/organizations", "/api/whoami"];

function forbiddenIn(text: string): string[] {
  return SCRIPT_FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(
    ([name]) => name
  );
}

describe("the built script of the page", () => {
  it("is small: under 60 KB gzip with the sheet (AC-16)", () => {
    expect(bundle.length).toBeGreaterThan(1000);
    const gzip = (text: string) =>
      execFileSync("gzip", ["-9c"], { input: text }).length;
    expect(gzip(bundle) + gzip(sheet)).toBeLessThan(60 * 1024);
  });

  it("carries no HTML sink, eval, timer, browser storage, outside channel or log", () => {
    expect(forbiddenIn(bundle)).toEqual([]);
  });

  it("finds each of them when it is there (the check is not blind)", () => {
    const planted = [
      "a.innerHTML=b",
      "a.outerHTML=b",
      'a.insertAdjacentHTML("x",b)',
      "document.write(b)",
      "eval(b)",
      "new Function(b)",
      "setTimeout(f,1)",
      "setInterval(f,1)",
      "localStorage.x",
      "sessionStorage.x",
      "indexedDB.open(x)",
      "document.cookie",
      "navigator.sendBeacon(u)",
      "new XMLHttpRequest",
      "new WebSocket(u)",
      "console.log(x)",
      'fetch("https://elsewhere.example")',
      'document.createElement("style")',
      "a.style.color=b",
    ];
    expect(planted.map((text) => forbiddenIn(text))).toEqual(
      SCRIPT_FORBIDDEN.map(([name]) => [name])
    );
  });

  it("calls only the routes of this cut", () => {
    expect([...new Set(bundle.match(API_PATH))].sort()).toEqual(
      ROUTES_OF_THIS_CUT
    );
  });
});

describe("the sheet of the page", () => {
  it("loads nothing: no import, no url(), no font face", () => {
    expect(sheet).not.toMatch(SHEET_LOADS);
  });
});

/** Every file under apps/admin/ui; the guard covers all of them but the test DOM, which defines the sinks to refuse them. */
function uiFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? uiFiles(path) : [relative(app, path)];
  });
}

const OUTSIDE_THE_GUARD = ["ui/test-dom.ts"];

describe("the Biome guard of apps/admin/ui (AC-13)", () => {
  it("leaves out exactly the test DOM, and it is there", () => {
    const files = uiFiles(ui);
    expect(files.filter((file) => OUTSIDE_THE_GUARD.includes(file))).toEqual(
      OUTSIDE_THE_GUARD
    );
    const biome = JSON.parse(
      readFileSync(join(repository, "biome.jsonc"), "utf8").replaceAll(
        /^\s*\/\/.*$/gm,
        ""
      )
    ) as { overrides: { includes: string[]; plugins?: string[] }[] };
    const guard = biome.overrides.find((override) =>
      override.plugins?.includes(
        "./scripts/biome-plugins/admin-ui-text-only.grit"
      )
    );
    expect(guard?.includes).toEqual([
      "apps/admin/ui/**",
      ...OUTSIDE_THE_GUARD.map((file) => `!apps/admin/${file}`),
    ]);
  });

  it("refuses each planted sink and each planted import, and lets text and the allowed types through", () => {
    const sinks = [
      'box.innerHTML = "<b>x</b>";',
      'box.outerHTML = "x";',
      'box["innerHTML"] = "x";',
      "export const read = box.innerHTML;",
      'box.insertAdjacentHTML("beforeend", "x");',
      'document.write("x");',
      'eval("1");',
      'export const make = new Function("return 1");',
      "setTimeout(() => undefined, 1);",
      "setInterval(() => undefined, 1);",
      'localStorage.setItem("a", "b");',
      'sessionStorage.setItem("a", "b");',
      'indexedDB.open("x");',
      'document.cookie = "a=b";',
      'document.createElement("style");',
      'document.createElement("script");',
      "document.adoptedStyleSheets = [];",
      'console.log("x");',
    ];
    const imports = [
      "@polaris/db/admin-diagnostics-repository",
      "@polaris/domain/billing/entitlements",
      "@polaris/http-security",
      "@/ui/button",
      "../../web/src/app",
      "../src/app",
      "hono",
      "react",
      "node:fs",
      "cloudflare:workers",
    ];
    const allowed = [
      'import type { OrganizationDiagnostics } from "@polaris/domain/admin/organization-diagnostics";',
      'import { createDom } from "./dom";',
      "export const dom = createDom(document);",
      "export type Report = OrganizationDiagnostics;",
      'dom.el("p").textContent = "<b>ok</b>";',
    ];
    const names = [
      "zz-planted-sinks.ts",
      "zz-planted-imports.ts",
      "zz-planted-allowed.ts",
    ];
    const contents = [
      `const box = document.createElement("div");\n${sinks.join("\n")}\n`,
      `${imports.map((source, index) => `import type { T${index} } from "${source}";`).join("\n")}\nexport type All = [${imports.map((_source, index) => `T${index}`).join(", ")}];\n`,
      `${allowed.join("\n")}\n`,
    ];
    try {
      names.forEach((name, index) => {
        writeFileSync(join(ui, name), contents[index] ?? "");
      });
      const result = spawnSync(
        join(repository, "node_modules/.bin/biome"),
        [
          "lint",
          "--max-diagnostics=200",
          ...names.map((name) => `apps/admin/ui/${name}`),
        ],
        { cwd: repository, encoding: "utf8" }
      );
      const output = `${result.stdout}${result.stderr}`;
      const lines = (name: string, rule: string) =>
        [
          ...output.matchAll(
            new RegExp(`apps/admin/ui/${name}:(\\d+):\\d+ ${rule}`, "g")
          ),
        ].map((match) => Number(match[1]));
      // one per planted line (line 1 of the sinks file makes the element)
      const sinkLines = new Set([
        ...lines("zz-planted-sinks\\.ts", "plugin"),
        ...lines("zz-planted-sinks\\.ts", "lint/suspicious/noConsole"),
      ]);
      expect([...sinkLines].sort((a, b) => a - b)).toEqual(
        sinks.map((_sink, index) => index + 2)
      );
      expect(
        lines("zz-planted-imports\\.ts", "lint/style/noRestrictedImports")
      ).toEqual(imports.map((_source, index) => index + 1));
      expect(lines("zz-planted-allowed\\.ts", "\\S+")).toEqual([]);
    } finally {
      for (const name of names) {
        rmSync(join(ui, name), { force: true });
      }
    }
  }, 120_000);
});
