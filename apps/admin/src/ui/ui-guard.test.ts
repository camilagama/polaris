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
import { type AdminDependencies, createAdminApp } from "../app";

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
  ["eval", /\beval\b/],
  ["Function constructor", /\bFunction\b/],
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
  ["setHTMLUnsafe", /setHTMLUnsafe/],
  ["parseHTMLUnsafe", /parseHTMLUnsafe/],
  ["createContextualFragment", /createContextualFragment/],
  ["DOMParser", /DOMParser/],
  ["srcdoc", /srcdoc/],
  ["caches", /\bcaches\b/],
  ["postMessage", /postMessage/],
  ["dynamic import", /\bimport\(/],
  ["a worker", /\bnew (Shared)?Worker\b/],
  ["window.name", /window\.name/],
  ["a source set from a string", /\.src\s*=/],
];

const API_PATH = /\/api\/[a-z-]+/g;
/** The app is built only to list its routes: no request is made, so no dependency is ever called. */
const NEVER = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("the route list called a dependency");
    },
  }
);
const NO_DEPENDENCIES = new Proxy(
  {},
  { get: () => NEVER }
) as AdminDependencies;
const SIDEBAR_WIDTH = /--sidebar-width:\s*16rem;/;
const HEADER_HEIGHT = /--app-header:\s*3\.5rem;/;
const SHEET_LOADS = /@import|url\(|@font-face|https?:/i;
const NAME_WRAPS = /\.purge label bdi\s*\{[^}]*overflow-wrap:\s*anywhere/;
/**
 * The routes of the cut (AC-6 of the v1, AC-C9 of the v2): who the operator is, the search and the diagnostics, the
 * funnel, the support cases (list, detail, open and close) with the refund window under them
 * (`/api/support-cases/:id/refund-window`), and the operational incidents (list, detail and the retry of one event,
 * `/api/operational-incidents/:id/events/:eventId/retry`; Parte 2), of a store, suspending and
 * reactivating it (`/api/support-cases/:id/suspend` and `/reactivate`) and marking it as internal
 * (`/api/organizations/:id/classification`; Parte 3), giving and ending a temporary entitlement of a case
 * (`/api/support-cases/:id/entitlement-grants` and `…/:grantId`; Parte 4), the court's read of the access log
 * (`/api/access-log/read`, a POST; Parte 8), and the privacy cases (list, detail, open and each of the six steps,
 * `/api/privacy-cases/:id/identity`, `/role`, `/scope`, `/decision`, `/actions` and `/resolve`; Parte 11), and the two acts on
 * the closure notice of a closed store (`/api/support-cases/:id/closure-notice/reissue` and `/dismiss`; Parte 12), and
 * the temporary access to a case's customers: giving it (`/api/support-cases/:id/access`), reading them masked
 * (`/api/support-cases/:id/customers`) and ending it (`/api/tenant-access/:grantId`; Parte 5), and scheduling and
 * cancelling the purge of a closed store, placing and releasing its legal hold, and the list of the holds in force
 * (`/api/support-cases/:id/purge`, `/purge/cancel`, `/legal-hold`, `/legal-hold/release` and `/api/legal-holds`;
 * Parte 7), and revealing one field of one customer (`/api/support-cases/:id/customers/:customerId/reveal`; Parte 6).
 */
const ROUTES_OF_THIS_CUT = [
  "/api/access-log",
  "/api/funnel",
  "/api/legal-holds",
  "/api/operational-incidents",
  "/api/organizations",
  "/api/privacy-cases",
  "/api/support-cases",
  "/api/tenant-access",
  "/api/whoami",
];

function forbiddenIn(text: string, allowed: readonly string[] = []): string[] {
  return SCRIPT_FORBIDDEN.filter(
    ([name, pattern]) => !allowed.includes(name) && pattern.test(text)
  ).map(([name]) => name);
}

/**
 * The one timer of the page: the revealed customer value must leave the screen on its own after 30 seconds, and
 * nothing but a timer does that without a click. It is counted: one call, in one module.
 */
const TIMER_MODULE = "ui/views/reveal.ts";
const TIMER_CALL = /\bsetTimeout\(/g;
const TEST_FILE = /(\.test|\/test-[a-z-]+)\.ts$/;

function timerCalls(files: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    files
      .map((file): [string, number] => [
        file,
        (readFileSync(join(app, file), "utf8").match(TIMER_CALL) ?? []).length,
      ])
      .filter(([, count]) => count > 0)
  );
}

const MONEY_ON_ONE_LINE = /\.money\s*\{[^}]*white-space:\s*nowrap/;
const BUTTON_ROW_WRAPS = /\.button-row\s*\{[^}]*flex-wrap:\s*wrap/;
const BUTTON_LABEL_WRAPS =
  /\.button-row button[^{]*\{[^}]*white-space:\s*normal/;

const CARD_IS_MEASURED = /\.area \{[^}]*container-type:\s*inline-size/;
const STACKS_BY_THE_CARD = /@container \(max-width: 40rem\)/;

describe("the tables beside the sidebar", () => {
  it("stack by the width of their card, not of the window, so a 768 px window with the 16 rem sidebar has no horizontal scroll", () => {
    expect(sheet).toMatch(CARD_IS_MEASURED);
    expect(sheet).toMatch(STACKS_BY_THE_CARD);
  });
});

describe("the narrow screen of the billing area (AC-P10.2 to AC-P10.6)", () => {
  it("keeps a refund amount on one line and lets the buttons wrap, so 360 px has no horizontal scroll", () => {
    expect(sheet).toMatch(MONEY_ON_ONE_LINE);
    expect(sheet).toMatch(BUTTON_ROW_WRAPS);
    expect(sheet).toMatch(BUTTON_LABEL_WRAPS);
  });
});

describe("the built script of the page", () => {
  it("is small: under 100 KB gzip with the sheet, one bundle (corte admin-v2, AC-C15)", () => {
    expect(bundle.length).toBeGreaterThan(1000);
    const gzip = (text: string) =>
      execFileSync("gzip", ["-9c"], { input: text }).length;
    expect(gzip(bundle) + gzip(sheet)).toBeLessThan(100 * 1024);
  });

  it("carries no HTML sink, eval, browser storage, outside channel or log, and exactly one timer", () => {
    expect(forbiddenIn(bundle, ["setTimeout"])).toEqual([]);
    expect(bundle.match(/setTimeout/g)).toHaveLength(1);
  });

  it("has that one timer in the module of the reveal and nowhere else, and counts a second one", () => {
    const sources = uiFiles(ui).filter((file) => !TEST_FILE.test(file));
    expect(timerCalls(sources)).toEqual({ [TIMER_MODULE]: 1 });
    expect("setTimeout(f,1);setTimeout(g,2)".match(TIMER_CALL)).toHaveLength(2);
    expect("clearTimeout(timer)".match(TIMER_CALL)).toBeNull();
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
      "a.setHTMLUnsafe(b)",
      "Document.parseHTMLUnsafe(b)",
      "r.createContextualFragment(b)",
      "new DOMParser",
      "f.srcdoc=b",
      "caches.open(b)",
      "w.postMessage(b)",
      'import("./x")',
      "new Worker(u)",
      "window.name=b",
      "s.src=u",
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

  it("names, under those routes, only the diagnostics, the refund window, cancelling a renewal and refunding the period in force, the close of a case, the retry of one event, suspending and reactivating a store, marking it as internal, giving or ending an entitlement, the read of the access log, the six steps of a privacy case, the two acts on the closure notice, giving an access, reading the masked customers and revealing one field of one, and the purge and the legal hold: no other action of a case or a store", () => {
    // every literal segment after the first of every Admin route (`/api/support-cases/:caseId/close` gives `close`)
    const segments = new Set(
      createAdminApp(NO_DEPENDENCIES, { css: "", js: "" })
        .routes.filter((route) => route.path.startsWith("/api/"))
        .flatMap((route) =>
          route.path
            .split("/")
            .slice(3)
            .filter((segment) => segment !== "" && !segment.startsWith(":"))
        )
    );
    expect(segments.size).toBeGreaterThan(10);
    const namedIn = (known: ReadonlySet<string>, text: string) =>
      [...known]
        .filter((segment) => new RegExp(`/${segment}(?![a-z-])`).test(text))
        .sort();
    const expected = [
      "access",
      "actions",
      "billing",
      "cancel",
      "cancel-renewal",
      "classification",
      "close",
      "closure-notice",
      "customers",
      "decision",
      "diagnostics",
      "dismiss",
      "entitlement-grants",
      "events",
      "identity",
      "legal-hold",
      "purge",
      "reactivate",
      "read",
      "refund",
      "refund-window",
      "reissue",
      "release",
      "resolve",
      "retry",
      "reveal",
      "role",
      "scope",
      "suspend",
    ];
    const named = (text: string) => namedIn(segments, text);
    expect(named(bundle)).toEqual(expected);
    // every route segment is one the page names; a planted call to a segment no route of the cut permits is seen
    const planted = new Set([...segments, "erase"]);
    expect(expected).not.toContain("erase");
    expect(
      namedIn(planted, `${bundle}fetch(\`/api/support-cases/\${id}/erase\`)`)
    ).toEqual([...expected, "erase"].sort());
  });
});

/** The sources that hold a revealed customer value: nothing there reaches the clipboard, storage, a log or a secret. */
const FIELD_LIST = /REVEAL_FIELDS[^=]*=\s*\[([^\]]*)\]/;
const QUOTED = /"[a-z]+"/g;
const REVEAL_SOURCES = ["ui/views/reveal.ts", "ui/views/access.ts"];
const REVEAL_FORBIDDEN =
  /clipboard|localStorage|sessionStorage|indexedDB|console|document\.cookie|document\.title|history\.(push|replace)State|location\.(hash|search|href)|execCommand|password|passwd|senha|secret|segredo|token|api[_-]?key|webhook/i;

describe("the sources of the reveal (AC-P6.3, AC-P6.4)", () => {
  it("name no clipboard, storage, log, address, title or secret", () => {
    for (const file of REVEAL_SOURCES) {
      const code = readFileSync(join(app, file), "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .replaceAll(/^\s*\/\/.*$/gm, "");
      expect({ file, hit: code.match(REVEAL_FORBIDDEN)?.[0] }).toEqual({
        file,
        hit: undefined,
      });
    }
  });

  it("finds each of them when it is there (the check is not blind)", () => {
    for (const planted of [
      "navigator.clipboard.writeText(v)",
      "localStorage.setItem(k, v)",
      "console.log(v)",
      "document.title = v",
      "history.replaceState(null, '', v)",
      "const apiKey = 1",
      "const token = 1",
    ]) {
      expect(REVEAL_FORBIDDEN.test(planted)).toBe(true);
    }
  });

  it("offers exactly the four fields of the server's list and no other", () => {
    const source = readFileSync(join(app, "ui/views/reveal.ts"), "utf8");
    const list = source.match(FIELD_LIST)?.[1];
    expect(list?.match(QUOTED)).toEqual([
      '"name"',
      '"email"',
      '"phone"',
      '"notes"',
    ]);
  });
});

const DELETE_CALL = /method:\s*"DELETE"/g;
const OTHER_WRITES = /method:\s*"(PUT|PATCH)"/;

describe("the verbs of the built script", () => {
  it("sends one DELETE, the end of a grant or of an access, and no PUT or PATCH", () => {
    expect(bundle.match(DELETE_CALL)).toHaveLength(1);
    expect(bundle).not.toMatch(OTHER_WRITES);
  });
});

describe("the sheet of the page", () => {
  it("loads nothing: no import, no url(), no font face", () => {
    expect(sheet).not.toMatch(SHEET_LOADS);
  });

  it("lets the store's name typed to schedule the purge wrap at 360 px instead of widening the page", () => {
    expect(sheet).toMatch(NAME_WRAPS);
  });

  it("sets the width of the dash's sidebar and the height of its header in the sheet, never in a style attribute", () => {
    expect(sheet).toMatch(SIDEBAR_WIDTH);
    expect(sheet).toContain(".w-\\(--sidebar-width\\) {");
    expect(sheet).toMatch(HEADER_HEIGHT);
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

/** A suppression comment would switch the guard off for the line below it: none is allowed in apps/admin/ui. */
const SUPPRESSION = /biome-ignore/;

describe("the Biome guard of apps/admin/ui (AC-13)", () => {
  it("is never switched off by a comment, in any file of the page (and the check sees one)", () => {
    const suppressed = uiFiles(ui).filter(
      (file) =>
        !OUTSIDE_THE_GUARD.includes(file) &&
        SUPPRESSION.test(readFileSync(join(app, file), "utf8"))
    );
    expect(suppressed).toEqual([]);
    expect(
      SUPPRESSION.test(
        "// biome-ignore lint/plugin: planted\nbox.innerHTML = x;"
      )
    ).toBe(true);
  });

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
      'window.eval("1");',
      '(0, eval)("1");',
      'Function("return 1");',
      "window.setTimeout(() => undefined, 1);",
      "globalThis.setInterval(() => undefined, 1);",
      'globalThis.document.cookie = "a";',
      'caches.open("x");',
      'window.name = "x";',
      'Reflect.set(box, "innerHTML", "x");',
      'Object.assign(box, { innerHTML: "x" });',
      'box["inner" + "HTML"] = "x";',
      'box.setHTMLUnsafe("x");',
      'Document.parseHTMLUnsafe("x");',
      'document.createRange().createContextualFragment("x");',
      "export const parser = new DOMParser();",
      'document.execCommand("insertHTML", false, "x");',
      'import("./dom");',
      'export const worker = new Worker("x.js");',
      'window.postMessage("x", "*");',
      "export const frame = box.srcdoc;",
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

  it("refuses a timer in any module but the reveal's, whatever its name", () => {
    const names = ["zz-planted-timer.ts", "views/zz-reveal.ts"];
    const content = "setTimeout(() => undefined, 1);\nexport {};\n";
    try {
      for (const name of names) {
        writeFileSync(join(ui, name), content);
      }
      const result = spawnSync(
        join(repository, "node_modules/.bin/biome"),
        ["lint", ...names.map((name) => `apps/admin/ui/${name}`)],
        { cwd: repository, encoding: "utf8" }
      );
      const output = `${result.stdout}${result.stderr}`;
      for (const name of names) {
        expect(output).toContain(`apps/admin/ui/${name}:1:1 plugin`);
      }
    } finally {
      for (const name of names) {
        rmSync(join(ui, name), { force: true });
      }
    }
  }, 120_000);
});
