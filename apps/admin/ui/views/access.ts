import {
  type ApiFailure,
  endAccess,
  giveAccess,
  PROBLEM_TEXT,
  readCustomers,
} from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts, table } from "../blocks";
import { labelName, storeName } from "../dom";
import { brasiliaMomentText } from "../format";
import { createNotice } from "../notice";
import { limitText, writeMayHaveHappened } from "../refusal";
import type { MaskedCustomer, SupportCaseDetail } from "../types";
import type { StoreActionsCase } from "./store-actions";

export const ACCESS_TEXT =
  "Você passa a ver os clientes desta loja, com nome, e-mail e telefone mascarados. Somente leitura, só neste caso. Acaba no prazo, ao revogar ou ao fechar o caso. Não se prorroga.";
export const ACCESS_UNDO =
  'Sim: "Encerrar acesso agora", ou acaba sozinho no prazo. Não se prorroga.';
const ACCESS_AUDIT =
  "O acesso dado fica na auditoria com o seu e-mail e o caso.";
const END_EFFECT =
  "O efeito é imediato: a lista de clientes sai da tela e nenhuma página nova é lida com este acesso.";
export const END_ACCESS_UNDO =
  "Sim, com outro acesso: é uma nova decisão, registrada.";
const END_AUDIT = "O encerramento fica na auditoria com o seu e-mail e o caso.";
export const READ_AUDIT =
  "Cada página de clientes que você lê fica na auditoria, com o seu e-mail e o caso (só a quantidade de clientes, nunca os dados).";
const HIDDEN_PAGE = "Recarregue o caso para continuar.";
export const NO_ACCESS = "O acesso acabou ou não foi dado.";
const CASE_CLOSED = "O caso está fechado: o acesso acabou com ele.";
export const NO_CUSTOMERS = "Esta loja não tem clientes.";
export const NOTHING_ENDED = "Nada foi encerrado: o acesso já tinha acabado.";
export const ACCESS_UNKNOWN =
  "Não deu para confirmar se o acesso foi dado. Releia o caso antes de tentar de novo.";
export const END_UNKNOWN =
  "Não deu para confirmar se o acesso foi encerrado. Releia o caso antes de tentar de novo.";
const RELOAD_FAILED =
  "A ação foi enviada, mas não deu para reler o caso. Releia o caso antes de continuar.";

/** The durations the page offers: a subset of the server's 5 to 240 minutes, which decides what it accepts. */
export const ACCESS_MINUTES: readonly number[] = [5, 15, 30, 60, 120, 240];
const DEFAULT_MINUTES = 60;

const CASE_GONE = "Este caso não foi encontrado. Nada foi dado.";
const REFUSED_ACCESS: Readonly<Record<string, string>> = {
  case_not_open: "O caso já está fechado. Nada foi dado.",
  invalid_duration:
    "A duração não foi aceita: use de 5 a 240 minutos. Nada foi dado.",
  unknown_case: CASE_GONE,
};

export interface AccessMessage {
  kind: "alert" | "success";
  text: string;
}

export interface AccessView {
  /** Throws away what was read (the case is shown again, or the page leaves): nothing of a customer stays in memory. */
  discard: () => void;
  element: HTMLElement;
  /** Says how the action before ended, once the case is shown again. */
  say: (message: AccessMessage) => void;
}

export interface AccessCase extends StoreActionsCase {
  status: string;
}

interface Hooks {
  /** Reads the whole case again and shows it; false when it could not be shown. */
  reload: (message: AccessMessage) => Promise<boolean>;
}

interface ActiveAccess {
  expiresAt: string;
  id: string;
}

/** The access of this operator the server says is in force (its clock), the latest to end when there are several. */
function ownAccess(
  grants: SupportCaseDetail["grants"],
  principalId: string
): ActiveAccess | null {
  let found: ActiveAccess | null = null;
  for (const grant of grants) {
    if (
      grant.principalId === principalId &&
      grant.active &&
      grant.revokedAt === null &&
      (found === null ||
        new Date(grant.expiresAt).getTime() >
          new Date(found.expiresAt).getTime())
    ) {
      found = { expiresAt: grant.expiresAt, id: grant.id };
    }
  }
  return found;
}

function failureText(failure: ApiFailure, notFound: string): string {
  switch (failure.problem) {
    case "forbidden":
      return PROBLEM_TEXT.forbidden;
    case "not_found":
      return notFound;
    case "rate_limited":
      return limitText(failure);
    case "session":
      return PROBLEM_TEXT.session;
    case "conflict":
      return PROBLEM_TEXT.conflict;
    case "network":
    case "unavailable":
      return PROBLEM_TEXT[failure.problem];
    default:
      return PROBLEM_TEXT.failed;
  }
}

