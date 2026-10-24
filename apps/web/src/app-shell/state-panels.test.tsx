import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./error-boundary";
import { NotFoundPage } from "./not-found-page";

/** The way back of the 404 and of the failure of a screen is the Início (`/`), not the sale. */
const HOME_LINK = /<a[^>]*href="\/"[^>]*>Ir para o Início<\/a>/;

describe("the panels of the 404 and of the failure of a screen", () => {
  it("send the 404 back to the Início", () => {
    const html = renderToStaticMarkup(<NotFoundPage pathname="/nada" />);
    expect(html).toMatch(HOME_LINK);
    expect(html).not.toContain("Ir para Vender");
    expect(html).toContain('href="/sales/history"');
  });

  it("send the failure of a screen back to the Início", () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain("Algo deu errado nesta tela");
    expect(html).toMatch(HOME_LINK);
    expect(html).not.toContain("Ir para Vender");
  });
});
