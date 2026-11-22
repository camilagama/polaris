// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import { emptyConfigurationDraft } from "./product-variants-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const noop = () => undefined;

const form = () => (
  <StaticOrganizationProvider
    organization={{ id: "o1", name: "Loja", role: "owner", timezone: "UTC" }}
  >
    <ProductVariantConfigurationForm
      configuration={{
        configured: false,
        options: [],
        productVersion: 1,
        variants: [],
      }}
      draft={{
        ...emptyConfigurationDraft,
        selectedOptions: ["color"],
        valueLines: { ...emptyConfigurationDraft.valueLines, color: "Azul" },
      }}
      onConfigured={noop}
      onConflict={noop}
      onDraftChange={noop}
      onSkuCleared={noop}
      organizationId="o1"
      product={{ id: "p1" } as ProductReadModel}
    />
  </StaticOrganizationProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("o foco da combinação que acabou de nascer", () => {
  it("fica na segunda combinação depois de dois cliques seguidos, sem render entre eles", () => {
    render(form());
    const add = screen.getByRole("button", { name: "Adicionar combinação" });
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    act(() => {
      vi.runAllTimers();
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.contains(document.activeElement)).toBe(true);
    expect(rows[0]?.contains(document.activeElement)).toBe(false);
  });

  it("vai ao primeiro campo da combinação de um clique só", () => {
    render(form());
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Adicionar combinação" })
      );
    });
    act(() => {
      vi.runAllTimers();
    });
    const [row] = screen.getAllByRole("listitem");
    expect(row?.contains(document.activeElement)).toBe(true);
  });
});
