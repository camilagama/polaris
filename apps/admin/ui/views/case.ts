import { PROBLEM_TEXT, type Problem } from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts } from "../blocks";
import { hasControlCharacter, labelName, storeName } from "../dom";
import {
  auditEventText,
  brasiliaMomentText,
  caseKindText,
  caseStatusText,
} from "../format";
import { createNotice } from "../notice";
import { RECORD_LABEL } from "../record-label";
import type { ClosedSupportCase, SupportCaseDetail } from "../types";
import { type AccessMessage, type AccessView, accessView } from "./access";
import { newCaseLink, storePath } from "./case-links";
import { entitlementsView } from "./entitlements";
import { storeActionsView } from "./store-actions";

/** The server's limit for a resolution (`MAX_CASE_RESOLUTION_LENGTH`), in characters as a person counts them. */
const MAX_RESOLUTION_LENGTH = 500;

export const CLOSE_EFFECT =
  "Fechar o atendimento revoga todos os acessos temporários dele. Atendimento fechado não reabre.";
export const CLOSE_UNDO = "Não: isso não poderá ser desfeito.";
const CLOSE_AUDIT =
  "O fechamento fica na auditoria com o seu e-mail e o atendimento.";
export const CLOSE_UNKNOWN =
  "Não deu para confirmar se o atendimento foi fechado. Recarregue o atendimento para ver o estado antes de tentar de novo.";
export const CLOSED_NOT_SHOWN =
  "O atendimento foi fechado, mas não deu para mostrá-lo de novo. Use Recarregar o atendimento.";
const RESOLUTION_REFUSED =
  "A resolução não foi aceita: use até 500 caracteres, sem caracteres de controle nem quebra de linha.";

type Case = SupportCaseDetail["case"];

/** Why a resolution typed here would be refused by the server, or null when it would be taken. */
function resolutionProblem(text: string): string | null {
  if ([...text].length > MAX_RESOLUTION_LENGTH) {
    return `A resolução aceita até ${MAX_RESOLUTION_LENGTH} caracteres.`;
  }
  if (hasControlCharacter(text)) {
    return "A resolução não aceita caracteres de controle nem quebra de linha.";
  }
  return null;
}

function problemText(problem: Problem): string {
  if (problem === "not_found") {
    return "Este atendimento não foi encontrado.";
  }
  return PROBLEM_TEXT[problem === "invalid" ? "failed" : problem];
}

/**
 * The screen of one support case (AC-P1.5, AC-P1.6): what it is, its history (read when the screen opens, not
 * audited) and, while it is open, the one action of this part: closing it, reviewed in two steps on the screen. The
 * close is one request per click; a case already closed is said to have been, and a closed case offers no action.
 */
