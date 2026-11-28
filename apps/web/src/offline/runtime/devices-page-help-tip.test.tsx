// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/orpc", () => ({
  orpcClient: { device: { list: () => new Promise(() => undefined) } },
}));
vi.mock("../../sign-in/sign-in-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sign-in/sign-in-model")>()),
  loadAuthMethods: () => new Promise(() => undefined),
}));
vi.mock("./runtime-context", () => ({
  useOfflineRuntime: () => null,
  useRuntimeSnapshot: () => null,
}));
vi.mock("../../app-shell/screen-title", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app-shell/screen-title")>()),
  useTabActive: () => true,
}));

const { DevicesPage } = await import("./devices-page");

const FIRST_SENTENCE = "Os aparelhos em que você usa o Polaris offline.";
const SECOND_SENTENCE =
  "Se perdeu um celular ou computador, revogue o aparelho: o servidor deixa de aceitar o que ele enviar.";

describe("o (i) Sobre Aparelhos da tela de aparelhos", () => {
  afterEach(cleanup);

  it("abre com as duas frases e não deixa texto sob o título", () => {
    const { container } = render(<DevicesPage />);
    expect(container.querySelector("header p")).toBeNull();
    expect(container.textContent).not.toContain(FIRST_SENTENCE);
    fireEvent.click(screen.getByRole("button", { name: "Sobre Aparelhos" }));
    expect(
      screen.getByText(`${FIRST_SENTENCE} ${SECOND_SENTENCE}`)
    ).toBeTruthy();
  });
});
