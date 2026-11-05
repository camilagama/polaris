import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/**
 * The operator's pages of the Admin (corte admin-v2, Parte 1): one route per screen, each a whole HTML document the
 * Worker renders itself, behind the same Access verification as the API, with one script and one sheet built from
 * `apps/admin/ui` and embedded as Text modules.
 *
 * What the Worker writes into a page is fixed text and what it already knows without reading a store: the screen,
 * the menu of the screens the principal's capabilities open (links, so the menu works without the script), the
 * environment and the UUID of the path or of `?loja=` once it passed the UUID test. No store name, e-mail, reason or
 * bootstrap JSON is ever written: every datum reaches the page by `fetch` and is written as text. The two file names
 * carry a hash of their content, so a page opened during a deploy never pairs a new HTML with an old script (a stale
 * name answers 404).
 */

export interface AdminPageAssets {
  /** The sheet, `apps/admin/ui/admin.css`. */
  css: string;
  /** The bundled script of `apps/admin/ui/main.ts`. */
  js: string;
}

export type ScreenId =
  | "caso"
  | "caso-novo"
  | "casos"
  | "funil"
  | "incidente"
  | "incidentes"
  | "inicio"
  | "loja"
  | "lojas"
  | "registro";

interface Screen {
  capability: PlatformCapability;
  /** The screen's name in the tab title and in its `h1`. */
  title: string;
}

export const SCREENS: Readonly<Record<ScreenId, Screen>> = {
  caso: { capability: "support_case:manage", title: "Caso de suporte" },
  "caso-novo": {
    capability: "support_case:manage",
    title: "Abrir caso de suporte",
  },
  casos: { capability: "support_case:manage", title: "Casos de suporte" },
  funil: { capability: "platform:read", title: "Funil de ativação" },
  incidente: { capability: "operational_incident:read", title: "Incidente" },
  incidentes: {
    capability: "operational_incident:read",
    title: "Incidentes",
  },
  inicio: { capability: "platform:read", title: "Início" },
  loja: { capability: "organization:diagnose", title: "Loja" },
  lojas: { capability: "organization:diagnose", title: "Buscar loja" },
  registro: { capability: "access_log:read", title: "Registro de acessos" },
};

interface MenuItem {
  capability: PlatformCapability;
  label: string;
  path: string;
  screens: readonly ScreenId[];
}

/**
 * The menu of the design (§1.1), with only the screens that exist: a group whose items the operator cannot open goes
 * with its label. The other items of the design (Privacidade, Retenções legais, Configurações) enter with their parts.
 */
const MENU: readonly { items: readonly MenuItem[]; label: string | null }[] = [
  {
    items: [
      {
        capability: "platform:read",
        label: "Início",
        path: "/",
        screens: ["inicio"],
      },
    ],
    label: null,
  },
  {
    items: [
      {
        capability: "organization:diagnose",
        label: "Buscar loja",
        path: "/lojas",
        screens: ["lojas", "loja"],
      },
    ],
    label: "Lojas",
  },
  {
    items: [
      {
        capability: "support_case:manage",
        label: "Casos de suporte",
        path: "/casos",
        screens: ["casos", "caso-novo", "caso"],
      },
    ],
    label: "Suporte",
  },
  {
    items: [
      {
        capability: "operational_incident:read",
        label: "Incidentes",
        path: "/incidentes",
        screens: ["incidentes", "incidente"],
      },
      {
        capability: "platform:read",
        label: "Funil",
        path: "/funil",
        screens: ["funil"],
      },
    ],
    label: "Operação",
  },
  {
    items: [
      {
        capability: "access_log:read",
        label: "Registro de acessos",
        path: "/registro",
        screens: ["registro"],
      },
    ],
    label: "Auditoria",
  },
];

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The screen a path names, with the UUID it carries; null for any other path (it answers 404). */
export function screenOfPath(
  path: string
): { id: string | null; screen: ScreenId } | null {
  const fixed: Readonly<Record<string, ScreenId>> = {
    "/": "inicio",
    "/casos": "casos",
    "/casos/novo": "caso-novo",
    "/funil": "funil",
    "/incidentes": "incidentes",
    "/lojas": "lojas",
    "/registro": "registro",
  };
  const screen = fixed[path];
  if (screen !== undefined) {
    return { id: null, screen };
  }
  const [, area, id, ...rest] = path.split("/");
  if (rest.length > 0 || id === undefined || !isUuid(id)) {
    return null;
  }
  if (area === "lojas") {
    return { id: id.toLowerCase(), screen: "loja" };
  }
  if (area === "casos") {
    return { id: id.toLowerCase(), screen: "caso" };
  }
  if (area === "incidentes") {
    return { id: id.toLowerCase(), screen: "incidente" };
  }
  return null;
}

interface Environment {
  banner: string;
  kind: "production" | "staging" | "unknown";
  title: string;
}

/** The environment as the Worker's configuration names it; never guessed from the hostname (design §1.2). */
function environmentOf(name: string | undefined): Environment {
  if (name === "production") {
    return {
      banner: "PRODUÇÃO · dados reais",
      kind: "production",
      title: "PRODUÇÃO",
    };
  }
  if (name === "staging") {
    return {
      banner: "STAGING · dados de teste",
      kind: "staging",
      title: "STAGING",
    };
  }
  return {
    banner: "Ambiente não informado",
    kind: "unknown",
    title: "AMBIENTE NÃO INFORMADO",
  };
}

