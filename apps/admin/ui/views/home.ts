import { PROBLEM_TEXT, type Problem } from "../api";
import type { ScreenTools } from "../app";
import type { Dom } from "../dom";
import { createNotice } from "../notice";
import type {
  OperationalIncidentPage,
  PrivacyCasePage,
  PrivacyCaseSummary,
  SupportCasePage,
} from "../types";
import { storePath } from "./case-links";
import { organizationsView } from "./organizations";

/** The server's largest page: the count is of one page, and says "ou mais" when the server has another. */
const COUNT_PAGE = "50";

interface Counted {
  figure: string | null;
  what: string;
}

function openCasesText(count: number, more: boolean): Counted {
  if (more) {
    return {
      figure: String(count),
      what: "ou mais atendimentos de suporte abertos",
    };
  }
  return count === 1
    ? { figure: "1", what: "atendimento de suporte aberto" }
    : { figure: String(count), what: "atendimentos de suporte abertos" };
}

/** The server orders incidents by ID, not by what is left to send: a page with none, but with another page after it, says only that there is more to look at. */
function incidentsText(count: number, more: boolean): Counted {
  if (count === 0) {
    return {
      figure: null,
      what: "Há falhas de envio na lista: veja se alguma tem eventos a reenviar",
    };
  }
  if (more) {
    return {
      figure: String(count),
      what: "ou mais falhas de envio com eventos a reenviar",
    };
  }
  return count === 1
    ? { figure: "1", what: "falha de envio com eventos a reenviar" }
    : { figure: String(count), what: "falhas de envio com eventos a reenviar" };
}

function privacyCasesText(count: number, more: boolean): Counted {
  if (more) {
    return { figure: String(count), what: "ou mais pedidos de dados abertos" };
  }
  return count === 1
    ? { figure: "1", what: "pedido de dados aberto" }
    : { figure: String(count), what: "pedidos de dados abertos" };
}

/** The server's own count of days (`dueInDays`) and its `overdue`, only compared here: no date is worked out on the page. */
function mostUrgent(cases: readonly PrivacyCaseSummary[]): string | null {
  if (cases.some((item) => item.overdue === true)) {
    return "o mais urgente está vencido";
  }
  const days = cases
    .map((item) => item.dueInDays)
    .filter((value): value is number => typeof value === "number");
  if (days.length === 0) {
    return null;
  }
  const first = Math.min(...days);
  if (first < 0) {
    return "o mais urgente está vencido";
  }
  if (first === 0) {
    return "o mais urgente vence hoje";
  }
  return first === 1
    ? "o mais urgente vence em 1 dia"
    : `o mais urgente vence em ${first} dias`;
}

const GUIDE = [
  "Ache a loja em Lojas.",
  "Para agir, abra um atendimento: ele autoriza e registra.",
  "Pedidos de dados e falhas aparecem aqui quando houver.",
] as const;

interface WaitingItem {
  destination: string;
  figure: string | null;
  href: string;
  what: string;
}

/** One item of "Esperando por você": the whole line is one link, the figure apart from the text and the destination. */
export function waitingItem(
  dom: Dom,
  { destination, figure, href, what }: WaitingItem
): HTMLElement {
  return dom.el(
    "li",
    {},
    dom.el(
      "a",
      {
        "aria-label": `${figure === null ? "" : `${figure} `}${what}: ${destination.toLowerCase()}`,
        class: "waiting-item",
        href,
      },
      figure === null
        ? null
        : dom.el("span", { class: "waiting-count" }, figure),
      figure === null ? null : " ",
      dom.el("span", { class: "waiting-what" }, what),
      " ",
      dom.el("span", { class: "waiting-go" }, `${destination} →`)
    )
  );
}

/**
 * Início (AC-P1.2b): what waits for the operator first, then the store search; of each list the operator may read, how
 * many wait, read once when the screen opens and only from lists that are not audited: the open privacy cases (with the
 * due date of the most urgent, in words from the server's day count), the open support cases and the incidents with
 * dead events to send again. Each item is one link around its line. The three-line guide is fixed text: nothing is
 * kept in the browser. No metric and nothing read again by itself.
 */
export function homeView(tools: ScreenTools): HTMLElement {
  const { api, can, dom, navigate } = tools;
  const notice = createNotice(dom);
  const waiting = dom.el("ul", { class: "waiting", hidden: "" });
  const waitingLine = (
    figure: string | null,
    what: string,
    destination: string,
    href: string
  ) => waitingItem(dom, { destination, figure, href, what });
  const empty = dom.el("p", { class: "hint", hidden: "" });
  const emptyNextStep = () =>
    can("organization:diagnose")
      ? [
          "Para atender uma loja, comece por ",
          dom.el("a", { href: "/lojas" }, "Lojas"),
          ".",
        ]
      : [
          "Para ver o que você pode fazer, abra ",
          dom.el("a", { href: "/configuracoes" }, "Minha conta e permissões"),
          ".",
        ];

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

  const countPrivacyCases = async (): Promise<HTMLElement | null> => {
    const parameters = new URLSearchParams({
      filter: "open",
      limit: COUNT_PAGE,
    });
    const answer = await api.get<PrivacyCasePage>(
      `/api/privacy-cases?${parameters.toString()}`
    );
    if (!(answer.ok && Array.isArray(answer.data?.cases))) {
      failed("os pedidos de dados", answer);
      return null;
    }
    const count = answer.data.cases.length;
    const more = answer.data.next !== null;
    if (count === 0 && !more) {
      return null;
    }
    const text = privacyCasesText(count, more);
    const urgent = mostUrgent(answer.data.cases);
    const scope = more ? `entre os ${COUNT_PAGE} mais recentes, ` : "";
    return waitingLine(
      text.figure,
      urgent === null ? text.what : `${text.what}, ${scope}${urgent}`,
      "Ver pedidos de dados",
      "/privacidade"
    );
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
    const text = openCasesText(count, more);
    return waitingLine(text.figure, text.what, "Ver atendimentos", "/casos");
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
    const text = incidentsText(count, more);
    return waitingLine(
      text.figure,
      text.what,
      "Ver falhas de envio",
      "/incidentes"
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
        dom.fill(empty, "Nada esperando por você. ", ...emptyNextStep());
        empty.removeAttribute("hidden");
      }
      return;
    }
    dom.fill(waiting, ...found);
    waiting.removeAttribute("hidden");
  };

  const counts: Promise<HTMLElement | null>[] = [];
  if (can("privacy_case:manage")) {
    counts.push(countPrivacyCases());
  }
  if (can("support_case:manage")) {
    counts.push(countCases());
  }
  if (can("operational_incident:read")) {
    counts.push(countIncidents());
  }
  showWaiting(counts);
  const parts: HTMLElement[] = [
    dom.el(
      "section",
      { "aria-labelledby": "esperando-titulo", class: "area" },
      dom.el("h2", { id: "esperando-titulo" }, "Esperando por você"),
      notice.element,
      waiting,
      empty,
      dom.el(
        "ol",
        { "aria-label": "Por onde começar", class: "hint guide" },
        ...GUIDE.map((line) => dom.el("li", {}, line))
      )
    ),
  ];
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
  return dom.el("div", { class: "areas" }, ...parts);
}
