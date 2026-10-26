import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineCopyNotice } from "./offline-copy-notice";

const ZONE = "America/Sao_Paulo";
const SUPPORT = "Vendas feitas depois não estão aqui.";

/** The notice of a copy under a server that did not answer, as the screens say it (paliativo dos 1102). */
function stale(generatedAt: string) {
  return renderToStaticMarkup(
    <OfflineCopyNotice
      generatedAt={generatedAt}
      online={{ onRetry: () => undefined }}
      timezone={ZONE}
      waitingOperations={0}
    />
  );
}

describe("the notice of the copy with a connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T20:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says what is on screen, with the hour alone when the copy is of today", () => {
    const html = stale("2026-10-23T15:00:00.000Z");
    expect(html).toContain("Não foi possível atualizar agora");
    expect(html).toContain(`Mostrando os números de 12:00. ${SUPPORT}`);
    expect(html).toContain("Tentar novamente");
    expect(html).not.toContain("Atualizado");
  });

  it("says the day too when the copy is of another day", () => {
    const html = stale("2026-10-22T21:40:00.000Z");
    expect(html).toContain(
      `Mostrando os números de 22/10 às 18:40. ${SUPPORT}`
    );
    expect(html).not.toContain("Atualizado");
  });
});
