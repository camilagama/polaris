import { type Api, createApi, type Fetch, PROBLEM_TEXT } from "./api";
import { createDom, type Dom } from "./dom";
import { createNotice } from "./notice";
import type { WhoAmI } from "./types";
import { accessLogView } from "./views/access-log";
import { caseView } from "./views/case";
import { casesView } from "./views/cases";
import { diagnosticsView } from "./views/diagnostics";
import { funnelView } from "./views/funnel";
import { homeView } from "./views/home";
import { incidentView } from "./views/incident";
import { incidentsView } from "./views/incidents";
import { legalHoldsView } from "./views/legal-holds";
import { newCaseView } from "./views/new-case";
import { organizationsView } from "./views/organizations";
import { privacyCaseView } from "./views/privacy-case";
import { privacyCasesView } from "./views/privacy-cases";
import { privacyNewView } from "./views/privacy-new";
import { refundWindowView } from "./views/refund-window";
import { settingsView } from "./views/settings";
import { storeView } from "./views/store";

/**
 * What the Worker wrote on the page's root (`data-*`, corte admin-v2, Parte 1): which screen this is, the environment
 * and the UUIDs the path or `?loja=` carried, already checked by the Worker. Nothing else of the URL is read.
 */
export interface ScreenContext {
  /** `?acao=purge` on a privacy case: its tab of the purge and the legal hold, the one fixed value the Worker names. */
  action?: "purge";
  environment: "production" | "staging" | "unknown";
  /** The capability keys the Worker names, from the domain's own lists: the page keeps no list of its own. */
  flagKeys: readonly string[];
  id: string | null;
  limitKeys: readonly string[];
  listState: "abertos" | "fechados";
  screen: string;
  store: string | null;
}

/** Everything a screen gets: the DOM, the API, who the operator is and how to go to another screen. */
export interface ScreenTools {
  api: Api;
  can: (capability: string) => boolean;
  context: ScreenContext;
  dom: Dom;
  /** Goes to another screen of the Admin by its path (a GET, never a write). */
  navigate: (path: string) => void;
  now: () => Date;
  who: WhoAmI;
}

const ENVIRONMENT_TEXT: Readonly<Record<ScreenContext["environment"], string>> =
  {
    production: "PRODUÇÃO",
    staging: "STAGING",
    unknown: "não informado",
  };

export function environmentText(context: ScreenContext): string {
  return ENVIRONMENT_TEXT[context.environment];
}

function forbiddenArea(dom: Dom, name: string, id: string) {
  return dom.el(
    "section",
    { "aria-labelledby": id, class: "area" },
    dom.el("h2", { id }, name),
    dom.el("p", {}, PROBLEM_TEXT.forbidden)
  );
}

/** Lojas: the v1's search, diagnostics and refund window, in one screen (AC-P1.3). */
function storesScreen(tools: ScreenTools): HTMLElement[] {
  const { api, can, dom, now } = tools;
  if (!can("organization:diagnose")) {
    return [forbiddenArea(dom, "Lojas", "lojas-titulo")];
  }
  const store = diagnosticsView(dom, api, now);
  const refund = refundWindowView(tools);
  return [
    organizationsView(dom, api, (organization) => {
      refund.show(organization);
      store.show(organization);
    }),
    store.element,
    refund.element,
  ];
}

function funnelScreen(tools: ScreenTools): HTMLElement[] {
  return tools.can("platform:read")
    ? [funnelView(tools.dom, tools.api)]
    : [forbiddenArea(tools.dom, "Funil de ativação", "funil-titulo")];
}

/** The privacy screens (Parte 11): each shown only to an operator with `privacy_case:manage`; the server asks again. */
function privacyScreen(
  tools: ScreenTools,
  view: (tools: ScreenTools) => HTMLElement
): HTMLElement[] {
  return tools.can("privacy_case:manage")
    ? [view(tools)]
    : [forbiddenArea(tools.dom, "Pedidos de dados", "privacidade-titulo")];
}

const SCREENS: Readonly<Record<string, (tools: ScreenTools) => HTMLElement[]>> =
  {
    caso: (tools) => [caseView(tools)],
    "caso-novo": (tools) => [newCaseView(tools)],
    casos: (tools) => [casesView(tools)],
    funil: funnelScreen,
    incidente: (tools) =>
      tools.can("operational_incident:read")
        ? [incidentView(tools)]
        : [forbiddenArea(tools.dom, "Falha de envio", "incidente-titulo")],
    incidentes: (tools) =>
      tools.can("operational_incident:read")
        ? [incidentsView(tools)]
        : [forbiddenArea(tools.dom, "Falhas de envio", "incidentes-titulo")],
    configuracoes: (tools) =>
      tools.can("platform:read")
        ? settingsView(tools)
        : [
            forbiddenArea(
              tools.dom,
              "Minha conta e permissões",
              "configuracoes-titulo"
            ),
          ],
    inicio: (tools) => [homeView(tools)],
    loja: (tools) => [storeView(tools)],
    lojas: storesScreen,
    privacidade: (tools) => privacyScreen(tools, privacyCasesView),
    "privacidade-caso": (tools) => privacyScreen(tools, privacyCaseView),
    "privacidade-novo": (tools) => privacyScreen(tools, privacyNewView),
    registro: (tools) =>
      tools.can("access_log:read")
        ? [accessLogView(tools)]
        : [forbiddenArea(tools.dom, "Registro de acessos", "registro-titulo")],
    retencoes: (tools) =>
      tools.can("organization:legal_hold")
        ? [legalHoldsView(tools)]
        : [
            forbiddenArea(
              tools.dom,
              "Lojas com trava legal",
              "retencoes-titulo"
            ),
          ],
  };

/**
 * One screen of the Admin (corte admin-v2, Parte 1): who is signed in, then what this screen shows to this operator's
 * capabilities. Hiding something is only for the operator's sake: every route asks for its capability again (AC-C1).
 * Nothing is kept in the browser and nothing runs on a timer; a screen reads only what is cheap and not audited when
 * it opens, and everything else on a click (AC-C5).
 */
export async function mountAdmin(
  root: HTMLElement,
  fetchJson: Fetch,
  now: () => Date,
  context: ScreenContext,
  navigate: (path: string) => void
) {
  const dom = createDom(root.ownerDocument);
  const api = createApi(fetchJson);
  const notice = createNotice(dom);
  const operator = dom.el("p", { class: "operator" });
  const main = dom.el("div", { class: "areas" });
  dom.fill(
    root,
    dom.el("div", { class: "top" }, operator),
    notice.element,
    main
  );

  notice.status("Carregando…");
  const who = await api.get<WhoAmI>("/api/whoami");
  if (!who.ok) {
    notice.alert(PROBLEM_TEXT[who.problem]);
    return;
  }
  notice.clear();
  // the operator's own e-mail is the only one the page shows (AC-6 of the v1)
  operator.textContent = `Operador: ${who.data.principal.emailSnapshot ?? who.data.principal.id}`;

  const screen = SCREENS[context.screen];
  if (screen === undefined) {
    notice.alert(PROBLEM_TEXT.failed);
    return;
  }
  dom.fill(
    main,
    ...screen({
      api,
      can: (capability) => who.data.capabilities.includes(capability),
      context,
      dom,
      navigate,
      now,
      who: who.data,
    })
  );
}
