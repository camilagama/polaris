import type { CustomerReadModel } from "@polaris/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingCustomer } from "../offline/customer-create";
import type { PendingCustomerUpdate } from "../offline/customer-update";
import { CustomerList } from "./customer-list";

/**
 * The list of the customers screen, drawn without a browser: what each state says and what each row carries. The menu
 * opens in a popup (Base UI), so its items are proved in the browser (e2e/offline-screens.e2e.ts and
 * e2e/lote-2-telas.e2e.ts); here is the trigger, its name and whether it is off.
 */
const customer = (
  n: number,
  name: string,
  overrides: Partial<CustomerReadModel> = {}
): CustomerReadModel => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  email: null,
  id: `0199c2d0-0000-7000-8000-0000000000${60 + n}`,
  name,
  notes: null,
  organizationId: "org",
  phone: "11900000001",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
  ...overrides,
});

const noop = () => undefined;
type Props = ComponentProps<typeof CustomerList>;
const base: Props = {
  customers: [customer(1, "Ana Lima")],
  isLoading: false,
  isOffline: false,
  onAnonymize: noop,
  onArchive: noop,
  onEdit: noop,
  onNew: noop,
  onRestore: noop,
  pendingAction: null,
  status: "active",
  syncStates: new Map(),
  updateStates: new Map(),
};
const render = (overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(<CustomerList {...base} {...overrides} />);

const OFF = ' disabled=""';
/** The trigger of the menu of a customer, as drawn: its tag, to say whether it is off. */
function menuTrigger(markup: string, name: string): string {
  const tag = new RegExp(
    `<button[^>]*aria-label="Mais ações para ${name}"[^>]*>`
  ).exec(markup);
  if (!tag) {
    throw new Error(`no menu for ${name}`);
  }
  return tag[0];
}

describe("the list of customers", () => {
  it("says it is loading, and shows no row", () => {
    const html = render({ isLoading: true });
    expect(html).toContain("Carregando clientes…");
    expect(html).not.toContain("Ana Lima");
  });

  it("tells the empty list what to do next, and the archived one that there is none", () => {
    const empty = render({ customers: [] });
    expect(empty).toContain(
      "Nenhum cliente ainda. Cadastre o primeiro em “Novo cliente”."
    );
    // the form is not on the page: the empty list carries the button that opens it
    expect(empty).toContain("Novo cliente</button>");
    expect(render({ customers: [], status: "archived" })).toContain(
      "Nenhum cliente arquivado."
    );
  });

  it("draws the name, the contacts and the state in words, and leaves the notes and the date to the editor", () => {
    const html = render({
      customers: [
        customer(1, "Ana Lima", {
          email: "ana@exemplo.com",
          notes: "Prefere o WhatsApp.",
        }),
      ],
    });
    expect(html).toContain("Ana Lima");
    expect(html).toContain("(11) 90000-0001 · ana@exemplo.com");
    expect(html).not.toContain("Prefere o WhatsApp.");
    expect(html).toContain("Ativo");
    expect(html).not.toContain("Atualizado em");
    expect(html).toContain('data-customer-id="');
  });

  it("says Arquivado in words on an archived customer", () => {
    const html = render({
      customers: [customer(1, "Ana Lima", { status: "archived" })],
      status: "archived",
    });
    expect(html).toContain("Arquivado");
  });

  it("keeps an anonymized customer read only: what was removed, in words, and no menu", () => {
    const html = render({
      customers: [
        customer(1, "Cliente anonimizado", {
          anonymizedAt: "2026-10-15T12:00:00.000Z",
          phone: null,
        }),
      ],
    });
    expect(html).toContain("Anonimizado");
    expect(html).toContain(
      "Dados pessoais removidos: não dá para editar nem restaurar; as vendas dele não mudam."
    );
    expect(html).not.toContain("Mais ações para");
  });

  it("marks a customer created here that the server has not confirmed, and says why it is locked", () => {
    const ana = customer(1, "Ana Lima");
    const html = render({
      syncStates: new Map([[ana.id, { state: "pending" } as PendingCustomer]]),
    });
    expect(html).toContain('data-sync-state="pending"');
    expect(html).toContain("Aguardando envio");
    expect(html).toContain(
      "Disponível depois que o servidor confirmar o cadastro."
    );
  });

  it("names an edit that was refused and sends it to Pendências", () => {
    const ana = customer(1, "Ana Lima");
    const html = render({
      updateStates: new Map([
        [ana.id, { state: "rejected" } as PendingCustomerUpdate],
      ]),
    });
    expect(html).toContain("Alteração recusada pelo servidor");
    expect(html).toContain('href="/attention"');
    expect(html).toContain("Resolver em Pendências");
  });

  it("locks the menus while an action runs, and says which one", () => {
    const ana = customer(1, "Ana Lima");
    expect(menuTrigger(render(), "Ana Lima")).not.toContain(OFF);
    const html = render({ pendingAction: `archive:${ana.id}` });
    expect(menuTrigger(html, "Ana Lima")).toContain(OFF);
    expect(html).toContain("Arquivando…");
  });
});
