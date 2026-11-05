import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { FLAG_KEYS, LIMIT_KEYS } from "@polaris/domain/billing/entitlements";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/**
 * The operator's pages of the Admin (corte admin-v2, Parte 1): one route per screen, each a whole HTML document the
 * Worker renders itself, behind the same Access verification as the API, with one script and one sheet built from
 * `apps/admin/ui` and embedded as Text modules.
 *
 * What the Worker writes into a page is fixed text and what it already knows without reading a store: the screen,
 * the menu of the screens the principal's capabilities open (links, so the menu works without the script), the
 * environment, the UUID of the path or of `?loja=` once it passed the UUID test and, on the case screen, the two lists
 * of keys a grant may name (fixed by the domain, nothing of a store). No store name, e-mail, reason or
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
  | "configuracoes"
  | "funil"
  | "incidente"
  | "incidentes"
  | "inicio"
  | "loja"
  | "lojas"
  | "privacidade"
  | "privacidade-caso"
  | "privacidade-novo"
  | "registro"
  | "retencoes";

interface Screen {
  capability: PlatformCapability;
  purpose: string;
  /** The screen's name in the tab title and in its `h1`. */
  title: string;
}

export const PURPOSE_MAX_LENGTH = 90;

export const SCREENS: Readonly<Record<ScreenId, Screen>> = {
  caso: {
    capability: "support_case:manage",
    purpose:
      "Aqui você age na loja: suspender, dar plano, ver clientes. Tudo fica registrado.",
    title: "Atendimento",
  },
  "caso-novo": {
    capability: "support_case:manage",
    purpose:
      "Diga o motivo: o atendimento autoriza as ações na loja e registra cada uma.",
    title: "Abrir atendimento",
  },
  casos: {
    capability: "support_case:manage",
    purpose:
      "Para mexer em uma loja, abra um atendimento: ele autoriza e registra.",
    title: "Atendimentos",
  },
  configuracoes: {
    capability: "platform:read",
    purpose:
      "Quem você é neste painel, o que pode fazer e em que ambiente está. Só leitura.",
    title: "Minha conta e permissões",
  },
  funil: {
    capability: "platform:read",
    purpose: "Quantas lojas criadas chegaram a vender, por semana. Só leitura.",
    title: "Funil de ativação",
  },
  incidente: {
    capability: "operational_incident:read",
    purpose:
      "Eventos desta falha que não foram entregues. Reenvie um por vez, se couber.",
    title: "Falha de envio",
  },
  incidentes: {
    capability: "operational_incident:read",
    purpose:
      "Eventos que não chegaram ao provedor ou ao app; reenvie um por vez.",
    title: "Falhas de envio",
  },
  inicio: {
    capability: "platform:read",
    purpose: "O que está esperando você hoje.",
    title: "Início",
  },
  loja: {
    capability: "organization:diagnose",
    purpose:
      "Plano, cobrança e situação desta loja. Só leitura; para agir, abra um atendimento.",
    title: "Loja",
  },
  lojas: {
    capability: "organization:diagnose",
    purpose:
      "Encontre uma loja e veja plano, cobrança e situação. Para agir, abra um atendimento.",
    title: "Lojas",
  },
  privacidade: {
    capability: "privacy_case:manage",
    purpose:
      "Pedidos do titular: acesso, correção e exclusão, etapa por etapa, com prazo.",
    title: "Pedidos de dados",
  },
  "privacidade-caso": {
    capability: "privacy_case:manage",
    purpose:
      "Registre as etapas do pedido do titular e o apagamento da loja encerrada.",
    title: "Atendimento de privacidade",
  },
  "privacidade-novo": {
    capability: "privacy_case:manage",
    purpose:
      "Registre o pedido de um titular dos dados; o prazo conta do dia em que ele chegou.",
    title: "Abrir atendimento de privacidade",
  },
  registro: {
    capability: "access_log:read",
    purpose:
      "Consulta sob ordem judicial (processo CNJ): quem acessou, de onde. Fica registrada.",
    title: "Registro de acessos",
  },
  retencoes: {
    capability: "organization:legal_hold",
    purpose: "Lojas cujos dados a lei manda guardar, e até quando. Só leitura.",
    title: "Lojas com trava legal",
  },
};

