// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProductsCard } from "./public-catalog-panels";

const none = () => undefined;
const CHOSEN_COUNT = /1 de 2 produtos ativos escolhidos/;

function product(id: string, name: string): ProductReadModel {
  return { id, name } as ProductReadModel;
}

function renderCard() {
  return render(
    <ProductsCard
      feedback={{ error: null, notice: null }}
      onChange={none}
      online
      pending={false}
      planBlocks={false}
      products={[product("a", "Calça jeans"), product("b", "Camiseta")]}
      shown={new Set(["a"])}
    />
  );
}

describe("o bloco Produtos do catálogo público", () => {
  afterEach(cleanup);

  it("diz à vista, em linha própria sob a contagem, o que nunca aparece", () => {
    renderCard();
    const privacy = screen.getByText(
      "Custo, estoque e SKU nunca aparecem no catálogo."
    );
    const count = screen.getByText(CHOSEN_COUNT);
    expect(privacy).not.toBe(count);
    expect(privacy.tagName).toBe("P");
    expect(count.nextElementSibling).toBe(privacy);
  });

  it("sem resultado, a frase fica centrada como nas outras listas", () => {
    renderCard();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Buscar produto" }),
      {
        target: { value: "tenis" },
      }
    );
    const notice = screen.getByText("Nenhum produto com “tenis”.");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.className).toContain("text-center");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("a linha da lista tem py-3, como as outras listas", () => {
    renderCard();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).toContain("py-3");
      expect(row.className).not.toContain("py-2.5");
    }
  });
});
