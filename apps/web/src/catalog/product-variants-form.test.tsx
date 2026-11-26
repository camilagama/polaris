// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import { ProductVariantSkuSection } from "./product-variant-sku-section";
import {
  emptyConfigurationDraft,
  type VariantConfigurationDraft,
} from "./product-variants-model";

const readPlan = vi.hoisted(() => vi.fn());

vi.mock("../lib/orpc", () => ({ orpcClient: { billing: { readPlan } } }));

const noop = () => undefined;
const configuration = (sku: string | null) => ({
  configured: false as const,
  options: [],
  productId: "p1",
  productVersion: 1,
  variants: [
    {
      id: "v1",
      isDefault: true,
      listPrice: null,
      position: null,
      sku,
      values: [],
      version: 1,
    },
  ],
});

afterEach(() => {
  cleanup();
  readPlan.mockReset();
});

const formOf = (
  sku: string | null,
  draft: VariantConfigurationDraft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
  },
  billingSelfService = false
) => (
  <StaticOrganizationProvider
    billingSelfService={billingSelfService}
    organization={{ id: "o1", name: "Loja", role: "owner", timezone: "UTC" }}
  >
    <ProductVariantConfigurationForm
      configuration={configuration(sku)}
      draft={draft}
      onConfigured={noop}
      onConflict={noop}
      onDraftChange={noop}
      onSkuCleared={noop}
      organizationId="o1"
      product={{ id: "p1" } as ProductReadModel}
    />
  </StaticOrganizationProvider>
);

function draw(
  sku: string | null,
  draft: VariantConfigurationDraft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
  }
) {
  return renderToStaticMarkup(formOf(sku, draft));
}

const show = (
  sku: string | null,
  draft: VariantConfigurationDraft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
  },
  billingSelfService = false
) => render(formOf(sku, draft, billingSelfService));

describe("warning of the SKU of the default variant", () => {
  it("the button that clears it names the SKU that will be erased", () => {
    const markup = draw("ABC-123");
    expect(markup).toContain(
      "Limpe o SKU da variante padrão antes de configurar opções"
    );
    expect(markup).toContain(
      "Limpar SKU &quot;ABC-123&quot; da variante padrão"
    );
    expect(markup).not.toContain(">Limpar SKU da variante padrão<");
  });

  it("without a SKU there is no warning and no button", () => {
    expect(draw(null)).not.toContain("Limpar SKU");
  });
});

const drawValues = (colorLines: string) =>
  draw(null, {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: colorLines },
  });

describe("the error of the values of an option", () => {
  it("says the count over the limit as a polite status, so each key does not interrupt the reader", () => {
    const markup = drawValues(`Azul\n${"a".repeat(81)}`);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("A linha 2 tem 81.");
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(
      'aria-describedby="product-variant-values-color-error'
    );
  });

  it("keeps the other errors of the values as an alert", () => {
    const markup = drawValues("Azul\nazul");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Remova valores repetidos nesta opção.");
    expect(markup).not.toContain('role="status"');
  });
});

describe("the error of the SKU over the limit", () => {
  it("is a polite status with the count, and the field and the button point to it", () => {
    const markup = renderToStaticMarkup(
      <ProductVariantSkuSection
        configuration={configuration("A".repeat(71))}
        onConflict={noop}
        onUpdated={noop}
        organizationId="o1"
        productId="p1"
      />
    );
    expect(markup).toContain("Use até 64 caracteres. Agora são 71.");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-disabled="true"');
  });
});

describe("Adicionar todas as combinações", () => {
  it("names on the button how many combinations it adds, and reads nothing before the tap", () => {
    const markup = draw(null, {
      ...emptyConfigurationDraft,
      selectedOptions: ["size", "color"],
      valueLines: {
        ...emptyConfigurationDraft.valueLines,
        color: "Preta\nBranca\nAzul",
        size: "P\nM\nG\nGG",
      },
    });
    expect(markup).toContain("Adicionar todas as combinações (12)");
    expect(markup).toContain(
      'nada é salvo antes de "Salvar variantes"'.replaceAll('"', "&quot;")
    );
  });

  it("is off, without a count, while an option has no values", () => {
    show(null);
    const addAll = screen.getByRole("button", {
      name: "Adicionar todas as combinações",
    });
    expect((addAll as HTMLButtonElement).disabled).toBe(true);
  });
});

