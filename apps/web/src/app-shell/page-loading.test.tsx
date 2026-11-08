import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageLoading } from "./page-loading";

describe("PageLoading", () => {
  it("says the wait to the screen reader only, as a status, with the skeleton as the picture", () => {
    const html = renderToStaticMarkup(<PageLoading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<p class="sr-only">Carregando…</p>');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-slot="skeleton"');
  });

  it("keeps the given label as the same hidden line", () => {
    const html = renderToStaticMarkup(
      <PageLoading label="Carregando sua loja…" />
    );
    expect(html).toContain('<p class="sr-only">Carregando sua loja…</p>');
  });

  it("draws the line when there is no skeleton, because then it is the only thing on the screen", () => {
    const html = renderToStaticMarkup(
      <PageLoading label="Não disponível" skeleton={false} />
    );
    expect(html).toContain(
      '<p class="text-muted-foreground">Não disponível</p>'
    );
    expect(html).not.toContain("sr-only");
    expect(html).not.toContain('data-slot="skeleton"');
  });
});
