import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { storeName } from "../dom";
import { createNotice } from "../notice";
import type {
  OpenedSupportCase,
  OrganizationPage,
  OrganizationSummary,
} from "../types";
import { casePath } from "./case-links";
import { organizationsView } from "./organizations";
import {
  MAX_REASON_LENGTH,
  openProblemText,
  reasonProblem,
} from "./support-case";

interface Choice {
  id: string;
  name: string | null;
}

/**
 * Abrir caso de suporte (AC-P1.5): a store chosen (from the store's screen, `?loja=`, or by the search here) and a
 * reason of 1 to 500 characters with its counter, sent as JSON in the body. Only the support kind is offered: a
 * privacy case has its own workflow. The case opened is shown on its own screen, which is where it is used.
 */
export function newCaseView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom, navigate } = tools;
  const notice = createNotice(dom);
  const chosenLine = dom.el(
    "p",
    { class: "chosen", id: "caso-loja" },
    "Nenhuma loja escolhida."
  );
  const reason = dom.el("input", {
    "aria-describedby": "motivo-erro motivo-contador motivo-dica",
    autocomplete: "off",
    id: "motivo",
    maxlength: String(MAX_REASON_LENGTH),
    name: "motivo",
    required: "",
    type: "text",
  });
  const reasonError = dom.el("p", {
    "aria-live": "polite",
    class: "field-error",
    id: "motivo-erro",
  });
  const counter = dom.el(
    "p",
    { class: "hint", id: "motivo-contador" },
    `0 de ${MAX_REASON_LENGTH} caracteres`
  );
  const openButton = dom.el("button", { type: "submit" }, "Abrir caso");
  const form = dom.el(
    "form",
    { class: "search case-form", novalidate: "" },
    dom.el("h3", {}, "Loja do caso"),
    chosenLine,
    dom.el("label", { for: "motivo" }, "Motivo"),
    dom.el("div", { class: "search-row" }, reason, openButton),
    reasonError,
    counter,
    dom.el(
      "p",
      { class: "hint", id: "motivo-dica" },
      "O motivo fica na auditoria e justifica as ações deste caso. Curto e sem dado pessoal do cliente."
    )
  );

  let chosen: Choice | null = null;
  let sending = false;

  const choose = (choice: Choice) => {
    chosen = choice;
    dom.fill(
      chosenLine,
      "Loja: ",
      storeName(dom, choice.name ?? "nome não lido", choice.id)
    );
  };

  const clearReasonError = () => {
    reasonError.textContent = "";
    reason.removeAttribute("aria-invalid");
  };

  const showReasonError = (text: string) => {
    notice.clear();
    reasonError.textContent = text;
    reason.setAttribute("aria-invalid", "true");
    reason.focus();
  };

  const open = async (choice: Choice) => {
    const text = reason.value.trim();
    const problem = reasonProblem(text);
    if (problem !== null) {
      showReasonError(problem);
      return;
    }
    clearReasonError();
    sending = true;
    openButton.setAttribute("aria-disabled", "true");
    notice.status("Abrindo o caso…");
    const answer = await api.post<OpenedSupportCase>("/api/support-cases", {
      kind: "support",
      organizationId: choice.id,
      reason: text,
    });
    const path = answer.ok ? casePath(answer.data?.id) : null;
    if (answer.ok && path !== null) {
      // the button stays off: the screen of the case opened replaces this one
      notice.success("Caso aberto. Abrindo o caso…");
      navigate(path);
      return;
    }
    sending = false;
    openButton.setAttribute("aria-disabled", "false");
    if (answer.ok) {
      notice.alert(openProblemText("failed"));
    } else if (answer.problem === "invalid") {
      showReasonError(openProblemText(answer.problem));
    } else if (answer.problem === "not_found") {
      notice.alert("Esta loja não foi encontrada.");
    } else {
      notice.alert(openProblemText(answer.problem));
    }
  };

  reason.addEventListener("input", () => {
    clearReasonError();
    counter.textContent = `${[...reason.value].length} de ${MAX_REASON_LENGTH} caracteres`;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (sending) {
      return;
    }
    if (chosen === null) {
      notice.alert("Escolha a loja antes de abrir o caso.");
      return;
    }
    open(chosen);
  });

  const parts: (HTMLElement | null)[] = [];
  const { store } = context;
  if (store !== null) {
    choose({ id: store, name: null });
    if (can("organization:diagnose")) {
      readName(store);
    }
  } else if (can("organization:diagnose")) {
    parts.push(
      organizationsView(
        dom,
        api,
        (organization: OrganizationSummary) => {
          choose({ id: organization.id, name: organization.name });
          reason.focus();
        },
        "Escolher loja"
      )
    );
  } else {
    dom.fill(
      chosenLine,
      "Sem permissão para buscar loja: abra o caso pela tela da loja."
    );
  }

  /** The chosen store's name, by its exact ID (the search, not audited); the case is opened by the ID all the same. */
  async function readName(id: string) {
    const parameters = new URLSearchParams({ limit: "1", query: id });
    const answer = await api.get<OrganizationPage>(
      `/api/organizations?${parameters.toString()}`
    );
    if (!answer.ok) {
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    const found = Array.isArray(answer.data?.organizations)
      ? answer.data.organizations.find((item) => item.id === id)
      : undefined;
    if (found === undefined) {
      notice.alert("Esta loja não foi encontrada.");
      return;
    }
    if (chosen?.id === id) {
      choose({ id, name: found.name });
    }
  }

  return dom.el(
    "section",
    { "aria-labelledby": "novo-caso-titulo", class: "area" },
    dom.el("h2", { id: "novo-caso-titulo" }, "Novo caso de suporte"),
    ...parts,
    form,
    notice.element
  );
}
