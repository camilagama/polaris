import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CancelLink } from "./change-password-page";

// the client of the server reads `window` when it loads: nothing here talks to it
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

/** "Cancelar" of the Senha tab goes back to Minha conta, which is where the tab lives. */
describe("Cancelar of the Senha tab", () => {
  it("goes back to Minha conta, not to Configurações", () => {
    const html = renderToStaticMarkup(<CancelLink />);
    expect(html).toContain('href="/conta"');
    expect(html).toContain('aria-label="Cancelar e voltar para Minha conta"');
    expect(html).not.toContain("configuracoes");
  });
});
