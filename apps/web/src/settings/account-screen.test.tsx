// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const address = vi.hoisted(() => ({ search: "" }));
const server = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    on: null as boolean | null,
  };
});

vi.mock("../app-shell/address", () => ({
  replaceAddress: vi.fn(),
  useAddress: () => ({ pathname: "/conta", search: address.search }),
}));

vi.mock("../offline/runtime/enabled", () => ({
  OFFLINE_RUNTIME_ENABLED: true,
}));

vi.mock("../offline/runtime/devices-page", () => ({
  DevicesPage: () => <h2>Aparelhos deste usuário</h2>,
}));

vi.mock("../sign-in/change-password-page", () => ({
  ChangePasswordPage: () => <h2>Trocar senha</h2>,
}));

vi.mock("./settings-tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings-tabs")>()),
  usePasswordOn: () =>
    useSyncExternalStore(
      (listener) => {
        server.listeners.add(listener);
        return () => server.listeners.delete(listener);
      },
      () => server.on
    ),
}));

import { AccountScreen } from "./account-screen";

const CHANGE_PASSWORD = /Trocar senha/;

function answer(on: boolean) {
  act(() => {
    server.on = on;
    for (const listener of server.listeners) {
      listener();
    }
  });
}

function open(search: string) {
  address.search = search;
  server.on = null;
  render(<AccountScreen />);
}

afterEach(() => {
  cleanup();
});

describe("Minha conta enquanto o servidor não disse se a senha está ligada", () => {
  it("sem aba no endereço mostra só o título e a espera: nenhuma aba, nenhum painel, nenhum 'Trocar senha'", () => {
    open("");
    expect(
      screen.getByRole("heading", { level: 1, name: "Minha conta" })
    ).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryAllByRole("tabpanel")).toHaveLength(0);
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
  });

  it("sem aba, a resposta 'desligada' abre Aparelhos, sem Senha", async () => {
    open("");
    answer(false);
    expect(await screen.findByText("Aparelhos deste usuário")).toBeTruthy();
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
    expect(screen.queryByRole("tab", { name: "Senha" })).toBeNull();
  });

  it("sem aba, a resposta 'ligada' abre Senha, com Aparelhos na faixa", async () => {
    open("");
    answer(true);
    expect(await screen.findByText(CHANGE_PASSWORD)).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Senha" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Aparelhos" })).toBeTruthy();
  });

  it("uma aba que o endereço não conhece espera como a ausência de aba", () => {
    open("?aba=nenhuma");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
  });

  it("com aba=senha desenha Senha já na espera, como antes", async () => {
    open("?aba=senha");
    expect(await screen.findByText(CHANGE_PASSWORD)).toBeTruthy();
  });

  it("com aba=aparelhos desenha Aparelhos já na espera, como antes", async () => {
    open("?aba=aparelhos");
    expect(await screen.findByText("Aparelhos deste usuário")).toBeTruthy();
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
  });
});
