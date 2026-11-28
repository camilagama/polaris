// @vitest-environment happy-dom
import type { CategoryReadModel } from "@polaris/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
const create = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    category: {
      create: (input: unknown) => create(input),
      list: (input: unknown) => list(input),
    },
  },
}));

vi.mock("../lib/motion-level", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/motion-level")>()),
  useMotionLevel: () => "none" as const,
}));

vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionOnline: () => true,
}));

import { TabPanelScope } from "../app-shell/screen-title";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { CategoriesPage } from "./categories-page";

const organizationId = "org_1";
const NAME_FIELD = "Nova categoria";
const ADD_BUTTON = "Adicionar categoria";

function category(name: string): CategoryReadModel {
  return {
    archivedAt: null,
    createdAt: "2026-10-14T12:00:00.000Z",
    deletedAt: null,
    id: "0199c2d0-0000-7000-8000-000000000041",
    name,
    organizationId,
    status: "active",
    updatedAt: "2026-10-14T12:00:00.000Z",
  };
}

function renderPage(inTab = false) {
  const page = <CategoriesPage />;
  return render(
    <StaticOrganizationProvider
      organization={{
        id: organizationId,
        name: "Loja do teste",
        role: "owner",
        timezone: "America/Sao_Paulo",
      }}
    >
      {inTab ? <TabPanelScope>{page}</TabPanelScope> : page}
    </StaticOrganizationProvider>
  );
}

beforeEach(() => {
  list.mockImplementation(() => Promise.resolve({ categories: [] }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the categories screen with an empty list", () => {
  it("keeps the form to create on the screen and takes a name on the first screen", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Nenhuma categoria ativa.");

    const field = screen.getByRole("textbox", { name: NAME_FIELD });
    const add = screen.getByRole("button", { name: ADD_BUTTON });
    expect((add as HTMLButtonElement).disabled).toBe(false);
    expect(add.getAttribute("aria-disabled")).not.toBe("true");

    await user.type(field, "Acessórios");
    expect((field as HTMLInputElement).value).toBe("Acessórios");
    expect(screen.getByText("10/100 caracteres")).toBeTruthy();
  });

  it("sends the name typed on the empty list and says the category was created", async () => {
    const user = userEvent.setup();
    create.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(category(name))
    );
    renderPage();
    await screen.findByText("Nenhuma categoria ativa.");

    await user.type(
      screen.getByRole("textbox", { name: NAME_FIELD }),
      "Acessórios"
    );
    await user.click(screen.getByRole("button", { name: ADD_BUTTON }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Acessórios",
        organizationId,
      })
    );
    expect(
      await screen.findByText("Categoria “Acessórios” adicionada.")
    ).toBeTruthy();
  });
});

describe("the title of the categories screen", () => {
  it("is the h1 of the page, drawn on a line of its own, when the screen stands alone", async () => {
    const { container } = renderPage();
    await screen.findByText("Nenhuma categoria ativa.");
    const title = screen.getByRole("heading", { level: 1, name: "Categorias" });
    expect(title.className).not.toContain("sr-only");
    expect(title.closest("[data-title-line]")?.className).not.toContain(
      "contents"
    );
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("stays only for a screen reader in the tab of Produtos, and its line takes no room", async () => {
    const { container } = renderPage(true);
    await screen.findByText("Nenhuma categoria ativa.");
    const title = screen.getByRole("heading", { level: 2, name: "Categorias" });
    expect(title.className).toContain("sr-only");
    expect(title.closest("[data-title-line]")?.className).toBe("contents");
    expect(container.querySelectorAll("h1")).toHaveLength(0);
  });
});
