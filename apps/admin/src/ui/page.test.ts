import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { securityHeaders } from "@polaris/http-security";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type AccessClaims, AccessJwtError } from "../access-jwt";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "../app";

/**
 * The operator's page as the Worker serves it (corte admin-tela-v1, AC-1, AC-2 and AC-11; D-1 of the security
 * review): behind the login, with the document policy on exactly the page, its script and its sheet, and the inert
 * policy on everything else. The script is the real one, built here from apps/admin/ui as `build:ui` builds it.
 */

const app = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "polaris-admin-ui-"));
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
const assets = {
  css: readFileSync(join(app, "ui/admin.css"), "utf8"),
  js: readFileSync(join(out, "admin.js"), "utf8"),
};
afterAll(() => rmSync(out, { force: true, recursive: true }));

const bindings: AdminBindings = {
  ACCESS_AUDIENCE: "a".repeat(64),
  ACCESS_TEAM_DOMAIN: "polaris.cloudflareaccess.com",
  ADMIN_HYPERDRIVE: { connectionString: "postgresql://admin.invalid/db" },
};
const claims: AccessClaims = {
  email: "owner@example.com",
  expiresAt: 2_000_000_000,
  issuedAt: 1_000_000_000,
  issuer: "https://polaris.cloudflareaccess.com",
  subject: "subject-1",
};
const owner = {
  emailSnapshot: "owner@example.com",
  id: "0199a0a0-0000-7000-8000-000000000001",
  issuer: "https://polaris.cloudflareaccess.com",
  role: "platform_owner",
  subject: "subject-1",
};

const INERT =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DOCUMENT = securityHeaders("admin-document")["Content-Security-Policy"];
const SCRIPT_TAG = /<script\b[^>]*>/gi;
const SCRIPT_SRC =
  /<script type="module" src="(\/ui\/admin-[0-9a-f]{16}\.js)"><\/script>/;
const STYLE_HREF =
  /<link rel="stylesheet" href="(\/ui\/admin-[0-9a-f]{16}\.css)" \/>/;
const LINK_TAG = /<link\b/gi;
const MODULE_SCRIPT = /^<script type="module" src="\/ui\/admin-/;
/** Rodrigo's list (D-1): an inline style, an event handler attribute, a style attribute, a javascript: URL, and any element that loads or submits. */
const HTML_FORBIDDEN = [
  /<style\b/i,
  /\son[a-z]+\s*=/i,
  /\sstyle\s*=/i,
  /javascript:/i,
  /<(img|iframe|object|embed|base|form)\b/i,
];

function setup(overrides: Partial<AdminDependencies> = {}) {
  const dependencies = {
    accessLog: {},
    activationFunnel: {},
    authenticate: vi.fn(() => Promise.resolve(claims)),
    incidents: {},
    organizations: {
      diagnostics: vi.fn(() => Promise.resolve(null)),
      list: vi.fn(() => Promise.resolve({ next: null, organizations: [] })),
    },
    privacy: {},
    refundWindow: {},
    report: vi.fn(),
    resolvePrincipal: vi.fn(() => Promise.resolve(owner)),
    support: {},
    ...overrides,
  } as unknown as AdminDependencies;
  const admin = createAdminApp(dependencies, assets);
  const call = (path: string, init: RequestInit = {}, token = true) =>
    admin.fetch(
      new Request(`https://admin.example.invalid${path}`, {
        ...init,
        headers: token ? { "cf-access-jwt-assertion": "token" } : {},
      }),
      bindings
    );
  return { call, dependencies };
}

async function paths() {
  const html = await (await setup().call("/")).text();
  return {
    script: SCRIPT_SRC.exec(html)?.[1] ?? "",
    style: STYLE_HREF.exec(html)?.[1] ?? "",
  };
}

function expectAdminHeaders(response: Response, policy: string) {
  expect(response.headers.get("content-security-policy")).toBe(policy);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("cross-origin-opener-policy")).toBe(
    "same-origin"
  );
}

