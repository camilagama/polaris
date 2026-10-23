import { describe, expect, it } from "vitest";
import {
  categoryActionNotice,
  categoryErrorMessage,
  categoryNameCountLabel,
  categoryNameIsTooLong,
  isCategoryListStatus,
} from "./categories-model";

const refusal = (code: string) => ({ code });

describe("the name of a category", () => {
  it("counts code points, so an emoji is one character", () => {
    expect(categoryNameCountLabel("Camisetas")).toBe("9/100 caracteres");
    expect(categoryNameCountLabel("👕".repeat(3))).toBe("3/100 caracteres");
  });

  it("says how far over the limit it is, and only then", () => {
    expect(categoryNameIsTooLong("a".repeat(100))).toBe(false);
    expect(categoryNameIsTooLong("a".repeat(101))).toBe(true);
    expect(categoryNameCountLabel("a".repeat(101))).toBe(
      "Limite de 100 caracteres excedido (101)."
    );
  });
});

describe("the states of the list", () => {
  it("knows the three tabs and nothing else", () => {
    expect(isCategoryListStatus("active")).toBe(true);
    expect(isCategoryListStatus("archived")).toBe(true);
    expect(isCategoryListStatus("deleted")).toBe(true);
    expect(isCategoryListStatus("all")).toBe(false);
  });
});

describe("what the screen says when a call fails", () => {
  it("separates the name already in use from a state that changed", () => {
    expect(categoryErrorMessage(refusal("CONFLICT"), "create")).toBe(
      "Já existe uma categoria com esse nome nesta organização."
    );
    expect(categoryErrorMessage(refusal("CONFLICT"), "rename")).toBe(
      "Já existe uma categoria com esse nome nesta organização."
    );
    expect(categoryErrorMessage(refusal("CONFLICT"), "archive")).toBe(
      "O estado da categoria mudou. Atualize a lista e tente novamente."
    );
  });

  it("explains a removal that products block and a restore that cannot be", () => {
    expect(categoryErrorMessage(refusal("CONFLICT"), "delete")).toBe(
      "Desvincule os produtos desta categoria antes de removê-la."
    );
    expect(categoryErrorMessage(refusal("CONFLICT"), "restore")).toBe(
      "Categorias removidas não podem ser restauradas."
    );
  });

  it("never says the sentence about the session: the notice of the shell carries it", () => {
    expect(categoryErrorMessage(refusal("UNAUTHORIZED"))).toBe(
      "Não foi possível carregar as categorias."
    );
    expect(categoryErrorMessage(refusal("UNAUTHORIZED"), "create")).toBe(
      "A categoria não foi alterada."
    );
  });

  it("falls back to a sentence that asks to try again", () => {
    expect(categoryErrorMessage(new Error("boom"), "delete")).toBe(
      "Não foi possível concluir a operação. Tente novamente."
    );
    expect(categoryErrorMessage(refusal("SERVICE_UNAVAILABLE"))).toBe(
      "O catálogo está temporariamente indisponível. Tente novamente."
    );
  });
});

describe("the notice of an action that went through", () => {
  it("names the category and the effect", () => {
    expect(categoryActionNotice("archive", "Camisetas", true)).toBe(
      "Categoria “Camisetas” arquivada."
    );
    expect(categoryActionNotice("restore", "Camisetas", true)).toBe(
      "Categoria “Camisetas” restaurada."
    );
    expect(categoryActionNotice("delete", "Camisetas", true)).toContain(
      "o registro de histórico foi preservado"
    );
  });

  it("says when nothing changed", () => {
    expect(categoryActionNotice("archive", "Camisetas", false)).toBe(
      "A categoria “Camisetas” já estava nesse estado."
    );
  });
});
