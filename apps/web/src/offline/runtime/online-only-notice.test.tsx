import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isConnected, OnlineOnlyStrip } from "./online-only-notice";

describe("whether a screen that needs the server can reach it", () => {
  it("is connected only when the browser and the runtime both say so", () => {
    expect(isConnected(true, true)).toBe(true);
    expect(isConnected(false, true)).toBe(false);
    expect(isConnected(true, false)).toBe(false);
    expect(isConnected(false, false)).toBe(false);
  });

  it("trusts the browser alone when the runtime keeps no account of the connection", () => {
    expect(isConnected(true, undefined)).toBe(true);
    expect(isConnected(false, undefined)).toBe(false);
  });
});

describe("the strip of a screen that needs a connection (U-54)", () => {
  const html = renderToStaticMarkup(<OnlineOnlyStrip />);

  it("says what is missing and what it means for what was typed", () => {
    expect(html).toContain("Sem internet.");
    expect(html).toContain("Esta tela precisa de conexão.");
    expect(html).toContain(
      "O que você digitou fica aqui até a conexão voltar."
    );
  });

  it("is a status, not an alert: the person is not interrupted, the screen still works for reading", () => {
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
});
