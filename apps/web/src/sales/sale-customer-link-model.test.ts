import type {
  CustomerReadModel,
  SaleCustomerLinkReadModel,
} from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  availableActions,
  beginLinkSubmission,
  buildLinkCommand,
  currentCustomerView,
  customersLoaded,
  customersLoadFailed,
  customersLoading,
  historyRows,
  initialLinkPanelState,
  isLatestRequest,
  isLinkSubmitting,
  type LinkPanelState,
  linkLoaded,
  linkLoadFailed,
  linkLoading,
  linkSubmitFailed,
  linkSubmitted,
  mapLinkError,
  nextRequestToken,
  parseSaleId,
  pickerView,
  readSaleIdParam,
  rejectLinkCommand,
  selectCustomer,
  submissionView,
  VALUES_UNCHANGED_NOTE,
} from "./sale-customer-link-model";

const organizationId = "org_1";
const saleId = "77777777-7777-4777-8777-777777777777";
const ana = "a0000000-0000-4000-8000-000000000001";
const bruno = "b0000000-0000-4000-8000-000000000002";
const carla = "c0000000-0000-4000-8000-000000000003";
const gone = "d0000000-0000-4000-8000-000000000004";
const context = { organizationId, saleId };

function customer(
  id: string,
  name: string,
  status: "active" | "archived" = "active"
): CustomerReadModel {
  return {
    archivedAt: status === "archived" ? "2026-02-01T00:00:00.000Z" : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    email: `${name.toLowerCase()}@example.com`,
    id,
    name,
    notes: null,
    organizationId,
    phone: "+55 11 99999-0000",
    status,
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

const customers = [
  customer(ana, "Ana"),
  customer(bruno, "Bruno"),
  customer(carla, "Carla", "archived"),
];

function link(
  customerId: string | null,
  version: number,
  history: SaleCustomerLinkReadModel["history"] = []
): SaleCustomerLinkReadModel {
  return { current: { customerId, version }, history, saleId };
}

function ready(
  value: SaleCustomerLinkReadModel,
  list: readonly CustomerReadModel[] = customers
): LinkPanelState {
  return customersLoaded(linkLoaded(initialLinkPanelState(), value), list);
}

const neverAssigned = () => ready(link(null, 0));
const assignedToAna = () =>
  ready(
    link(ana, 1, [
      {
        action: "assign",
        createdAt: "2026-05-01T12:00:00.000Z",
        customerId: ana,
        version: 1,
      },
    ])
  );

describe("sale identifier", () => {
  it("accepts a UUID, trims and lowercases it", () => {
    expect(parseSaleId(`  ${saleId.toUpperCase()} `)).toBe(saleId);
  });

  it("rejects text that is not a UUID", () => {
    expect(parseSaleId("abc")).toBeNull();
    expect(parseSaleId("")).toBeNull();
    expect(parseSaleId(null)).toBeNull();
  });

  it("reads the saleId query parameter: valid, invalid or absent", () => {
    expect(readSaleIdParam(`?saleId=${saleId}`)).toEqual({
      kind: "valid",
      saleId,
    });
    expect(readSaleIdParam("?saleId=nope")).toEqual({ kind: "invalid" });
    expect(readSaleIdParam("?other=1")).toEqual({ kind: "absent" });
    expect(readSaleIdParam("")).toEqual({ kind: "absent" });
  });
});

describe("load states", () => {
  it("starts with the sale and the customers loading", () => {
    const state = initialLinkPanelState();
    expect(state.link.status).toBe("loading");
    expect(state.customers.status).toBe("loading");
    expect(currentCustomerView(state).kind).toBe("loading");
    expect(pickerView(state).kind).toBe("loading");
    expect(availableActions(state)).toEqual([]);
  });

  it("keeps an already loaded link visible while it reloads", () => {
    const state = neverAssigned();
    expect(linkLoading(state)).toBe(state);
    expect(customersLoading(state)).toBe(state);
    expect(linkLoading(initialLinkPanelState()).link.status).toBe("loading");
  });

  it("reports a link that failed to load, with a specific message for a missing sale", () => {
    const missing = linkLoadFailed(initialLinkPanelState(), {
      code: "NOT_FOUND",
      data: { reason: "sale_not_found" },
    });
    expect(currentCustomerView(missing)).toMatchObject({ kind: "error" });
    expect(currentCustomerView(missing).label).toContain("não foi encontrada");
    const forbidden = linkLoadFailed(initialLinkPanelState(), {
      code: "FORBIDDEN",
    });
    expect(currentCustomerView(forbidden).label).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
    expect(availableActions(missing)).toEqual([]);
  });

  it("reports customers that failed to load, with the generic forbidden message", () => {
    const state = customersLoadFailed(neverAssigned(), { code: "FORBIDDEN" });
    expect(pickerView(state)).toEqual({
      kind: "error",
      message: "Sua conta não tem acesso a esta organização ou ação.",
    });
  });

  it("explains an empty customer list and points to the customers screen", () => {
    const state = ready(link(null, 0), []);
    expect(pickerView(state)).toMatchObject({
      href: "/customers",
      kind: "empty",
    });
    const onlyArchived = ready(link(null, 0), [
      customer(ana, "Ana", "archived"),
    ]);
    expect(pickerView(onlyArchived).kind).toBe("empty");
  });
});

describe("allowed actions", () => {
  it("offers only assign when the sale never had a customer", () => {
    const actions = availableActions(neverAssigned());
    expect(actions.map((action) => action.action)).toEqual(["assign"]);
    expect(actions[0]).toMatchObject({
      enabled: false,
      hint: "Escolha um cliente ativo.",
      label: "Associar cliente",
    });
  });

  it("enables assign once an active customer is chosen", () => {
    const state = selectCustomer(neverAssigned(), ana);
    expect(availableActions(state)[0]?.enabled).toBe(true);
  });

  it("offers assign again after the customer was removed", () => {
    const removed = ready(
      link(null, 2, [
        {
          action: "assign",
          createdAt: "2026-05-01T12:00:00.000Z",
          customerId: ana,
          version: 1,
        },
        {
          action: "unassign",
          createdAt: "2026-05-02T12:00:00.000Z",
          customerId: null,
          version: 2,
        },
      ])
    );
    expect(availableActions(removed).map((action) => action.action)).toEqual([
      "assign",
    ]);
    expect(currentCustomerView(removed).detail).toBe(
      "O cliente foi removido desta venda."
    );
  });

  it("offers reassign and unassign when the sale has a customer", () => {
    const actions = availableActions(assignedToAna());
    expect(actions.map((action) => action.action)).toEqual([
      "reassign",
      "unassign",
    ]);
    expect(actions.map((action) => action.label)).toEqual([
      "Trocar cliente",
      "Remover cliente",
    ]);
    expect(actions[0]?.enabled).toBe(false);
    expect(actions[1]?.enabled).toBe(true);
  });

  it("does not let the same customer or an archived customer be chosen", () => {
    const same = selectCustomer(assignedToAna(), ana);
    expect(availableActions(same)[0]).toMatchObject({
      enabled: false,
      hint: "Escolha um cliente diferente do atual.",
    });
    const archived = selectCustomer(assignedToAna(), carla);
    expect(availableActions(archived)[0]?.enabled).toBe(false);
    const other = selectCustomer(assignedToAna(), bruno);
    expect(availableActions(other)[0]?.enabled).toBe(true);
  });

  it("disables every action while a request is in flight", () => {
    const state = beginLinkSubmission(
      selectCustomer(assignedToAna(), bruno),
      "reassign"
    );
    const actions = availableActions(state);
    expect(actions.every((action) => !action.enabled)).toBe(true);
    expect(actions[0]?.label).toBe("Salvando…");
  });
});

describe("command payloads", () => {
  it("assigns with the version the operator saw", () => {
    const state = selectCustomer(neverAssigned(), ana);
    expect(buildLinkCommand(state, "assign", context)).toEqual({
      command: {
        action: "assign",
        input: {
          customerId: ana,
          expectedVersion: 0,
          organizationId,
          saleId,
        },
      },
      ok: true,
    });
  });

  it("reassigns using the current version, not a fixed one", () => {
    const state = selectCustomer(ready(link(ana, 5, [])), bruno);
    expect(buildLinkCommand(state, "reassign", context)).toMatchObject({
      command: { input: { customerId: bruno, expectedVersion: 5 } },
      ok: true,
    });
  });

  it("unassigns without naming a customer", () => {
    const result = buildLinkCommand(assignedToAna(), "unassign", context);
    expect(result).toEqual({
      command: {
        action: "unassign",
        input: { expectedVersion: 1, organizationId, saleId },
      },
      ok: true,
    });
  });

  it("refuses an action the state does not allow or that is not enabled", () => {
    expect(
      buildLinkCommand(neverAssigned(), "unassign", context)
    ).toMatchObject({ ok: false });
    expect(buildLinkCommand(assignedToAna(), "assign", context)).toMatchObject({
      ok: false,
    });
    expect(buildLinkCommand(neverAssigned(), "assign", context)).toEqual({
      message: "Escolha um cliente ativo.",
      ok: false,
    });
    expect(
      buildLinkCommand(initialLinkPanelState(), "assign", context)
    ).toMatchObject({ ok: false });
  });

  it("puts no customer data in the request", () => {
    const state = selectCustomer(neverAssigned(), ana);
    const result = buildLinkCommand(state, "assign", context);
    const text = JSON.stringify(result);
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("99999");
    expect(text).not.toContain("Ana");
  });
});

describe("submission state", () => {
  it("guards against a double submit", () => {
    const state = selectCustomer(neverAssigned(), ana);
    const first = beginLinkSubmission(state, "assign");
    expect(isLinkSubmitting(first)).toBe(true);
    expect(beginLinkSubmission(first, "assign")).toBe(first);
    expect(submissionView(first)).toEqual({
      kind: "submitting",
      message: "Salvando…",
    });
  });

  it("shows success per action, adopts the returned link and clears the choice", () => {
    const state = beginLinkSubmission(
      selectCustomer(neverAssigned(), ana),
      "assign"
    );
    const done = linkSubmitted(state, "assign", {
      changed: true,
      link: link(ana, 1, [
        {
          action: "assign",
          createdAt: "2026-05-01T12:00:00.000Z",
          customerId: ana,
          version: 1,
        },
      ]),
    });
    expect(submissionView(done)).toEqual({
      kind: "success",
      message: "Cliente associado à venda.",
    });
    expect(done.selectedCustomerId).toBe("");
    expect(currentCustomerView(done).label).toBe("Ana");
    expect(isLinkSubmitting(done)).toBe(false);

    const swapped = linkSubmitted(done, "reassign", {
      changed: true,
      link: link(bruno, 2),
    });
    expect(submissionView(swapped).message).toBe("Cliente trocado.");
    const removed = linkSubmitted(swapped, "unassign", {
      changed: true,
      link: link(null, 3),
    });
    expect(submissionView(removed).message).toBe("Cliente removido da venda.");
  });

  it("says nothing changed for a repeated action (changed false)", () => {
    const done = linkSubmitted(assignedToAna(), "assign", {
      changed: false,
      link: link(ana, 1),
    });
    expect(submissionView(done).message).toContain("Nada mudou");
    expect(
      done.link.status === "ready" && done.link.value.current.version
    ).toBe(1);
  });

  it("reports a rejected command without a request", () => {
    const state = rejectLinkCommand(
      neverAssigned(),
      "Escolha um cliente ativo."
    );
    expect(submissionView(state)).toEqual({
      kind: "error",
      message: "Escolha um cliente ativo.",
    });
  });

  it("states that the sale values do not change", () => {
    expect(VALUES_UNCHANGED_NOTE).toContain("não altera os valores da venda");
  });
});

describe("error mapping", () => {
  it("reloads the link after a version conflict", () => {
    const failure = mapLinkError({
      code: "CONFLICT",
      data: { reason: "sale_customer_link_version_conflict" },
    });
    expect(failure.reloadLink).toBe(true);
    expect(failure.reloadCustomers).toBe(false);
    expect(failure.message).toContain("Outra pessoa alterou");
    expect(failure.message).toContain("nada foi alterado");
  });

  it("reloads the link after a state conflict", () => {
    const failure = mapLinkError({
      code: "CONFLICT",
      data: { reason: "sale_customer_link_state_conflict" },
    });
    expect(failure.reloadLink).toBe(true);
    expect(failure.message).toContain("já tem cliente");
  });

  it("reloads the customers when the customer is archived or gone", () => {
    for (const [code, reason] of [
      ["CONFLICT", "sale_customer_archived"],
      ["NOT_FOUND", "customer_not_found"],
    ] as const) {
      const failure = mapLinkError({ code, data: { reason } });
      expect(failure.reloadCustomers, reason).toBe(true);
      expect(failure.reloadLink, reason).toBe(false);
      expect(failure.message, reason).toContain("escolha outro cliente");
    }
  });

  it("maps a missing sale and invalid commands without reloading", () => {
    const missing = mapLinkError({
      code: "NOT_FOUND",
      data: { reason: "sale_not_found" },
    });
    expect(missing.message).toContain("não foi encontrada");
    expect(missing.reloadLink).toBe(false);
    const invalid = mapLinkError({
      code: "BAD_REQUEST",
      data: { reason: "invalid_sale_customer_link" },
    });
    expect(invalid.reason).toBe("invalid_sale_customer_link");
    expect(invalid.reloadLink).toBe(false);
  });

  it("falls back to the generic per-code message for a missing or unknown reason", () => {
    const generic = mapLinkError({ code: "CONFLICT" });
    expect(generic.message).toContain("O estado da venda ou do cliente mudou");
    for (const data of [
      undefined,
      { reason: "something_new" },
      { reason: 7 },
    ]) {
      expect(mapLinkError({ code: "CONFLICT", data }).message).toBe(
        generic.message
      );
    }
    expect(mapLinkError({ code: "BAD_REQUEST" }).message).toContain(
      "recusou os dados"
    );
    expect(mapLinkError({ code: "NOT_FOUND" }).reloadLink).toBe(true);
  });

  it("uses the existing generic messages for authorization errors", () => {
    expect(mapLinkError({ code: "UNAUTHORIZED" }).message).toContain("sessão");
    const forbidden = mapLinkError({
      code: "FORBIDDEN",
      data: { reason: "sale_customer_archived" },
    });
    expect(forbidden.message).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
    expect(forbidden.reason).toBeNull();
    expect(forbidden.reloadCustomers).toBe(false);
  });

  it("reloads the link after a network, 5xx or unknown failure", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      { code: "SERVICE_UNAVAILABLE" },
      new Error("boom"),
    ]) {
      const failure = mapLinkError(error);
      expect(failure.reloadLink).toBe(true);
      expect(failure.message).toContain("Recarregamos o estado");
    }
  });
});

