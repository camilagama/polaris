import type { CustomerReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import type { PendingCustomer } from "../offline/customer-create";
import type { PendingCustomerUpdate } from "../offline/customer-update";
import {
  customerErrorMessage,
  customerStatusLabel,
  hasCustomerContact,
  isCustomerListStatus,
  lockedReasonFor,
  syncStateLabel,
} from "./customers-model";

const refusal = (code: string) => ({ code });
const customer = (overrides: Partial<CustomerReadModel> = {}) =>
  ({
    anonymizedAt: null,
    status: "active",
    ...overrides,
  }) as CustomerReadModel;
const created = (state: PendingCustomer["state"]) =>
  ({ state }) as PendingCustomer;
const edited = (state: PendingCustomerUpdate["state"]) =>
  ({ state }) as PendingCustomerUpdate;

describe("the contact of a customer", () => {
  it("needs a phone or an e-mail, and a blank one is none", () => {
    const draft = { email: "", name: "Ana", notes: "", phone: "" };
    expect(hasCustomerContact(draft)).toBe(false);
    expect(hasCustomerContact({ ...draft, phone: "   " })).toBe(false);
    expect(hasCustomerContact({ ...draft, phone: "11900000001" })).toBe(true);
    expect(hasCustomerContact({ ...draft, email: "ana@exemplo.com" })).toBe(
      true
    );
  });
});

describe("the state of a customer in words", () => {
  it("puts anonymized before the lifecycle", () => {
    expect(customerStatusLabel(customer())).toBe("Ativo");
    expect(customerStatusLabel(customer({ status: "archived" }))).toBe(
      "Arquivado"
    );
    expect(
      customerStatusLabel(
        customer({ anonymizedAt: "2026-10-14T12:00:00.000Z" })
      )
    ).toBe("Anonimizado");
  });

  it("knows the two tabs", () => {
    expect(isCustomerListStatus("active")).toBe(true);
    expect(isCustomerListStatus("archived")).toBe(true);
    expect(isCustomerListStatus("anonymized")).toBe(false);
  });
});

describe("what waits for the server", () => {
  it("locks a customer that was created or edited here and not confirmed", () => {
    expect(lockedReasonFor(undefined, undefined)).toBeNull();
    expect(lockedReasonFor(created("pending"), undefined)).toBe(
      "Disponível depois que o servidor confirmar o cadastro."
    );
    expect(lockedReasonFor(undefined, edited("pending"))).toBe(
      "Disponível depois que o servidor confirmar a alteração."
    );
  });

  it("sends a refused edit to Pendências before another one", () => {
    expect(lockedReasonFor(undefined, edited("rejected"))).toContain(
      "Resolva em Pendências"
    );
  });

  it("names the stage of a creation and of an edit apart", () => {
    expect(syncStateLabel(created("pending"), false)).toBe("Aguardando envio");
    expect(syncStateLabel(created("sending"), false)).toBe("Enviando…");
    expect(syncStateLabel(created("rejected"), false)).toBe(
      "Recusado pelo servidor"
    );
    expect(syncStateLabel(edited("pending"), true)).toBe(
      "Alteração aguardando envio"
    );
    expect(syncStateLabel(edited("sending"), true)).toBe("Enviando alteração…");
    expect(syncStateLabel(edited("rejected"), true)).toBe(
      "Alteração recusada pelo servidor"
    );
  });
});

describe("what the screen says when a call fails", () => {
  it("says what did not happen, per action, for a session that ended", () => {
    expect(customerErrorMessage(refusal("UNAUTHORIZED"), "archive")).toBe(
      "O cliente não foi arquivado."
    );
    expect(customerErrorMessage(refusal("UNAUTHORIZED"), "anonymize")).toBe(
      "O cliente não foi anonimizado."
    );
    expect(customerErrorMessage(refusal("UNAUTHORIZED"), "load")).toBe(
      "Não foi possível carregar os clientes."
    );
    expect(customerErrorMessage(refusal("UNAUTHORIZED"), "save")).toBe(
      "O cliente não foi salvo."
    );
  });

  it("asks to check the name and the contact when the server refuses the form", () => {
    expect(customerErrorMessage(refusal("BAD_REQUEST"), "save")).toBe(
      "Confira o nome e informe ao menos um telefone ou email válido."
    );
  });

  it("separates the duplicate check that failed from the load", () => {
    expect(
      customerErrorMessage(refusal("SERVICE_UNAVAILABLE"), "duplicate-check")
    ).toContain("possíveis clientes repetidos");
    expect(customerErrorMessage(refusal("SERVICE_UNAVAILABLE"), "load")).toBe(
      "A lista de clientes está temporariamente indisponível. Tente novamente."
    );
  });

  it("sends a customer with a command waiting to Pendências", () => {
    expect(
      customerErrorMessage(new Error("customer_has_pending_command"), "archive")
    ).toContain("resolva em Pendências");
  });
});