/**
 * Acesso aos clientes (corte admin-v2, Parte 5; AC-P5.1 to AC-P5.5): on the screen of a support case, give the
 * operator an access to the store's customers, read them masked as the server masks them, and end the access. The
 * access in force is the one the case's own read says is the operator's (by the database's clock); the end shown is
 * the one the server answered. Reading is a click, a page of at most 50 at a time, and the pages stay only in this
 * page's memory: they leave the DOM when the access ends, is refused, is found past its end or the page is hidden. With
 * no timer (the script has none), "past its end" is checked, against the end the server gave, at every
 * interaction with the section; the server refuses the read of an access that ended whatever the page shows.
 * Revealing a field is not here.
 */
export function accessView(
  tools: ScreenTools,
  item: AccessCase,
  grants: SupportCaseDetail["grants"],
  hooks: Hooks
): AccessView | null {
  const { api, can, context, dom, now, who } = tools;
  const canGrant = can("tenant_access:grant");
  const canRead = can("tenant_data:read");
  if (!(canGrant || canRead)) {
    return null;
  }
  const open = item.status === "open";
  const notice = createNotice(dom);
  const stateBox = dom.el("div", { class: "access-state" });
  const actionBox = dom.el("div", { class: "access-action" });
  const listBox = dom.el("div", { class: "customers" });
  const controls: HTMLElement[] = [];
  let access = open ? ownAccess(grants, who.principal.id) : null;
  let customers: MaskedCustomer[] = [];
  let next: string | null = null;
  let listed = false;
  let busy = false;
  let writing = false;
  let turn = 0;
  let minutes = DEFAULT_MINUTES;

  const setBusy = (on: boolean) => {
    busy = on;
    for (const control of controls) {
      control.setAttribute("aria-disabled", String(on));
    }
  };

  const control = (text: string, secondary: boolean, onClick: () => void) => {
    const element = dom.el(
      "button",
      secondary ? { class: "secondary", type: "button" } : { type: "button" },
      text
    );
    element.addEventListener("click", () => {
      if (!busy) {
        onClick();
      }
    });
    controls.push(element);
    return element;
  };

  const dropList = () => {
    customers = [];
    next = null;
    listed = false;
    dom.fill(listBox);
  };

  const renderList = () => {
    if (!listed) {
      dom.fill(listBox);
      return;
    }
    if (customers.length === 0) {
      dom.fill(listBox, dom.el("p", {}, NO_CUSTOMERS));
      return;
    }
    const rows = customers.map((customer) => [
      dom.el("bdi", {}, customer.name),
      customer.email === null
        ? "sem e-mail"
        : dom.el("bdi", {}, customer.email),
      customer.phone === null
        ? "sem telefone"
        : dom.el("bdi", {}, customer.phone),
      customer.hasNotes ? "tem observações" : "sem observações",
      customer.archived ? "arquivado" : "ativo",
    ]);
    const count = `${customers.length} ${customers.length === 1 ? "cliente lido" : "clientes lidos"}.`;
    dom.fill(
      listBox,
      table(
        dom,
        "Clientes da loja, mascarados",
        ["Nome", "E-mail", "Telefone", "Observações", "Situação"],
        rows
      ),
      dom.el("p", { class: "hint" }, count),
      next === null
        ? dom.el("p", { class: "hint" }, "Fim da lista.")
        : control("Carregar mais", true, () => {
            readPage(true);
          })
    );
  };

  const renderState = () => {
    if (!open) {
      dom.fill(
        stateBox,
        dom.el("p", {}, NO_ACCESS),
        dom.el("p", { class: "hint" }, CASE_CLOSED)
      );
      return;
    }
    if (access === null) {
      dom.fill(
        stateBox,
        dom.el("p", {}, NO_ACCESS),
        canGrant ? dom.el("p", {}, ACCESS_TEXT) : null,
        canGrant
          ? control("Dar acesso aos clientes", false, () => {
              notice.clear();
              openForm();
            })
          : null
      );
      return;
    }
    dom.fill(
      stateBox,
      dom.el(
        "p",
        {},
        `Acesso ativo até ${brasiliaMomentText(access.expiresAt)}. Somente leitura, só clientes; não se prorroga.`
      ),
      canRead ? dom.el("p", {}, READ_AUDIT) : null,
      dom.el(
        "div",
        { class: "button-row" },
        canRead
          ? control(
              listed ? "Atualizar a lista" : "Ver clientes",
              false,
              () => {
                readPage(false);
              }
            )
          : null,
        canGrant
          ? control("Encerrar acesso agora", true, () => {
              notice.clear();
              reviewEnd();
            })
          : null
      )
    );
  };

  const leave = () => {
    turn += 1;
    access = null;
    if (!writing) {
      setBusy(false);
    }
    dropList();
    dom.fill(actionBox);
    renderState();
  };

  /** False, with the list off the screen, when the end the server gave has passed. */
  const stillActive = (): boolean => {
    if (access === null) {
      return false;
    }
    if (now().getTime() < new Date(access.expiresAt).getTime()) {
      return true;
    }
    leave();
    notice.status("O acesso acabou.");
    return false;
  };

  const reloadWith = async (message: AccessMessage) => {
    if (await hooks.reload(message)) {
      return;
    }
    writing = false;
    leave();
    dom.fill(
      stateBox,
      control("Reler o caso", true, () => {
        reloadWith({ kind: "alert", text: RELOAD_FAILED });
      })
    );
    notice.alert(RELOAD_FAILED);
  };

  const readFailed = async (failure: ApiFailure) => {
    if (
      failure.problem === "forbidden" &&
      failure.code === "tenant_access_denied"
    ) {
      leave();
      await reloadWith({ kind: "alert", text: NO_ACCESS });
      return;
    }
    if (failure.problem === "forbidden" || failure.problem === "session") {
      dropList();
      renderState();
    }
    notice.alert(failureText(failure, "Este caso não foi encontrado."));
  };

  async function readPage(more: boolean) {
    if (busy || !stillActive()) {
      return;
    }
    const cursor = more ? next : null;
    if (more && cursor === null) {
      return;
    }
    turn += 1;
    const mine = turn;
    setBusy(true);
    notice.status(more ? "Lendo mais clientes…" : "Lendo os clientes…");
    const answer = await readCustomers(api, item.id, cursor);
    if (mine !== turn) {
      return;
    }
    setBusy(false);
    if (!answer.ok) {
      await readFailed(answer);
      return;
    }
    const page = answer.data;
    customers = more ? [...customers, ...page.customers] : page.customers;
    ({ next } = page);
    listed = true;
    renderState();
    renderList();
    notice.success(
      more ? "Mais clientes lidos." : "Clientes lidos. Estão mascarados."
    );
  }

  const reviewFacts = (
    lines: readonly [string, Node | string][],
    effect: string,
    undo: string,
    audit: string
  ) =>
    facts(dom, [
      ["Ambiente", environmentText(context)],
      ["Loja", storeName(dom, item.organizationName, item.organizationId)],
      [
        "Caso",
        `Aberto em ${brasiliaMomentText(item.openedAt)}: ${labelName(item.reason, 120)}`,
      ],
      ...lines,
      ["O que acontece", effect],
      ["Dá para desfazer", undo],
      ["Fica na auditoria", audit],
    ]);

  const sendGrant = async () => {
    writing = true;
    setBusy(true);
    notice.status("Dando o acesso…");
    const answer = await giveAccess(api, item.id, minutes);
    if (answer.ok) {
      await reloadWith({
        kind: "success",
        text: `Acesso dado. Acaba em ${brasiliaMomentText(answer.data.expiresAt)}. Use Ver clientes para ler a lista.`,
      });
      return;
    }
    writing = false;
    setBusy(false);
    if (writeMayHaveHappened(answer)) {
      notice.alert(ACCESS_UNKNOWN);
      dom.fill(
        actionBox,
        control("Reler o caso", true, () => {
          reloadWith({ kind: "alert", text: ACCESS_UNKNOWN });
        })
      );
      return;
    }
    const text =
      answer.problem === "invalid"
        ? (REFUSED_ACCESS[answer.code ?? ""] ??
          "O pedido não foi aceito. Nada foi dado.")
        : failureText(answer, CASE_GONE);
    if (answer.code === "case_not_open") {
      await reloadWith({ kind: "alert", text });
      return;
    }
    notice.alert(text);
  };

  function reviewGrant() {
    const heading = dom.el(
      "h4",
      { id: "acesso-revisao", tabindex: "-1" },
      "Revise antes de dar o acesso"
    );
    const confirm = control("Confirmar acesso", false, () => {
      sendGrant();
    });
    const back = control("Voltar", true, () => {
      openForm();
    });
    dom.fill(
      actionBox,
      heading,
      reviewFacts(
        [["Duração", `${minutes} minutos`]],
        `Você passa a ver os clientes desta loja, com nome, e-mail e telefone mascarados, por ${minutes} minutos. Somente leitura, só neste caso. Não mostra vendas nem produtos.`,
        ACCESS_UNDO,
        ACCESS_AUDIT
      ),
      dom.el(
        "p",
        { class: "hint" },
        "O prazo conta da confirmação; a hora em que o acesso acaba é a que o Admin devolve depois."
      ),
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  }

  function openForm() {
    const select = dom.el(
      "select",
      { id: "acesso-minutos", name: "minutos" },
      ...ACCESS_MINUTES.map((value) =>
        dom.el("option", { value: String(value) }, `${value} minutos`)
      )
    );
    select.value = String(minutes);
    const review = dom.el("button", { type: "submit" }, "Revisar o acesso");
    const cancel = control("Cancelar", true, () => {
      dom.fill(actionBox);
      stateBox.querySelector("button")?.focus();
    });
    const form = dom.el(
      "form",
      { class: "search", novalidate: "" },
      dom.el("label", { for: "acesso-minutos" }, "Duração do acesso"),
      select,
      dom.el("div", { class: "button-row" }, review, cancel)
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const chosen = Number(select.value);
      if (busy || !ACCESS_MINUTES.includes(chosen)) {
        return;
      }
      minutes = chosen;
      reviewGrant();
    });
    dom.fill(
      actionBox,
      dom.el("h4", { id: "acesso-formulario" }, "Dar acesso aos clientes"),
      form
    );
    select.focus();
  }

  const sendEnd = async (grantId: string) => {
    writing = true;
    setBusy(true);
    notice.status("Encerrando o acesso…");
    const answer = await endAccess(api, grantId);
    if (answer.ok) {
      dropList();
      await reloadWith(
        answer.data.revoked
          ? {
              kind: "success",
              text: "Acesso encerrado. A lista de clientes saiu da tela.",
            }
          : { kind: "alert", text: NOTHING_ENDED }
      );
      return;
    }
    writing = false;
    setBusy(false);
    if (writeMayHaveHappened(answer)) {
      notice.alert(END_UNKNOWN);
      dom.fill(
        actionBox,
        control("Reler o caso", true, () => {
          reloadWith({ kind: "alert", text: END_UNKNOWN });
        })
      );
      return;
    }
    if (answer.problem === "not_found") {
      dropList();
      await reloadWith({ kind: "alert", text: NOTHING_ENDED });
      return;
    }
    notice.alert(failureText(answer, NOTHING_ENDED));
  };

  function reviewEnd() {
    if (!stillActive() || access === null) {
      return;
    }
    const grantId = access.id;
    const heading = dom.el(
      "h4",
      { id: "acesso-encerrar", tabindex: "-1" },
      "Revise antes de encerrar o acesso"
    );
    const confirm = control("Confirmar encerramento do acesso", false, () => {
      sendEnd(grantId);
    });
    const back = control("Voltar", true, () => {
      dom.fill(actionBox);
      stateBox.querySelector("button")?.focus();
    });
    dom.fill(
      actionBox,
      heading,
      reviewFacts(
        [
          [
            "Acesso",
            `Ativo até ${brasiliaMomentText(access.expiresAt)}, somente leitura`,
          ],
        ],
        END_EFFECT,
        END_ACCESS_UNDO,
        END_AUDIT
      ),
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  }

  renderState();
  const section = dom.el(
    "section",
    { "aria-labelledby": "acesso-titulo", class: "action-panel" },
    dom.el("h3", { id: "acesso-titulo" }, "Acesso aos clientes"),
    notice.element,
    stateBox,
    actionBox,
    listBox
  );
  for (const type of ["focusin", "pointerdown", "keydown"]) {
    section.addEventListener(type, () => {
      stillActive();
    });
  }
  const discard = () => {
    turn += 1;
    access = null;
    writing = false;
    setBusy(false);
    dropList();
    dom.fill(actionBox);
    dom.document.defaultView?.removeEventListener("pagehide", onHide);
  };
  const onHide = () => {
    discard();
    dom.fill(stateBox, dom.el("p", {}, HIDDEN_PAGE));
  };
  dom.document.defaultView?.addEventListener("pagehide", onHide);
  return {
    discard,
    element: section,
    say: (message) => {
      if (message.kind === "success") {
        notice.success(message.text);
      } else {
        notice.alert(message.text);
      }
    },
  };
}