describe("refresh after a conflict", () => {
  it("shows the new current state and keeps the conflict message", () => {
    const stale = selectCustomer(assignedToAna(), bruno);
    const failed = linkSubmitFailed(beginLinkSubmission(stale, "reassign"), {
      code: "CONFLICT",
      data: { reason: "sale_customer_link_version_conflict" },
    });
    expect(submissionView(failed).kind).toBe("error");
    const reloaded = linkLoaded(failed, link(carla, 2));
    expect(currentCustomerView(reloaded).label).toBe("Carla (arquivado)");
    expect(submissionView(reloaded).message).toContain("Outra pessoa alterou");
    const command = buildLinkCommand(reloaded, "unassign", context);
    expect(command).toMatchObject({
      command: { input: { expectedVersion: 2 } },
      ok: true,
    });
  });

  it("drops a chosen customer that became archived after reloading customers", () => {
    const chosen = selectCustomer(neverAssigned(), bruno);
    const refreshed = customersLoaded(chosen, [
      customer(ana, "Ana"),
      customer(bruno, "Bruno", "archived"),
    ]);
    expect(refreshed.selectedCustomerId).toBe("");
    expect(availableActions(refreshed)[0]?.enabled).toBe(false);
    const kept = customersLoaded(chosen, customers);
    expect(kept.selectedCustomerId).toBe(bruno);
  });
});

