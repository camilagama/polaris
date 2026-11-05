import { PROBLEM_TEXT, type Problem } from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts } from "../blocks";
import { labelName, storeName } from "../dom";
import { brasiliaMomentText } from "../format";
import { createNotice, type Notice } from "../notice";
import {
  ACTIONS,
  CATEGORIES,
  CHANNELS,
  type Choices,
  DECISION_REASONS,
  DECISIONS,
  IDENTITY_METHODS,
  IDENTITY_STATUSES,
  isCode,
  labelOf,
  REQUEST_TYPES,
  REQUESTER_KINDS,
  ROLES,
} from "../privacy";
import type { PrivacyCaseDetail, PrivacyStepAnswer } from "../types";
import { storePath } from "./case-links";
import { closureNoticeSection, mayShowClosureNotice } from "./closure-notice";
import { dueCell } from "./privacy-cases";
import {
  choiceField,
  type Field,
  isUuidText,
  MAX_NOTE_LENGTH,
  MAX_REFERENCE_LENGTH,
  NO_PERSONAL_DATA,
  noteProblem,
  plainField,
  referenceProblem,
  textField,
} from "./privacy-form";

export const STEP_UNDO = "Não: cada etapa vale uma vez.";
export const STEP_RECORD =
  "A etapa fica no registro do caso e na auditoria, com o seu e-mail. A nota não vai para a auditoria.";
export const STAGE_CONFLICT =
  "Esta etapa já foi registrada ou ainda não é a vez dela. Nada foi refeito.";
export const ACTIONS_ONLY_RECORD =
  "Isto registra o que foi feito pelos comandos próprios; não altera dado da loja.";
export const STEP_UNKNOWN =
  "Não deu para confirmar se a etapa foi registrada. Recarregue o caso para ver o estado antes de tentar de novo.";
const STEP_REFUSED =
  "A etapa não foi aceita: confira os campos e as regras desta etapa.";

type Detail = PrivacyCaseDetail;
type StepKey =
  | "actions"
  | "decision"
  | "identity"
  | "resolve"
  | "role"
  | "scope";

interface StepSpec {
  key: StepKey;
  /** The last part of the route, `/api/privacy-cases/:caseId{segment}`, written whole so the route guard sees it. */
  segment: string;
  title: string;
}

/** The six steps of ADR 0077, in the server's order. */
const STEPS: readonly StepSpec[] = [
  { key: "identity", segment: "/identity", title: "Identidade" },
  { key: "role", segment: "/role", title: "Papel do Polaris" },
  { key: "scope", segment: "/scope", title: "Escopo" },
  { key: "decision", segment: "/decision", title: "Decisão" },
  { key: "actions", segment: "/actions", title: "Ações" },
  { key: "resolve", segment: "/resolve", title: "Resolução" },
];

const STAGE_ORDER = [
  "requested",
  "identity_checked",
  "role_determined",
  "scoped",
  "decided",
  "executed",
  "resolved",
];

/** The rules the server enforces, said in words; the screen enforces none of them for the operator (AC-P11.3). */
export const RULES: Readonly<Record<StepKey, readonly string[]>> = {
  actions: [
    ACTIONS_ONLY_RECORD,
    "Uma recusa não tem ação a registrar. Um encaminhamento se cumpre com “Encaminhado à loja”, “Nada a fazer” ou “Outro”. Uma aceitação se cumpre fazendo algo: nem “Encaminhado à loja” nem “Nada a fazer”.",
    "O registro alcançado, quando houver, é o ID (UUID) dele, nunca nome ou e-mail.",
  ],
  decision: [
    "Com a identidade não confirmada, só se recusa, com o motivo “Identidade não confirmada”; esse motivo só vale nesse caso.",
    "Como operador, o Polaris não aceita por conta própria um pedido sobre dado que só processa, a menos que quem pede seja o dono da loja: o caminho é encaminhar à loja, que é a controladora.",
    "Encaminhar ao controlador só vale quando o Polaris é operador. Toda decisão que não seja aceitar sem ressalva tem motivo.",
  ],
  identity: [
    "Registre como a identidade de quem pede foi conferida. Um documento, se conferido, é visto fora do Polaris e não é guardado.",
    "Com a identidade não confirmada, o caso só poderá ser recusado.",
  ],
  resolve: [
    "Resolver fecha o caso e revoga os acessos temporários dele. Caso resolvido não reabre.",
    "Uma aceitação só se resolve depois de ao menos uma ação registrada; uma recusa ou um encaminhamento se resolvem sem ação.",
  ],
  role: [
    "Controlador: o Polaris decide sobre o dado (conta, autenticação, assinatura, segurança e suporte). Operador: o Polaris só processa o dado pela loja (por exemplo, os clientes que a loja cadastra).",
    "Como operador, o Polaris não aceita por conta própria o pedido de quem não é o dono da loja.",
  ],
  scope: [
    "Marque ao menos uma categoria de dado. A referência ao titular é um código opaco, nunca nome, e-mail ou documento.",
  ],
};

