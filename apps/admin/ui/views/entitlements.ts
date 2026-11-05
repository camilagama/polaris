import { type ApiFailure, PROBLEM_TEXT } from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts, table } from "../blocks";
import { labelName, storeName } from "../dom";
import {
  brasiliaMomentText,
  brasiliaTime,
  entitlementText,
  grantValueText,
} from "../format";
import { MAX_REASON_LENGTH } from "../grant-limits";
import { createNotice } from "../notice";
import { limitText, writeMayHaveHappened } from "../refusal";
import type {
  EndedEntitlement,
  GrantedEntitlement,
  OrganizationDiagnostics,
} from "../types";
import {
  fingerprintOf,
  GRANT_EXPIRES,
  GRANT_RAISES,
  type GrantFields,
  grantForm,
} from "./grant-form";
import type { StoreActionsCase } from "./store-actions";

const HOUR_MS = 3_600_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GRANT_UNDO =
  "Sim: Encerrar concessão. Uma nova concessão é outra decisão registrada.";
const GRANT_AUDIT =
  "A concessão fica na auditoria com o seu e-mail e o caso. O motivo digitado fica com ela.";
export const END_EFFECT =
  "Encerrar a concessão devolve a loja ao que o plano dá. Não poderá ser desfeito; uma nova concessão é outra decisão registrada.";
export const END_UNDO =
  "Não: isso não poderá ser desfeito. Uma nova concessão é outra decisão registrada.";
const END_AUDIT = "O encerramento fica na auditoria com o seu e-mail e o caso.";
export const NOTHING_ENDED = "Nada foi encerrado.";
export const OUTCOME_NOT_RECORDED =
  "A ação foi feita, mas o registro do resultado na auditoria não foi confirmado. O pedido ficou registrado. Não repita a ação; avise a engenharia.";
export const NO_GRANTS = "Nenhuma concessão em vigor.";
export const GRANT_RETRY =
  "Outra ação ao mesmo tempo mexeu nesta concessão. Tente de novo.";
export const GRANT_UNKNOWN =
  "Não deu para confirmar se a concessão foi dada. Releia as concessões em vigor antes de tentar de novo; repetir o mesmo pedido pelo formulário, sem mudar nada, não cria uma segunda concessão.";
export const END_UNKNOWN =
  "Não deu para confirmar se a concessão foi encerrada. Releia as concessões em vigor antes de tentar de novo.";
export const GRANT_REPEATED =
  "Este pedido já tinha sido feito: a concessão é a mesma e nada novo foi dado.";
const GRANT_CASE_GONE = "Este caso não foi encontrado. Nada foi dado.";
const GRANT_NOT_ACCEPTED =
  "O caso não está aberto ou não é desta loja, ou o pedido não foi aceito. Nada foi mudado. Recarregue o caso.";

const REFUSED_GRANT: Readonly<Record<string, string>> = {
  grant_too_long: "O prazo passa do máximo de 366 dias. Nada foi dado.",
  invalid_key:
    "Esse recurso ou limite não está no catálogo. Escolha da lista. Nada foi dado.",
  invalid_period:
    "O prazo não foi aceito: use horas inteiras, até 366 dias. Nada foi dado.",
  invalid_reason: `O motivo não foi aceito: use de 1 a ${MAX_REASON_LENGTH} caracteres, sem caracteres de controle. Nada foi dado.`,
  invalid_value:
    "O valor não foi aceito para este recurso ou limite. Nada foi dado.",
};

interface ListedGrant {
  expiresAt: string;
  flagValue: boolean | null;
  /** Null when the diagnostics gave none (an older Worker): the grant is listed and cannot be ended here. */
  id: string | null;
  key: string;
  limitValue: number | null;
}

interface Draft {
  commandId: string;
  sentFingerprint: string | null;
}

interface Buttons {
  back: HTMLElement;
  confirm: HTMLElement;
}

function valueText(fields: GrantFields): string {
  if (typeof fields.value === "boolean") {
    return fields.value ? "ligado" : "desligado";
  }
  return String(fields.value);
}

