import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { labelName, storeName } from "../dom";
import { brasiliaMomentText } from "../format";
import { createNotice } from "../notice";
import type { SupportCasePage } from "../types";
import { caseLink, closedCasesLink, newCaseLink } from "./case-links";
import { diagnosticsView } from "./diagnostics";

/** The most open cases of one store the box asks for; the server's page holds at most 50. */
const CASES_PAGE = "50";
const REASON_SHOWN = 80;

/**
 * "Casos desta loja" (design §2.3): the store's open support cases, read when the screen opens (the list is not
 * audited), each a link to the case, where the actions are; with none, the way to open one.
 */
function storeCases(tools: ScreenTools, organizationId: string): HTMLElement {
  const { api, dom } = tools;
  const notice = createNotice(dom);
  const list = dom.el("ul", { class: "case-list", hidden: "" });
  const load = async () => {
    notice.status("Buscando os casos abertos desta loja…");
    const parameters = new URLSearchParams({
      limit: CASES_PAGE,
      organizationId,
      status: "open",
    });
    const answer = await api.get<SupportCasePage>(
      `/api/support-cases?${parameters.toString()}`
    );
    if (!answer.ok) {
      notice.alert(
        PROBLEM_TEXT[answer.problem === "invalid" ? "failed" : answer.problem]
      );
      return;
    }
    if (!Array.isArray(answer.data?.cases)) {
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    const cases = answer.data.cases.filter(
      (item) =>
        item.organizationId === organizationId &&
        item.status === "open" &&
        item.kind === "support"
    );
    dom.fill(
      list,
      ...cases.map((item) =>
        dom.el(
          "li",
          {},
          `Aberto em ${brasiliaMomentText(item.openedAt)} · `,
          dom.el(
            "span",
            { class: "reason", title: labelName(item.reason, 500) },
            labelName(item.reason, REASON_SHOWN)
          ),
          " ",
          caseLink(dom, item)
        )
      )
    );
    if (cases.length === 0) {
      list.setAttribute("hidden", "");
      notice.status("Nenhum caso aberto desta loja.");
    } else {
      list.removeAttribute("hidden");
      notice.status(
        cases.length === 1 ? "1 caso aberto." : `${cases.length} casos abertos.`
      );
    }
  };
  load();
  return dom.el(
    "section",
    { "aria-labelledby": "casos-loja-titulo", class: "area" },
    dom.el("h2", { id: "casos-loja-titulo" }, "Casos desta loja"),
    notice.element,
    list,
    newCaseLink(dom, organizationId),
    closedCasesLink(dom, organizationId)
  );
}

/**
 * Loja (design §2.3): the store of the path, its open cases and the v1's diagnostics. The store's actions live in its
 * cases, so this screen reads and links, and changes nothing.
 */
export function storeView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom, now } = tools;
  const { id } = context;
  if (id === null) {
    return dom.el("p", { role: "alert" }, "Esta loja não foi encontrada.");
  }
  const head = dom.el(
    "p",
    { class: "store-head" },
    storeName(dom, "", id)
  );
  const parts: HTMLElement[] = [head];
  if (can("support_case:manage")) {
    parts.push(storeCases(tools, id));
  }
  const diagnostics = diagnosticsView(dom, api, now, (organization) =>
    dom.fill(head, storeName(dom, organization.name, organization.id))
  );
  diagnostics.show({ id, name: "" });
  parts.push(diagnostics.element);
  return dom.el("div", { class: "areas" }, ...parts);
}
