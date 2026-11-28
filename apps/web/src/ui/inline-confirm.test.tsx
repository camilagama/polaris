import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineConfirm } from "@/ui/inline-confirm";

const noop = () => undefined;
const FIND_OPENER = () => null;

function draw(busy = false) {
  return renderToStaticMarkup(
    <InlineConfirm
      action="remoção"
      busy={busy}
      confirmLabel="Remover cliente"
      keepLabel="Manter cliente"
      object="Ana Lima"
      onConfirm={noop}
      onKeep={noop}
      opener={FIND_OPENER}
    >
      Remover tira a ficha da lista. Não dá para desfazer.
    </InlineConfirm>
  );
}

const DESCRIBED_BY = /aria-describedby="([^"]+)"/;
const BUTTON_ORDER = /<button[^>]*>([^<]*)<\/button>/g;

describe("InlineConfirm, as drawn", () => {
  it("is a group named by the action and the object, never an alertdialog", () => {
    const html = draw();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Confirmar remoção de Ana Lima"');
    expect(html).not.toContain("alertdialog");
  });

  it("points aria-describedby at the sentence of the screen, with no bold", () => {
    const html = draw();
    const id = DESCRIBED_BY.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(
      `<p class="text-support" id="${id}">Remover tira a ficha da lista. Não dá para desfazer.</p>`
    );
    expect(html).not.toContain("<strong");
  });

  it("is the destructive inset block that takes the focus by code, with the 3 px ring of the app", () => {
    const html = draw();
    expect(html).toContain('data-slot="inset-block"');
    expect(html).toContain("ring-destructive/60");
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("focus-ring");
    expect(html).not.toContain("outline-none");
    expect(html).toContain("grid gap-3 p-3");
  });

  it("puts keeping (outline) before the destructive answer, in a row that wraps with 12 px between", () => {
    const html = draw();
    const labels = Array.from(html.matchAll(BUTTON_ORDER), (match) => match[1]);
    expect(labels).toEqual(["Manter cliente", "Remover cliente"]);
    expect(html.indexOf("border-border")).toBeLessThan(
      html.indexOf("bg-destructive")
    );
    expect(html).toContain("flex flex-wrap gap-3");
  });

  it("turns both buttons off while the command runs", () => {
    expect(draw().match(/ disabled=""/g)).toBeNull();
    expect(draw(true).match(/ disabled=""/g)).toHaveLength(2);
  });
});