/** The grants in force: not revoked and not past their end. The server decides again at each command. */
function listedGrants(report: OrganizationDiagnostics, now: Date) {
  const listed: ListedGrant[] = [];
  for (const grant of report.grants) {
    if (
      grant.revokedAt === null &&
      new Date(grant.expiresAt).getTime() > now.getTime()
    ) {
      listed.push({
        expiresAt: grant.expiresAt,
        flagValue: grant.flagValue,
        id:
          typeof grant.id === "string" && UUID.test(grant.id) ? grant.id : null,
        key: grant.key,
        limitValue: grant.limitValue,
      });
    }
  }
  return listed;
}

function refusalText(failure: ApiFailure, notFound: string): string {
  switch (failure.problem) {
    case "forbidden":
      return PROBLEM_TEXT.forbidden;
    case "not_found":
      return notFound;
    case "rate_limited":
      return limitText(failure);
    case "session":
      return PROBLEM_TEXT.session;
    case "invalid":
      return REFUSED_GRANT[failure.code ?? ""] ?? GRANT_NOT_ACCEPTED;
    case "conflict":
      return GRANT_RETRY;
    default:
      return PROBLEM_TEXT.failed;
  }
}

function isGranted(data: unknown): data is GrantedEntitlement {
  return (
    typeof data === "object" &&
    data !== null &&
    "created" in data &&
    typeof data.created === "boolean" &&
    "id" in data &&
    typeof data.id === "string" &&
    "outcomeRecorded" in data &&
    typeof data.outcomeRecorded === "boolean"
  );
}

function isEnded(data: unknown): data is EndedEntitlement {
  return (
    typeof data === "object" &&
    data !== null &&
    "revoked" in data &&
    typeof data.revoked === "boolean" &&
    "outcomeRecorded" in data &&
    typeof data.outcomeRecorded === "boolean"
  );
}

/**
 * Plano e cobrança (corte admin-v2, Parte 4; AC-P4.1 to AC-P4.4, AC-P4.6): on the screen of an open support case,
 * give the case's store a temporary entitlement and end one. Both are reviewed in two steps and send one request per
 * click. The form's `commandId` is made when it opens and kept for a repeat of the same content, so a slow network or
 * a double click is one grant. The grants in force are read when asked and once after each answer, from the
 * diagnostics (not audited); ending goes by the ID the diagnostics give, and with none there is no way to end. The
 * page checks the form's shape and length only: what a grant may be is the server's to say, and its refusal is said
 * in words.
 */
