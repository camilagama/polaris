import type { CategoryReadModel } from "@polaris/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryList } from "./category-list";

/**
 * The list of the categories screen, drawn without a browser: what each state says and what each row carries. The menu
 * opens in a popup (Base UI), so its items are proved in the browser (e2e/lote-2-telas.e2e.ts); here is the trigger,
 * its name and whether it is off.
 */
const category = (
  n: number,
  name: string,
  status: CategoryReadModel["status"] = "active"
): CategoryReadModel => ({
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  id: `0199c2d0-0000-7000-8000-0000000000${40 + n}`,
  name,
  organizationId: "org",
  status,
  updatedAt: "2026-10-14T12:00:00.000Z",
});

const noop = () => undefined;
type Props = ComponentProps<typeof CategoryList>;
const base: Props = {
  categories: [category(1, "Camisetas"), category(2, "Calçados")],
  isLoading: false,
  onArchive: noop,
  onDelete: noop,
  onDeleteCancel: noop,
  onDeleteStart: noop,
  onRenameCancel: noop,
  onRenameChange: noop,
  onRenameStart: noop,
  onRenameSubmit: noop,
  onRestore: noop,
  pendingAction: null,
  pendingDeleteId: null,
  renameValue: "",
  renamingCategoryId: null,
  status: "active",
};
const render = (overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(<CategoryList {...base} {...overrides} />);

const OFF = ' disabled=""';
// the id is in an attribute, for the tests; the text of a row never shows it (it was the first eight characters)
const ID_AS_TEXT = />s*0199c2d0/;
/** The trigger of the menu of a category, as drawn: its tag, to say whether it is off. */
function menuTrigger(markup: string, name: string): string {
  const tag = new RegExp(
    `<button[^>]*aria-label="Mais ações para ${name}"[^>]*>`
  ).exec(markup);
  if (!tag) {
    throw new Error(`no menu for ${name}`);
  }
  return tag[0];
}

describe("the list of categories", () => {
  it("says it is loading, and shows no row", () => {
    const html = render({ isLoading: true });
    expect(html).toContain("Carregando categorias…");
    expect(html).not.toContain("Camisetas");
  });

  it("tells each tab what an empty list means", () => {
    expect(render({ categories: [] })).toContain(
      "Nenhuma categoria ativa. Adicione a primeira do catálogo."
    );
    expect(render({ categories: [], status: "archived" })).toContain(
      "Não há categorias arquivadas."
    );
    expect(render({ categories: [], status: "deleted" })).toContain(
      "Não há categorias removidas."
    );
  });

  it("draws a row with the state in words, the date, and a menu named after the category, with no code", () => {
    const html = render();
    expect(menuTrigger(html, "Camisetas")).not.toContain(OFF);
    expect(html).toContain("Ativa");
    expect(html).toContain("Atualizada em");
    expect(html).not.toMatch(ID_AS_TEXT);
  });

  it("says Arquivada in words on an archived one", () => {
    const html = render({
      categories: [category(1, "Camisetas", "archived")],
      status: "archived",
    });
    expect(html).toContain("Arquivada");
  });

  it("keeps a removed category read only: the reason in words and no menu", () => {
    const html = render({
      categories: [category(1, "Camisetas", "deleted")],
      status: "deleted",
    });
    expect(html).toContain("Removida");
    expect(html).toContain("Histórico preservado; não pode ser restaurada.");
    expect(html).not.toContain("Mais ações para");
  });

  it("turns the row that is being renamed into a form with the current name and its count", () => {
    const html = render({
      renameValue: "Camisetas",
      renamingCategoryId: category(1, "Camisetas").id,
    });
    expect(html).toContain("Novo nome para Camisetas");
    expect(html).toContain('value="Camisetas"');
    expect(html).toContain("9/100 caracteres");
    // the other row is untouched
    expect(menuTrigger(html, "Calçados")).toBeTruthy();
  });

  it("marks a name over the limit in the rename form", () => {
    const html = render({
      renameValue: "a".repeat(101),
      renamingCategoryId: category(1, "Camisetas").id,
    });
    expect(html).toContain("Limite de 100 caracteres excedido (101).");
    expect(html).toContain('aria-invalid="true"');
  });

  it("asks again before a removal, in the row, naming the category and what stays", () => {
    const html = render({ pendingDeleteId: category(2, "Calçados").id });
    expect(html).toContain("Confirmar remoção de Calçados");
    expect(html).toContain("Ela some da lista e não pode ser restaurada.");
    expect(html).toContain("O histórico de vendas continua igual.");
    expect(html).toContain("“Calçados”");
    expect(html).toContain("Remover categoria</button>");
  });

  it("says what a row is doing, and locks the menu of that row while it does", () => {
    const html = render({
      pendingAction: `archive:${category(1, "Camisetas").id}`,
    });
    expect(html).toContain("Atualizando…");
    expect(menuTrigger(html, "Camisetas")).toContain(OFF);
    expect(menuTrigger(html, "Calçados")).not.toContain(OFF);
  });
});
