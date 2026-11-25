// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  list: vi.fn(),
  setup: vi.fn(),
}));

vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionReturn: () => true,
  workerAnswers: () => Promise.resolve(false),
}));
vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    organization: { role: "owner", timezone: "America/Sao_Paulo" },
    organizationId: "org-a",
  }),
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    product: { list: server.list },
    publicCatalog: { setup: server.setup },
  },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: (read: () => Promise<unknown>) => read(),
}));
vi.mock("../app-shell/screen-title", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-shell/screen-title")>()),
  useTabActive: () => true,
}));

const { PublicCatalogPage } = await import("./public-catalog-page");

const NO_ANSWER = new TypeError("Failed to fetch");

describe("o catálogo público na primeira leitura", () => {
  beforeEach(() => {
    server.setup.mockReset();
    server.list.mockReset();
    server.setup.mockReturnValue(new Promise(() => undefined));
    server.list.mockReturnValue(new Promise(() => undefined));
  });
  afterEach(cleanup);

  it("desenha o esqueleto dos três blocos, escondido do leitor de tela", () => {
    const { container } = render(<PublicCatalogPage />);
    const skeleton = container.querySelector("[data-catalog-skeleton]");
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(
      skeleton?.querySelectorAll("[data-slot='skeleton']").length
    ).toBeGreaterThan(0);
    expect(
      [...(skeleton?.querySelectorAll("h2") ?? [])].map(
        (heading) => heading.textContent
      )
    ).toEqual(["Perfil público", "Catálogo", "Produtos"]);
  });

  it("diz «Carregando…» só ao leitor de tela, sem texto visível", () => {
    render(<PublicCatalogPage />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Carregando…");
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(screen.getAllByText("Carregando…")).toHaveLength(1);
  });

  it("não deixa nenhum bloco do esqueleto na árvore de acessibilidade", () => {
    render(<PublicCatalogPage />);
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  it("tira o esqueleto quando a leitura falha, deixando só o aviso de erro", async () => {
    server.setup.mockRejectedValue(new Error("boom"));
    server.list.mockResolvedValue({ products: [] });
    const { container } = render(<PublicCatalogPage />);
    await waitFor(() =>
      expect(container.querySelector("[data-catalog-skeleton]")).toBeNull()
    );
    expect(screen.queryByText("Carregando…")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Tentar novamente" })
    ).toBeTruthy();
  });

  it("sem resposta do servidor, não deixa o esqueleto parado na tela", async () => {
    server.setup.mockRejectedValue(NO_ANSWER);
    server.list.mockRejectedValue(NO_ANSWER);
    const { container } = render(<PublicCatalogPage />);
    await waitFor(() =>
      expect(container.querySelector("[data-catalog-skeleton]")).toBeNull()
    );
  });
});
