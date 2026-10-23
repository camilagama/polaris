import type {
  CustomerReadModel,
  SaleCustomerLinkReadModel,
} from "@polaris/contracts";
import {
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import {
  type ChoiceOption,
  type Loadable,
  loadErrorMessage,
} from "./sale-form-model";

export type LinkAction = SaleCustomerLinkReadModel["history"][number]["action"];

export interface SaleCustomerLinkChange {
  changed: boolean;
  link: SaleCustomerLinkReadModel;
}

export const VALUES_UNCHANGED_NOTE =
  "Associar um cliente não altera os valores da venda: itens, preços, ajustes, pagamento e estoque continuam como foram confirmados.";

const actionButtonLabels: Readonly<Record<LinkAction, string>> = {
  assign: "Associar cliente",
  reassign: "Trocar cliente",
  unassign: "Remover cliente",
};

const historyActionLabels: Readonly<Record<LinkAction, string>> = {
  assign: "Cliente associado",
  reassign: "Cliente trocado",
  unassign: "Cliente removido",
};

const successMessages: Readonly<Record<LinkAction, string>> = {
  assign: "Cliente associado à venda.",
  reassign: "Cliente trocado.",
  unassign: "Cliente removido da venda.",
};

export const INVALID_SALE_ID_MESSAGE =
  "Informe um identificador de venda válido (um UUID, como 123e4567-e89b-42d3-a456-426614174000).";

/* -------------------------------------------------------------------------- */
/* Sale identifier (standalone page)                                          */
/* -------------------------------------------------------------------------- */

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns the lowercase sale ID, or null when the text is not a UUID. */
export function parseSaleId(text: string | null): string | null {
  const trimmed = (text ?? "").trim();
  return uuidPattern.test(trimmed) ? trimmed.toLowerCase() : null;
}

export type SaleIdParam =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; saleId: string };

/** Reads `?saleId=<uuid>` from a query string; the ID is never customer data. */
export function readSaleIdParam(search: string): SaleIdParam {
  const raw = new URLSearchParams(search).get("saleId");
  if (raw === null) {
    return { kind: "absent" };
  }
  const saleId = parseSaleId(raw);
  return saleId === null ? { kind: "invalid" } : { kind: "valid", saleId };
}

/* -------------------------------------------------------------------------- */
/* Request ordering                                                           */
/* -------------------------------------------------------------------------- */

/** A counter kept in a ref: only the latest request of a load may apply. */
export interface RequestSequence {
  current: number;
}

/** Starts a request and invalidates every earlier one. */
export function nextRequestToken(sequence: RequestSequence): number {
  sequence.current += 1;
  return sequence.current;
}

