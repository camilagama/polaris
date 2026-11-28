// @vitest-environment happy-dom
import type {
  CustomerDuplicateMatchReadModel,
  CustomerReadModel,
} from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CustomerForm } from "./customer-form";

const noop = () => undefined;
const keepFocus = () => true;

const customer = (
  id: number,
  name: string,
  status: CustomerReadModel["status"] = "active"
): CustomerReadModel => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  email: "ana@example.com",
  id: `0199c2d0-0000-7000-8000-${id.toString(16).padStart(12, "0")}`,
  name,
  notes: null,
  organizationId: "org",
  phone: "11900000001",
  status,
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
});

const renderForm = (duplicateMatches: CustomerDuplicateMatchReadModel[]) =>
  render(
    <CustomerForm
      contactError={null}
      draft={{ email: "", name: "", notes: "", phone: "" }}
      duplicateMatches={duplicateMatches}
      editingCustomer={null}
      error={null}
      feedbackRef={null}
      finalFocus={keepFocus}
      isPending={false}
      notice={null}
      onCancel={noop}
      onChange={noop}
      onClosed={noop}
      onCreateAnyway={noop}
      onDismiss={noop}
      onSubmit={noop}
      onUseExisting={noop}
      open
    />
  );

afterEach(cleanup);

describe("os textos do formulário de cliente", () => {
  it("o apoio do grupo de contato diz que e-mail e telefone podem se repetir", async () => {
    renderForm([]);
    const support = await screen.findByText(
      "E-mail e telefone podem se repetir entre clientes."
    );
    const group = screen.getByRole("group", {
      name: "Telefone ou e-mail (um dos dois)",
    });
    expect(group.contains(support)).toBe(true);
  });

  it("diz por inteiro o que o cadastro parecido tem em comum: e-mail, telefone, ou os dois", async () => {
    renderForm([
      { customer: customer(1, "Ana"), matchedBy: ["email"] },
      { customer: customer(2, "Bia"), matchedBy: ["phone"] },
      { customer: customer(3, "Caio"), matchedBy: ["email", "phone"] },
    ]);
    expect(await screen.findAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Mesmo e-mail")).toBeTruthy();
    expect(screen.getByText("Mesmo telefone")).toBeTruthy();
    expect(screen.getByText("Mesmo e-mail e telefone")).toBeTruthy();
  });

  it("explica o bloco de possíveis clientes e que nada é mesclado sozinho", async () => {
    renderForm([{ customer: customer(1, "Ana"), matchedBy: ["email"] }]);
    expect(
      await screen.findByRole("heading", {
        name: "Encontramos possíveis clientes existentes",
      })
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Revise os cadastros por e-mail ou telefone. Nenhum dado será mesclado automaticamente."
      )
    ).toBeTruthy();
  });

  it("avisa que escolher um cadastro arquivado não o restaura", async () => {
    renderForm([
      {
        customer: customer(4, "Dora", "archived"),
        matchedBy: ["phone"],
      },
    ]);
    expect(
      await screen.findByText("Selecionar este cadastro não o restaura.")
    ).toBeTruthy();
  });
});
