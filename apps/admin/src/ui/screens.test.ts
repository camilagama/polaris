import { PLATFORM_CAPABILITIES } from "@polaris/domain/admin/platform-capabilities";
import { securityHeaders } from "@polaris/http-security";
import { describe, expect, it, vi } from "vitest";
import type { AccessClaims } from "../access-jwt";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "../app";
import { createAdminPage, type PageRequest } from "./page";

/**
 * The screens of the Admin v2 shell as the Worker serves them (corte admin-v2, Parte 1: AC-P1.1, AC-P1.2, AC-C1,
 * AC-C6, AC-C8): one route per screen, each a whole document behind the login, with the document policy, a title that
 * starts with the environment, and a menu of links that only names what the operator's capabilities open.
 */

const assets = { css: "body{}", js: "export{};" };
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
const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-00000000beef";
const DOCUMENT = securityHeaders("admin-document")["Content-Security-Policy"];
const INERT = securityHeaders("admin")["Content-Security-Policy"];
const HTML_FORBIDDEN = [
  /<style\b/i,
  /\son[a-z]+\s*=/i,
  /\sstyle\s*=/i,
  /javascript:/i,
  /<(img|iframe|object|embed|base|form)\b/i,
];

function setup(role = "platform_owner", environment?: string) {
  const dependencies = {
    accessLog: {},
    activationFunnel: {},
    authenticate: vi.fn(() => Promise.resolve(claims)),
    incidents: {},
    organizations: {},
    privacy: {},
    refundWindow: {},
    report: vi.fn(),
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...owner, role })),
    support: {},
  } as unknown as AdminDependencies;
  const admin = createAdminApp(dependencies, assets);
  return (path: string, token = true) =>
    admin.fetch(
      new Request(`https://admin.example.invalid${path}`, {
        headers: token ? { "cf-access-jwt-assertion": "token" } : {},
      }),
      environment === undefined
        ? bindings
        : { ...bindings, POLARIS_ENVIRONMENT: environment }
    );
}

const TITLE = /<title>([^<]*)<\/title>/;
const MENU = /<nav aria-label="Admin" class="menu">(.*?)<\/nav>/s;
const LINK =
  /<a href="([^"]*)"( aria-current="page")?>(?:<span[^>]*>[^<]*<\/span>)?([^<]*)<\/a>/g;
const GROUP = /<p class="menu-group">([^<]*)<\/p>/g;
const ROOT = /<div id="admin"([^>]*)>/;
const NAV = /<nav aria-label="Admin"/g;
const DIGIT = /\d/;

function menuOf(html: string) {
  const menu = MENU.exec(html)?.[1] ?? "";
  return {
    current: [...menu.matchAll(LINK)]
      .filter((match) => match[2] !== undefined)
      .map((match) => match[3]),
    groups: [...menu.matchAll(GROUP)].map((match) => match[1]),
    links: [...menu.matchAll(LINK)].map((match) => `${match[3]} ${match[1]}`),
  };
}

const SCREENS = [
  ["/", "Início", "Início", 'data-tela="inicio"'],
  ["/lojas", "Buscar loja", "Buscar loja", 'data-tela="lojas"'],
  [`/lojas/${STORE}`, "Loja", "Buscar loja", `data-id="${STORE}"`],
  ["/casos", "Casos de suporte", "Casos de suporte", 'data-estado="abertos"'],
  [
    "/casos/novo",
    "Abrir caso de suporte",
    "Casos de suporte",
    'data-tela="caso-novo"',
  ],
  [
    `/casos/${CASE}`,
    "Caso de suporte",
    "Casos de suporte",
    `data-id="${CASE}"`,
  ],
  ["/funil", "Funil de ativação", "Funil", 'data-tela="funil"'],
] as const;