type StepState = "current" | "done" | "later" | "skipped";

function stageIndex(stage: string): number {
  return STAGE_ORDER.indexOf(stage);
}

/** Where each step is, from the stage and the decision the server returned (ADR 0077). */
function stepStates(detail: Detail): Record<StepKey, StepState> {
  const { privacy } = detail;
  const at = stageIndex(privacy.stage);
  const open = detail.case.status === "open" && privacy.stage !== "resolved";
  const ordered = (index: number): StepState => {
    if (at > index) {
      return "done";
    }
    return at === index && open ? "current" : "later";
  };
  const { decision } = privacy;
  const withoutAction =
    decision === "reject" || decision === "redirect_to_controller";
  let actions: StepState = "later";
  let resolve: StepState = "later";
  if (privacy.stage === "resolved") {
    actions = detail.actions.length > 0 ? "done" : "skipped";
    resolve = "done";
  } else if (privacy.stage === "executed") {
    actions = "done";
    resolve = open ? "current" : "later";
  } else if (privacy.stage === "decided") {
    actions = decision === "reject" ? "skipped" : "current";
    resolve = withoutAction ? "current" : "later";
    if (!open) {
      actions = actions === "current" ? "later" : actions;
      resolve = "later";
    }
  }
  return {
    actions,
    decision: ordered(3),
    identity: ordered(0),
    resolve,
    role: ordered(1),
    scope: ordered(2),
  };
}

function problemText(problem: Problem): string {
  if (problem === "not_found") {
    return "Este caso não foi encontrado.";
  }
  return PROBLEM_TEXT[problem === "invalid" ? "failed" : problem];
}

interface StepForm {
  fields: HTMLElement[];
  /** The body of the step's request and the words of what it records, or null once a field is marked refused. */
  read: () => { body: Record<string, string | string[]>; value: string } | null;
}

/**
 * The screen of one privacy case (corte admin-v2, Parte 11): the case, its due date as the server keeps it, and the
 * six steps of ADR 0077 as one vertical column, the same at 1280 and at 360 (AC-P11.8). The step whose turn it is
 * is open; the steps done are one line each; the steps after it are off. Nothing is chosen for the operator, and each
 * step goes through the two-step review (AC-P11.3, AC-P11.4), one request per click; a step refused as out of turn
 * or repeated is said in words and the steps are read again (AC-P11.2).
 */
