import {
  type ClosureNoticeAct,
  PROBLEM_TEXT,
  type Problem,
  sendClosureNotice,
} from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts } from "../blocks";
import {
  DISMISS_EFFECT,
  DISMISS_RECORD,
  DISMISS_RULES,
  DISMISS_UNDO,
  NOTICE_READ_FAILED,
  NOTICE_UNKNOWN,
  REISSUE_EFFECT,
  REISSUE_RECORD,
  REISSUE_UNDO,
  refusalText,
} from "../closure-notice-words";
import { storeName } from "../dom";
import { buttonRow, effectLine, recordLine } from "../effect-lines";
import { brasiliaMomentText } from "../format";
import { createNotice, type Notice } from "../notice";
import {
  CLOSURE_NOTICE_DISMISSALS,
  CLOSURE_NOTICE_ORGANIZATION_STATUSES,
  labelOf,
} from "../privacy";
import { RECORD_LABEL } from "../record-label";
import type { OrganizationDiagnostics, PrivacyCaseDetail } from "../types";
import { radioChoice } from "./privacy-form";

const NOTICE_RECORD =
  "Cada ato fica na auditoria, com o seu e-mail e o atendimento.";

function problemText(problem: Problem): string {
  if (problem === "not_found") {
    return "Este atendimento não foi encontrado.";
  }
  return PROBLEM_TEXT[problem === "invalid" ? "failed" : problem];
}

type Detail = PrivacyCaseDetail;

export interface ClosureNoticeHooks {
  /** False once the screen was drawn again or left: an old read writes nothing. */
  current: () => boolean;
  /** Whether the operator may read the store's state; without it the acts are offered and the server refuses. */
  readsStore: boolean;
  /** Reads the case again, and says how the act ended once the screen is shown again; false if it could not. */
  reread: (outcome?: {
    kind: "alert" | "success";
    text: string;
  }) => Promise<boolean>;
}

interface Buttons {
  back: HTMLButtonElement;
  confirm: HTMLButtonElement;
  reload: HTMLButtonElement;
}

/** Whether the notice section may be asked for at all: the capability to act, on a case that is still open. */
export function mayShowClosureNotice(
  can: (capability: string) => boolean,
  detail: Detail
): boolean {
  return can("organization:purge") && detail.case.status === "open";
}

/**
 * "Aviso de encerramento" in a privacy case (corte admin-v2, Parte 12; ADR 0102): reissue the notice of D minus 7 days
 * or dismiss it. The section exists for a store in the states the server accepts the acts in, which the case read does
 * not say: an operator who may read the store reads its state once, from its diagnostics, and a store in another
 * state (or a read that failed) leaves nothing of the section in the page; an operator who may not read it is offered
 * the acts and the server refuses by name what does not fit. Each act is reviewed in two steps with the store and the case in view, sends one request
 * per click and ends by reading the case, and so the section, again. The section schedules and cancels no purge.
 */
