// @vitest-environment happy-dom
import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductVariantsPanel } from "./product-variants-panel";

const getVariants = vi.hoisted(() => vi.fn());

vi.mock("../lib/orpc", () => ({
  orpcClient: { product: { getVariants } },
}));

const noop = () => undefined;

const configured = {
  configured: true,
  options: [],
  productVersion: 3,
  variants: [
    {
      id: "v1",
      isDefault: false,
      listPrice: "50.00",
      sku: "CAM-AZ-P",
      values: [
        { optionName: "color", optionValueName: "Azul" },
        { optionName: "size", optionValueName: "P" },
      ],
      version: 1,
    },
    {
      id: "v2",
      isDefault: false,
      listPrice: "50.00",
      sku: "CAM-AZ-M",
      values: [
        { optionName: "color", optionValueName: "Azul" },
        { optionName: "size", optionValueName: "M" },
      ],
      version: 1,
    },
  ],
} as unknown as ProductVariantConfigurationReadModel;

const HAND_DRAWN_BOX = /(^|\s)(border(-[a-z0-9]+)*|rounded(-[a-z0-9]+)*)(\s|$)/;
const EXTRA_EDGE =
  /(^|\s)(border(-[a-z0-9]+)*|ring(-[a-z0-9]+)*|shadow(-[a-z0-9]+)*)(\s|$)/;

function renderConfiguredList() {
  getVariants.mockResolvedValue(configured);
  render(
    <StaticOrganizationProvider
      organization={{ id: "o1", name: "Loja", role: "owner", timezone: "UTC" }}
    >
      <ProductVariantsPanel
        configurationDraft={null}
        focusVariantId={null}
        onConfigurationDraftChange={noop}
        onProductUpdated={noop}
        organizationId="o1"
        product={{ id: "p1" } as ProductReadModel}
      />
    </StaticOrganizationProvider>
  );
  return screen.findByRole("list", { name: "Variantes cadastradas" });
}

afterEach(() => {
  cleanup();
  getVariants.mockReset();
});

describe("a lista Variantes cadastradas", () => {
  it("põe cada variante em um InsetBlock, sem caixa escrita à mão no contêiner", async () => {
    const list = await renderConfiguredList();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) {
      const block = item.firstElementChild;
      expect(block?.getAttribute("data-slot")).toBe("inset-block");
      expect(item.className).not.toMatch(HAND_DRAWN_BOX);
      expect(block?.className ?? "").not.toMatch(EXTRA_EDGE);
    }
    expect(list.className).not.toMatch(HAND_DRAWN_BOX);
  });

  it("diz cada variante pelas opções e o rótulo delas", async () => {
    const list = await renderConfiguredList();
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Cor: Azul · Tamanho: P");
    expect(items[1]?.textContent).toContain("Cor: Azul · Tamanho: M");
  });
});