export interface PageRequest {
  capabilities: readonly string[];
  environment: string | undefined;
  /** The operator may not open this screen: the shell and "Sem permissão para isto.", no script data. */
  forbidden: boolean;
  /** The UUID of the path (a store or a case). */
  id: string | null;
  /** `?estado=` of the cases' list, only its two fixed values. */
  listState: "abertos" | "fechados";
  screen: ScreenId;
  /** `?loja=`, only once it passed the UUID test. */
  store: string | null;
}

export interface AdminPage {
  /** The body and type of a file path, or null when the path is not one of the two files. */
  file: (path: string) => { body: string; type: string } | null;
  /** True for the paths answered with the document profile: every screen, the script and the sheet. */
  isDocumentPath: (path: string) => boolean;
  render: (request: PageRequest) => string;
}

const HASH_BYTES = 8;

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest).slice(0, HASH_BYTES)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function synchronous(
  rendered: HtmlEscapedString | Promise<HtmlEscapedString>
): HtmlEscapedString {
  // nothing in it is asynchronous, so the render is ready; a promise here would be a mistake to stop on
  if (rendered instanceof Promise) {
    throw new Error("the Admin page must render synchronously");
  }
  return rendered;
}

function menuOf(screen: ScreenId, capabilities: readonly string[]) {
  const groups = MENU.map((group) => ({
    ...group,
    items: group.items.filter((entry) =>
      capabilities.includes(entry.capability)
    ),
  })).filter((group) => group.items.length > 0);
  const itemOf = (entry: MenuItem) => {
    const current = entry.screens.includes(screen);
    return synchronous(
      current
        ? html`<li><a href="${entry.path}" aria-current="page"><span aria-hidden="true">▸ </span>${entry.label}</a></li>`
        : html`<li><a href="${entry.path}">${entry.label}</a></li>`
    );
  };
  return synchronous(
    html`<nav aria-label="Admin" class="menu">${groups.map((group) =>
      synchronous(
        group.label === null
          ? html`<ul>${group.items.map(itemOf)}</ul>`
          : html`<p class="menu-group">${group.label}</p><ul>${group.items.map(itemOf)}</ul>`
      )
    )}</nav>`
  );
}

function rootAttributes(request: PageRequest, environment: Environment) {
  if (request.forbidden) {
    return raw("");
  }
  const pairs: [string, string][] = [
    ["data-tela", request.screen],
    ["data-ambiente", environment.kind],
  ];
  if (request.id !== null) {
    pairs.push(["data-id", request.id]);
  }
  if (request.store !== null) {
    pairs.push(["data-loja", request.store]);
  }
  if (request.screen === "casos") {
    pairs.push(["data-estado", request.listState]);
  }
  return pairs.map(([name, value]) =>
    synchronous(html` ${raw(name)}="${value}"`)
  );
}

function documentOf(
  request: PageRequest,
  scriptPath: string,
  stylePath: string
): string {
  const environment = environmentOf(request.environment);
  const screen = SCREENS[request.screen];
  const menu = menuOf(request.screen, request.capabilities);
  const banner = synchronous(
    html`<p class="env env-${environment.kind}">${environment.banner}</p>`
  );
  const content = request.forbidden
    ? synchronous(html`<p>Sem permissão para isto.</p>`)
    : synchronous(html`<p>Carregando…</p>
        <noscript><p>Esta tela precisa de JavaScript ligado. O menu funciona sem ele.</p></noscript>`);
  return synchronous(
    html`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${environment.title} · ${screen.title} · Polaris Admin</title>
    <link rel="stylesheet" href="${stylePath}" />
    <script type="module" src="${scriptPath}"></script>
  </head>
  <body>
    <div class="shell">
      <aside class="side">
        ${banner}
        <p class="brand">Polaris Admin</p>
        ${menu}
      </aside>
      <header class="compact">
        ${banner}
        <details class="compact-menu">
          <summary><span aria-hidden="true">☰</span> Menu <span class="brand">Polaris Admin</span></summary>
          ${menu}
        </details>
      </header>
      <main class="content">
        <h1 id="tela-titulo" tabindex="-1">${screen.title}</h1>
        <div id="admin"${rootAttributes(request, environment)}>
          ${content}
        </div>
      </main>
    </div>
  </body>
</html>
`
  ).toString();
}

/** The pages for these files; the hashes are taken once per isolate. */
export function createAdminPage(
  assets: AdminPageAssets
): () => Promise<AdminPage> {
  let page: Promise<AdminPage> | null = null;
  const build = async (): Promise<AdminPage> => {
    const [script, style] = await Promise.all([
      contentHash(assets.js),
      contentHash(assets.css),
    ]);
    const scriptPath = `/ui/admin-${script}.js`;
    const stylePath = `/ui/admin-${style}.css`;
    const files = new Map([
      [scriptPath, { body: assets.js, type: "text/javascript; charset=utf-8" }],
      [stylePath, { body: assets.css, type: "text/css; charset=utf-8" }],
    ]);
    return {
      file: (path) => files.get(path) ?? null,
      isDocumentPath: (path) => files.has(path) || screenOfPath(path) !== null,
      render: (request) => documentOf(request, scriptPath, stylePath),
    };
  };
  return () => {
    // a failed build is not kept: the next request tries again
    page ??= build().catch((error: unknown) => {
      page = null;
      throw error;
    });
    return page;
  };
}
