// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { emptyDraft, ProductForm } from "./product-form";

const noop = () => undefined;

function drawForm(editing: boolean): HTMLFormElement {
  const { container } = render(
    <ProductForm
      categories={[]}
      categoryRefusal={0}
      draft={{ ...emptyDraft, name: editing ? "Camiseta" : "" }}
      editing={editing}
      onChange={noop}
      onSubmit={noop}
      showRequired={false}
    />
  );
  const form = container.querySelector("form");
  if (!form) {
    throw new Error("no form");
  }
  return form;
}

function sections(form: HTMLElement) {
  return [...form.querySelectorAll("fieldset")].map((fieldset) => {
    const legend = fieldset.querySelector(":scope > legend");
    return {
      controls: [...fieldset.querySelectorAll(CONTROLS)].map(
        (control) => control.id
      ),
      legend: legend?.textContent,
      visible: legend !== null && !legend.classList.contains("sr-only"),
    };
  });
}

const CONTROLS = "input:not([aria-hidden=true]), textarea";
const FOCUSABLE = "input, textarea, button, [role=combobox]";

afterEach(cleanup);

describe("sections of the product form", () => {
  it("splits a new product into Produto, Preço e estoque and the details, each a fieldset named by its legend", () => {
    expect(sections(drawForm(false))).toEqual([
      { controls: ["product-name"], legend: "Produto", visible: true },
      {
        controls: [
          "product-list-price",
          "product-quantity",
          "product-unit-cost",
        ],
        legend: "Preço e estoque",
        visible: true,
      },
      {
        controls: ["product-description"],
        legend: "Mais detalhes",
        visible: false,
      },
    ]);
  });

  it("keeps the edit to Produto and the details, without the opening stock", () => {
    expect(sections(drawForm(true)).map((section) => section.legend)).toEqual([
      "Produto",
      "Mais detalhes",
    ]);
  });

  it("puts one rule between the sections, out of the reading", () => {
    const form = drawForm(false);
    const rules = [...form.querySelectorAll("[data-slot=field-separator]")];
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.getAttribute("aria-hidden")).toBe("true");
      expect(rule.className).toContain("bg-border");
    }
  });

  it("keeps the focus order of the fields as it was, with no positive tabindex", () => {
    const form = drawForm(false);
    const order = [...form.querySelectorAll(FOCUSABLE)].map(
      (element) =>
        element.id ||
        element.getAttribute("aria-label") ||
        element.textContent?.trim()
    );
    expect(order.slice(0, 5)).toEqual([
      "product-name",
      "product-list-price",
      "product-quantity",
      "product-unit-cost",
      "Mais detalhescategoria e descrição",
    ]);
    expect(order.indexOf("product-description")).toBeGreaterThan(4);
    const positive = [...form.querySelectorAll("[tabindex]")].filter(
      (element) => Number(element.getAttribute("tabindex")) > 0
    );
    expect(positive).toEqual([]);
  });
});
