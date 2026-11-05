import { PROBLEM_TEXT, sendProviderCommand } from "../api";
import type { ScreenTools } from "../app";
import { facts } from "../blocks";
import { hasControlCharacter, labelName, storeName } from "../dom";
import {
  billingStateText,
  brasiliaMomentText,
  calendarDayText,
  lastDayText,
  methodText,
  minutesText,
  moneyText,
} from "../format";
import { MAX_REASON_LENGTH } from "../grant-limits";
import type { Notice } from "../notice";
import {
  AMOUNT_PATTERN,
  amountChangedText,
  CANCEL_AUDIT,
  CANCEL_BUTTON,
  CANCEL_CONFIRM,
  CANCEL_TITLE,
  CASE_GONE,
  cancelEffectText,
  cancelUndoText,
  environmentLine,
  IN_PROGRESS,
  limitReachedText,
  NO_CHARGE,
  NO_RENEWAL,
  NOT_ACCEPTED,
  NOTHING_TO_DO,
  OUTCOME_NOT_RECORDED,
  PIX_OUTSIDE,
  PROVIDER_NOT_HERE,
  REASON_HINT,
  REFUND_AUDIT,
  REFUND_LIMIT,
  REFUND_NEEDS_OTHER_PERMISSION,
  REFUND_TITLE,
  REFUND_UNDO,
  RENEWAL_ALREADY_CANCELLED,
  REREAD_BUTTON,
  RESULT_TEXT,
  RETRY_BUTTON,
  RENEWAL_LABEL,
  MAYBE_SENT_HINT,
  NOT_RECORDED_SUFFIX,
  refundEffectText,
  type SettledResult,
  UNKNOWN_HINT,
  UNKNOWN_OUTCOME,
  WRITE_MAY_HAVE_HAPPENED,
} from "../refund-words";
import { limitText, writeMayHaveHappened } from "../refusal";
import type { RefundWindowView } from "../types";
import { NO_PERSONAL_DATA } from "./privacy-form";
import type { CaseChoice } from "./support-case";

type Kind = "cancel" | "refund";

/** What the area says after it reads the billing again, which every definite answer does. */
export interface After {
  kind: "alert" | "success";
  /** The refund's confirmation opens again, with this reason, over the amount the new read gives (`amount_changed`). */
  reopenRefund?: { from: string | null; reason: string };
  text: string | ((view: RefundWindowView) => string);
}

export interface BillingActionsOptions {
  /** Turns the area's own buttons off while a command is on its way, so nothing else is asked meanwhile. */
  busy: (on: boolean) => void;
  choice: CaseChoice;
  /** A confirmation opened (true) or closed (false): the page shows no other reason field beside an open one. */
  confirming?: (open: boolean) => void;
  notice: Notice;
  organization: { id: string; name: string };
  settled: (after: After) => void;
  view: RefundWindowView;
}

export interface BillingActions {
  element: HTMLElement;
  openRefund: (reason: string) => void;
}

/** The command the operator opened: its ID is made when the confirmation opens and kept until a definite answer. */
interface Draft {
  commandId: string;
  input: HTMLInputElement;
  kind: Kind;
  reason: string;
  /** The outcome of the last send is unknown: the same ID goes again, with the same reason. */
  sent: boolean;
}

const ALERT_RESULTS: ReadonlySet<SettledResult> = new Set([
  "not_linked",
  "refund_not_supported",
]);

/**
 * The amount that goes to the server is the first charge of this link as the read gave it, as `money.md` writes it:
 * nothing else is offered, and it is not known to be the charge in force (a change of cycle prices the next ones
 * apart), so the server's `amount_changed` is the check.
 */
function firstChargeAmountOf(view: RefundWindowView): string | null {
  const amount = view.firstChargeAmount;
  const paid = view.state === "active" || view.state === "grace";
  return paid &&
    amount !== null &&
    AMOUNT_PATTERN.test(amount) &&
    amount !== "0.00"
    ? amount
    : null;
}

