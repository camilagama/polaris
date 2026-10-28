import { createApi, type Fetch, PROBLEM_TEXT } from "./api";
import { createDom } from "./dom";
import { createNotice } from "./notice";
import type { WhoAmI } from "./types";
import { diagnosticsView } from "./views/diagnostics";
import { organizationsView } from "./views/organizations";

/**
 * The Admin page (corte admin-tela-v1, part A): who is signed in, then the areas this operator's capabilities open.
 * Hiding an area is only for the operator's sake: every route asks for its capability again (AC-3). Nothing is kept
 * in the browser, nothing runs on a timer and nothing is read before the operator asks, except `whoami`.
 */
export async function mountAdmin(root: HTMLElement, fetchJson: Fetch) {
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

  if (!who.data.capabilities.includes("organization:diagnose")) {
    dom.fill(
      main,
      dom.el(
        "section",
        { class: "area" },
        dom.el("h2", {}, "Lojas"),
        dom.el("p", {}, PROBLEM_TEXT.forbidden)
      )
    );
    return;
  }
  const store = diagnosticsView(dom, api);
  dom.fill(
    main,
    organizationsView(dom, api, (organization) => store.show(organization)),
    store.element
  );
}
