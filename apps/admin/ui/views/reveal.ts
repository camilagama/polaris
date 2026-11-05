import { type Api, type ApiFailure, PROBLEM_TEXT, revealField } from "../api";
import { type Dom, labelName, revealedText } from "../dom";
import type { Notice } from "../notice";
import { limitText, writeMayHaveHappened } from "../refusal";
import type { MaskedCustomer, RevealableField } from "../types";

/** The longest a revealed value stays on the screen; it leaves sooner on any of the events below. */
export const REVEAL_SECONDS = 30;

export const REVEAL_AUDIT =
  "Esta revelação fica registrada na auditoria (o campo, não o valor)";
export const REVEALED_MARK =
  "Revelado · fica na auditoria (o campo, não o valor)";
export const REVEAL_UNDO =
  "Não: a revelação fica no registro (o campo, não o valor), mesmo que você esconda.";
export const REVEAL_GONE =
  "O valor revelado saiu da tela. Para ver de novo, revele de novo: cada revelação fica na auditoria.";
export const REVEAL_UNKNOWN =
  "Não deu para confirmar se o dado foi revelado. Nada foi mostrado; se tentar de novo, outra revelação fica na auditoria.";
export const CUSTOMER_GONE = "Cliente não encontrado.";
export const NO_ACCESS_NOW =
  "O acesso acabou ou o caso foi fechado: nada foi revelado.";
const REVEAL_REFUSED = "O pedido não foi aceito. Nada foi revelado.";

interface FieldText {
  article: string;
  empty: string;
  label: string;
}

/** The four fields the server reveals, in the order of the menu; there is no other and no secret among them. */
export const REVEAL_FIELDS: readonly RevealableField[] = [
  "name",
  "email",
  "phone",
  "notes",
];

export const FIELD_TEXT: Readonly<Record<RevealableField, FieldText>> = {
  email: {
    article: "o e-mail",
    empty: "Este cliente não tem e-mail cadastrado.",
    label: "E-mail",
  },
  name: {
    article: "o nome",
    empty: "Este cliente não tem nome cadastrado.",
    label: "Nome",
  },
  notes: {
    article: "as observações",
    empty: "Este cliente não tem observações cadastradas.",
    label: "Observações",
  },
  phone: {
    article: "o telefone",
    empty: "Este cliente não tem telefone cadastrado.",
    label: "Telefone",
  },
};

const confirmText = (field: RevealableField) =>
  `Revelar ${FIELD_TEXT[field].article} deste cliente`;

type Phase =
  | { customerId: string; kind: "gone" }
  | { customerId: string; kind: "menu" }
  | { customerId: string; field: RevealableField; kind: "review" }
  | {
      customerId: string;
      field: RevealableField;
      kind: "shown";
      value: string | null;
    };

export interface RevealHost {
  /** The route's own answer when no access is in force: the whole section leaves and the case is read again. */
  accessEnded: (text: string) => Promise<void>;
  api: Api;
  caseId: string;
  /** A button of the section: aria-disabled while anything of it answers, and the click is refused then. */
  control: (
    text: string,
    secondary: boolean,
    onClick: () => void
  ) => HTMLElement;
  dom: Dom;
  /** The end of the access the server gave, or null when none is in force. */
  expiresAt: () => string | null;
  isBusy: () => boolean;
  notice: Notice;
  /** Forgets buttons that left the page, so the section does not keep every one it ever made. */
  release: (elements: readonly HTMLElement[]) => void;
  now: () => Date;
  /** Ambiente, loja and caso, then the three lines of the review (corte admin-v2, AC-C2). */
  review: (
    lines: readonly [string, Node | string][],
    effect: string,
    undo: string,
    audit: string
  ) => HTMLElement;
  setBusy: (on: boolean) => void;
  /** False, with the section already off the screen, when the end the server gave has passed. */
  stillActive: () => boolean;
}

export interface Reveal {
  /** The cell of one row: the menu and the revealed value, painted for what is going on now. */
  cell: (customer: MaskedCustomer) => HTMLElement;
  /** Throws away any value, review or menu, the timer and the listening: nothing of a customer stays in memory or in the DOM. */
  clear: () => void;
  /** Where the review of the field being revealed is written. */
  element: HTMLElement;
}

function failureText(failure: ApiFailure): string {
  if (writeMayHaveHappened(failure)) {
    return REVEAL_UNKNOWN;
  }
  switch (failure.problem) {
    case "forbidden":
      return PROBLEM_TEXT.forbidden;
    case "not_found":
      return CUSTOMER_GONE;
    case "rate_limited":
      return limitText(failure);
    case "session":
      return PROBLEM_TEXT.session;
    case "conflict":
      return PROBLEM_TEXT.conflict;
    default:
      return REVEAL_REFUSED;
  }
}

