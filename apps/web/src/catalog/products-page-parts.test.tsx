import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionFeedback } from "./products-page-parts";

/** The notice of the last action (drawn without a browser): "Desfazer" only where the screen hands an undo. */
const regionRef = createRef<HTMLDivElement>();
const noop = () => undefined;
const ANY_DISABLED_BUTTON = /<button[^>]*disabled=""/;
const DISABLED_UNDO = /<button[^>]*disabled=""[^>]*>Desfazer/;

describe("ActionFeedback", () => {
  it("has no button on a notice without an undo (the restored one)", () => {
    const markup = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” restaurado."
        regionRef={regionRef}
      />
    );
    expect(markup).toContain("restaurado.");
    expect(markup).not.toContain("Desfazer");
    expect(markup).not.toContain("<button");
  });

  it("offers Desfazer on the archived notice, and switches it off when it cannot start", () => {
    const on = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” arquivado."
        onUndo={noop}
        regionRef={regionRef}
        undoDisabled={false}
      />
    );
    expect(on).toContain("Desfazer");
    expect(on).not.toMatch(ANY_DISABLED_BUTTON);
    const off = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” arquivado."
        onUndo={noop}
        regionRef={regionRef}
        undoDisabled
      />
    );
    expect(off).toMatch(DISABLED_UNDO);
  });
});