export function caseView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom, who } = tools;
  const notice = createNotice(dom);
  const body = dom.el("div", { class: "case" });
  const caseId = context.id;
  let turn = 0;
  let access: AccessView | null = null;

  const byWhom = (principalId: string) =>
    principalId === who.principal.id ? "você" : "outro operador";

  const header = (item: Case) => {
    const link =
      can("organization:diagnose") && storePath(item.organizationId) !== null
        ? dom.el(
            "a",
            { href: storePath(item.organizationId) ?? "/lojas" },
            "Ver loja"
          )
        : null;
    const support = item.kind === "support";
    const pairs: [string, Node | string][] = [
      [
        "Loja",
        dom.el(
          "span",
          {},
          storeName(dom, item.organizationName, item.organizationId),
          link === null ? "" : " ",
          link
        ),
      ],
      ["Tipo", caseKindText(item.kind)],
      ["Estado", caseStatusText(item.status)],
      ["Aberto em", brasiliaMomentText(item.openedAt)],
      [
        "Aberto por",
        byWhom(item.openedBy) === "você" ? "Você" : "Outro operador",
      ],
      ["Motivo", support ? item.reason : "Fica no fluxo de privacidade."],
    ];
    if (support && item.context !== null) {
      pairs.push(["Contexto", item.context]);
    }
    if (item.status === "closed") {
      pairs.push(["Fechado em", brasiliaMomentText(item.closedAt)]);
      pairs.push(["Resolução", item.resolution ?? "Sem resolução escrita."]);
    }
    return facts(dom, pairs);
  };

  const history = (detail: SupportCaseDetail) => {
    const grants = detail.grants.map((grant) => {
      let state = "vencido";
      if (grant.revokedAt !== null) {
        state = `encerrado em ${brasiliaMomentText(grant.revokedAt)}`;
      } else if (grant.active) {
        state = "ativo";
      }
      return dom.el(
        "li",
        {},
        `Acesso aos dados de ${brasiliaMomentText(grant.startsAt)} até ${brasiliaMomentText(grant.expiresAt)}: ${state}.`
      );
    });
    const events = detail.audit.map((entry) =>
      dom.el(
        "li",
        {},
        `${brasiliaMomentText(entry.createdAt)} · ${auditEventText(entry.eventType)} · por ${byWhom(entry.principalId)}`
      )
    );
    return dom.el(
      "section",
      { "aria-labelledby": "historico-titulo", class: "history" },
      dom.el(
        "h3",
        { id: "historico-titulo" },
        "O que foi feito neste atendimento"
      ),
      grants.length === 0
        ? dom.el("p", {}, "Nenhum acesso temporário neste atendimento.")
        : dom.el("ul", {}, ...grants),
      events.length === 0
        ? dom.el("p", {}, "Nada registrado ainda.")
        : dom.el("ul", {}, ...events)
    );
  };

  const accessSection = (detail: SupportCaseDetail) => {
    access = accessView(tools, detail.case, detail.grants, {
      reload: (message: AccessMessage) => load(() => access?.say(message)),
    });
    return access?.element ?? null;
  };

  const actions = (detail: SupportCaseDetail) => {
    const item = detail.case;
    access?.discard();
    access = null;
    if (item.kind !== "support") {
      return dom.el(
        "p",
        { class: "hint" },
        "Atendimento de privacidade: aqui ele é só leitura. Ele é conduzido e fechado no fluxo de privacidade."
      );
    }
    if (item.status !== "open") {
      return dom.el(
        "div",
        { class: "closed-case" },
        dom.el(
          "p",
          {},
          `Atendimento fechado em ${brasiliaMomentText(item.closedAt)}. Para agir de novo, abra outro atendimento.`
        ),
        newCaseLink(dom, item.organizationId),
        accessSection(detail)
      );
    }
    const mayAct = can("organization:suspend") || can("organization:classify");
    return dom.el(
      "div",
      { class: "case-actions" },
      closePanel(item),
      mayAct ? storeActionsView(tools, item) : null,
      can("billing:operate") ? entitlementsView(tools, item) : null,
      accessSection(detail)
    );
  };

  const render = (detail: SupportCaseDetail) => {
    dom.fill(body, header(detail.case), actions(detail), history(detail));
  };

  /**
   * Reads the case; with `after`, says how the action before ended once the case is shown again. False when the case
   * could not be shown (the failure is already said).
   */
  const load = async (after?: () => void): Promise<boolean> => {
    turn += 1;
    const mine = turn;
    if (after === undefined) {
      notice.status("Carregando o atendimento…");
    }
    const answer = await api.get<SupportCaseDetail>(
      `/api/support-cases/${encodeURIComponent(caseId ?? "")}`
    );
    if (mine !== turn) {
      return true;
    }
    if (!answer.ok) {
      notice.alert(problemText(answer.problem));
      return false;
    }
    if (
      typeof answer.data?.case?.id !== "string" ||
      !Array.isArray(answer.data.audit) ||
      !Array.isArray(answer.data.grants)
    ) {
      notice.alert(PROBLEM_TEXT.failed);
      return false;
    }
    render(answer.data);
    if (after === undefined) {
      notice.clear();
    } else {
      after();
    }
    return true;
  };

  function closePanel(item: Case): HTMLElement {
    const panel = dom.el("section", {
      "aria-labelledby": "fechar-titulo",
      class: "action-panel",
    });
    const resolution = dom.el("input", {
      "aria-describedby": "resolucao-erro resolucao-contador resolucao-dica",
      autocomplete: "off",
      id: "resolucao",
      maxlength: String(MAX_RESOLUTION_LENGTH),
      name: "resolucao",
      type: "text",
    });
    const resolutionError = dom.el("p", {
      "aria-live": "polite",
      class: "field-error",
      id: "resolucao-erro",
    });
    const counter = dom.el(
      "p",
      { class: "hint", id: "resolucao-contador" },
      `0 de ${MAX_RESOLUTION_LENGTH} caracteres`
    );
    let sending = false;
    let typed = "";

    const title = (text: string) =>
      dom.el("h3", { id: "fechar-titulo", tabindex: "-1" }, text);

    const start = () => {
      const open = dom.el("button", { type: "button" }, "Fechar atendimento");
      open.addEventListener("click", () => showForm());
      dom.fill(
        panel,
        title("Atendimento em uso"),
        dom.el("p", {}, CLOSE_EFFECT),
        open
      );
    };

    const showForm = (error = "") => {
      const next = dom.el("button", { type: "submit" }, "Revisar o fechamento");
      const back = dom.el(
        "button",
        { class: "secondary", type: "button" },
        "Cancelar"
      );
      back.addEventListener("click", () => {
        start();
        panel.querySelector("button")?.focus();
      });
      const form = dom.el(
        "form",
        { class: "search", novalidate: "" },
        dom.el("label", { for: "resolucao" }, "Resolução (opcional)"),
        resolution,
        resolutionError,
        counter,
        dom.el(
          "p",
          { class: "hint", id: "resolucao-dica" },
          "Como o atendimento terminou, curto e sem dado pessoal do cliente. Fica no registro do atendimento."
        ),
        dom.el("p", {}, CLOSE_EFFECT),
        dom.el("div", { class: "button-row" }, next, back)
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = resolution.value.trim();
        const problem = resolutionProblem(text);
        if (problem !== null) {
          showError(problem);
          return;
        }
        typed = text;
        review();
      });
      resolutionError.textContent = "";
      resolution.removeAttribute("aria-invalid");
      dom.fill(panel, title("Fechar o atendimento"), form);
      if (error === "") {
        resolution.focus();
      } else {
        showError(error);
      }
    };

    const showError = (text: string) => {
      resolutionError.textContent = text;
      resolution.setAttribute("aria-invalid", "true");
      resolution.focus();
    };

    const review = () => {
      const confirm = dom.el(
        "button",
        { type: "button" },
        "Confirmar o fechamento do atendimento"
      );
      const back = dom.el(
        "button",
        { class: "secondary", type: "button" },
        "Voltar"
      );
      const reload = dom.el(
        "button",
        { class: "secondary", hidden: "", type: "button" },
        "Recarregar o atendimento"
      );
      const heading = title("Revise antes de fechar");
      back.addEventListener("click", () => {
        if (!sending) {
          showForm();
        }
      });
      reload.addEventListener("click", () => {
        load();
      });
      confirm.addEventListener("click", () => {
        if (!sending) {
          close({ back, confirm, reload });
        }
      });
      dom.fill(
        panel,
        heading,
        facts(dom, [
          ["Ambiente", environmentText(context)],
          ["Loja", storeName(dom, item.organizationName, item.organizationId)],
          [
            "Atendimento",
            `Aberto em ${brasiliaMomentText(item.openedAt)}: ${labelName(item.reason, 120)}`,
          ],
          ["Resolução", typed === "" ? "Sem resolução escrita." : typed],
          ["O que acontece", CLOSE_EFFECT],
          ["Dá para desfazer", CLOSE_UNDO],
          [RECORD_LABEL, CLOSE_AUDIT],
        ]),
        dom.el("div", { class: "button-row" }, confirm, back, reload)
      );
      heading.focus();
    };

    /** After a close whose outcome the screen cannot show, the only way on is to read the case again. */
    const onlyReload = (buttons: {
      back: HTMLButtonElement;
      confirm: HTMLButtonElement;
      reload: HTMLButtonElement;
    }) => {
      sending = true;
      buttons.confirm.setAttribute("hidden", "");
      buttons.back.setAttribute("hidden", "");
      buttons.reload.removeAttribute("hidden");
    };

    const close = async (buttons: {
      back: HTMLButtonElement;
      confirm: HTMLButtonElement;
      reload: HTMLButtonElement;
    }) => {
      sending = true;
      buttons.confirm.setAttribute("aria-disabled", "true");
      buttons.back.setAttribute("aria-disabled", "true");
      notice.status("Fechando o atendimento…");
      const answer = await api.post<ClosedSupportCase>(
        `/api/support-cases/${encodeURIComponent(item.id)}/close`,
        { resolution: typed }
      );
      if (answer.ok && answer.data?.status === "closed") {
        const said = answer.data.changed
          ? "Atendimento fechado. Os acessos temporários dele foram revogados."
          : "Este atendimento já estava fechado.";
        if (!(await load(() => notice.success(said)))) {
          onlyReload(buttons);
          notice.alert(CLOSED_NOT_SHOWN);
        }
        return;
      }
      sending = false;
      buttons.confirm.setAttribute("aria-disabled", "false");
      buttons.back.setAttribute("aria-disabled", "false");
      if (!answer.ok && answer.problem === "invalid") {
        notice.clear();
        showForm(RESOLUTION_REFUSED);
        return;
      }
      if (
        answer.ok ||
        answer.problem === "network" ||
        answer.problem === "failed" ||
        answer.problem === "unavailable"
      ) {
        // the request may have reached the server: the state is read again before anything is tried
        onlyReload(buttons);
        notice.alert(CLOSE_UNKNOWN);
        return;
      }
      notice.alert(problemText(answer.problem));
    };

    resolution.addEventListener("input", () => {
      resolutionError.textContent = "";
      resolution.removeAttribute("aria-invalid");
      counter.textContent = `${[...resolution.value].length} de ${MAX_RESOLUTION_LENGTH} caracteres`;
    });
    start();
    return panel;
  }

  if (caseId === null) {
    notice.alert("Este atendimento não foi encontrado.");
  } else {
    load();
  }
  return dom.el(
    "section",
    { "aria-labelledby": "caso-titulo", class: "area" },
    dom.el("h2", { id: "caso-titulo" }, "Dados do atendimento"),
    notice.element,
    body
  );
}
