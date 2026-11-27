// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import { ProductVariantSkuSection } from "./product-variant-sku-section";
import {
  ADD_AT_LIMIT,
  ADD_NEEDS_VALUES,
  addCombinationReason,
  emptyConfigurationDraft,
  MAX_VARIANTS,
  type VariantConfigurationDraft,
} from "./product-variants-model";

const readPlan = vi.hoisted(() => vi.fn());
const configureVariants = vi.hoisted(() => vi.fn());

vi.mock("../lib/orpc", () => ({
  orpcClient: { billing: { readPlan }, product: { configureVariants } },
}));

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
  configureVariants.mockReset();
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
const MARQUE_AO_MENOS = /Marque ao menos uma opção/;

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

  it("is off while an option has no values, and the sentence under it says why", () => {
    show(null);
    const row = screen.getByRole("button", ADD_ROW);
    const reason = screen.getByText(ADD_NEEDS_VALUES);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect((row as HTMLButtonElement).disabled).toBe(false);
    expect(row.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.id).not.toBe("");
    expect(row.nextElementSibling).toBe(reason);
  });

  it("does not add a combination on a tap while it is off", () => {
    show(null);
    fireEvent.click(screen.getByRole("button", ADD_ROW));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("Nenhuma combinação adicionada.")).toBeTruthy();
  });

  it("is off at the limit, with the sentence of the limit and the number of MAX_VARIANTS", () => {
    show(null, {
      ...withOptions,
      variants: Array.from({ length: MAX_VARIANTS }, () => ({
        values: { color: "Azul" },
      })),
    });
    const row = screen.getByRole("button", ADD_ROW);
    const reason = screen.getByText(ADD_AT_LIMIT);
    expect(ADD_AT_LIMIT).toContain(String(MAX_VARIANTS));
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("aria-describedby")).toBe(reason.id);
    expect(screen.queryByText(ADD_NEEDS_VALUES)).toBeNull();
    fireEvent.click(row);
    expect(screen.getAllByRole("listitem")).toHaveLength(MAX_VARIANTS);
  });

  it("is really disabled, with no sentence, while the save is in flight", async () => {
    configureVariants.mockReturnValue(new Promise(noop));
    const colors = Array.from({ length: MAX_VARIANTS }, (_, i) => `C${i}`);
    show(null, {
      ...withOptions,
      valueLines: {
        ...emptyConfigurationDraft.valueLines,
        color: colors.join("\n"),
      },
      variants: colors.map((color) => ({ values: { color } })),
    });
    const row = screen.getByRole("button", ADD_ROW);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Salvar variantes" }));
    await screen.findByRole("button", { name: "Salvando…" });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.hasAttribute("aria-disabled")).toBe(false);
    expect(row.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText(ADD_AT_LIMIT)).toBeNull();
  });

  const heardBy = (button: HTMLElement) =>
    (button.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  const NEEDS_OPTION = "Marque ao menos uma opção para começar.";
  const reasons = [
    {
      draft: { ...emptyConfigurationDraft },
      heard: NEEDS_OPTION,
      name: "no_options",
    },
    {
      draft: {
        ...emptyConfigurationDraft,
        selectedOptions: ["color" as const],
      },
      heard: ADD_NEEDS_VALUES,
      name: "missing_values",
    },
    {
      draft: {
        ...withOptions,
        valueLines: { ...withOptions.valueLines, color: "Azul\nazul" },
      },
      heard: "Corrija os valores das opções para adicionar combinações.",
      name: "invalid_values",
    },
    {
      draft: {
        ...withOptions,
        variants: Array.from({ length: MAX_VARIANTS }, () => ({
          values: { color: "Azul" },
        })),
      },
      heard: ADD_AT_LIMIT,
      name: "limit",
    },
  ];

  it.each(reasons)(
    "$name: the reader hears the sentence of the cause through aria-describedby",
    ({ draft, heard }) => {
      show(null, draft);
      const row = screen.getByRole("button", ADD_ROW);
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(heardBy(row)).toBe(heard);
    }
  );

  it("no_options: the sentence at the top is the only one, and the button points to it", () => {
    show(null, emptyConfigurationDraft);
    const row = screen.getByRole("button", ADD_ROW);
    const sentences = screen.getAllByText(MARQUE_AO_MENOS);
    expect(sentences).toHaveLength(1);
    expect(row.getAttribute("aria-describedby")).toBe(sentences[0]?.id);
    expect(sentences[0]?.id).not.toBe("");
    expect(row.nextElementSibling).not.toBe(sentences[0]);
    expect(addCombinationReason("no_options")).toBeNull();
  });

  it("no_options with combinations still in the list: the button still points to the top sentence", () => {
    show(null, { ...emptyConfigurationDraft, variants: [{ values: {} }] });
    const row = screen.getByRole("button", ADD_ROW);
    expect(heardBy(row)).toBe(NEEDS_OPTION);
    expect(screen.getAllByText(MARQUE_AO_MENOS)).toHaveLength(1);
  });

  it("the other causes keep the sentence right under the button", () => {
    for (const { draft, heard, name } of reasons.slice(1)) {
      show(null, draft);
      const row = screen.getByRole("button", ADD_ROW);
      expect(row.nextElementSibling?.textContent, name).toBe(heard);
      cleanup();
    }
  });

  it.each(reasons)(
    "$name: Enter on the button that is off adds nothing and the focus stays on it",
    async ({ draft }) => {
      const user = userEvent.setup();
      show(null, draft);
      const row = screen.getByRole("button", ADD_ROW);
      row.focus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      expect(screen.queryAllByRole("listitem")).toHaveLength(
        draft.variants.length
      );
      expect(document.activeElement).toBe(row);
    }
  );

  it("changes nothing while a combination can be added: no sentence, no attribute", () => {
    show(null, withOptions);
    const row = screen.getByRole("button", ADD_ROW);
    expect(row.hasAttribute("aria-disabled")).toBe(false);
    expect(row.hasAttribute("aria-describedby")).toBe(false);
    expect((row as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(ADD_NEEDS_VALUES)).toBeNull();
    expect(screen.queryByText(ADD_AT_LIMIT)).toBeNull();
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

  it("reads the value of each known class: 1 until its condition holds, then what the class says", () => {
    const withClass = (name: string, tag = "div") => {
      const element = document.createElement(tag);
      element.className = name;
      return element;
    };
    const disabledChild = () => {
      const child = document.createElement("span");
      child.setAttribute("data-disabled", "");
      return child;
    };
    const asked: string[] = [];
    const read = (
      name: string,
      off: Element,
      on: Element,
      expected: number
    ) => {
      asked.push(name);
      expect(opacityOf(off), `${name} off`).toBe(1);
      expect(opacityOf(on), `${name} on`).toBe(expected);
    };

    const holder = withClass(FADES_WHOLE);
    const holderOn = withClass(FADES_WHOLE);
    holderOn.append(disabledChild());
    read(FADES_WHOLE, holder, holderOn, 0.5);

    const alone = withClass(BOX_FADES_ALONE);
    const aloneOn = withClass(BOX_FADES_ALONE);
    aloneOn.setAttribute("data-disabled", "");
    read(BOX_FADES_ALONE, alone, aloneOn, 0.5);

    const stays = `${BOX_FADES_ALONE} ${BOX_STAYS_AT_1}`;
    const stayOff = withClass(stays);
    stayOff.setAttribute("data-disabled", "");
    const stayOn = withClass(stays);
    stayOn.setAttribute("data-disabled", "");
    const label = document.createElement("label");
    label.append(stayOn);
    expect(opacityOf(stayOff), "the box alone fades").toBe(0.5);
    expect(opacityOf(stayOn), "the box in a label with a disabled child").toBe(
      1
    );
    asked.push(BOX_STAYS_AT_1);

    const peer = document.createElement("input");
    peer.className = "peer";
    const afterPeer = withClass(AFTER_DISABLED_PEER, "label");
    document.createElement("div").append(peer, afterPeer);
    const peerOff = opacityOf(afterPeer);
    peer.disabled = true;
    expect(peerOff, `${AFTER_DISABLED_PEER} off`).toBe(1);
    expect(opacityOf(afterPeer), `${AFTER_DISABLED_PEER} on`).toBe(0.5);
    asked.push(AFTER_DISABLED_PEER);

    for (const [name, group] of [
      [IN_DISABLED_GROUP, "group"],
      [IN_DISABLED_FIELD, "group/field"],
    ] as const) {
      const owner = withClass(group);
      const inside = withClass(name, "span");
      owner.append(inside);
      owner.setAttribute("data-disabled", "false");
      expect(opacityOf(inside), `${name} off`).toBe(1);
      owner.setAttribute("data-disabled", "true");
      expect(opacityOf(inside), `${name} on`).toBe(0.5);
      asked.push(name);
    }

    expect(asked.sort()).toEqual([...KNOWN_OPACITY_CLASSES].sort());
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
