import { type Api, createApi, type Fetch, PROBLEM_TEXT } from "./api";
import { createDom, type Dom } from "./dom";
import { createNotice } from "./notice";
import type { WhoAmI } from "./types";
import { caseView } from "./views/case";
import { casesView } from "./views/cases";
import { diagnosticsView } from "./views/diagnostics";
import { funnelView } from "./views/funnel";
import { homeView } from "./views/home";
import { incidentView } from "./views/incident";
import { incidentsView } from "./views/incidents";
import { newCaseView } from "./views/new-case";
import { organizationsView } from "./views/organizations";
import { refundWindowView } from "./views/refund-window";
import { storeView } from "./views/store";

/**
 * What the Worker wrote on the page's root (`data-*`, corte admin-v2, Parte 1): which screen this is, the environment
 * and the UUIDs the path or `?loja=` carried, already checked by the Worker. Nothing else of the URL is read.
 */
export interface ScreenContext {
  environment: "production" | "staging" | "unknown";
  id: string | null;
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

/** Buscar loja: the v1's search, diagnostics and refund window, in one screen (AC-P1.3). */
function storesScreen(tools: ScreenTools): HTMLElement[] {
  const { api, can, dom, now } = tools;
  if (!can("organization:diagnose")) {
    return [forbiddenArea(dom, "Lojas", "lojas-titulo")];
  }
  const store = diagnosticsView(dom, api, now);
  const refund = refundWindowView(dom, api, {
    manageCases: can("support_case:manage"),
    readWindow: can("billing:operate"),
  });
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

const SCREENS: Readonly<Record<string, (tools: ScreenTools) => HTMLElement[]>> =
  {
    caso: (tools) => [caseView(tools)],
    "caso-novo": (tools) => [newCaseView(tools)],
    casos: (tools) => [casesView(tools)],
    funil: funnelScreen,
    incidente: (tools) =>
      tools.can("operational_incident:read")
        ? [incidentView(tools)]
        : [forbiddenArea(tools.dom, "Incidente", "incidente-titulo")],
    incidentes: (tools) =>
      tools.can("operational_incident:read")
        ? [incidentsView(tools)]
        : [forbiddenArea(tools.dom, "Incidentes", "incidentes-titulo")],
    inicio: (tools) => [homeView(tools)],
    loja: (tools) => [storeView(tools)],
    lojas: storesScreen,
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