interface MenuItem {
  capability: PlatformCapability;
  label: string;
  path: string;
  screens: readonly ScreenId[];
}

interface MenuGroup {
  /** The foot of the menu: set apart from the groups above it. */
  foot?: true;
  items: readonly MenuItem[];
  label: string | null;
}

/**
 * The menu by task, with only the screens that exist: a group whose items the operator cannot open goes with its
 * label.
 */
const MENU: readonly MenuGroup[] = [
  {
    items: [
      {
        capability: "platform:read",
        label: SCREENS.inicio.title,
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
        label: SCREENS.lojas.title,
        path: "/lojas",
        screens: ["lojas", "loja"],
      },
      {
        capability: "support_case:manage",
        label: SCREENS.casos.title,
        path: "/casos",
        screens: ["casos", "caso-novo", "caso"],
      },
    ],
    label: "Atender uma loja",
  },
  {
    items: [
      {
        capability: "privacy_case:manage",
        label: SCREENS.privacidade.title,
        path: "/privacidade",
        screens: ["privacidade", "privacidade-novo", "privacidade-caso"],
      },
      {
        capability: "organization:legal_hold",
        label: SCREENS.retencoes.title,
        path: "/retencoes",
        screens: ["retencoes"],
      },
    ],
    label: "Privacidade (LGPD)",
  },
  {
    items: [
      {
        capability: "operational_incident:read",
        label: SCREENS.incidentes.title,
        path: "/incidentes",
        screens: ["incidentes", "incidente"],
      },
      {
        capability: "platform:read",
        label: SCREENS.funil.title,
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
        label: SCREENS.registro.title,
        path: "/registro",
        screens: ["registro"],
      },
    ],
    label: "Para o jurídico",
  },
  {
    foot: true,
    items: [
      {
        capability: "platform:read",
        label: SCREENS.configuracoes.title,
        path: "/configuracoes",
        screens: ["configuracoes"],
      },
    ],
    label: null,
  },
];

function parentOf(screen: ScreenId): { label: string; path: string } | null {
  for (const group of MENU) {
    for (const entry of group.items) {
      if (entry.screens.includes(screen) && entry.screens[0] !== screen) {
        return { label: entry.label, path: entry.path };
      }
    }
  }
  return null;
}

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
    "/configuracoes": "configuracoes",
    "/funil": "funil",
    "/incidentes": "incidentes",
    "/lojas": "lojas",
    "/privacidade": "privacidade",
    "/privacidade/novo": "privacidade-novo",
    "/registro": "registro",
    "/retencoes": "retencoes",
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
  if (area === "privacidade") {
    return { id: id.toLowerCase(), screen: "privacidade-caso" };
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
  /** `?acao=` of a privacy case, only its one fixed value: the tab of the purge and the legal hold. */
  action?: "purge";
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
          ? html`<ul${group.foot ? raw(' class="menu-foot"') : raw("")}>${group.items.map(itemOf)}</ul>`
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
  if (request.screen === "casos" || request.screen === "privacidade") {
    pairs.push(["data-estado", request.listState]);
  }
  if (request.screen === "privacidade-caso" && request.action === "purge") {
    pairs.push(["data-acao", request.action]);
  }
  if (request.screen === "caso") {
    // the keys a grant may name come from the domain's lists, so the screen has no copy to drift
    pairs.push(
      ["data-chaves-limite", LIMIT_KEYS.join(" ")],
      ["data-chaves-recurso", FLAG_KEYS.join(" ")]
    );
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
  const parent = parentOf(request.screen);
  const back =
    parent === null
      ? raw("")
      : synchronous(
          html`<p class="back"><a href="${parent.path}">‹ ${parent.label}</a></p>`
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
        ${back}
        <h1 id="tela-titulo" tabindex="-1">${screen.title}</h1>
        <p id="tela-proposito" class="purpose">${screen.purpose}</p>
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