export function isLatestRequest(
  sequence: RequestSequence,
  token: number
): boolean {
  return sequence.current === token;
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export interface LinkFailure {
  message: string;
  reason: string | null;
  /** The customer choices are stale: reload them and choose again. */
  reloadCustomers: boolean;
  /** The sale's attribution changed or is unknown: reload it before retrying. */
  reloadLink: boolean;
}

type LinkSubmission =
  | { phase: "idle" }
  | { action: LinkAction; phase: "submitting" }
  | { failure: LinkFailure; phase: "error" }
  | { changed: boolean; message: string; phase: "success" };

export interface LinkPanelState {
  customers: Loadable<readonly CustomerReadModel[]>;
  link: Loadable<SaleCustomerLinkReadModel>;
  selectedCustomerId: string;
  submission: LinkSubmission;
}

export function initialLinkPanelState(): LinkPanelState {
  return {
    customers: { status: "loading" },
    link: { status: "loading" },
    selectedCustomerId: "",
    submission: { phase: "idle" },
  };
}

function activeCustomers(state: LinkPanelState): readonly CustomerReadModel[] {
  return state.customers.status === "ready"
    ? state.customers.value.filter((customer) => customer.status === "active")
    : [];
}

function isSelectedActive(state: LinkPanelState): boolean {
  return activeCustomers(state).some(
    (customer) => customer.id === state.selectedCustomerId
  );
}

export function isLinkSubmitting(state: LinkPanelState): boolean {
  return state.submission.phase === "submitting";
}

/* ---- loading -------------------------------------------------------------- */

/** Starts a (re)load; an already loaded link stays visible while it refreshes. */
export function linkLoading(state: LinkPanelState): LinkPanelState {
  return state.link.status === "ready"
    ? state
    : { ...state, link: { status: "loading" } };
}

export function customersLoading(state: LinkPanelState): LinkPanelState {
  return state.customers.status === "ready"
    ? state
    : { ...state, customers: { status: "loading" } };
}

/**
 * Keeps the choice only while it can still be chosen: it must not be the sale's
 * current customer (the picker leaves that one out) and, once customers are
 * loaded, it must still be an active customer.
 */
function settleSelection(state: LinkPanelState): LinkPanelState {
  if (state.selectedCustomerId === "") {
    return state;
  }
  const currentId =
    state.link.status === "ready" ? state.link.value.current.customerId : null;
  const choosable =
    state.selectedCustomerId !== currentId &&
    (state.customers.status !== "ready" || isSelectedActive(state));
  return choosable ? state : { ...state, selectedCustomerId: "" };
}

export function linkLoaded(
  state: LinkPanelState,
  link: SaleCustomerLinkReadModel
): LinkPanelState {
  return settleSelection({ ...state, link: { status: "ready", value: link } });
}

export function linkLoadFailed(
  state: LinkPanelState,
  error: unknown
): LinkPanelState {
  const message =
    rpcErrorReason(error) === "sale_not_found"
      ? "Esta venda não foi encontrada nesta loja. Confira o identificador da venda."
      : loadErrorMessage(error, "o cliente da venda");
  return { ...state, link: { message, status: "error" } };
}

/** A new customer list drops a selection that is no longer an active customer. */
export function customersLoaded(
  state: LinkPanelState,
  customers: readonly CustomerReadModel[]
): LinkPanelState {
  const next: LinkPanelState = {
    ...state,
    customers: { status: "ready", value: customers },
  };
  return settleSelection(next);
}

export function customersLoadFailed(
  state: LinkPanelState,
  error: unknown
): LinkPanelState {
  return {
    ...state,
    customers: {
      message: loadErrorMessage(error, "os clientes"),
      status: "error",
    },
    selectedCustomerId: "",
  };
}

export function selectCustomer(
  state: LinkPanelState,
  customerId: string
): LinkPanelState {
  return { ...state, selectedCustomerId: customerId };
}

/* -------------------------------------------------------------------------- */
/* Allowed actions and commands                                               */
/* -------------------------------------------------------------------------- */

export interface ActionState {
  action: LinkAction;
  enabled: boolean;
  /** Why the action is disabled, when it is. */
  hint: string | null;
  label: string;
}

function chooseHint(state: LinkPanelState): string | null {
  const current =
    state.link.status === "ready" ? state.link.value.current.customerId : null;
  if (!isSelectedActive(state)) {
    return "Escolha um cliente ativo.";
  }
  if (current !== null && current === state.selectedCustomerId) {
    return "Escolha um cliente diferente do atual.";
  }
  return null;
}

/**
 * The actions the current attribution allows: assign when the sale has no
 * customer; reassign and unassign when it has one. Each says whether it can be
 * used right now.
 */
export function availableActions(state: LinkPanelState): ActionState[] {
  if (state.link.status !== "ready") {
    return [];
  }
  const busy = isLinkSubmitting(state);
  const hint = chooseHint(state);
  const submitting =
    state.submission.phase === "submitting" ? state.submission.action : null;
  const label = (action: LinkAction) =>
    submitting === action ? "Salvando…" : actionButtonLabels[action];
  if (state.link.value.current.customerId === null) {
    return [
      {
        action: "assign",
        enabled: !busy && hint === null,
        hint,
        label: label("assign"),
      },
    ];
  }
  return [
    {
      action: "reassign",
      enabled: !busy && hint === null,
      hint,
      label: label("reassign"),
    },
    {
      action: "unassign",
      enabled: !busy,
      hint: null,
      label: label("unassign"),
    },
  ];
}

interface CommandTarget {
  expectedVersion: number;
  organizationId: string;
  saleId: string;
}

export type LinkCommand =
  | {
      action: "assign" | "reassign";
      input: CommandTarget & { customerId: string };
    }
  | { action: "unassign"; input: CommandTarget };

export type LinkCommandResult =
  | { command: LinkCommand; ok: true }
  | { message: string; ok: false };

/**
 * Builds the request for an allowed, enabled action. Every request carries the
 * `expectedVersion` the operator saw.
 */
export function buildLinkCommand(
  state: LinkPanelState,
  action: LinkAction,
  context: { organizationId: string; saleId: string }
): LinkCommandResult {
  if (state.link.status !== "ready") {
    return { message: "Aguarde o carregamento da venda.", ok: false };
  }
  const allowed = availableActions(state).find(
    (candidate) => candidate.action === action
  );
  if (!allowed) {
    return {
      message: "Esta ação não está disponível para o estado atual da venda.",
      ok: false,
    };
  }
  if (!allowed.enabled) {
    return {
      message: allowed.hint ?? "Aguarde a operação em andamento.",
      ok: false,
    };
  }
  const target: CommandTarget = {
    expectedVersion: state.link.value.current.version,
    organizationId: context.organizationId,
    saleId: context.saleId,
  };
  if (action === "unassign") {
    return { command: { action, input: target }, ok: true };
  }
  return {
    command: {
      action,
      input: { ...target, customerId: state.selectedCustomerId },
    },
    ok: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                 */
/* -------------------------------------------------------------------------- */

/** Marks the request in flight; a second start while submitting is ignored. */
export function beginLinkSubmission(
  state: LinkPanelState,
  action: LinkAction
): LinkPanelState {
  return isLinkSubmitting(state)
    ? state
    : { ...state, submission: { action, phase: "submitting" } };
}

/** A command rejected before any request (not enabled or not ready). */
export function rejectLinkCommand(
  state: LinkPanelState,
  message: string
): LinkPanelState {
  return {
    ...state,
    submission: {
      failure: {
        message,
        reason: null,
        reloadCustomers: false,
        reloadLink: false,
      },
      phase: "error",
    },
  };
}

export function linkSubmitted(
  state: LinkPanelState,
  action: LinkAction,
  change: SaleCustomerLinkChange
): LinkPanelState {
  return {
    ...state,
    link: { status: "ready", value: change.link },
    selectedCustomerId: "",
    submission: {
      changed: change.changed,
      message: change.changed
        ? successMessages[action]
        : "Nada mudou: a venda já estava neste estado, e nenhuma versão nova foi criada.",
      phase: "success",
    },
  };
}

export function linkSubmitFailed(
  state: LinkPanelState,
  error: unknown
): LinkPanelState {
  return {
    ...state,
    submission: { failure: mapLinkError(error), phase: "error" },
  };
}

const reasonFailures = new Map<string, Omit<LinkFailure, "reason">>([
  [
    "sale_customer_link_version_conflict",
    {
      message:
        "Outra pessoa alterou o cliente desta venda. Recarregamos o estado atual; nada foi alterado agora. Revise e tente de novo.",
      reloadCustomers: false,
      reloadLink: true,
    },
  ],
  [
    "sale_customer_link_state_conflict",
    {
      message:
        "Essa ação não serve para o estado atual da venda (por exemplo, ela já tem cliente). Recarregamos o estado atual; nada foi alterado.",
      reloadCustomers: false,
      reloadLink: true,
    },
  ],
  [
    "sale_customer_archived",
    {
      message:
        "O cliente escolhido foi arquivado e não pode receber vendas. Atualizamos a lista; escolha outro cliente.",
      reloadCustomers: true,
      reloadLink: false,
    },
  ],
  [
    "customer_not_found",
    {
      message:
        "O cliente escolhido não existe mais nesta loja. Atualizamos a lista; escolha outro cliente.",
      reloadCustomers: true,
      reloadLink: false,
    },
  ],
  [
    "sale_not_found",
    {
      message:
        "Esta venda não foi encontrada nesta loja. Confira o identificador da venda.",
      reloadCustomers: false,
      reloadLink: false,
    },
  ],
  [
    "invalid_sale_customer_link",
    {
      message:
        "O servidor recusou os dados do pedido. Recarregue a página e tente de novo.",
      reloadCustomers: false,
      reloadLink: false,
    },
  ],
]);

const serverErrorCodes = new Set([
  "BAD_GATEWAY",
  "GATEWAY_TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
]);

function codeFailure(code: string | undefined): Omit<LinkFailure, "reason"> {
  const plain = {
    message: "",
    reloadCustomers: false,
    reloadLink: false,
  };
  switch (code) {
    case "UNAUTHORIZED":
      return {
        ...plain,
        message: "O vínculo do cliente com a venda não foi alterado.",
      };
    case "FORBIDDEN":
      return {
        ...plain,
        message: "Sua conta não tem acesso a esta loja ou a esta ação.",
      };
    case "BAD_REQUEST":
      return {
        ...plain,
        message:
          "O servidor recusou os dados do pedido. Revise e tente de novo.",
      };
    case "NOT_FOUND":
      return {
        ...plain,
        message:
          "A venda ou o cliente não existe nesta loja. Atualize os dados e tente de novo.",
        reloadCustomers: true,
        reloadLink: true,
      };
    case "CONFLICT":
      return {
        ...plain,
        message:
          "O estado da venda ou do cliente mudou. Recarregamos os dados; revise e tente de novo.",
        reloadCustomers: true,
        reloadLink: true,
      };
    default:
      return {
        ...plain,
        message:
          "Não foi possível concluir agora. Recarregamos o estado da venda para você conferir antes de tentar de novo.",
        reloadLink: true,
      };
  }
}

/**
 * Maps an oRPC error to a message and to what to reload. A known `data.reason`
 * on a 400/404/409 refines the generic per-code message. Network, 5xx and
 * unknown errors reload the link: repeating an action that already took effect
 * is a harmless version conflict, never a duplicate.
 */
export function mapLinkError(error: unknown): LinkFailure {
  const unaccepted = legalAcceptanceMessage(error);
  if (unaccepted !== undefined) {
    return {
      message: unaccepted,
      reason: null,
      reloadCustomers: false,
      reloadLink: false,
    };
  }
  const code = rpcErrorCode(error);
  const reason = rpcErrorReason(error) ?? null;
  const refinable =
    code === "BAD_REQUEST" || code === "NOT_FOUND" || code === "CONFLICT";
  const refined =
    refinable && reason !== null ? reasonFailures.get(reason) : undefined;
  if (refined) {
    return { ...refined, reason };
  }
  const base =
    code !== undefined && serverErrorCodes.has(code)
      ? codeFailure(undefined)
      : codeFailure(code);
  return { ...base, reason: refinable ? reason : null };
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

function customerName(
  customers: Loadable<readonly CustomerReadModel[]>,
  customerId: string
): string {
  if (customers.status === "loading") {
    return "Carregando cliente…";
  }
  if (customers.status === "error") {
    return "Cliente indisponível";
  }
  const customer = customers.value.find(
    (candidate) => candidate.id === customerId
  );
  if (!customer) {
    return "Cliente indisponível";
  }
  return customer.status === "archived"
    ? `${customer.name} (arquivado)`
    : customer.name;
}

export interface CurrentCustomerView {
  detail: string | null;
  kind: "customer" | "error" | "loading" | "none";
  label: string;
}

/** The customer the sale currently has, by name only. */
export function currentCustomerView(
  state: LinkPanelState
): CurrentCustomerView {
  if (state.link.status === "loading") {
    return { detail: null, kind: "loading", label: "Carregando…" };
  }
  if (state.link.status === "error") {
    return { detail: null, kind: "error", label: state.link.message };
  }
  const { current } = state.link.value;
  if (current.customerId === null) {
    return {
      detail:
        current.version === 0
          ? "Esta venda nunca teve cliente associado."
          : "O cliente foi removido desta venda.",
      kind: "none",
      label: "Sem cliente",
    };
  }
  return {
    detail: `Versão ${current.version} da atribuição.`,
    kind: "customer",
    label: customerName(state.customers, current.customerId),
  };
}

export type PickerView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { href: string; kind: "empty"; message: string }
  | { kind: "ready"; options: ChoiceOption[] };

/** Only active customers can be newly linked; the current one is left out. */
export function pickerView(state: LinkPanelState): PickerView {
  if (state.customers.status === "loading") {
    return { kind: "loading", message: "Carregando clientes…" };
  }
  if (state.customers.status === "error") {
    return { kind: "error", message: state.customers.message };
  }
  const currentId =
    state.link.status === "ready" ? state.link.value.current.customerId : null;
  const options = activeCustomers(state)
    .filter((customer) => customer.id !== currentId)
    .map((customer) => ({ id: customer.id, label: customer.name }))
    .sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));
  if (options.length === 0) {
    return {
      href: "/customers",
      kind: "empty",
      message:
        "Nenhum outro cliente ativo para escolher. Cadastre ou restaure um cliente na tela de clientes.",
    };
  }
  return { kind: "ready", options };
}

export interface HistoryRow {
  actionLabel: string;
  dateText: string;
  key: string;
  text: string;
  version: number;
}

const instantFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

function formatInstant(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : instantFormatter.format(date);
}

/** The version history, newest first, with customer names resolved. */
export function historyRows(state: LinkPanelState): HistoryRow[] {
  if (state.link.status !== "ready") {
    return [];
  }
  const entries = [...state.link.value.history].sort(
    (left, right) => left.version - right.version
  );
  const rows: HistoryRow[] = [];
  let previousCustomerId: string | null = null;
  for (const entry of entries) {
    const subjectId: string | null =
      entry.action === "unassign" ? previousCustomerId : entry.customerId;
    const actionLabel = historyActionLabels[entry.action];
    rows.push({
      actionLabel,
      dateText: formatInstant(entry.createdAt),
      key: `v${entry.version}`,
      text:
        subjectId === null
          ? actionLabel
          : `${actionLabel}: ${customerName(state.customers, subjectId)}`,
      version: entry.version,
    });
    previousCustomerId = entry.customerId;
  }
  return rows.reverse();
}

export interface SubmissionView {
  kind: "error" | "idle" | "submitting" | "success";
  message: string | null;
}

export function submissionView(state: LinkPanelState): SubmissionView {
  const { submission } = state;
  switch (submission.phase) {
    case "submitting":
      return { kind: "submitting", message: "Salvando…" };
    case "error":
      return { kind: "error", message: submission.failure.message };
    case "success":
      return { kind: "success", message: submission.message };
    default:
      return { kind: "idle", message: null };
  }
}