/**
 * Revealing one field of one customer (corte admin-v2, Parte 6; AC-P6.1 to AC-P6.4): a menu in each row, a review in
 * two steps for the chosen field, one request per confirmation, and the value written as text in that row only. One
 * value at a time. It leaves the DOM and the memory after `REVEAL_SECONDS`, or sooner when the access ends (the
 * server's end), the section is left, the list is read again, the tab is hidden, the page leaves or another reveal
 * starts. This is the only place of the page's script with a timer, because a value on the screen must go away with
 * no click of the operator; the guard counts it. The value is never put in an address, the title, storage, a log or
 * the clipboard: it exists only as the text of one cell.
 */
export function createReveal(host: RevealHost): Reveal {
  const { dom, notice } = host;
  const reviewBox = dom.el("div", { class: "reveal-review" });
  const cells = new Map<string, HTMLElement>();
  const customers = new Map<string, MaskedCustomer>();
  const cellControls = new Map<string, HTMLElement[]>();
  let reviewControls: HTMLElement[] = [];
  let phase: Phase | null = null;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let watching = false;
  const onVisibility = () => {
    if (dom.document.hidden) {
      hideValue(REVEAL_GONE);
    }
  };
  const watch = (on: boolean) => {
    if (on === watching) {
      return;
    }
    watching = on;
    if (on) {
      dom.document.addEventListener("visibilitychange", onVisibility);
    } else {
      dom.document.removeEventListener("visibilitychange", onVisibility);
    }
  };

  const stopTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const nameOf = (customerId: string) =>
    labelName(customers.get(customerId)?.name ?? "", 40);

  /** A button of one row, remembered with it so that repainting the row lets it go. */
  const rowControl = (
    customerId: string,
    text: string,
    onClick: () => void
  ) => {
    const button = host.control(text, true, onClick);
    cellControls.set(customerId, [
      ...(cellControls.get(customerId) ?? []),
      button,
    ]);
    return button;
  };

  const resetReview = () => {
    host.release(reviewControls);
    reviewControls = [];
    dom.fill(reviewBox);
  };

  const menuButton = (customerId: string, open: boolean) => {
    const button = rowControl(customerId, "Revelar ▾", () => {
      toggleMenu(customerId);
    });
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-controls", `revelar-${customerId}`);
    button.setAttribute(
      "aria-label",
      `Revelar um dado pessoal do cliente ${nameOf(customerId)}`
    );
    return button;
  };

  const fieldMenu = (customerId: string) =>
    dom.el(
      "div",
      {
        "aria-label": "Campo a revelar",
        class: "button-row",
        id: `revelar-${customerId}`,
        role: "group",
      },
      ...REVEAL_FIELDS.map((field) =>
        rowControl(customerId, FIELD_TEXT[field].label, () => {
          openReview(customerId, field);
        })
      )
    );

  const cellContent = (customerId: string) => {
    if (phase === null || phase.customerId !== customerId) {
      return [menuButton(customerId, false)];
    }
    switch (phase.kind) {
      case "menu":
        return [menuButton(customerId, true), fieldMenu(customerId)];
      case "gone":
        return [
          dom.el("p", { class: "hint" }, "Valor escondido: revele de novo."),
          menuButton(customerId, false),
        ];
      case "review":
        return [menuButton(customerId, false)];
      case "shown":
        return [
          dom.el(
            "bdi",
            { class: "revealed-value", tabindex: "-1" },
            phase.value === null
              ? FIELD_TEXT[phase.field].empty
              : revealedText(phase.value)
          ),
          dom.el(
            "p",
            { class: "hint" },
            `${FIELD_TEXT[phase.field].label} · ${REVEALED_MARK}`
          ),
          rowControl(customerId, "Esconder agora", () => {
            hideValue("Valor escondido.");
            cells.get(customerId)?.querySelector("button")?.focus();
          }),
        ];
      default: {
        const unreachable: never = phase;
        return unreachable;
      }
    }
  };

  const paint = (customerId: string) => {
    const cell = cells.get(customerId);
    if (cell !== undefined) {
      host.release(cellControls.get(customerId) ?? []);
      cellControls.set(customerId, []);
      dom.fill(cell, ...cellContent(customerId));
    }
  };

  const setPhase = (next: Phase | null) => {
    const before = phase?.customerId;
    phase = next;
    if (before !== undefined) {
      paint(before);
    }
    if (next !== null && next.customerId !== before) {
      paint(next.customerId);
    }
  };

  const clear = () => {
    epoch += 1;
    stopTimer();
    watch(false);
    phase = null;
    for (const cell of cells.values()) {
      dom.fill(cell);
    }
    for (const list of cellControls.values()) {
      host.release(list);
    }
    cellControls.clear();
    cells.clear();
    customers.clear();
    resetReview();
  };

  /** Drops a value that is on the screen and says so; the row stays masked, with the way to ask again. */
  function hideValue(message: string) {
    if (phase === null || phase.kind !== "shown") {
      return;
    }
    epoch += 1;
    stopTimer();
    watch(false);
    setPhase({ customerId: phase.customerId, kind: "gone" });
    notice.status(message);
  }

  const show = (
    customerId: string,
    field: RevealableField,
    value: string | null
  ) => {
    const end = host.expiresAt();
    const left =
      end === null ? 0 : new Date(end).getTime() - host.now().getTime();
    setPhase({ customerId, field, kind: "shown", value });
    watch(true);
    stopTimer();
    timer = setTimeout(
      () => {
        timer = undefined;
        hideValue(REVEAL_GONE);
        host.stillActive();
      },
      Math.max(Math.min(REVEAL_SECONDS * 1000, left), 0)
    );
  };

  const fail = async (failure: ApiFailure) => {
    if (
      failure.problem === "forbidden" &&
      failure.code === "tenant_access_denied"
    ) {
      await host.accessEnded(NO_ACCESS_NOW);
      return;
    }
    setPhase(null);
    notice.alert(failureText(failure));
  };

  const send = async (customerId: string, field: RevealableField) => {
    if (host.isBusy() || !host.stillActive()) {
      return;
    }
    stopTimer();
    epoch += 1;
    const mine = epoch;
    setPhase({ customerId, field, kind: "review" });
    host.setBusy(true);
    notice.status(`Revelando ${FIELD_TEXT[field].article} do cliente…`);
    const answer = await revealField(host.api, host.caseId, customerId, field);
    if (mine !== epoch) {
      return;
    }
    host.setBusy(false);
    resetReview();
    if (!answer.ok) {
      await fail(answer);
      return;
    }
    if (!host.stillActive()) {
      return;
    }
    if (dom.document.hidden) {
      setPhase({ customerId, kind: "gone" });
      notice.status(REVEAL_GONE);
      return;
    }
    show(customerId, field, answer.data.value);
    notice.success(
      `${FIELD_TEXT[field].label}: valor revelado na linha do cliente. ${REVEALED_MARK}.`
    );
  };

  function openReview(customerId: string, field: RevealableField) {
    if (!host.stillActive()) {
      return;
    }
    notice.clear();
    resetReview();
    setPhase({ customerId, field, kind: "review" });
    const heading = dom.el(
      "h4",
      { id: "revelar-revisao", tabindex: "-1" },
      `Revise antes de revelar ${FIELD_TEXT[field].article}`
    );
    const confirm = host.control(confirmText(field), false, () => {
      send(customerId, field);
    });
    const back = host.control("Voltar", true, () => {
      setPhase({ customerId, kind: "menu" });
      resetReview();
      cells.get(customerId)?.querySelector("button")?.focus();
    });
    reviewControls = [confirm, back];
    dom.fill(
      reviewBox,
      heading,
      host.review(
        [
          ["Cliente", dom.el("bdi", {}, nameOf(customerId))],
          ["Campo", FIELD_TEXT[field].label],
        ],
        `${FIELD_TEXT[field].article[0]?.toUpperCase()}${FIELD_TEXT[field].article.slice(1)} deste cliente aparece na tela, só nesta linha, por até ${REVEAL_SECONDS} segundos. Some antes se o acesso acabar, se você sair da página ou esconder a aba, ou se revelar outro dado.`,
        REVEAL_UNDO,
        `${REVEAL_AUDIT}, com o seu e-mail e o caso.`
      ),
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  }

  function toggleMenu(customerId: string) {
    if (!host.stillActive()) {
      return;
    }
    resetReview();
    notice.clear();
    const open = phase?.kind === "menu" && phase.customerId === customerId;
    setPhase(open ? null : { customerId, kind: "menu" });
    cells.get(customerId)?.querySelector("button")?.focus();
  }

  return {
    cell: (customer) => {
      const cell = dom.el("div", { class: "reveal-cell" });
      cells.set(customer.id, cell);
      customers.set(customer.id, customer);
      paint(customer.id);
      return cell;
    },
    clear,
    element: reviewBox,
  };
}
