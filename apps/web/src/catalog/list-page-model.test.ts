import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE, listCountText, listPage } from "./list-page-model";

const rows = (count: number) => Array.from({ length: count }, (_, i) => i);
const PRODUCT = ["produto", "produtos"] as const;

describe("uma página da lista", () => {
  it("desenha 50 de cada vez e diz se sobram", () => {
    expect(LIST_PAGE_SIZE).toBe(50);
    const first = listPage(rows(1248), LIST_PAGE_SIZE);
    expect(first.items).toEqual(rows(50));
    expect(first.hasMore).toBe(true);
    const second = listPage(rows(1248), 2 * LIST_PAGE_SIZE);
    expect(second.items).toHaveLength(100);
    expect(second.items.at(-1)).toBe(99);
  });

  it("exatamente uma página, ou menos, não oferece mais", () => {
    expect(listPage(rows(50), LIST_PAGE_SIZE).hasMore).toBe(false);
    expect(listPage(rows(51), LIST_PAGE_SIZE).hasMore).toBe(true);
    expect(listPage(rows(3), LIST_PAGE_SIZE)).toEqual({
      hasMore: false,
      items: [0, 1, 2],
    });
  });
});

describe("a contagem no alto da lista", () => {
  it("diz o total com separador de milhar, no singular e no plural", () => {
    expect(listCountText(1248, 1248, "", PRODUCT)).toBe("1.248 produtos");
    expect(listCountText(1, 1, "", PRODUCT)).toBe("1 produto");
    expect(listCountText(12, 12, "  ", PRODUCT)).toBe("12 produtos");
  });

  it("com busca, diz quantos acharam de quantos há", () => {
    expect(listCountText(37, 1248, "camisa", PRODUCT)).toBe(
      "37 de 1.248 produtos"
    );
    expect(listCountText(1203, 12_480, "a", PRODUCT)).toBe(
      "1.203 de 12.480 produtos"
    );
  });
});
