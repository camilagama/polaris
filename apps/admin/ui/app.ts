import { createApi, type Fetch, PROBLEM_TEXT } from "./api";
import { createDom } from "./dom";
import { createNotice } from "./notice";
import type { WhoAmI } from "./types";
import { diagnosticsView } from "./views/diagnostics";
import { funnelView } from "./views/funnel";
import { organizationsView } from "./views/organizations";
import { refundWindowView } from "./views/refund-window";

/**
 * The Admin page (corte admin-tela-v1): who is signed in, then the areas this operator's capabilities open, in order:
 * Lojas, Loja and Reembolso of the chosen store, and the Funil. Hiding an area is only for the operator's sake: every
 * route asks for its capability again (AC-3). Nothing is kept in the browser, nothing runs on a timer and nothing is
 * read before the operator asks, except `whoami`.
 */
export async function mountAdmin(
  root: HTMLElement,
  fetchJson: Fetch,
  now: () => Date = () => new Date()
) {
  const dom = createDom(root.ownerDocument);
  const api = createApi(fetchJson);
  const notice = createNotice(dom);
  const operator = dom.el("p", { class: "operator" });
  const main = dom.el("main", { class: "areas" });
  dom.fill(
    root,
    dom.el(
      "header",
      { class: "top" },
      dom.el("h1", {}, "Polaris Admin"),
      operator
    ),
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
  // the operator's own e-mail is the only one the page shows (AC-6)
  operator.textContent = `Operador: ${who.data.principal.emailSnapshot ?? who.data.principal.id}`;

  const can = (capability: string) =>
    who.data.capabilities.includes(capability);
  const funnel = can("platform:read")
    ? funnelView(dom, api)
    : forbiddenArea("Funil de ativação", "funil-titulo");

  if (!can("organization:diagnose")) {
    dom.fill(main, forbiddenArea("Lojas", "lojas-titulo"), funnel);
    return;
  }
  const store = diagnosticsView(dom, api, now);
  const refund = refundWindowView(dom, api, {
    manageCases: can("support_case:manage"),
    readWindow: can("billing:operate"),
  });
  dom.fill(
    main,
    organizationsView(dom, api, (organization) => {
      refund.show(organization);
      store.show(organization);
    }),
    store.element,
    refund.element,
    funnel
  );

  function forbiddenArea(name: string, id: string) {
    return dom.el(
      "section",
      { "aria-labelledby": id, class: "area" },
      dom.el("h2", { id }, name),
      dom.el("p", {}, PROBLEM_TEXT.forbidden)
    );
  }
}
