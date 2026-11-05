import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { FLAG_KEYS, LIMIT_KEYS } from "@polaris/domain/billing/entitlements";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { type IconName, icon } from "./icons";

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
  icon: IconName;
  label: string;
  path: string;
  screens: readonly ScreenId[];
}

interface MenuGroup {
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
        icon: "house",
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
        icon: "store",
        label: SCREENS.lojas.title,
        path: "/lojas",
        screens: ["lojas", "loja"],
      },
      {
        capability: "support_case:manage",
        icon: "message-square-text",
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
        icon: "shield-check",
        label: SCREENS.privacidade.title,
        path: "/privacidade",
        screens: ["privacidade", "privacidade-novo", "privacidade-caso"],
      },
      {
        capability: "organization:legal_hold",
        icon: "lock-keyhole",
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
        icon: "triangle-alert",
        label: SCREENS.incidentes.title,
        path: "/incidentes",
        screens: ["incidentes", "incidente"],
      },
      {
        capability: "platform:read",
        icon: "funnel",
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
        icon: "scroll-text",
        label: SCREENS.registro.title,
        path: "/registro",
        screens: ["registro"],
      },
    ],
    label: "Para o jurídico",
  },
];

/** "Minha conta e permissões" is in the menu of the account, in the header, as the dash has its account there. */
const ACCOUNT: MenuItem = {
  capability: "platform:read",
  icon: "user-round",
  label: SCREENS.configuracoes.title,
  path: "/configuracoes",
  screens: ["configuracoes"],
};

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

/*
 * The class strings of the dash's shell (`apps/web/src/ui/sidebar.tsx`, `app-shell/app-shell.tsx` and
 * `app-shell/shell-header.tsx`), less what folds the column (the Admin does not fold it): the same markup, compiled by
 * the same Tailwind into the Admin's sheet. `apps/web/scripts/admin-sheet.test.ts` holds each one to the dash's files.
 */
const SIDEBAR_GROUP = "relative flex w-full min-w-0 flex-col p-2";
const SIDEBAR_GROUP_LABEL =
  "flex h-8 shrink-0 items-center rounded-md px-2 font-medium text-sidebar-foreground text-xs";
const SIDEBAR_GROUP_CONTENT = "w-full text-sm";
const SIDEBAR_MENU = "flex w-full min-w-0 flex-col gap-0";
const SIDEBAR_MENU_ITEM = "group/menu-item relative";
const SIDEBAR_MENU_BUTTON =
  "peer/menu-button focus-ring relative flex h-8 touch:h-11 items-center w-full gap-2 overflow-hidden rounded-md p-2 text-left text-sm no-underline motion-full:transition-colors hover:bg-sidebar-hover hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&>span:first-of-type]:truncate [&_svg]:size-4 [&_svg]:shrink-0";
