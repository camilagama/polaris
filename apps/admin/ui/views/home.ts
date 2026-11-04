import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { createNotice } from "../notice";
import type { SupportCasePage } from "../types";
import { storePath } from "./case-links";
import { organizationsView } from "./organizations";

/** The server's largest page: the count is of one page, and says "ou mais" when the server has another. */
const COUNT_PAGE = "50";

function openCasesText(count: number, more: boolean): string {
  if (more) {
    return `${count} ou mais casos de suporte abertos`;
  }
  return count === 1
    ? "1 caso de suporte aberto"
    : `${count} casos de suporte abertos`;
}

/**
 * Início (AC-P1.2b): the store search and, of each list the operator may read, how many wait for them, read once
 * when the screen opens and only from lists that are not audited. Today that is the open support cases; the lists
 * of privacy cases and incidents enter with their screens. No metric and nothing read again by itself.
 */
export function homeView(tools: ScreenTools): HTMLElement {
  const { api, can, dom, navigate } = tools;
  const notice = createNotice(dom);
  const waiting = dom.el("ul", { class: "waiting", hidden: "" });
  const empty = dom.el(
    "p",
    { class: "hint", hidden: "" },
    "Nada esperando por você."
  );

  const countCases = async () => {
    const parameters = new URLSearchParams({
      limit: COUNT_PAGE,
      status: "open",
    });
    const answer = await api.get<SupportCasePage>(
      `/api/support-cases?${parameters.toString()}`
    );
    if (!(answer.ok && Array.isArray(answer.data?.cases))) {
      notice.alert(
        `Não foi possível contar os casos abertos. ${PROBLEM_TEXT[answer.ok || answer.problem === "invalid" || answer.problem === "not_found" ? "failed" : answer.problem]}`
      );
      return;
    }
    const count = answer.data.cases.filter(
      (item) => item.kind === "support" && item.status === "open"
    ).length;
    const more = answer.data.next !== null;
    if (count === 0 && !more) {
      empty.removeAttribute("hidden");
      return;
    }
    dom.fill(
      waiting,
      dom.el(
        "li",
        {},
        `${openCasesText(count, more)} `,
        dom.el("a", { href: "/casos" }, "Ver casos")
      )
    );
    waiting.removeAttribute("hidden");
  };

  const parts: HTMLElement[] = [];
  if (can("organization:diagnose")) {
    parts.push(
      organizationsView(dom, api, (organization) => {
        const path = storePath(organization.id);
        if (path !== null) {
          navigate(path);
        }
      })
    );
  }
  if (can("support_case:manage")) {
    countCases();
  } else {
    empty.removeAttribute("hidden");
  }
  parts.push(
    dom.el(
      "section",
      { "aria-labelledby": "esperando-titulo", class: "area" },
      dom.el("h2", { id: "esperando-titulo" }, "Esperando por você"),
      notice.element,
      waiting,
      empty
    )
  );
  return dom.el("div", { class: "areas" }, ...parts);
}
