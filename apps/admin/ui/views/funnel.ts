import type { Api, ApiFailure } from "../api";
import { PROBLEM_TEXT } from "../api";
import { table } from "../blocks";
import type { Dom } from "../dom";
import {
  brasiliaMomentText,
  funnelCountAndShare,
  funnelCountText,
  minutesText,
  weekText,
} from "../format";
import { createNotice } from "../notice";
import type { ActivationFunnelResponse } from "../types";

/** The windows the operator picks from; the server takes 1 to 26. */
const WEEK_CHOICES = ["4", "8", "12", "26"] as const;
const DEFAULT_WEEKS = "12";

/** The 429 of the funnel, with the wait the server gave (AC-7); without one, no number is made up. */
function funnelLimitText(retryAfterSeconds: number | undefined): string {
  return retryAfterSeconds === undefined
    ? "Limite de leituras do funil por hora atingido. Tente de novo mais tarde."
    : `Limite de leituras do funil por hora atingido. Tente de novo em ${minutesText(retryAfterSeconds)}.`;
}

function problemText(failure: ApiFailure): string {
  if (failure.problem === "rate_limited") {
    return funnelLimitText(failure.retryAfterSeconds);
  }
  // the page sends only `weeks` from its own list: a 400 here is the Admin's error, not something the operator typed
  return PROBLEM_TEXT[
    failure.problem === "invalid" ? "failed" : failure.problem
  ];
}

/**
 * A table of the funnel stays a table on a narrow screen: it scrolls sideways inside its own region (focusable, named
 * by its caption, so a keyboard user can scroll it) with the week column fixed, and the page does not scroll.
 */
function funnelTable(
  dom: Dom,
  caption: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[]
) {
  const element = table(dom, caption, headers, rows);
  element.setAttribute("class", "grid funnel");
  return dom.el(
    "div",
    {
      "aria-label": caption,
      class: "table-scroll",
      role: "region",
      tabindex: "0",
    },
    element
  );
}

function signupsTable(dom: Dom, funnel: ActivationFunnelResponse) {
  return funnelTable(
    dom,
    "Cadastros por semana",
    ["Semana", "Cadastros", "Com loja"],
    funnel.signups.map((week) => [
      weekText(week),
      funnelCountText(week.accounts),
      funnelCountAndShare(week.withStore, week.percentWithStore),
    ])
  );
}

function cohortsTable(dom: Dom, funnel: ActivationFunnelResponse) {
  return funnelTable(
    dom,
    "Lojas criadas em cada semana e o que fizeram",
    [
      "Semana",
      "Lojas",
      "1º produto",
      "1ª venda",
      "Ativação em 7 dias",
      "Retenção na 2ª semana",
      "Retenção na 3ª semana",
      "Retenção na 5ª semana",
    ],
    funnel.cohorts.map((cohort) => [
      weekText(cohort),
      funnelCountText(cohort.stores),
      funnelCountAndShare(
        cohort.withFirstProduct,
        cohort.percent.withFirstProduct
      ),
      funnelCountAndShare(cohort.withFirstSale, cohort.percent.withFirstSale),
      funnelCountAndShare(
        cohort.activatedIn7Days,
        cohort.percent.activatedIn7Days
      ),
      funnelCountAndShare(
        cohort.retention.week2,
        cohort.percent.retentionWeek2
      ),
      funnelCountAndShare(
        cohort.retention.week3,
        cohort.percent.retentionWeek3
      ),
      funnelCountAndShare(
        cohort.retention.week5,
        cohort.percent.retentionWeek5
      ),
    ])
  );
}

function firstSaleTable(dom: Dom, funnel: ActivationFunnelResponse) {
  return funnelTable(
    dom,
    "Tempo até a 1ª venda, por semana de criação da loja",
    [
      "Semana",
      "Até 10 min",
      "Até 1 h",
      "Até 1 dia",
      "Até 7 dias",
      "Depois de 7 dias",
      "Sem venda",
    ],
    funnel.cohorts.map((cohort) => [
      weekText(cohort),
      funnelCountText(cohort.timeToFirstSale.upTo10Minutes),
      funnelCountText(cohort.timeToFirstSale.upTo1Hour),
      funnelCountText(cohort.timeToFirstSale.upTo1Day),
      funnelCountText(cohort.timeToFirstSale.upTo7Days),
      funnelCountText(cohort.timeToFirstSale.after7Days),
      funnelCountText(cohort.withoutSale),
    ])
  );
}

function activeTable(dom: Dom, funnel: ActivationFunnelResponse) {
  return funnelTable(
    dom,
    "Lojas ativas por semana",
    ["Semana", "Lojas ativas"],
    funnel.activeStores.map((week) => [
      weekText(week),
      funnelCountText(week.stores),
    ])
  );
}