export function closureNoticeSection(
  tools: ScreenTools,
  detail: Detail,
  hooks: ClosureNoticeHooks
): HTMLElement {
  const { api, context, dom } = tools;
  const slot = dom.el("div", { class: "closure-notice-slot", hidden: "" });
  const item = detail.case;
  let sending = false;

  const read = async () => {
    const answer = await api.get<OrganizationDiagnostics>(
      `/api/organizations/${encodeURIComponent(item.organizationId)}/diagnostics`
    );
    if (!hooks.current()) {
      return;
    }
    const organization = answer.ok ? answer.data?.organization : undefined;
    if (
      !answer.ok ||
      organization?.id !== item.organizationId ||
      typeof organization.status !== "string"
    ) {
      const again = dom.el(
        "button",
        { class: "secondary", type: "button" },
        "Reler o atendimento"
      );
      again.addEventListener("click", () => {
        hooks.reread();
      });
      slot.removeAttribute("hidden");
      dom.fill(
        slot,
        dom.el("p", { class: "hint", role: "status" }, NOTICE_READ_FAILED),
        again
      );
      return;
    }
    if (CLOSURE_NOTICE_ORGANIZATION_STATUSES.includes(organization.status)) {
      showActions();
    }
  };

  const sectionTitle = () =>
    dom.el(
      "h3",
      { id: "aviso-encerramento-titulo", tabindex: "-1" },
      "Aviso de encerramento"
    );

  const wrap = (...children: (HTMLElement | null)[]) =>
    dom.el(
      "section",
      {
        "aria-labelledby": "aviso-encerramento-titulo",
        class: "closure-notice action-panel",
      },
      ...children
    );

  const caseFacts = () =>
    facts(dom, [
      ["Ambiente", environmentText(context)],
      ["Loja", storeName(dom, item.organizationName, item.organizationId)],
      [
        "Atendimento",
        `Atendimento de privacidade aberto em ${brasiliaMomentText(item.openedAt)}`,
      ],
    ]);

  const showActions = () => {
    const notice = createNotice(dom);
    const reissue = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Reemitir o aviso"
    );
    const dismiss = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Dispensar o aviso"
    );
    reissue.addEventListener("click", () => {
      if (!sending) {
        reviewReissue();
      }
    });
    dismiss.addEventListener("click", () => {
      if (!sending) {
        dismissForm();
      }
    });
    slot.removeAttribute("hidden");
    dom.fill(
      slot,
      wrap(
        sectionTitle(),
        dom.el(
          "p",
          { class: "hint" },
          "O aviso de 7 dias diz ao dono que os dados da loja serão apagados. Reemita enquanto ele não foi entregue nem dispensado, ou dispense quando ninguém pode ser avisado."
        ),
        caseFacts(),
        effectLine(dom, "reissueNotice"),
        effectLine(dom, "dismissNotice"),
        buttonRow(dom, reissue, dismiss),
        recordLine(dom, NOTICE_RECORD),
        notice.element
      )
    );
  };

  const reviewHeading = (text: string) =>
    dom.el("h4", { id: "aviso-encerramento-revisao", tabindex: "-1" }, text);

  const buttonsOf = (confirmText: string): Buttons => ({
    back: dom.el("button", { class: "secondary", type: "button" }, "Voltar"),
    confirm: dom.el("button", { type: "button" }, confirmText),
    reload: dom.el(
      "button",
      { class: "secondary", hidden: "", type: "button" },
      "Reler o atendimento"
    ),
  });

  const reviewReissue = () => {
    const notice = createNotice(dom);
    const buttons = buttonsOf("Confirmar reemissão do aviso");
    const heading = reviewHeading("Revise antes de reemitir o aviso");
    wire(buttons, notice, { kind: "reissue" }, () => {
      showActions();
      slot.querySelector("button")?.focus();
    });
    dom.fill(
      slot,
      wrap(
        heading,
        facts(dom, [
          ["Ambiente", environmentText(context)],
          ["Loja", storeName(dom, item.organizationName, item.organizationId)],
          [
            "Atendimento",
            `Atendimento de privacidade aberto em ${brasiliaMomentText(item.openedAt)}`,
          ],
          ["O que acontece", REISSUE_EFFECT],
          ["Dá para desfazer", REISSUE_UNDO],
          [RECORD_LABEL, REISSUE_RECORD],
        ]),
        dom.el(
          "div",
          { class: "button-row" },
          buttons.confirm,
          buttons.back,
          buttons.reload
        ),
        notice.element
      )
    );
    heading.focus();
  };

  const dismissForm = () => {
    const notice = createNotice(dom);
    const reason = radioChoice(
      dom,
      "aviso-encerramento-motivo",
      "Motivo da dispensa",
      CLOSURE_NOTICE_DISMISSALS
    );
    const next = dom.el("button", { type: "submit" }, "Revisar a dispensa");
    const back = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Voltar"
    );
    const form = dom.el(
      "form",
      { class: "step-form", novalidate: "" },
      dom.el("p", { class: "hint" }, DISMISS_RULES),
      reason.element,
      dom.el("div", { class: "button-row" }, next, back)
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const chosen = CLOSURE_NOTICE_DISMISSALS.find(
        ([code]) => code === reason.chosen()
      );
      if (chosen === undefined) {
        reason.refuse("Escolha o motivo da dispensa.");
        return;
      }
      reviewDismiss(chosen[0]);
    });
    back.addEventListener("click", () => {
      showActions();
      slot.querySelector("button")?.focus();
    });
    dom.fill(slot, wrap(sectionTitle(), caseFacts(), form, notice.element));
    reason.first.focus();
  };

  const reviewDismiss = (code: string) => {
    const notice = createNotice(dom);
    const buttons = buttonsOf("Confirmar dispensa do aviso");
    const heading = reviewHeading("Revise antes de dispensar o aviso");
    wire(buttons, notice, { kind: "dismiss", reason: code }, () => {
      dismissForm();
    });
    dom.fill(
      slot,
      wrap(
        heading,
        facts(dom, [
          ["Ambiente", environmentText(context)],
          ["Loja", storeName(dom, item.organizationName, item.organizationId)],
          [
            "Atendimento",
            `Atendimento de privacidade aberto em ${brasiliaMomentText(item.openedAt)}`,
          ],
          ["Motivo", labelOf(CLOSURE_NOTICE_DISMISSALS, code)],
          ["O que acontece", DISMISS_EFFECT],
          ["Dá para desfazer", DISMISS_UNDO],
          [RECORD_LABEL, DISMISS_RECORD],
        ]),
        dom.el(
          "div",
          { class: "button-row" },
          buttons.confirm,
          buttons.back,
          buttons.reload
        ),
        notice.element
      )
    );
    heading.focus();
  };

  const wire = (
    buttons: Buttons,
    notice: Notice,
    act: ClosureNoticeAct,
    goBack: () => void
  ) => {
    buttons.back.addEventListener("click", () => {
      if (!sending) {
        goBack();
      }
    });
    buttons.reload.addEventListener("click", () => {
      hooks.reread();
    });
    buttons.confirm.addEventListener("click", () => {
      if (!sending) {
        send(buttons, notice, act);
      }
    });
  };

  const onlyReload = (buttons: Buttons) => {
    sending = true;
    buttons.confirm.setAttribute("hidden", "");
    buttons.back.setAttribute("hidden", "");
    buttons.reload.removeAttribute("hidden");
  };

  const send = async (
    buttons: Buttons,
    notice: Notice,
    act: ClosureNoticeAct
  ) => {
    sending = true;
    buttons.confirm.setAttribute("aria-disabled", "true");
    buttons.back.setAttribute("aria-disabled", "true");
    notice.status(
      act.kind === "dismiss" ? "Dispensando o aviso…" : "Reemitindo o aviso…"
    );
    const outcome = await sendClosureNotice(
      api,
      item.id,
      item.organizationId,
      act
    );
    if (outcome.kind === "done") {
      await finish(
        {
          kind: "success",
          text:
            act.kind === "dismiss"
              ? "Aviso dispensado. Ele conta como entregue; o apagamento ainda espera 7 dias."
              : "Aviso reemitido. Um aviso novo foi registrado para o dono atual.",
        },
        buttons,
        notice
      );
      return;
    }
    if (outcome.kind === "refused") {
      await finish(
        { kind: "alert", text: refusalText(outcome.code) },
        buttons,
        notice
      );
      return;
    }
    const { problem } = outcome;
    if (
      problem === "network" ||
      problem === "failed" ||
      problem === "unavailable"
    ) {
      onlyReload(buttons);
      notice.alert(NOTICE_UNKNOWN);
      return;
    }
    if (problem === "session" || problem === "rate_limited") {
      sending = false;
      buttons.confirm.setAttribute("aria-disabled", "false");
      buttons.back.setAttribute("aria-disabled", "false");
      notice.alert(problemText(problem));
      return;
    }
    await finish(
      { kind: "alert", text: problemText(problem) },
      buttons,
      notice
    );
  };

  const finish = async (
    outcome: { kind: "alert" | "success"; text: string },
    buttons: Buttons,
    notice: Notice
  ) => {
    if (await hooks.reread(outcome)) {
      return;
    }
    onlyReload(buttons);
    notice.status(
      `${outcome.text} Não deu para mostrar o atendimento de novo: use Reler o atendimento.`
    );
  };

  if (hooks.readsStore) {
    read();
  } else {
    showActions();
  }
  return slot;
}