describe("the page and its two files", () => {
  it("serves the page to an operator with the document policy, uncached and without referrer (AC-1)", async () => {
    const response = await setup().call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=UTF-8"
    );
    expectAdminHeaders(response, DOCUMENT);
  });

  it("serves the script and the sheet under their hashed names, with their types and the same policy", async () => {
    const { call } = setup();
    const { script, style } = await paths();
    const js = await call(script);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect(await js.text()).toBe(assets.js);
    expectAdminHeaders(js, DOCUMENT);
    const css = await call(style);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe(assets.css);
    expectAdminHeaders(css, DOCUMENT);
  });

  it("names a changed script differently, so an old page never runs a new script", async () => {
    const before = await paths();
    const changed = createAdminApp(setup().dependencies, {
      ...assets,
      js: `${assets.js}\n`,
    });
    const html = await (
      await changed.fetch(
        new Request("https://admin.example.invalid/", {
          headers: { "cf-access-jwt-assertion": "token" },
        }),
        bindings
      )
    ).text();
    expect(SCRIPT_SRC.exec(html)?.[1]).not.toBe(before.script);
    expect(STYLE_HREF.exec(html)?.[1]).toBe(before.style);
    const stale = await changed.fetch(
      new Request(`https://admin.example.invalid${before.script}`, {
        headers: { "cf-access-jwt-assertion": "token" },
      }),
      bindings
    );
    expect(stale.status).toBe(404);
    expectAdminHeaders(stale, INERT);
  });

  it.each([
    ["/api/whoami", {}],
    ["/health", {}],
    ["/nada", {}],
    ["/index.html", {}],
    ["/ui/admin-0000000000000000.js", {}],
    ["/ui/", {}],
    ["/", { method: "POST" }],
  ] as const)("keeps the inert policy on %s (the API, /health, a 404, a stale file, a POST to the page)", async (path, init) => {
    expectAdminHeaders(await setup().call(path, init), INERT);
  });
});

describe("who gets the page (AC-2)", () => {
  it.each(["/", "/ui/admin-0000000000000000.js"])(
    "answers %s without a token with 401 and no HTML, before asking anyone",
    async (path) => {
      const { call, dependencies } = setup();
      const response = await call(path, {}, false);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
      expect(dependencies.authenticate).not.toHaveBeenCalled();
      expectAdminHeaders(response, DOCUMENT_OR_INERT(path));
    }
  );

  it("refuses the script and the sheet without a token too", async () => {
    const { script, style } = await paths();
    const answers = await Promise.all(
      [script, style].map((path) => setup().call(path, {}, false))
    );
    for (const response of answers) {
      expect(response.status).toBe(401);
    }
    const bodies = await Promise.all(answers.map((answer) => answer.text()));
    expect(bodies).toEqual([
      '{"error":"unauthenticated"}',
      '{"error":"unauthenticated"}',
    ]);
  });

  it.each([
    [
      "a token of another team",
      {
        authenticate: vi.fn(() =>
          Promise.reject(new AccessJwtError("wrong_issuer"))
        ),
      },
      401,
    ],
    [
      "a login that is not an operator, or a disabled one",
      { resolvePrincipal: vi.fn(() => Promise.resolve(null)) },
      403,
    ],
  ] as const)("refuses %s without HTML", async (_name, overrides, status) => {
    const response = await setup(overrides as Partial<AdminDependencies>).call(
      "/"
    );
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("<html");
  });
});

/** The page path keeps the document policy even on its refusal (the list is by path); a file path that is stale does not. */
function DOCUMENT_OR_INERT(path: string): string {
  return path === "/" ? DOCUMENT : INERT;
}

describe("the HTML is a constant (AC-11, D-1)", () => {
  it("is the same for every operator: nothing of the login, a store or the request is written into it", async () => {
    const first = await (await setup().call("/")).text();
    const other = await (
      await setup({
        resolvePrincipal: vi.fn(() =>
          Promise.resolve({
            ...owner,
            emailSnapshot: "<script>alert(1)</script>@example.com",
            id: "0199a0a0-0000-7000-8000-000000000002",
          })
        ),
      }).call("/?q=<b>x</b>")
    ).text();
    expect(other).toBe(first);
    expect(first).not.toContain("owner@example.com");
  });

  it("has one module script by file, one sheet, and no inline script, style, handler or javascript: URL", async () => {
    const html = await (await setup().call("/")).text();
    expect(html.match(SCRIPT_TAG)).toEqual([
      expect.stringMatching(MODULE_SCRIPT),
    ]);
    expect(html).toMatch(SCRIPT_SRC);
    expect(html.match(LINK_TAG)).toHaveLength(1);
    expect(html).toMatch(STYLE_HREF);
    for (const forbidden of HTML_FORBIDDEN) {
      expect(html).not.toMatch(forbidden);
    }
  });
});