const ADD_ALL = /^Adicionar todas as combinações/;
const ADD_ROW = { name: "Adicionar combinação" };

describe("Adicionar combinação, the last row of the list", () => {
  const withOptions = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color" as const],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: "Azul" },
  };
  const order = (node: Node) =>
    [...document.body.querySelectorAll("*")].indexOf(node as Element);
  const follows = (before: Node, after: Node) => order(before) < order(after);

  it("is a button, outside the list, and sits right under the empty-list sentence", () => {
    show(null, withOptions);
    const sentence = screen.getByText("Nenhuma combinação adicionada.");
    const row = screen.getByRole("button", ADD_ROW);
    expect(row.getAttribute("type")).toBe("button");
    expect(row.closest("ol")).toBeNull();
    expect(follows(sentence, row)).toBe(true);
    expect(sentence.parentElement).toBe(row.parentElement);
    expect(sentence.nextElementSibling).toBe(row);
  });

  it("stays after the last combination and before the other actions", () => {
    show(null, {
      ...withOptions,
      variants: [{ values: { color: "Azul" } }],
    });
    const list = screen.getByRole("list");
    const row = screen.getByRole("button", ADD_ROW);
    const addAll = screen.getByRole("button", {
      name: ADD_ALL,
    });
    expect(follows(list, row)).toBe(true);
    expect(list.contains(row)).toBe(false);
    expect(follows(row, addAll)).toBe(true);
    expect(list.nextElementSibling).toBe(row);
  });

  it("is off, as before, while an option has no values", () => {
    show(null);
    expect(
      (screen.getByRole("button", ADD_ROW) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

describe("each combination of the list", () => {
  const withRows = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color" as const],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: "Azul" },
    variants: [{ values: { color: "Azul" } }, { values: { color: "Azul" } }],
  };

  it("is a field group named by its badge, so the reader says which combination the fields belong to", () => {
    show(null, withRows);
    for (const number of [1, 2]) {
      const group = screen.getByRole("group", {
        name: `Combinação ${number}`,
      });
      expect(group.getAttribute("data-slot")).toBe("field-group");
      expect(group.tagName).toBe("FIELDSET");
    }
  });
});

const FADES_WHOLE = "has-data-disabled:opacity-50";
const BOX_STAYS_AT_1 = "group-has-data-disabled/label:opacity-100!";
const BOX_FADES_ALONE = "data-disabled:opacity-50";
const AFTER_DISABLED_PEER = "peer-disabled:opacity-50";
const IN_DISABLED_GROUP = "group-data-[disabled=true]:opacity-50";
const IN_DISABLED_FIELD = "group-data-[disabled=true]/field:opacity-50";
const OPACITY_UTILITY = /(^|:)!?opacity-/;
const KNOWN_OPACITY_CLASSES = [
  FADES_WHOLE,
  BOX_STAYS_AT_1,
  BOX_FADES_ALONE,
  AFTER_DISABLED_PEER,
  IN_DISABLED_GROUP,
  IN_DISABLED_FIELD,
];

const insideDisabledGroup = (element: Element, group: string) => {
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (
      ancestor.classList.contains(group) &&
      ancestor.getAttribute("data-disabled") === "true"
    ) {
      return true;
    }
  }
  return false;
};

const followsDisabledPeer = (element: Element) => {
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.classList.contains("peer") && sibling.matches(":disabled")) {
      return true;
    }
  }
  return false;
};

/**
 * Tailwind is not compiled here: the opacity of each element of the row is read from the classes it renders, with the
 * rule each variant has in the generated CSS (`has-data-disabled` holds a disabled child, `data-disabled` is on the
 * element itself, `group-has-data-disabled/label` is a label above that holds one), and the chain is multiplied the
 * way the browser stacks it (`peer-disabled` is a disabled `.peer` sibling before it, `group-data-[disabled=true]` an
 * ancestor `.group` carrying `data-disabled="true"`, and `/field` the ancestor named `group/field`). An opacity class
 * this table does not know throws, so a new way of fading the row has to be taught here instead of silently
 * counting as 1.
 */
function opacityOf(element: Element): number {
  for (const name of element.classList) {
    if (OPACITY_UTILITY.test(name) && !KNOWN_OPACITY_CLASSES.includes(name)) {
      throw new Error(
        `opacityOf does not know the opacity class "${name}"; add its rule to the table`
      );
    }
  }
  const rules = [
    {
      important: false,
      matches: element.querySelector("[data-disabled]") !== null,
      name: FADES_WHOLE,
      value: 0.5,
    },
    {
      important: false,
      matches: element.hasAttribute("data-disabled"),
      name: BOX_FADES_ALONE,
      value: 0.5,
    },
    {
      important: true,
      matches: Boolean(
        element.parentElement
          ?.closest("label")
          ?.querySelector("[data-disabled]")
      ),
      name: BOX_STAYS_AT_1,
      value: 1,
    },
    {
      important: false,
      matches: followsDisabledPeer(element),
      name: AFTER_DISABLED_PEER,
      value: 0.5,
    },
    {
      important: false,
      matches: insideDisabledGroup(element, "group"),
      name: IN_DISABLED_GROUP,
      value: 0.5,
    },
    {
      important: false,
      matches: insideDisabledGroup(element, "group/field"),
      name: IN_DISABLED_FIELD,
      value: 0.5,
    },
  ].filter((rule) => rule.matches && element.classList.contains(rule.name));
  const important = rules.filter((rule) => rule.important);
  return (important.length > 0 ? important : rules).at(-1)?.value ?? 1;
}

describe("opacityOf", () => {
  it("throws naming an opacity class it has no rule for", () => {
    for (const name of [
      "peer-disabled:opacity-25",
      "group-data-[disabled=true]/label:opacity-50",
      "aria-disabled:opacity-50",
    ]) {
      const element = document.createElement("div");
      element.className = `flex ${FADES_WHOLE} ${name}`;
      expect(() => opacityOf(element)).toThrow(name);
    }
  });

  it("reads the opacity classes that depend on a disabled peer or group from the tree", () => {
    const group = document.createElement("div");
    group.className = "group/field";
    group.setAttribute("data-disabled", "true");
    const box = document.createElement("span");
    box.className = IN_DISABLED_FIELD;
    group.append(box);
    expect(opacityOf(box)).toBe(0.5);
    group.setAttribute("data-disabled", "false");
    expect(opacityOf(box)).toBe(1);

    const peer = document.createElement("input");
    peer.className = "peer";
    const label = document.createElement("label");
    label.className = AFTER_DISABLED_PEER;
    document.createElement("div").append(peer, label);
    expect(opacityOf(label)).toBe(1);
    peer.disabled = true;
    expect(opacityOf(label)).toBe(0.5);
  });

  it("still reads 1 for an element with no opacity class and the known ones", () => {
    const plain = document.createElement("div");
    plain.className = "flex gap-2";
    expect(opacityOf(plain)).toBe(1);
    const known = document.createElement("div");
    known.className = KNOWN_OPACITY_CLASSES.join(" ");
    known.setAttribute("data-disabled", "");
    expect(() => opacityOf(known)).not.toThrow();
  });
});

const rowOpacity = (box: Element) =>
  opacityOf(box.closest("label") ?? box) * opacityOf(box);

describe("the row of an option while the form is busy", () => {
  const draft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color" as const],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: "Azul\nPreta" },
  };

  it("fades whole, label and box at 50%, never the box alone and never 25%", () => {
    readPlan.mockReturnValue(new Promise(() => undefined));
    show(null, draft, true);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(1);
    for (const box of boxes) {
      expect(rowOpacity(box), "idle").toBe(1);
    }
    const readsBefore = readPlan.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: ADD_ALL }));
    expect(readPlan.mock.calls.length).toBeGreaterThan(readsBefore);
    for (const box of boxes) {
      const label = box.closest("label");
      expect(label, "the box is inside a label").not.toBeNull();
      if (!label) {
        continue;
      }
      expect(box.hasAttribute("data-disabled")).toBe(true);
      expect(label.classList.contains(FADES_WHOLE)).toBe(true);
      expect(box.classList.contains(BOX_STAYS_AT_1)).toBe(true);
      expect(opacityOf(label), "label").toBe(0.5);
      expect(opacityOf(box), "box").toBe(1);
      expect(rowOpacity(box)).toBe(0.5);
    }
  });
});
