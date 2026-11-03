import { describe, expect, it } from "vitest";
import {
  countLineShown,
  LIST_PAGE_SIZE,
  listCountText,
  listPage,
  shownListCount,
} from "./list-page-model";

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
  it("tem lugar enquanto carrega e enquanto há linhas, e some só na lista vazia ou com erro", () => {
    expect(countLineShown(true, false, 0)).toBe(true);
    expect(countLineShown(false, true, 3)).toBe(true);
    expect(countLineShown(false, true, 0)).toBe(false);
    expect(countLineShown(false, false, 3)).toBe(false);
  });

  it("fica vazia quando a busca não acha nada ou a lista não está à vista", () => {
    expect(shownListCount(true, 0, 1248, "tenis", PRODUCT)).toBeNull();
    expect(shownListCount(false, 3, 3, "", PRODUCT)).toBeNull();
    expect(shownListCount(true, 3, 3, "", PRODUCT)).toBe("3 produtos");
  });

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
