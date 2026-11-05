import { PROBLEM_TEXT, type Problem } from "../api";
import type { ScreenTools } from "../app";
import { createNotice } from "../notice";
import type { OperationalIncidentPage, SupportCasePage } from "../types";
import { storePath } from "./case-links";
import { organizationsView } from "./organizations";

/** The server's largest page: the count is of one page, and says "ou mais" when the server has another. */
const COUNT_PAGE = "50";

function openCasesText(count: number, more: boolean): string {
  if (more) {
    return `${count} ou mais atendimentos de suporte abertos`;
  }
  return count === 1
    ? "1 atendimento de suporte aberto"
    : `${count} atendimentos de suporte abertos`;
}

/** The server orders incidents by ID, not by what is left to send: a page with none, but with another page after it, says only that there is more to look at. */
function incidentsText(count: number, more: boolean): string {
  if (count === 0) {
    return "Há falhas de envio na lista: veja se alguma tem eventos a reenviar";
  }
  if (more) {
    return `${count} ou mais falhas de envio com eventos a reenviar`;
  }
  return count === 1
    ? "1 falha de envio com eventos a reenviar"
    : `${count} falhas de envio com eventos a reenviar`;
}

/**
 * Início (AC-P1.2b): the store search and, of each list the operator may read, how many wait for them, read once
 * when the screen opens and only from lists that are not audited. Today that is the open support cases and the incidents
 * with dead events to send again; the list of privacy cases enters with its screen. No metric and nothing read again by itself.
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

  const unread: { text: string; what: string }[] = [];
  const failed = (what: string, answer: { ok: boolean; problem?: Problem }) => {
    const problem =
      answer.ok ||
      answer.problem === undefined ||
      answer.problem === "invalid" ||
      answer.problem === "not_found"
        ? "failed"
        : answer.problem;
    unread.push({ text: PROBLEM_TEXT[problem], what });
  };

  const countCases = async (): Promise<HTMLElement | null> => {
    const parameters = new URLSearchParams({
      kind: "support",
      limit: COUNT_PAGE,
      status: "open",
    });
    const answer = await api.get<SupportCasePage>(
      `/api/support-cases?${parameters.toString()}`
    );
    if (!(answer.ok && Array.isArray(answer.data?.cases))) {
      failed("os atendimentos abertos", answer);
      return null;
    }
    const count = answer.data.cases.length;
    const more = answer.data.next !== null;
    if (count === 0 && !more) {
      return null;
    }
    return dom.el(
      "li",
      {},
      `${openCasesText(count, more)} `,
      dom.el("a", { href: "/casos" }, "Ver atendimentos")
    );
  };

  const countIncidents = async (): Promise<HTMLElement | null> => {
    const parameters = new URLSearchParams({ limit: COUNT_PAGE });
    const answer = await api.get<OperationalIncidentPage>(
      `/api/operational-incidents?${parameters.toString()}`
    );
    if (!(answer.ok && Array.isArray(answer.data?.incidents))) {
      failed("as falhas de envio", answer);
      return null;
    }
    const count = answer.data.incidents.filter(
      (item) => item.deadEvents > 0
    ).length;
    const more = answer.data.next !== null;
    if (count === 0 && !more) {
      return null;
    }
    return dom.el(
      "li",
      {},
      `${incidentsText(count, more)} `,
      dom.el("a", { href: "/incidentes" }, "Ver falhas de envio")
    );
  };

  const showWaiting = async (pending: Promise<HTMLElement | null>[]) => {
    const found = (await Promise.all(pending)).filter(
      (item): item is HTMLElement => item !== null
    );
    const [first] = unread;
    if (first !== undefined) {
      const names = unread.map((item) => item.what).join(" e ");
      notice.alert(`Não foi possível contar ${names}. ${first.text}`);
    }
    if (found.length === 0) {
      if (first === undefined) {
        empty.removeAttribute("hidden");
      }
      return;
    }
    dom.fill(waiting, ...found);
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
  const counts: Promise<HTMLElement | null>[] = [];
  if (can("support_case:manage")) {
    counts.push(countCases());
  }
  if (can("operational_incident:read")) {
    counts.push(countIncidents());
  }
  showWaiting(counts);
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