describe("views", () => {
  it("shows the customer by name only", () => {
    const state = assignedToAna();
    const view = currentCustomerView(state);
    expect(view).toMatchObject({ kind: "customer", label: "Ana" });
    expect(JSON.stringify(view)).not.toContain("example.com");
    expect(JSON.stringify(view)).not.toContain("99999");
  });

  it("marks an archived linked customer and keeps showing it", () => {
    const state = ready(link(carla, 1), customers);
    expect(currentCustomerView(state).label).toBe("Carla (arquivado)");
    expect(availableActions(state).map((action) => action.action)).toEqual([
      "reassign",
      "unassign",
    ]);
  });

  it("shows an unavailable customer for an unknown id, and loading while customers load", () => {
    const unknown = ready(link(gone, 1), customers);
    expect(currentCustomerView(unknown).label).toBe("Cliente indisponível");
    const loading = linkLoaded(initialLinkPanelState(), link(ana, 1));
    expect(currentCustomerView(loading).label).toBe("Carregando cliente…");
    const failed = customersLoadFailed(loading, new Error("x"));
    expect(currentCustomerView(failed).label).toBe("Cliente indisponível");
  });

  it("describes a sale that never had a customer", () => {
    expect(currentCustomerView(neverAssigned())).toEqual({
      detail: "Esta venda nunca teve cliente associado.",
      kind: "none",
      label: "Sem cliente",
    });
    expect(historyRows(neverAssigned())).toEqual([]);
  });

  it("lists only active customers other than the current one, sorted", () => {
    expect(pickerView(neverAssigned())).toEqual({
      kind: "ready",
      options: [
        { id: ana, label: "Ana" },
        { id: bruno, label: "Bruno" },
      ],
    });
    expect(pickerView(assignedToAna())).toEqual({
      kind: "ready",
      options: [{ id: bruno, label: "Bruno" }],
    });
  });

  it("renders the history newest first with names resolved", () => {
    const state = ready(
      link(null, 4, [
        {
          action: "assign",
          createdAt: "2026-05-01T12:00:00.000Z",
          customerId: ana,
          version: 1,
        },
        {
          action: "reassign",
          createdAt: "2026-05-02T12:00:00.000Z",
          customerId: carla,
          version: 2,
        },
        {
          action: "reassign",
          createdAt: "2026-05-03T12:00:00.000Z",
          customerId: gone,
          version: 3,
        },
        {
          action: "unassign",
          createdAt: "2026-05-04T12:00:00.000Z",
          customerId: null,
          version: 4,
        },
      ])
    );
    const rows = historyRows(state);
    expect(rows.map((row) => row.version)).toEqual([4, 3, 2, 1]);
    expect(rows.map((row) => row.text)).toEqual([
      "Cliente removido: Cliente indisponível",
      "Cliente trocado: Cliente indisponível",
      "Cliente trocado: Carla (arquivado)",
      "Cliente associado: Ana",
    ]);
    expect(rows.map((row) => row.actionLabel)).toEqual([
      "Cliente removido",
      "Cliente trocado",
      "Cliente trocado",
      "Cliente associado",
    ]);
  });
});