const CURRENT_DOT = "ml-auto size-1.5 shrink-0 rounded-full bg-mark";

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
        ? html`<li class="${SIDEBAR_MENU_ITEM}"><a class="${SIDEBAR_MENU_BUTTON}" data-active="" data-sidebar="menu-button" href="${entry.path}" aria-current="page">${icon(entry.icon)}<span>${entry.label}</span><span aria-hidden="true" class="${CURRENT_DOT}"></span></a></li>`
        : html`<li class="${SIDEBAR_MENU_ITEM}"><a class="${SIDEBAR_MENU_BUTTON}" data-sidebar="menu-button" href="${entry.path}">${icon(entry.icon)}<span>${entry.label}</span></a></li>`
    );
  };
  if (groups.length === 0) {
    return null;
  }
  return synchronous(
    html`<nav aria-label="Admin">${groups.map((group) =>
      synchronous(
        html`<div class="${SIDEBAR_GROUP}" data-sidebar="group">${
          group.label === null
            ? raw("")
            : html`<div class="${SIDEBAR_GROUP_LABEL}" data-sidebar="group-label">${group.label}</div>`
        }<div class="${SIDEBAR_GROUP_CONTENT}"><ul class="${SIDEBAR_MENU}">${group.items.map(itemOf)}</ul></div></div>`
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

const LOGO = raw(
  '<svg aria-hidden="true" class="size-6" viewBox="0 0 24 24"><rect fill="currentColor" height="13" rx="1.2" width="2.4" x="10.8" y="9.2"/><circle cx="12" cy="4.4" fill="var(--mark)" r="2.7"/></svg>'
);
const SKIP_LINK =
  "focus-ring not-focus:sr-only fixed top-2 left-2 z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm no-underline";
const SHELL = "group/sidebar-wrapper flex min-h-svh w-full bg-sidebar";
const SIDEBAR = "group peer hidden text-sidebar-foreground md:block";
const SIDEBAR_GAP = "relative w-(--sidebar-width) bg-transparent";
const SIDEBAR_CONTAINER =
  "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) left-0 md:flex";
const SIDEBAR_INNER = "flex size-full flex-col bg-sidebar";
const SIDEBAR_HEADER = "flex flex-col gap-2 px-4 pt-2 pb-2";
const BRAND_ROW = "flex min-h-10 items-center justify-between gap-2";
const BRAND =
  "touch-hit focus-ring flex w-fit items-center gap-2.5 rounded-sm font-semibold tracking-tight";
const BADGE =
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border px-2 font-medium text-xs leading-none border-border bg-card text-muted-foreground";
const SIDEBAR_CONTENT = "flex min-h-0 flex-1 flex-col gap-0 overflow-auto";
const SIDEBAR_INSET = "relative flex w-full min-w-0 flex-1 flex-col";
const HEADER =
  "@container/header sticky top-0 z-20 h-(--app-header) shrink-0 bg-sidebar text-sidebar-foreground";
const HEADER_ROW =
  "flex h-full items-center gap-2 pr-2 pl-(--gutter) md:pr-4 md:pl-6";
const HEADER_BRAND =
  "touch-hit focus-ring flex shrink-0 items-center gap-2 rounded-sm font-semibold text-foreground tracking-tight md:hidden";
const HEADER_END = "ml-auto flex min-w-0 items-center gap-2 md:gap-3";
const HEADER_BUTTON =
  "touch-hit focus-ring inline-flex size-10 shrink-0 cursor-pointer list-none items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-accent-foreground [&::-webkit-details-marker]:hidden [&_svg]:size-[18px]";
const MOBILE_MENU =
  "absolute inset-x-0 top-full max-h-[calc(100dvh-var(--app-header))] overflow-y-auto bg-sidebar pb-2 shadow-lg";
const ACCOUNT_BUTTON =
  "touch-hit focus-ring flex h-10 min-w-0 max-w-[18rem] cursor-pointer list-none items-center gap-2 rounded-md px-1 text-foreground hover:bg-sidebar-hover [&::-webkit-details-marker]:hidden";
const ACCOUNT_STATIC =
  "flex h-10 min-w-0 max-w-[18rem] items-center gap-2 px-1 text-foreground";
const ACCOUNT_AVATAR =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground [&_svg]:size-4";
const ACCOUNT_POPUP =
  "absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/[0.06]";
const ACCOUNT_ITEM =
  "focus-ring flex h-8 touch:h-11 w-full items-center gap-2 rounded-md px-2 text-sm no-underline hover:bg-accent data-active:font-medium [&_svg]:size-4 [&_svg]:shrink-0";
const ACCOUNT_MENU = "relative min-w-0";
const ACCOUNT_EMAIL = "hidden min-w-0 truncate text-sm md:block";
const COMPACT_MENU = "compact-menu md:hidden";
const COMPACT_ENV = "compact-env md:hidden";
const TITLE = "text-title";
const PANEL =
  "flex flex-1 flex-col bg-background md:rounded-tl-xl md:border-(--card-ring) md:border-t md:border-l";
const MAIN =
  "content mx-auto w-[min(100%_-_2rem,72rem)] pt-[clamp(1.5rem,5vw,4.25rem)] pb-14";

/**
 * The menu of the account, in the header: the operator's e-mail, written by the script, and their page. Without the
 * capability of that page there is nothing to open, so the account is only the avatar and the e-mail, with no control.
 */
function accountOf(screen: ScreenId, capabilities: readonly string[]) {
  const who = html`<span class="${ACCOUNT_AVATAR}">${icon("user-round")}</span><span class="sr-only">Conta</span><span class="${ACCOUNT_EMAIL}" data-operador=""></span>`;
  if (!capabilities.includes(ACCOUNT.capability)) {
    return synchronous(
      html`<div class="${ACCOUNT_MENU} ${ACCOUNT_STATIC}" data-conta="">${who}</div>`
    );
  }
  const link = ACCOUNT.screens.includes(screen)
    ? html`<div class="${ACCOUNT_POPUP}"><a class="${ACCOUNT_ITEM}" data-active="" href="${ACCOUNT.path}" aria-current="page">${icon(ACCOUNT.icon)}${ACCOUNT.label}</a></div>`
    : html`<div class="${ACCOUNT_POPUP}"><a class="${ACCOUNT_ITEM}" href="${ACCOUNT.path}">${icon(ACCOUNT.icon)}${ACCOUNT.label}</a></div>`;
  return synchronous(
    html`<details class="${ACCOUNT_MENU}" data-conta="">
            <summary class="${ACCOUNT_BUTTON}">${who}</summary>
            ${link}
          </details>`
  );
}

/** The ☰ of a narrow screen opens the menu; with no item open to the operator it would open a blank strip, so it is not drawn. */
function compactMenuOf(menu: HtmlEscapedString | null) {
  if (menu === null) {
    return raw("");
  }
  return synchronous(
    html`<details class="${COMPACT_MENU}">
              <summary class="${HEADER_BUTTON}">${icon("menu")}<span class="sr-only">Menu</span></summary>
              <div class="${MOBILE_MENU}">${menu}</div>
            </details>`
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
    <a class="${SKIP_LINK}" href="#conteudo">Ir para o conteúdo</a>
    <div class="admin-shell ${SHELL}">
      <div class="${SIDEBAR}" data-slot="sidebar">
        <div class="${SIDEBAR_GAP}"></div>
        <aside class="${SIDEBAR_CONTAINER}" aria-label="Menu do Admin">
          <div class="${SIDEBAR_INNER}">
            <div class="${SIDEBAR_HEADER}">
              <div class="${BRAND_ROW}">
                <a class="${BRAND}" href="/">${LOGO}<span>Polaris</span></a>
                <span class="${BADGE}">ADMIN</span>
              </div>
              ${banner}
            </div>
            <div class="${SIDEBAR_CONTENT}">${menu ?? raw("")}</div>
          </div>
        </aside>
      </div>
      <div class="${SIDEBAR_INSET}">
        <header class="${HEADER}" data-app-header="">
          <div class="${HEADER_ROW}">
            ${compactMenuOf(menu)}
            <a class="${HEADER_BRAND}" href="/">${LOGO}Polaris<span class="${BADGE}">ADMIN</span></a>
            <div class="${HEADER_END}">${accountOf(request.screen, request.capabilities)}</div>
          </div>
        </header>
        <div class="${PANEL}" data-app-panel="">
          <div class="${COMPACT_ENV}">${banner}</div>
          <main class="${MAIN}" id="conteudo" tabindex="-1">
            ${back}
            <h1 class="${TITLE}" id="tela-titulo" tabindex="-1">${screen.title}</h1>
            <p id="tela-proposito" class="purpose">${screen.purpose}</p>
            <div id="admin"${rootAttributes(request, environment)}>
              ${content}
            </div>
          </main>
        </div>
      </div>
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
