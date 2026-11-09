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

const ROW_BUTTON_ANA =
  /<button[^>]*data-row-open=""[^>]*>(?:(?!<\/button>).)*<span class="sr-only">Editar <\/span>Ana Lima<\/span>/s;
const ROW_BUTTON_TAG = /<button[^>]*data-row-open=""[^>]*>/;
/** A button that opens before the one before it closed. */
const BUTTON_IN_BUTTON = /<button(?:(?!<\/button>).)*<button/s;

const noop = () => undefined;
type Props = ComponentProps<typeof CustomerList>;
const base: Props = {
  customers: [customer(1, "Ana Lima")],
  isLoading: false,
  isOffline: false,
  onAnonymize: noop,
  onArchive: noop,
  onEdit: noop,
  onRestore: noop,
  pendingAction: null,
  query: "",
  status: "active",
  syncStates: new Map(),
  total: 1,
  updateStates: new Map(),
};
const render = (overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(<CustomerList {...base} {...overrides} />);

const EMPTY_SENTENCE = /data-empty-title=""[^>]*>([^<]*)</;
const DESCRIBED_BY = /aria-describedby="([^"]*)"/;
/** The text of the elements a tag points to with aria-describedby, in order. */
function describedByText(markup: string, tag = ""): string[] {
  const ids = DESCRIBED_BY.exec(tag)?.[1]?.split(" ") ?? [];
  return ids.map((id) => {
    const text = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(markup)?.[1];
    return text ?? "";
  });
}

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

  it("says only what is missing in the empty list (no button), and that the archived one is empty", () => {
    const empty = render({ customers: [], total: 0 });
    expect(empty).toContain("Nenhum cliente ainda.");
    expect(empty).not.toContain("Cadastre o primeiro");
    expect(empty).toContain('role="status"');
    const sentence = EMPTY_SENTENCE.exec(empty)?.[1];
    expect(sentence?.length).toBeLessThanOrEqual(60);
    // the button that creates is the title line's: the empty list only says what is missing
    expect(empty).not.toContain("<button");
    expect(empty).not.toContain("Novo cliente");
    const archived = render({ customers: [], status: "archived", total: 0 });
    expect(archived).toContain("Nenhum cliente arquivado.");
    expect(archived).toContain("data-empty-state");
    expect(archived).toContain('role="status"');
    expect(archived).not.toContain("<button");
  });

  it("says what was searched when no customer matches, instead of saying there are none", () => {
    const html = render({ customers: [], query: " bia ", total: 3 });
    expect(html).toContain("Nenhum cliente com “bia”.");
    expect(html).not.toContain("Nenhum cliente ainda");
    expect(html).not.toContain("Novo cliente</button>");
  });

  it("opens the customer from the row: the name is an 'Editar …' button beside the menu, never around it", () => {
    const html = render();
    expect(html).toMatch(ROW_BUTTON_ANA);
    expect(html).not.toMatch(BUTTON_IN_BUTTON);
    expect(html).toContain('aria-label="Mais ações para Ana Lima"');
  });

  it("keeps a locked row focusable, with its reason, and an anonymized one with no button", () => {
    const ana = customer(1, "Ana Lima");
    const html = render({
      syncStates: new Map([[ana.id, { state: "pending" } as PendingCustomer]]),
    });
    const tag = ROW_BUTTON_TAG.exec(html)?.[0] ?? "missing";
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).toContain(
      `aria-describedby="customer-support-${ana.id} customer-locked-${ana.id}"`
    );
    expect(html).toContain(`id="customer-locked-${ana.id}"`);

    const gone = render({
      customers: [
        customer(2, "Cliente anonimizado", {
          anonymizedAt: "2026-10-14T12:00:00.000Z",
        }),
      ],
    });
    expect(gone).not.toContain("data-row-open");
  });

  it("describes the row button by its state badge and its contacts, both drawn with those ids", () => {
    const bia = customer(2, "Bia Souza", {
      archivedAt: "2026-10-14T12:00:00.000Z",
      email: "bia@exemplo.com",
      status: "archived",
    });
    const html = render({ customers: [bia], status: "archived" });
    const tag = ROW_BUTTON_TAG.exec(html)?.[0] ?? "missing";
    expect(tag).toContain(
      `aria-describedby="customer-state-${bia.id} customer-support-${bia.id}"`
    );
    expect(html).toContain(`id="customer-state-${bia.id}"`);
    expect(html).toContain(`id="customer-support-${bia.id}"`);
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
    expect(html).toContain("(11) 90000-0001</span> · <span");
    expect(html).toContain("ana<wbr/>@exemplo.com</span>");
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("Prefere o WhatsApp.");
    expect(html).not.toContain("Atualizado em");
    expect(html).toContain('data-customer-id="');
  });

  it("quebra o e-mail antes do @ sem mudar o texto, e deixa igual o dado sem @", () => {
    const html = render({
      customers: [
        customer(1, "Ana Lima", { email: "usuario.longo@exemplo.com.br" }),
        customer(2, "Bia Souza", { email: "sem-arroba" }),
        customer(3, "Caio Prado", { email: "@exemplo.com" }),
      ],
    });
    const emails = [
      ...html.matchAll(
        /<span class="inline-block[^"]*">([^<]*(?:<wbr\/>[^<]*)?)<\/span>/g
      ),
    ].map((m) => m[1] ?? "");
    const ana = emails.find((e) => e.includes("usuario"));
    expect(ana).toBe("usuario.longo<wbr/>@exemplo.com.br");
    expect(ana?.split("<wbr/>").join("")).toBe("usuario.longo@exemplo.com.br");
    expect(ana?.match(/<wbr\/>/g)).toHaveLength(1);
    expect(emails).toContain("sem-arroba");
    expect(emails).toContain("@exemplo.com");
    expect(html).not.toContain("sem<wbr");
    expect(html).not.toContain("\u200b");
  });

  it("não repete o selo Ativo em cada linha da aba Ativos", () => {
    const html = render({ customers: [customer(1, "Ana Lima")] });
    expect(html).not.toContain(">Ativo<");
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

  it("links the locked row button to the text of what runs, beside any reason already there", () => {
    const ana = customer(1, "Ana Lima");
    const bia = customer(2, "Bia Souza", { phone: null });
    const running = render({
      customers: [ana, bia],
      pendingAction: `archive:${ana.id}`,
      total: 2,
    });
    const [anaTag, biaTag] =
      running.match(/<button[^>]*data-row-open=""[^>]*>/g) ?? [];
    expect(anaTag).toContain('aria-disabled="true"');
    expect(describedByText(running, anaTag)).toContain("Arquivando…");
    expect(biaTag).not.toContain("customer-pending-");
    expect(running.split("customer-pending-")).toHaveLength(3);

    const idle = render({ customers: [ana, bia], total: 2 });
    expect(idle).not.toContain("customer-pending-");

    const both = render({
      pendingAction: `archive:${ana.id}`,
      syncStates: new Map([[ana.id, { state: "pending" } as PendingCustomer]]),
    });
    expect(ROW_BUTTON_TAG.exec(both)?.[0]).toContain(
      `aria-describedby="customer-support-${ana.id} customer-locked-${ana.id} customer-pending-${ana.id}"`
    );
  });
});