/** What the numbers leave out, from the answer: the count of internal stores and the server's own sentences. */
function notesBlock(dom: Dom, funnel: ActivationFunnelResponse) {
  const internal =
    funnel.internalStoresExcluded === 1
      ? "1 loja interna criada na janela"
      : `${funnel.internalStoresExcluded} lojas internas criadas na janela`;
  return dom.el(
    "ul",
    { class: "notes" },
    dom.el(
      "li",
      {},
      `Fora de todos os números de lojas: ${internal} (de teste, do dono e do time).`
    ),
    dom.el("li", {}, funnel.notCounted.purgedStores),
    dom.el("li", {}, funnel.notCounted.signups),
    dom.el(
      "li",
      {},
      `Grupos com menos de ${funnel.minimumStores} lojas aparecem como "não disponível", nunca como 0.`
    )
  );
}

/**
 * Funil (AC-7, AC-8): the platform's aggregate, read once when the operator opens the area and once per click on
 * "Atualizar", never by itself: each read is audited and spends one of the operator's 30 an hour, so a 5xx or a 429
 * is shown and not repeated, and changing the weeks does not read. Every number, share and "não disponível" is the
 * server's; the page adds, divides and rounds nothing.
 */
export function funnelView(dom: Dom, api: Api): HTMLElement {
  const notice = createNotice(dom);
  const toggle = dom.el(
    "button",
    {
      "aria-controls": "funil-corpo",
      "aria-expanded": "false",
      class: "secondary",
      type: "button",
    },
    "Abrir o funil"
  );
  const weeks = dom.el(
    "select",
    { "aria-describedby": "funil-dica", id: "funil-semanas" },
    ...WEEK_CHOICES.map((choice) =>
      dom.el(
        "option",
        choice === DEFAULT_WEEKS
          ? { selected: "", value: choice }
          : { value: choice },
        `${choice} semanas`
      )
    )
  );
  weeks.value = DEFAULT_WEEKS;
  const refresh = dom.el("button", { type: "button" }, "Atualizar");
  const result = dom.el("div", { class: "report" });
  const body = dom.el(
    "div",
    { hidden: "", id: "funil-corpo" },
    dom.el(
      "div",
      { class: "controls" },
      dom.el("label", { for: "funil-semanas" }, "Semanas"),
      dom.el("div", { class: "search-row" }, weeks, refresh)
    ),
    dom.el(
      "p",
      { class: "hint", id: "funil-dica" },
      "Mudar as semanas não lê o funil: use Atualizar."
    ),
    notice.element,
    result
  );

  let opened = false;
  let loading = false;
  let failed = false;
  let shownWeeks: string | null = null;

  const busy = (on: boolean) => {
    loading = on;
    refresh.setAttribute("aria-disabled", String(on));
  };

  const read = async () => {
    if (loading) {
      return;
    }
    const asked = weeks.value;
    busy(true);
    notice.status("Lendo o funil…");
    const answer = await api.get<ActivationFunnelResponse>(
      `/api/funnel?${new URLSearchParams({ weeks: asked }).toString()}`
    );
    busy(false);
    if (!answer.ok) {
      // the tables of the read before stay, under their own line that says of when and of how many weeks they are
      failed = true;
      notice.alert(problemText(answer));
      return;
    }
    const funnel = answer.data;
    try {
      render(funnel);
    } catch {
      failed = true;
      result.replaceChildren();
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    failed = false;
    shownWeeks = asked;
    notice.clear();
  };

  const render = (funnel: ActivationFunnelResponse) => {
    const tables = [
      dom.el(
        "p",
        { class: "read-at" },
        `Funil de ${funnel.weeks} semanas, atualizado em ${brasiliaMomentText(funnel.updatedAt)}.`
      ),
      dom.el("h3", {}, "Cadastros"),
      signupsTable(dom, funnel),
      dom.el("h3", {}, "Lojas criadas na semana"),
      cohortsTable(dom, funnel),
      dom.el("h3", {}, "Tempo até a 1ª venda"),
      firstSaleTable(dom, funnel),
      dom.el("h3", {}, "Lojas ativas"),
      activeTable(dom, funnel),
      dom.el("h3", {}, "O que não entra nos números"),
      notesBlock(dom, funnel),
    ];
    dom.fill(result, ...tables);
  };

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Fechar o funil" : "Abrir o funil";
    if (!open) {
      body.setAttribute("hidden", "");
      return;
    }
    body.removeAttribute("hidden");
    // the area reads when it is opened the first time; afterwards only "Atualizar" reads
    if (!opened) {
      opened = true;
      read();
    }
  });
  refresh.addEventListener("click", () => {
    read();
  });
  weeks.addEventListener("change", () => {
    // a read on its way or a failure on screen keeps its own sentence
    if (
      !(loading || failed) &&
      shownWeeks !== null &&
      shownWeeks !== weeks.value
    ) {
      notice.status(
        `Mostrando ${shownWeeks} semanas. Use Atualizar para ler ${weeks.value} semanas.`
      );
    }
  });

  return dom.el(
    "section",
    { "aria-labelledby": "funil-titulo", class: "area" },
    dom.el("h2", { id: "funil-titulo" }, "Funil de ativação"),
    dom.el(
      "p",
      { class: "hint" },
      "Números da plataforma, sem nenhuma loja. Cada leitura fica registrada na auditoria e conta no limite de leituras por hora de cada operador."
    ),
    toggle,
    body
  );
}
