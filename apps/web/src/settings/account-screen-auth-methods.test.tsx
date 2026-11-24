// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const address = vi.hoisted(() => ({ search: "" }));

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

const LOOKUP_TIMEOUT_MS = 6000;
const CHANGE_PASSWORD = /Trocar senha/;

function authMethodsAnswer(emailPassword: boolean) {
  return new Response(
    JSON.stringify({ emailPassword, google: true, turnstileSiteKey: null }),
    { headers: { "content-type": "application/json" }, status: 200 }
  );
}

/** A request that never answers and only ends when its signal aborts, as a stuck network does. */
function stuckUntilAborted(_input: unknown, init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

/** The module keeps what the server last said for the life of the page; each test opens a page of its own. */
async function openAccountScreen(afterImport: () => void = () => undefined) {
  vi.resetModules();
  const { AccountScreen } = await import("./account-screen");
  afterImport();
  address.search = "";
  render(<AccountScreen />);
}

let timeoutSpy: ReturnType<typeof vi.spyOn>;
const timeoutsAsked: number[] = [];

beforeEach(() => {
  timeoutsAsked.length = 0;
  timeoutSpy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((milliseconds: number) => {
      timeoutsAsked.push(milliseconds);
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("timed out", "TimeoutError")),
        milliseconds
      );
      return controller.signal;
    });
});

afterEach(() => {
  cleanup();
  timeoutSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Minha conta sem aba: o fim da espera do auth-methods", () => {
  it("com a resposta 'senha ligada' sai da espera e abre Senha, com Aparelhos na faixa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => authMethodsAnswer(true))
    );
    await openAccountScreen();
    expect(await screen.findByText(CHANGE_PASSWORD)).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Senha" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Aparelhos" })).toBeTruthy();
  });

  it("com a leitura que falha (rede) sai da espera e abre Aparelhos, sem Senha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")))
    );
    await openAccountScreen();
    expect(await screen.findByText("Aparelhos deste usuário")).toBeTruthy();
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
    expect(screen.queryByRole("tab", { name: "Senha" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("com o servidor que responde 503 sai da espera e abre Aparelhos, sem Senha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    await openAccountScreen();
    expect(await screen.findByText("Aparelhos deste usuário")).toBeTruthy();
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
  });

  it("com a leitura que não responde espera até o teto de 6 s e então abre Aparelhos, sem Senha", async () => {
    vi.stubGlobal("fetch", vi.fn(stuckUntilAborted));
    await openAccountScreen(() =>
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    );
    expect(timeoutsAsked).toEqual([LOOKUP_TIMEOUT_MS]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText("Aparelhos deste usuário")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();
    expect(await screen.findByText("Aparelhos deste usuário")).toBeTruthy();
    expect(screen.queryByText(CHANGE_PASSWORD)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
