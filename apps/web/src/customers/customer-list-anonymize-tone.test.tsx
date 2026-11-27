// @vitest-environment happy-dom
import type { CustomerReadModel } from "@polaris/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CustomerList } from "./customer-list";

const noop = () => undefined;

const customer: CustomerReadModel = {
  anonymizedAt: null,
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  email: null,
  id: "0199c2d0-0000-7000-8000-000000000061",
  name: "Ana Lima",
  notes: null,
  organizationId: "org",
  phone: "11900000001",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
};

afterEach(cleanup);

async function openAnonymizeConfirm() {
  const user = userEvent.setup();
  render(
    <CustomerList
      count="1 cliente"
      customers={[customer]}
      isLoading={false}
      isOffline={false}
      onAnonymize={noop}
      onArchive={noop}
      onEdit={noop}
      onRestore={noop}
      pendingAction={null}
      query=""
      status="active"
      syncStates={new Map()}
      today="2026-11-21"
      total={1}
      updateStates={new Map()}
    />
  );
  expect(document.querySelector('[data-slot="inset-block"]')).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Mais ações para Ana Lima" })
  );
  await user.click(await screen.findByRole("menuitem", { name: "Anonimizar" }));
  return screen.findByRole("group", {
    name: "Confirmar a anonimização de Ana Lima",
  });
}

describe("a confirmação de anonimizar um cliente", () => {
  it("diz por inteiro o que some, que não dá para desfazer e que as vendas ficam", async () => {
    const block = await openAnonymizeConfirm();
    expect(block.querySelector("p")?.textContent).toBe(
      "Anonimizar remove o nome, o telefone, o e-mail e as observações deste cliente. Não dá para desfazer. As vendas ligadas a ele continuam com os mesmos valores."
    );
    expect(block.querySelector("p strong")?.textContent).toBe(
      "Não dá para desfazer."
    );
    expect(
      within(block)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["Cancelar", "Anonimizar definitivamente"]);
  });

  it("é o bloco rebaixado em tom destrutivo, com o anel de destructive", async () => {
    const block = await openAnonymizeConfirm();
    expect(block.getAttribute("data-slot")).toBe("inset-block");
    expect(block.classList.contains("ring-destructive/60")).toBe(true);
  });
});