function reasonProblem(reason: string): string | null {
  if (reason === "") {
    return "Escreva o motivo.";
  }
  if ([...reason].length > MAX_REASON_LENGTH) {
    return `O motivo aceita até ${MAX_REASON_LENGTH} caracteres.`;
  }
  if (hasControlCharacter(reason)) {
    return "O motivo não aceita caracteres de controle nem quebra de linha.";
  }
  return null;
}

function renewalLine(renewal: RefundWindowView["renewal"]): string {
  if (renewal.status === "renewing") {
    return renewal.renewsOn === null
      ? "Viva: renova no fim do período pago"
      : `Viva: renova em ${calendarDayText(renewal.renewsOn)}`;
  }
  if (renewal.status === "cancelled") {
    return `Cancelada: o acesso pago vai até ${lastDayText(renewal.accessUntil)}`;
  }
  return "Não há renovação";
}

export { renewalLine };

/**
 * The two actions of the billing of a support case (ADR 0105), each reviewed in a step of its
 * own: cancel the renewal, and refund the period in force at the amount of the link's first charge (which cancels the renewal first). The page offers only
 * what the read says is possible and the operator may do; the server decides again at every command. The command ID is
 * made when a confirmation opens and kept until a definite answer, so a repeat after "we do not know" is the same
 * command, and a new opening is a new one. The amount sent is the amount read and shown, never one typed or worked
 * out. One request per click: the buttons answer `aria-disabled` while it is on its way.
 */