describe("one route per screen (AC-P1.2)", () => {
  it.each(SCREENS)(
    "serves %s as a whole document with the document policy, its title and its menu item marked",
    async (path, title, item, attribute) => {
      const response = await setup("platform_owner", "staging")(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=UTF-8"
      );
      expect(response.headers.get("content-security-policy")).toBe(DOCUMENT);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(TITLE.exec(html)?.[1]).toBe(`STAGING · ${title} · Polaris Admin`);
      expect(html).toContain(
        `<h1 id="tela-titulo" tabindex="-1">${title}</h1>`
      );
      expect(ROOT.exec(html)?.[1]).toContain(attribute);
      // the same menu twice (the side one and the <details> of a narrow screen), the current item marked in each
      expect(html.match(NAV)).toHaveLength(2);
      expect(menuOf(html).current).toEqual([item]);
      expect(html).toContain('<details class="compact-menu">');
      for (const forbidden of HTML_FORBIDDEN) {
        expect(html).not.toMatch(forbidden);
      }
    }
  );

  it.each([
    ["production", "PRODUÇÃO", "PRODUÇÃO · dados reais", "env-production"],
    ["staging", "STAGING", "STAGING · dados de teste", "env-staging"],
    [
      undefined,
      "AMBIENTE NÃO INFORMADO",
      "Ambiente não informado",
      "env-unknown",
    ],
    [
      "preview",
      "AMBIENTE NÃO INFORMADO",
      "Ambiente não informado",
      "env-unknown",
    ],
  ] as const)(
    "puts the environment %s first in the title and in words in the banner, never guessed from the host",
    async (environment, title, banner, kind) => {
      const html = await (
        await setup("platform_owner", environment)("/casos")
      ).text();
      expect(TITLE.exec(html)?.[1]).toBe(
        `${title} · Casos de suporte · Polaris Admin`
      );
      expect(html).toContain(`<p class="env ${kind}">${banner}</p>`);
    }
  );

  it.each([
    `/casos/${CASE}/close`,
    "/casos/123",
    "/lojas/nada",
    "/casos/novo/x",
    "/privacidade",
    "/incidentes",
    "/registro",
    "/retencoes",
    "/configuracoes",
  ])(
    "answers %s, not a screen of this part, with 404 and the inert policy",
    async (path) => {
      const response = await setup()(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toBe(INERT);
      expect(await response.text()).not.toContain("<html");
    }
  );

  it.each(SCREENS.map(([path]) => path))(
    "refuses %s without a token with 401 and no HTML (AC-C8)",
    async (path) => {
      const response = await setup()(path, false);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
  );

  it("writes into the page only the UUIDs that passed the test, and of the query only the fixed values (AC-C6)", async () => {
    const call = setup();
    const store = ROOT.exec(
      await (await call(`/casos/novo?loja=${STORE.toUpperCase()}`)).text()
    )?.[1];
    expect(store).toContain(`data-loja="${STORE}"`);
    const hostile = await (
      await call("/casos?loja=<b>x</b>&estado=<script>&q=dona@example.com")
    ).text();
    expect(ROOT.exec(hostile)?.[1]).toBe(
      ' data-tela="casos" data-ambiente="unknown" data-estado="abertos"'
    );
    expect(hostile).not.toContain("<b>");
    expect(hostile).not.toContain("dona@example.com");
    const closed = await (await call("/casos?estado=fechados")).text();
    expect(ROOT.exec(closed)?.[1]).toContain('data-estado="fechados"');
  });

  it("is the same document for two operators: nothing of the login is written into it", async () => {
    const first = await (await setup()(`/casos/${CASE}`)).text();
    expect(first).not.toContain("owner@example.com");
    expect(first).not.toContain(owner.id);
  });
});

describe("the menu by capability (AC-P1.1, AC-C1)", () => {
  const render = async (capabilities: readonly string[]) => {
    const page = await createAdminPage(assets)();
    const request: PageRequest = {
      capabilities,
      environment: "staging",
      forbidden: false,
      id: null,
      listState: "abertos",
      screen: "inicio",
      store: null,
    };
    return menuOf(page.render(request));
  };

  it.each([
    [
      "every capability",
      PLATFORM_CAPABILITIES,
      [
        "Início /",
        "Buscar loja /lojas",
        "Casos de suporte /casos",
        "Funil /funil",
      ],
      ["Lojas", "Suporte", "Operação"],
    ],
    [
      "platform:read",
      ["platform:read"],
      ["Início /", "Funil /funil"],
      ["Operação"],
    ],
    [
      "organization:diagnose",
      ["organization:diagnose"],
      ["Buscar loja /lojas"],
      ["Lojas"],
    ],
    [
      "support_case:manage",
      ["support_case:manage"],
      ["Casos de suporte /casos"],
      ["Suporte"],
    ],
    [
      "the read of the cases and the stores, no platform:read",
      ["organization:diagnose", "support_case:manage"],
      ["Buscar loja /lojas", "Casos de suporte /casos"],
      ["Lojas", "Suporte"],
    ],
    // the items of later parts are not in the menu until their screens exist
    [
      "only capabilities of screens that do not exist yet",
      [
        "privacy_case:manage",
        "operational_incident:read",
        "access_log:read",
        "organization:legal_hold",
      ],
      [],
      [],
    ],
    ["billing:operate", ["billing:operate"], [], []],
    ["none", [], [], []],
  ] as const)(
    "with %s, names exactly the items it opens and the groups that have one",
    async (_name, capabilities, links, groups) => {
      const menu = await render(capabilities);
      expect(menu.links).toEqual(links);
      expect(menu.groups).toEqual(groups);
    }
  );

  it("has no count in the menu", async () => {
    const page = await createAdminPage(assets)();
    const html = page.render({
      capabilities: PLATFORM_CAPABILITIES,
      environment: "production",
      forbidden: false,
      id: null,
      listState: "abertos",
      screen: "casos",
      store: null,
    });
    expect(MENU.exec(html)?.[1]).not.toMatch(DIGIT);
  });

  it("gives an operator with no capability the shell and the sentence, with no screen for the script (403)", async () => {
    const response = await setup("unknown_role")("/");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toBe(DOCUMENT);
    const html = await response.text();
    expect(html).toContain("Sem permissão para isto.");
    expect(ROOT.exec(html)?.[1]).toBe("");
    expect(menuOf(html).links).toEqual([]);
  });
});
