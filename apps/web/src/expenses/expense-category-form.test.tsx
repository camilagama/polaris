import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog } from "@/ui/dialog";
import { ExpenseCategoryForm } from "./expense-category-form";

const noop = () => undefined;
const save = () => Promise.resolve();
const freight = {
  groupKey: "operational",
  name: "Frete",
} as ExpenseCategoryReadModel;

const render = (editing: ExpenseCategoryReadModel | null) =>
  renderToStaticMarkup(
    <Dialog open>
      <ExpenseCategoryForm
        disabled={false}
        editing={editing}
        feedback={null}
        onCancel={noop}
        onDraftChange={noop}
        onSave={save}
      />
    </Dialog>
  );

const submitButton = (markup: string): string => {
  const tags = markup.match(/<button[^>]*type="submit"[^>]*>[^<]*<\/button>/g);
  expect(tags).toHaveLength(1);
  return tags?.[0] ?? "";
};

describe("the submit button of the category form", () => {
  it("editing says 'Salvar alterações', and still submits", () => {
    const button = submitButton(render(freight));
    expect(button).toContain(">Salvar alterações</button>");
    expect(button).toContain('type="submit"');
  });

  it("creating says 'Adicionar categoria', and still submits", () => {
    const button = submitButton(render(null));
    expect(button).toContain(">Adicionar categoria</button>");
    expect(button).toContain('type="submit"');
  });

  it("never says 'Salvar' alone", () => {
    expect(render(freight)).not.toContain(">Salvar</button>");
    expect(render(null)).not.toContain(">Salvar</button>");
  });
});