export function billingActionsView(
  tools: ScreenTools,
  options: BillingActionsOptions
): BillingActions {
  const { api, can, context, dom } = tools;
  const { choice, notice, organization, view } = options;
  const amount = firstChargeAmountOf(view);
  const box = dom.el("div", { class: "grant-action" });
  let sending = false;
  const pathOf = (kind: Kind) => {
    const base = `/api/support-cases/${encodeURIComponent(choice.id)}`;
    return kind === "cancel"
      ? `${base}/billing/cancel-renewal`
      : `${base}/billing/refund`;
  };
  const accessUntil =
    view.renewal.accessUntil === null
      ? null
      : lastDayText(view.renewal.accessUntil);
  const resubscribeFrom =
    view.renewal.resubscribeFrom === null
      ? null
      : lastDayText(view.renewal.resubscribeFrom);

  const button = (text: string, secondary: boolean, onClick: () => void) => {
    const element = dom.el(
      "button",
      secondary ? { class: "secondary", type: "button" } : { type: "button" },
      text
    );
    element.addEventListener("click", () => {
      if (!sending) {
        onClick();
      }
    });
    return element;
  };

  const environment = () => {
    const line = environmentLine(context.environment);
    return context.environment === "production"
      ? dom.el("span", { class: "warning" }, line)
      : line;
  };

  const reviewFacts = (
    lines: readonly [string, Node | string][],
    effect: string,
    undo: string,
    audit: string
  ) =>
    facts(dom, [
      ["Ambiente", environment()],
      ["Loja", storeName(dom, organization.name, organization.id)],
      [
        "Caso",
        `Aberto em ${brasiliaMomentText(choice.openedAt)}: ${labelName(choice.reason, 120)}`,
      ],
      ...lines,
      ["O que acontece", effect],
      ["Dá para desfazer", undo],
      ["Fica na auditoria", audit],
    ]);

  const reasonField = (prefill: string) => {
    const input = dom.el("input", {
      "aria-describedby":
        "cobranca-motivo-erro cobranca-motivo-contador cobranca-motivo-dica",
      autocomplete: "off",
      id: "cobranca-motivo",
      name: "motivo",
      required: "",
      type: "text",
    });
    input.value = prefill;
    const error = dom.el("p", {
      "aria-live": "polite",
      class: "field-error",
      id: "cobranca-motivo-erro",
      tabindex: "-1",
    });
    const counter = dom.el("p", {
      class: "hint",
      id: "cobranca-motivo-contador",
    });
    const count = () => {
      counter.textContent = `${[...input.value].length} de ${MAX_REASON_LENGTH} caracteres`;
    };
    input.addEventListener("input", count);
    count();
    return {
      element: dom.el(
        "div",
        { class: "search case-form" },
        dom.el("label", { for: "cobranca-motivo" }, "Motivo"),
        input,
        error,
        counter,
        dom.el(
          "p",
          { class: "hint", id: "cobranca-motivo-dica" },
          `${REASON_HINT} ${NO_PERSONAL_DATA}`
        )
      ),
      error,
      input,
    };
  };

  const close = () => {
    options.confirming?.(false);
    dom.fill(box);
    buttonsRow.querySelector("button")?.focus();
  };

  const lock = (buttons: HTMLElement[], locked: boolean) => {
    for (const element of buttons) {
      element.setAttribute("aria-disabled", String(locked));
    }
    options.busy(locked);
  };

  const failureText = (
    kind: Kind,
    failure: Parameters<typeof limitText>[0]
  ) => {
    switch (failure.problem) {
      case "rate_limited":
        return kind === "refund"
          ? limitReachedText(
              failure.retryAfterSeconds === undefined
                ? null
                : minutesText(failure.retryAfterSeconds)
            )
          : limitText(failure);
      case "forbidden":
        return PROBLEM_TEXT.forbidden;
      case "session":
        return PROBLEM_TEXT.session;
      case "not_found":
        return CASE_GONE;
      case "invalid":
        return NOT_ACCEPTED;
      default:
        return PROBLEM_TEXT.failed;
    }
  };

  const amountChanged = (current: Draft) => {
    options.settled({
      kind: "alert",
      reopenRefund: { from: view.firstChargeAmount, reason: current.reason },
      text: (fresh) =>
        amountChangedText(
          fresh.firstChargeAmount === null
            ? null
            : moneyText(fresh.firstChargeAmount),
          fresh.firstChargeAmount === view.firstChargeAmount
        ),
    });
  };

  const definite = (result: SettledResult, outcomeRecorded: boolean) => {
    const text = RESULT_TEXT[result]({
      accessUntil,
      amount: moneyText(amount),
    });
    if (outcomeRecorded) {
      options.settled({
        kind: ALERT_RESULTS.has(result) ? "alert" : "success",
        text,
      });
      return;
    }
    options.settled({
      kind: "alert",
      text:
        result === "cancelled" || result === "refund_requested"
          ? OUTCOME_NOT_RECORDED
          : `${text} ${NOT_RECORDED_SUFFIX}`,
    });
  };

  const send = async (current: Draft, buttons: HTMLElement[]) => {
    sending = true;
    lock(buttons, true);
    notice.status(
      current.kind === "cancel"
        ? "Cancelando a renovação…"
        : "Pedindo o reembolso ao provedor…"
    );
    const body =
      current.kind === "refund" && amount !== null
        ? {
            commandId: current.commandId,
            expectedAmount: amount,
            reason: current.reason,
          }
        : { commandId: current.commandId, reason: current.reason };
    const outcome = await sendProviderCommand(api, pathOf(current.kind), body);
    sending = false;
    lock(buttons, false);
    if (outcome.kind === "result") {
      switch (outcome.result) {
        case "provider_unavailable":
          unknown(current, UNKNOWN_OUTCOME, UNKNOWN_HINT, buttons);
          return;
        case "command_in_progress":
          freeze(current);
          notice.alert(IN_PROGRESS);
          return;
        case "amount_changed":
          amountChanged(current);
          return;
        default:
          definite(outcome.result, outcome.outcomeRecorded);
          return;
      }
    }
    if (writeMayHaveHappened(outcome.problem)) {
      unknown(current, WRITE_MAY_HAVE_HAPPENED, MAYBE_SENT_HINT, buttons);
      return;
    }
    // the request was refused before anything ran: a new attempt is a new command
    current.commandId = crypto.randomUUID();
    notice.alert(failureText(current.kind, outcome.problem));
  };

  /** The reason of a command that may be running stays as it was sent: a repeat is the same command. */
  function freeze(current: Draft) {
    current.input.setAttribute("aria-readonly", "true");
    current.input.readOnly = true;
    current.sent = true;
  }

  /** The outcome is not known: the confirmation stays as it was and the same command can go again. */
  function unknown(
    current: Draft,
    text: string,
    hint: string,
    buttons: HTMLElement[]
  ) {
    notice.alert(text);
    buttons[0]?.replaceChildren(RETRY_BUTTON);
    if (!current.sent) {
      box.append(
        dom.el("p", { class: "hint", id: "cobranca-incerto" }, hint),
        button(REREAD_BUTTON, true, () => {
          options.settled({ kind: "success", text: "Cobrança lida de novo." });
        })
      );
    }
    freeze(current);
  }

  const review = (kind: Kind, prefill = "") => {
    notice.clear();
    options.confirming?.(true);
    const field = reasonField(prefill);
    const current: Draft = {
      commandId: crypto.randomUUID(),
      input: field.input,
      kind,
      reason: "",
      sent: false,
    };
    const heading = dom.el(
      "h4",
      { id: "cobranca-revisao", tabindex: "-1" },
      kind === "cancel" ? CANCEL_TITLE : REFUND_TITLE
    );
    const money = moneyText(amount);
    const confirm = dom.el(
      "button",
      { type: "button" },
      kind === "cancel" ? CANCEL_CONFIRM : `Reembolsar ${money}`
    );
    const back = button("Voltar", true, close);
    const buttons = [confirm, back];
    confirm.addEventListener("click", () => {
      if (sending) {
        return;
      }
      if (!current.sent) {
        const typed = field.input.value.trim();
        const problem = reasonProblem(typed);
        field.error.textContent = problem ?? "";
        if (problem !== null) {
          field.input.setAttribute("aria-invalid", "true");
          field.input.focus();
          return;
        }
        field.input.removeAttribute("aria-invalid");
        current.reason = typed;
      }
      send(current, buttons);
    });
    const lines: [string, Node | string][] =
      kind === "cancel"
        ? [
            [
              "Assinatura",
              `${methodText(view.method)}, ${billingStateText(view.state)}`,
            ],
            [RENEWAL_LABEL, renewalLine(view.renewal)],
          ]
        : [
            ["Valor a reembolsar", dom.el("span", { class: "money" }, money)],
            [
              "Cobrança",
              `Primeira cobrança em ${brasiliaMomentText(view.firstChargeAt)}, ${methodText(view.method)}`,
            ],
            [RENEWAL_LABEL, renewalLine(view.renewal)],
          ];
    dom.fill(
      box,
      heading,
      reviewFacts(
        lines,
        kind === "cancel"
          ? cancelEffectText(accessUntil)
          : refundEffectText(money),
        kind === "cancel" ? cancelUndoText(resubscribeFrom) : REFUND_UNDO,
        kind === "cancel" ? CANCEL_AUDIT : REFUND_AUDIT
      ),
      kind === "refund" ? dom.el("p", { class: "hint" }, REFUND_LIMIT) : null,
      field.element,
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  };

  const canCancel =
    can("billing:operate") && view.renewal.status === "renewing";
  const canRefund =
    can("billing:refund") && amount !== null && view.refundsHere;
  const buttonsRow = dom.el("div", { class: "button-row" });
  if (canCancel) {
    buttonsRow.append(button(CANCEL_BUTTON, false, () => review("cancel")));
  }
  if (canRefund) {
    buttonsRow.append(
      button(`Reembolsar ${moneyText(amount)}`, true, () => review("refund"))
    );
  }

  const hints: string[] = [];
  if (!canCancel) {
    hints.push(
      view.renewal.status === "cancelled"
        ? RENEWAL_ALREADY_CANCELLED
        : NO_RENEWAL
    );
  }
  if (amount === null) {
    hints.push(NO_CHARGE);
  } else if (!view.refundsHere) {
    hints.push(
      view.method === "pix_automatic" ? PIX_OUTSIDE : PROVIDER_NOT_HERE
    );
  } else if (!can("billing:refund")) {
    hints.push(REFUND_NEEDS_OTHER_PERMISSION);
  }
  if (!(canCancel || canRefund) && amount === null) {
    hints.push(NOTHING_TO_DO);
  }

  const element = dom.el(
    "div",
    { class: "billing-actions" },
    ...hints.map((text) => dom.el("p", { class: "hint" }, text)),
    buttonsRow,
    box
  );
  return {
    element,
    openRefund: (reason) => {
      if (canRefund) {
        review("refund", reason);
      }
    },
  };
}
