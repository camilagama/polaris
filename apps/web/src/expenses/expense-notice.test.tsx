import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionNotice } from "./expense-fields";

const noop = () => undefined;
const UNDO_BUTTON = /<button[^>]*>Desfazer<\/button>/;
const NATIVE_DISABLED = /\sdisabled(=|>)/;
const voided = {
  kind: "success",
  text: "Despesa “Panfletos” anulada.",
} as const;

describe("ActionNotice with Desfazer", () => {
  it("says what was voided and offers Desfazer as a button", () => {
    const html = renderToStaticMarkup(
      <ActionNotice feedback={voided} onUndo={noop} />
    );
    expect(html).toContain("Despesa “Panfletos” anulada.");
    expect(html).toMatch(UNDO_BUTTON);
  });

  it("a failed Desfazer keeps the button beside the error, to try again", () => {
    const html = renderToStaticMarkup(
      <ActionNotice
        feedback={{ kind: "error", text: "A despesa não foi reativada." }}
        onUndo={noop}
      />
    );
    expect(html).toContain("A despesa não foi reativada.");
    expect(html).toMatch(UNDO_BUTTON);
  });

  it("has no Desfazer for a notice that has nothing to give back", () => {
    const html = renderToStaticMarkup(
      <ActionNotice
        feedback={{ kind: "success", text: "Despesa reativada." }}
      />
    );
    expect(html).not.toContain("Desfazer");
  });

  it("while it cannot run, Desfazer stays reachable and points at the reason", () => {
    const html = renderToStaticMarkup(
      <ActionNotice
        feedback={voided}
        onUndo={noop}
        undoDisabled
        undoReasonId="connection-required-text"
      />
    );
    const button = html.match(UNDO_BUTTON)?.[0] ?? "";
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-describedby="connection-required-text"');
    expect(button).not.toMatch(NATIVE_DISABLED);
  });
});
