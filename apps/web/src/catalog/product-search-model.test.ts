import { describe, expect, it } from "vitest";
import {
  deleteNameKey,
  filterByName,
  productInitials,
  searchKey,
  typedNameMatches,
} from "./product-search-model";

const products = [
  { id: "1", name: "Camiseta do teste" },
  { id: "2", name: "Calça jeans" },
  { id: "3", name: "Boné aba reta" },
];

describe("busca de produtos", () => {
  it("ignora maiúsculas e acentos nos dois lados", () => {
    expect(searchKey("  CALÇA ")).toBe("calca");
    expect(filterByName(products, "calca").map((p) => p.id)).toEqual(["2"]);
    expect(filterByName(products, "BONÉ").map((p) => p.id)).toEqual(["3"]);
    expect(filterByName(products, "bone").map((p) => p.id)).toEqual(["3"]);
  });

  it("acha pelo meio do nome", () => {
    expect(filterByName(products, "ste").map((p) => p.id)).toEqual(["1"]);
  });

  it("texto vazio ou só de espaços mantém todos, na ordem, sem devolver a mesma lista", () => {
    const all = filterByName(products, "   ");
    expect(all.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(all).not.toBe(products);
  });

  it("sem resultado devolve lista vazia", () => {
    expect(filterByName(products, "tênis")).toEqual([]);
  });
});

describe("iniciais do produto", () => {
  it("as duas primeiras letras do nome, em maiúscula, com o acento", () => {
    expect(productInitials("Calça jeans")).toBe("CA");
    expect(productInitials("  tênis casual ")).toBe("TÊ");
    expect(productInitials("X")).toBe("X");
  });
});

describe("nome digitado para excluir um produto", () => {
  it("compara como a regra do nome único: sem maiúsculas, sem espaços repetidos e sem espaço nas pontas", () => {
    expect(
      typedNameMatches("  jaqueta   DE  inverno ", "Jaqueta de inverno")
    ).toBe(true);
    expect(typedNameMatches("Jaqueta de inverno", "Jaqueta de inverno")).toBe(
      true
    );
  });

  it("nome diferente, parcial ou vazio não confirma", () => {
    expect(typedNameMatches("Jaqueta", "Jaqueta de inverno")).toBe(false);
    expect(typedNameMatches("Jaqueta de inverno 2", "Jaqueta de inverno")).toBe(
      false
    );
    expect(typedNameMatches("", "Jaqueta de inverno")).toBe(false);
    expect(typedNameMatches("   ", "Jaqueta de inverno")).toBe(false);
  });

  it("o espaço sem quebra é um caractere do nome: o banco não o junta ao espaço comum", () => {
    expect(deleteNameKey("a b")).not.toBe(deleteNameKey("a b"));
  });
});