describe("selection after a reload", () => {
  it("clears the choice when the reloaded current customer is that choice", () => {
    const chosen = selectCustomer(assignedToAna(), bruno);
    const reloaded = linkLoaded(chosen, link(bruno, 2));
    expect(reloaded.selectedCustomerId).toBe("");
    expect(pickerView(reloaded)).toEqual({
      kind: "ready",
      options: [{ id: ana, label: "Ana" }],
    });
    expect(availableActions(reloaded)[0]?.hint).toBe(
      "Escolha um cliente ativo."
    );
  });

  it("keeps a choice that is still different from the reloaded customer", () => {
    const chosen = selectCustomer(assignedToAna(), bruno);
    expect(linkLoaded(chosen, link(ana, 2)).selectedCustomerId).toBe(bruno);
  });

  it("clears the choice when it is no longer an active customer", () => {
    const chosen = selectCustomer(neverAssigned(), bruno);
    const archived = customersLoaded(chosen, [
      customer(ana, "Ana"),
      customer(bruno, "Bruno", "archived"),
    ]);
    expect(linkLoaded(archived, link(null, 1)).selectedCustomerId).toBe("");
    const withoutChoice = { ...chosen, selectedCustomerId: gone };
    expect(linkLoaded(withoutChoice, link(null, 1)).selectedCustomerId).toBe(
      ""
    );
  });

  it("does not drop a choice made before the customers finished loading", () => {
    const loading = {
      ...linkLoaded(initialLinkPanelState(), link(null, 0)),
      selectedCustomerId: bruno,
    };
    expect(linkLoaded(loading, link(null, 1)).selectedCustomerId).toBe(bruno);
  });
});

describe("request ordering", () => {
  it("lets only the latest request of a load apply", () => {
    const sequence = { current: 0 };
    const first = nextRequestToken(sequence);
    expect(isLatestRequest(sequence, first)).toBe(true);
    const second = nextRequestToken(sequence);
    expect(second).toBeGreaterThan(first);
    expect(isLatestRequest(sequence, first)).toBe(false);
    expect(isLatestRequest(sequence, second)).toBe(true);
  });

  it("keeps independent sequences independent", () => {
    const linkSequence = { current: 0 };
    const customersSequence = { current: 0 };
    const linkToken = nextRequestToken(linkSequence);
    nextRequestToken(customersSequence);
    expect(isLatestRequest(linkSequence, linkToken)).toBe(true);
  });
});