export function privacyCaseView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom, now, who } = tools;
  const notice = createNotice(dom);
  const body = dom.el("div", { class: "case privacy-case" });
  const caseId = context.id;
  let turn = 0;
  let left = false;

  const byWhom = (principalId: string) =>
    principalId === who.principal.id ? "você" : "outro operador";

  const header = (detail: Detail) => {
    const item = detail.case;
    const { privacy } = detail;
    const path = storePath(item.organizationId);
    const link =
      can("organization:diagnose") && path !== null
        ? dom.el("a", { href: path }, "Ver loja")
        : null;
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
      ["Pedido", labelOf(REQUEST_TYPES, privacy.requestType)],
      ["Quem pede", labelOf(REQUESTER_KINDS, privacy.requesterKind)],
      ["Canal", labelOf(CHANNELS, privacy.channel)],
      ["Recebido em", brasiliaMomentText(privacy.receivedAt)],
      ["Aberto em", brasiliaMomentText(item.openedAt)],
      ["Prazo de resposta", closedText(detail) ?? dueCell(dom, privacy, now())],
      ["Nota", privacy.note ?? "Sem nota."],
    ];
    return facts(dom, pairs);
  };

  const doneLine = (key: StepKey, detail: Detail): string => {
    const { privacy } = detail;
    switch (key) {
      case "identity":
        return `${labelOf(IDENTITY_STATUSES, privacy.identityStatus)}, por ${labelOf(IDENTITY_METHODS, privacy.identityMethod).toLowerCase()}`;
      case "role":
        return labelOf(ROLES, privacy.polarisRole);
      case "scope": {
        const categories = (privacy.scopeCategories ?? [])
          .map((code) => labelOf(CATEGORIES, code))
          .join(", ");
        return privacy.subjectReference === null
          ? categories
          : `${categories} · referência ${labelName(privacy.subjectReference, MAX_REFERENCE_LENGTH)}`;
      }
      case "decision": {
        const parts = [labelOf(DECISIONS, privacy.decision)];
        if (privacy.decisionReason !== null) {
          parts.push(
            `motivo: ${labelOf(DECISION_REASONS, privacy.decisionReason)}`
          );
        }
        if (privacy.decisionNote !== null) {
          parts.push(`nota: ${labelName(privacy.decisionNote, 120)}`);
        }
        return parts.join(" · ");
      }
      case "actions":
        return detail.actions
          .map(
            (action) =>
              `${labelOf(ACTIONS, action.action)} (${brasiliaMomentText(action.recordedAt)}, por ${byWhom(action.recordedBy)})`
          )
          .join("; ");
      default:
        return detail.case.resolution === null
          ? "sem texto de resolução"
          : labelName(detail.case.resolution, 120);
    }
  };

  const skippedLine = (key: StepKey, detail: Detail): string =>
    key === "actions" && detail.privacy.decision === "reject"
      ? "Sem ação: uma recusa não tem o que registrar."
      : "Sem ação registrada.";

  const history = (detail: Detail) => {
    const events = detail.audit.map((entry) =>
      dom.el(
        "li",
        {},
        `${brasiliaMomentText(entry.at)} · ${auditText(entry.eventType)} · por ${byWhom(entry.principalId)}`
      )
    );
    return dom.el(
      "section",
      { "aria-labelledby": "privacidade-historico", class: "history" },
      dom.el("h3", { id: "privacidade-historico" }, "Histórico do caso"),
      events.length === 0
        ? dom.el("p", {}, "Nada registrado ainda.")
        : dom.el("ul", {}, ...events)
    );
  };

  const render = (detail: Detail) => {
    const states = stepStates(detail);
    const items = STEPS.map((spec, index) => {
      const number = `${index + 1}. ${spec.title}`;
      const state = states[spec.key];
      if (state === "done") {
        return dom.el(
          "li",
          { class: "step step-done" },
          dom.el(
            "p",
            { class: "step-line" },
            dom.el("span", { class: "step-mark" }, "Feita: "),
            `${number}: ${doneLine(spec.key, detail)}`
          )
        );
      }
      if (state === "skipped") {
        return dom.el(
          "li",
          { class: "step step-done" },
          dom.el(
            "p",
            { class: "step-line" },
            dom.el("span", { class: "step-mark" }, "Sem ação: "),
            `${number}: ${skippedLine(spec.key, detail)}`
          )
        );
      }
      if (state === "later") {
        return dom.el(
          "li",
          { class: "step step-later" },
          dom.el(
            "p",
            { class: "step-line" },
            dom.el("span", { class: "step-mark" }, "Depois: "),
            number
          )
        );
      }
      return dom.el(
        "li",
        { "aria-current": "step", class: "step step-current" },
        stepPanel(spec, index, detail)
      );
    });
    const closedLine =
      detail.case.status !== "open" && detail.privacy.stage !== "resolved"
        ? dom.el(
            "p",
            { class: "warning" },
            "Este caso foi fechado fora do fluxo de privacidade: as etapas que faltam não podem mais ser registradas."
          )
        : null;
    const drawn = turn;
    dom.fill(
      body,
      header(detail),
      closedLine,
      dom.el(
        "section",
        { "aria-labelledby": "privacidade-etapas", class: "steps-area" },
        dom.el("h3", { id: "privacidade-etapas" }, "Etapas do caso"),
        dom.el("ol", { class: "steps" }, ...items)
      ),
      mayShowClosureNotice(can, detail)
        ? closureNoticeSection(tools, detail, {
            current: () => !left && drawn === turn,
            readsStore: can("organization:diagnose"),
            reread: (outcome) =>
              load(
                outcome === undefined
                  ? undefined
                  : () => notice[outcome.kind](outcome.text)
              ),
          })
        : null,
      history(detail)
    );
  };

  /** Reads the case; `after` says how the step before ended once the steps are shown again. */
  const load = async (after?: () => void): Promise<boolean> => {
    if (left) {
      return true;
    }
    turn += 1;
    const mine = turn;
    if (after === undefined) {
      notice.status("Carregando o caso…");
    }
    const answer = await api.get<Detail>(
      `/api/privacy-cases/${encodeURIComponent(caseId ?? "")}`
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
      typeof answer.data.privacy?.stage !== "string" ||
      !Array.isArray(answer.data.actions) ||
      !Array.isArray(answer.data.audit)
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

  function formOf(key: StepKey, detail: Detail): StepForm {
    const id = (name: string) => `etapa-${key}-${name}`;
    const required = (
      field: Field<HTMLSelectElement>,
      list: Choices,
      problem: string
    ) => {
      if (!isCode(list, field.control.value)) {
        field.refuse(problem);
        return null;
      }
      return field.control.value;
    };
    if (key === "identity") {
      const status = choiceField(
        dom,
        id("status"),
        "Identidade",
        IDENTITY_STATUSES
      );
      const method = choiceField(
        dom,
        id("metodo"),
        "Como foi conferida",
        IDENTITY_METHODS
      );
      return {
        fields: [status.element, method.element],
        read: () => {
          const chosenStatus = required(
            status,
            IDENTITY_STATUSES,
            "Escolha se a identidade foi confirmada."
          );
          const chosenMethod =
            chosenStatus === null
              ? null
              : required(
                  method,
                  IDENTITY_METHODS,
                  "Escolha como a identidade foi conferida."
                );
          if (chosenStatus === null || chosenMethod === null) {
            return null;
          }
          return {
            body: { method: chosenMethod, status: chosenStatus },
            value: `${labelOf(IDENTITY_STATUSES, chosenStatus)}, por ${labelOf(IDENTITY_METHODS, chosenMethod).toLowerCase()}`,
          };
        },
      };
    }
    if (key === "role") {
      const role = choiceField(
        dom,
        id("papel"),
        "Papel do Polaris neste pedido",
        ROLES
      );
      return {
        fields: [role.element],
        read: () => {
          const chosen = required(role, ROLES, "Escolha o papel do Polaris.");
          return chosen === null
            ? null
            : { body: { role: chosen }, value: labelOf(ROLES, chosen) };
        },
      };
    }
    if (key === "scope") {
      return scopeForm(id);
    }
    if (key === "decision") {
      const decision = choiceField(dom, id("decisao"), "Decisão", DECISIONS);
      const reason = choiceField(
        dom,
        id("motivo"),
        "Motivo",
        DECISION_REASONS,
        "Obrigatório em toda decisão que não seja aceitar sem ressalva."
      );
      const note = textField(
        dom,
        id("nota"),
        "Nota da decisão (opcional)",
        MAX_NOTE_LENGTH,
        NO_PERSONAL_DATA
      );
      const caseFacts = dom.el(
        "p",
        { class: "hint" },
        `Neste caso: identidade ${labelOf(IDENTITY_STATUSES, detail.privacy.identityStatus).toLowerCase()}; papel do Polaris ${labelOf(ROLES, detail.privacy.polarisRole).split(":")[0]?.toLowerCase() ?? ""}; quem pede: ${labelOf(REQUESTER_KINDS, detail.privacy.requesterKind).toLowerCase()}.`
      );
      return {
        fields: [caseFacts, decision.element, reason.element, note.element],
        read: () => readDecision(decision, reason, note),
      };
    }
    if (key === "actions") {
      const action = choiceField(dom, id("acao"), "O que foi feito", ACTIONS);
      const entity = plainField(
        dom,
        id("registro"),
        "ID do registro alcançado (opcional)",
        "text",
        "O UUID do cliente ou da loja alcançado, quando houver."
      );
      entity.control.setAttribute("maxlength", "36");
      return {
        fields: [action.element, entity.element],
        read: () => {
          const chosen = required(action, ACTIONS, "Escolha o que foi feito.");
          if (chosen === null) {
            return null;
          }
          const entityText = entity.control.value.trim();
          if (entityText !== "" && !isUuidText(entityText)) {
            entity.refuse("Use o ID (UUID) do registro, ou deixe vazio.");
            return null;
          }
          const sent: Record<string, string> = { action: chosen };
          let value = labelOf(ACTIONS, chosen);
          if (entityText !== "") {
            sent.entityId = entityText.toLowerCase();
            value += `, registro ${entityText.toLowerCase()}`;
          }
          return { body: sent, value };
        },
      };
    }
    const resolution = textField(
      dom,
      id("texto"),
      "Resolução (opcional)",
      MAX_NOTE_LENGTH,
      NO_PERSONAL_DATA
    );
    return {
      fields: [resolution.element],
      read: () => {
        const text = resolution.control.value.trim();
        const refused = noteProblem(text, "A resolução");
        if (refused !== null) {
          resolution.refuse(refused);
          return null;
        }
        return text === ""
          ? { body: {}, value: "caso resolvido, sem texto de resolução" }
          : { body: { resolution: text }, value: `caso resolvido: “${text}”` };
      },
    };
  }

  function scopeForm(id: (name: string) => string): StepForm {
    const boxes = CATEGORIES.map(([code, words]) => {
      const box = dom.el("input", {
        id: id(code),
        name: id("categorias"),
        type: "checkbox",
        value: code,
      });
      return {
        box,
        code,
        element: dom.el(
          "div",
          { class: "check" },
          box,
          dom.el("label", { for: id(code) }, words)
        ),
      };
    });
    const groupError = dom.el("p", {
      "aria-live": "polite",
      class: "field-error",
      id: id("categorias-erro"),
    });
    const groupTitle = dom.el(
      "p",
      { class: "label", id: id("categorias-titulo") },
      "Categorias de dado"
    );
    const group = dom.el(
      "div",
      {
        "aria-describedby": id("categorias-erro"),
        "aria-labelledby": id("categorias-titulo"),
        class: "checks",
        role: "group",
      },
      ...boxes.map((entry) => entry.element)
    );
    for (const entry of boxes) {
      entry.box.addEventListener("change", () => {
        groupError.textContent = "";
      });
    }
    const reference = textField(
      dom,
      id("referencia"),
      "Referência ao titular (opcional)",
      MAX_REFERENCE_LENGTH,
      "Um código opaco, por exemplo o ID do cliente: letras sem acento, números, - e _."
    );
    return {
      fields: [groupTitle, group, groupError, reference.element],
      read: () => {
        const chosen = boxes
          .filter((entry) => entry.box.checked)
          .map((entry) => entry.code);
        if (chosen.length === 0) {
          groupError.textContent = "Marque ao menos uma categoria.";
          boxes[0]?.box.focus();
          return null;
        }
        const text = reference.control.value.trim();
        const refused = referenceProblem(text);
        if (refused !== null) {
          reference.refuse(refused);
          return null;
        }
        const categories = chosen
          .map((code) => labelOf(CATEGORIES, code))
          .join(", ");
        return {
          body:
            text === ""
              ? { categories: chosen }
              : { categories: chosen, subjectReference: text },
          value: text === "" ? categories : `${categories}, referência ${text}`,
        };
      },
    };
  }

  function stepPanel(
    spec: StepSpec,
    index: number,
    detail: Detail
  ): HTMLElement {
    const panel = dom.el("section", {
      "aria-labelledby": `etapa-${spec.key}-titulo`,
      class: "action-panel step-panel",
    });
    const stepNotice: Notice = createNotice(dom);
    const form = formOf(spec.key, detail);
    let sending = false;
    const label = `${index + 1}. ${spec.title}`;

    const title = (text: string) =>
      dom.el("h4", { id: `etapa-${spec.key}-titulo`, tabindex: "-1" }, text);

    const rules = () =>
      dom.el(
        "ul",
        { "aria-label": "Regras do servidor", class: "rules" },
        ...RULES[spec.key].map((rule) => dom.el("li", {}, rule))
      );

    const showForm = (focusButton = false) => {
      const next = dom.el(
        "button",
        { type: "submit" },
        `Revisar ${spec.title.toLowerCase()}`
      );
      const element = dom.el(
        "form",
        { class: "step-form", novalidate: "" },
        rules(),
        ...form.fields,
        dom.el("div", { class: "button-row" }, next)
      );
      element.addEventListener("submit", (event) => {
        event.preventDefault();
        stepNotice.clear();
        const read = form.read();
        if (read !== null) {
          review(read);
        }
      });
      dom.fill(panel, title(label), element, stepNotice.element);
      if (focusButton) {
        next.focus();
      }
    };

    const effect = (value: string) =>
      spec.key === "resolve"
        ? `A resolução fica registrada como ${value}. O caso fecha e os acessos temporários dele são revogados.`
        : `A etapa “${spec.title}” fica registrada como ${value}.`;

    const review = (read: {
      body: Record<string, string | string[]>;
      value: string;
    }) => {
      const confirm = dom.el(
        "button",
        { type: "button" },
        `Registrar ${spec.title.toLowerCase()}`
      );
      const back = dom.el(
        "button",
        { class: "secondary", type: "button" },
        "Voltar"
      );
      const reload = dom.el(
        "button",
        { class: "secondary", hidden: "", type: "button" },
        "Recarregar o caso"
      );
      const heading = title(`Revise antes de registrar: ${label}`);
      back.addEventListener("click", () => {
        if (!sending) {
          showForm(true);
        }
      });
      reload.addEventListener("click", () => {
        load();
      });
      confirm.addEventListener("click", () => {
        if (!sending) {
          send(read, { back, confirm, reload });
        }
      });
      const pairs: [string, Node | string][] = [
        ["Ambiente", environmentText(context)],
        [
          "Loja",
          storeName(
            dom,
            detail.case.organizationName,
            detail.case.organizationId
          ),
        ],
        [
          "Caso",
          `Caso de privacidade aberto em ${brasiliaMomentText(detail.case.openedAt)}`,
        ],
        ["O que acontece", effect(read.value)],
      ];
      if (spec.key === "actions") {
        pairs.push(["Só registro", ACTIONS_ONLY_RECORD]);
      }
      pairs.push(
        ["Dá para desfazer", STEP_UNDO],
        ["Fica no registro", STEP_RECORD]
      );
      dom.fill(
        panel,
        heading,
        facts(dom, pairs),
        dom.el("div", { class: "button-row" }, confirm, back, reload),
        stepNotice.element
      );
      heading.focus();
    };

    const send = async (
      read: { body: Record<string, string | string[]>; value: string },
      buttons: {
        back: HTMLButtonElement;
        confirm: HTMLButtonElement;
        reload: HTMLButtonElement;
      }
    ) => {
      sending = true;
      buttons.confirm.setAttribute("aria-disabled", "true");
      buttons.back.setAttribute("aria-disabled", "true");
      stepNotice.status(`Registrando ${spec.title.toLowerCase()}…`);
      const answer = await api.post<PrivacyStepAnswer>(
        `/api/privacy-cases/${encodeURIComponent(detail.case.id)}${spec.segment}`,
        read.body
      );
      if (answer.ok && typeof answer.data?.stage === "string") {
        const said = `Etapa “${spec.title}” registrada.`;
        if (!(await load(() => notice.success(said)))) {
          onlyReload(buttons);
          stepNotice.alert(
            "A etapa foi registrada, mas não deu para mostrar o caso de novo. Use Recarregar o caso."
          );
        }
        return;
      }
      if (!answer.ok && answer.problem === "conflict") {
        // out of turn or repeated: nothing is sent again, the steps are read as the server has them
        if (!(await load(() => notice.alert(STAGE_CONFLICT)))) {
          onlyReload(buttons);
          stepNotice.alert(STAGE_CONFLICT);
        }
        return;
      }
      refused(answer.ok ? "failed" : answer.problem, buttons);
    };

    const refused = (
      problem: Problem,
      buttons: {
        back: HTMLButtonElement;
        confirm: HTMLButtonElement;
        reload: HTMLButtonElement;
      }
    ) => {
      if (
        problem === "network" ||
        problem === "failed" ||
        problem === "unavailable"
      ) {
        onlyReload(buttons);
        stepNotice.alert(STEP_UNKNOWN);
        return;
      }
      sending = false;
      if (problem === "not_allowed" || problem === "invalid") {
        // the operator's choices stay as they were typed: the refusal is said inside the step
        showForm(false);
        stepNotice.alert(
          problem === "invalid" ? STEP_REFUSED : PROBLEM_TEXT.not_allowed
        );
        return;
      }
      buttons.confirm.setAttribute("aria-disabled", "false");
      buttons.back.setAttribute("aria-disabled", "false");
      stepNotice.alert(problemText(problem));
    };

    /** After a step whose outcome the screen cannot show, the only way on is to read the case again. */
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

    showForm(false);
    return panel;
  }

  // a page restored from the back-forward cache must not show the case's note, reference or choices again
  dom.document.defaultView?.addEventListener("pagehide", () => {
    left = true;
    turn += 1;
    dom.fill(body);
    notice.clear();
  });

  if (caseId === null) {
    notice.alert("Este caso não foi encontrado.");
  } else {
    load();
  }
  return dom.el(
    "section",
    { "aria-labelledby": "privacidade-caso-titulo", class: "area" },
    dom.el("h2", { id: "privacidade-caso-titulo" }, "Caso de privacidade"),
    notice.element,
    body
  );
}

/** The decision's body and words, or null once the first field the server would refuse is marked. */
function readDecision(
  decision: Field<HTMLSelectElement>,
  reason: Field<HTMLSelectElement>,
  note: Field<HTMLInputElement>
): { body: Record<string, string>; value: string } | null {
  const chosen = decision.control.value;
  if (!isCode(DECISIONS, chosen)) {
    decision.refuse("Escolha a decisão.");
    return null;
  }
  const why = reason.control.value;
  if (why === "" && chosen !== "accept") {
    reason.refuse(
      "Escolha o motivo: toda decisão que não seja aceitar sem ressalva tem motivo."
    );
    return null;
  }
  if (why !== "" && !isCode(DECISION_REASONS, why)) {
    reason.refuse("Escolha um motivo da lista.");
    return null;
  }
  const noteText = note.control.value.trim();
  const noteRefused = noteProblem(noteText, "A nota");
  if (noteRefused !== null) {
    note.refuse(noteRefused);
    return null;
  }
  const body: Record<string, string> = { decision: chosen };
  const words = [labelOf(DECISIONS, chosen)];
  if (why !== "") {
    body.reason = why;
    words.push(`motivo: ${labelOf(DECISION_REASONS, why)}`);
  }
  if (noteText !== "") {
    body.note = noteText;
    words.push("com nota");
  }
  return { body, value: words.join(", ") };
}

/** How a case that is no longer open ended, as the server recorded it; null while it is open. */
function closedText(detail: Detail): string | null {
  if (detail.privacy.stage === "resolved") {
    return `Caso resolvido em ${brasiliaMomentText(detail.privacy.resolvedAt ?? detail.case.closedAt)}`;
  }
  if (detail.case.status !== "open") {
    return `Caso fechado em ${brasiliaMomentText(detail.case.closedAt)}, sem resolução no fluxo de privacidade`;
  }
  return null;
}

const AUDIT_EVENTS: Readonly<Record<string, string>> = {
  "privacy_case.action_recorded": "Ação registrada",
  "privacy_case.stage_recorded": "Etapa registrada",
  "support_case.closed": "Caso fechado",
  "support_case.opened": "Caso aberto",
  "tenant_access.granted": "Acesso aos dados dado",
  "tenant_access.revoked": "Acesso aos dados encerrado",
};

function auditText(eventType: string): string {
  return AUDIT_EVENTS[eventType] ?? "Outra ação registrada";
}