export function entitlementsView(
  tools: ScreenTools,
  item: StoreActionsCase
): HTMLElement {
  const { api, context, dom, now } = tools;
  const notice = createNotice(dom);
  const listNotice = createNotice(dom);
  const listBox = dom.el("div", { class: "grants" });
  const actionBox = dom.el("div", { class: "grant-action" });
  const grantsPath = `/api/support-cases/${encodeURIComponent(item.id)}/entitlement-grants`;
  let grants: ListedGrant[] | null = null;
  let reading = 0;
  let sending = false;
  let draft: Draft | null = null;

  const reviewFacts = (
    lines: readonly [string, Node | string][],
    effect: Node | string,
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

  const readControl = button("Ver concessões em vigor", true, () => {
    readGrants();
  });

  const lockButtons = (buttons: Buttons, locked: boolean) => {
    buttons.confirm.setAttribute("aria-disabled", String(locked));
    buttons.back.setAttribute("aria-disabled", String(locked));
  };

  const renderList = () => {
    if (grants === null) {
      dom.fill(listBox);
      return;
    }
    if (grants.length === 0) {
      dom.fill(listBox, dom.el("p", {}, NO_GRANTS));
      return;
    }
    const rows = grants.map((grant) => {
      const { id } = grant;
      const end =
        id === null
          ? "Sem como encerrar por aqui"
          : button("Encerrar concessão", true, () => {
              notice.clear();
              reviewEnd(grant, id);
            });
      if (typeof end !== "string") {
        end.setAttribute(
          "aria-label",
          `Encerrar concessão de ${entitlementText(grant.key)}`
        );
      }
      return [
        entitlementText(grant.key),
        grantValueText(grant.limitValue, grant.flagValue),
        brasiliaMomentText(grant.expiresAt),
        end,
      ];
    });
    dom.fill(
      listBox,
      table(
        dom,
        "Concessões em vigor",
        ["Recurso ou limite", "Valor", "Acaba em", "Ação"],
        rows
      )
    );
  };

  const readGrants = async (): Promise<void> => {
    reading += 1;
    const mine = reading;
    listNotice.status("Lendo as concessões em vigor…");
    const answer = await api.get<OrganizationDiagnostics>(
      `/api/organizations/${encodeURIComponent(item.organizationId)}/diagnostics`
    );
    if (mine !== reading) {
      return;
    }
    const read = answer.ok ? answer.data : undefined;
    if (
      !answer.ok ||
      read?.organization?.id !== item.organizationId ||
      !Array.isArray(read.grants)
    ) {
      grants = null;
      renderList();
      listNotice.alert(
        answer.ok
          ? PROBLEM_TEXT.failed
          : PROBLEM_TEXT[
              answer.problem === "invalid" ? "failed" : answer.problem
            ]
      );
      return;
    }
    grants = listedGrants(read, now());
    readControl.textContent = "Atualizar concessões";
    renderList();
    listNotice.status(`Concessões lidas às ${brasiliaTime(now())}.`);
  };

  const afterWrite = async (said: string, outcomeRecorded: boolean) => {
    start();
    if (outcomeRecorded) {
      notice.success(said);
    } else {
      notice.alert(OUTCOME_NOT_RECORDED);
    }
    if (tools.can("organization:diagnose")) {
      await readGrants();
    }
  };

  const sendEnd = async (grantId: string, buttons: Buttons) => {
    sending = true;
    lockButtons(buttons, true);
    notice.status("Encerrando a concessão…");
    const answer = await api.delete<unknown>(
      `${grantsPath}/${encodeURIComponent(grantId)}`
    );
    sending = false;
    if (answer.ok && isEnded(answer.data)) {
      if (answer.data.revoked) {
        await afterWrite(
          `Concessão encerrada às ${brasiliaTime(now())}.`,
          answer.data.outcomeRecorded
        );
        return;
      }
    } else if (answer.ok || writeMayHaveHappened(answer)) {
      lockButtons(buttons, false);
      notice.alert(END_UNKNOWN);
      dom.fill(
        actionBox,
        button("Reler as concessões", true, () => {
          start();
          readGrants();
        })
      );
      return;
    } else if (answer.problem !== "not_found") {
      lockButtons(buttons, false);
      notice.alert(refusalText(answer, NOTHING_ENDED));
      return;
    }
    start();
    notice.alert(NOTHING_ENDED);
    await readGrants();
  };

  function reviewEnd(grant: ListedGrant, grantId: string) {
    const heading = dom.el(
      "h4",
      { id: "concessao-revisao", tabindex: "-1" },
      "Revise antes de encerrar"
    );
    const confirm = dom.el(
      "button",
      { type: "button" },
      "Confirmar encerramento da concessão"
    );
    const back = button("Voltar", true, () => {
      start();
      actionBox.querySelector("button")?.focus();
    });
    confirm.addEventListener("click", () => {
      if (!sending) {
        sendEnd(grantId, { back, confirm });
      }
    });
    dom.fill(
      actionBox,
      heading,
      reviewFacts(
        [
          [
            "Concessão",
            `${entitlementText(grant.key)} = ${grantValueText(grant.limitValue, grant.flagValue)}, até ${brasiliaMomentText(grant.expiresAt)}`,
          ],
        ],
        `A loja volta ao que o plano dá para ${entitlementText(grant.key)}. ${END_EFFECT}`,
        END_UNDO,
        END_AUDIT
      ),
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  }

  const sendGrant = async (
    current: Draft,
    fields: GrantFields,
    buttons: Buttons
  ) => {
    current.sentFingerprint = fingerprintOf(fields);
    sending = true;
    lockButtons(buttons, true);
    notice.status("Dando a concessão…");
    const answer = await api.post<unknown>(grantsPath, {
      commandId: current.commandId,
      hours: fields.hours,
      key: fields.key,
      reason: fields.reason,
      value: fields.value,
    });
    sending = false;
    if (answer.ok && isGranted(answer.data)) {
      draft = null;
      await afterWrite(
        answer.data.created
          ? `Concessão dada às ${brasiliaTime(now())}. A data em que acaba é a da lista.`
          : GRANT_REPEATED,
        answer.data.outcomeRecorded
      );
      return;
    }
    lockButtons(buttons, false);
    if (answer.ok || writeMayHaveHappened(answer)) {
      notice.alert(GRANT_UNKNOWN);
      dom.fill(
        actionBox,
        dom.el(
          "div",
          { class: "button-row" },
          button("Reler as concessões", true, () => {
            readGrants();
          }),
          button("Voltar ao formulário", true, () => {
            openForm(fields);
          })
        )
      );
    } else if (answer.problem === "invalid") {
      notice.clear();
      openForm(fields, refusalText(answer, GRANT_CASE_GONE));
    } else {
      notice.alert(refusalText(answer, GRANT_CASE_GONE));
    }
  };

  function reviewGrant(current: Draft, fields: GrantFields) {
    const heading = dom.el(
      "h4",
      { id: "concessao-revisao", tabindex: "-1" },
      "Revise antes de dar a concessão"
    );
    const confirm = dom.el("button", { type: "button" }, "Confirmar concessão");
    const back = button("Voltar", true, () => openForm(fields));
    confirm.addEventListener("click", () => {
      if (!sending) {
        sendGrant(current, fields, { back, confirm });
      }
    });
    const estimate = brasiliaMomentText(
      new Date(now().getTime() + fields.hours * HOUR_MS).toISOString()
    );
    dom.fill(
      actionBox,
      heading,
      reviewFacts(
        [["Motivo", dom.el("bdi", {}, fields.reason)]],
        `A loja passa a ter ${entitlementText(fields.key)} = ${valueText(fields)} até ${estimate}, sem mudar a cobrança. ${GRANT_RAISES}`,
        GRANT_UNDO,
        GRANT_AUDIT
      ),
      dom.el(
        "p",
        { class: "hint" },
        `${GRANT_EXPIRES} A data acima é uma estimativa pelo relógio deste navegador: o prazo conta a partir da confirmação e a data certa é a do servidor, mostrada na lista logo depois.`
      ),
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  }

  function openForm(prefill: GrantFields | null = null, refusal = "") {
    const current = draft ?? {
      commandId: crypto.randomUUID(),
      sentFingerprint: null,
    };
    draft = current;
    const form = grantForm(dom, context, {
      onCancel: () => {
        draft = null;
        start();
        actionBox.querySelector("button")?.focus();
      },
      onReview: (fields) => {
        // the same ID only for the same content: another one under it would be refused as a different grant
        if (
          current.sentFingerprint !== null &&
          current.sentFingerprint !== fingerprintOf(fields)
        ) {
          current.commandId = crypto.randomUUID();
          current.sentFingerprint = null;
        }
        reviewGrant(current, fields);
      },
      prefill,
      refusal,
    });
    dom.fill(actionBox, form.element);
    form.focus();
  }

  function start() {
    dom.fill(
      actionBox,
      dom.el("p", {}, GRANT_RAISES),
      dom.el("p", {}, GRANT_EXPIRES),
      button("Dar uma concessão", false, () => {
        notice.clear();
        draft = null;
        openForm();
      })
    );
  }

  start();
  return dom.el(
    "section",
    { "aria-labelledby": "plano-titulo", class: "action-panel" },
    dom.el("h3", { id: "plano-titulo" }, "Plano e cobrança"),
    notice.element,
    dom.el("h4", {}, "Concessões em vigor"),
    tools.can("organization:diagnose")
      ? dom.el("div", {}, listNotice.element, listBox, readControl)
      : dom.el(
          "p",
          { class: "hint" },
          "Para ver e encerrar concessões é preciso poder ver a situação da loja."
        ),
    actionBox
  );
}
