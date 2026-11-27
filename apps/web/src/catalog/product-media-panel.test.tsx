// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductMediaPanel } from "./product-media-panel";

const listProductMedia = vi.hoisted(() => vi.fn());

vi.mock("../lib/media-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/media-upload")>()),
  listProductMedia,
}));

afterEach(() => {
  cleanup();
  listProductMedia.mockReset();
});

describe("a espera das imagens do produto", () => {
  it("guarda a altura de uma imagem no esqueleto escondido e diz a frase só ao leitor de tela, num status", () => {
    listProductMedia.mockReturnValue(new Promise(() => undefined));
    render(
      <StaticOrganizationProvider
        organization={{
          id: "o1",
          name: "Loja",
          role: "owner",
          timezone: "UTC",
        }}
      >
        <ProductMediaPanel
          organizationId="o1"
          product={{ id: "p1", name: "Camiseta" } as ProductReadModel}
        />
      </StaticOrganizationProvider>
    );
    const phrase = screen.getByText("Carregando imagens…");
    const status = phrase.closest("[role='status']") as HTMLElement;
    expect(phrase.className).toBe("sr-only");
    expect(status.textContent).toBe("Carregando imagens…");
    const shape = status.querySelector('[data-slot="skeleton"]');
    expect(shape?.getAttribute("aria-hidden")).toBe("true");
    expect(shape?.className).toContain("h-24");
  });
});
