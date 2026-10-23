import type { ProductMediaAssetReadModel } from "@polaris/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductMediaList } from "./product-media-list";

/**
 * The list of images of the products screen, drawn without a browser: what each row says and which actions are on.
 * The move, the confirmation and the focus that follows are proved in the browser (e2e/product-media-screen.e2e.ts).
 */
const asset = (n: number, variantIds: string[] = []) =>
  ({
    assetId: `0199c2d0-0000-7000-8000-0000000000${10 + n}`,
    byteSize: 300_000 + n * 100_000,
    contentType: "image/webp",
    createdAt: "2026-10-14T12:00:00.000Z",
    height: 800,
    position: n,
    variantIds,
    width: 1000,
  }) satisfies ProductMediaAssetReadModel;

const noop = () => undefined;
type Props = ComponentProps<typeof ProductMediaList>;
const base: Props = {
  assets: [asset(0), asset(1, ["a", "b"]), asset(2)],
  busy: false,
  confirm: null,
  onAsk: noop,
  onConfirm: noop,
  onKeep: noop,
  onMove: noop,
  organizationId: "org",
  productName: "Camiseta lisa",
  running: null,
};
const render = (overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(<ProductMediaList {...base} {...overrides} />);

const OFF = ' disabled=""';
/** The tag of the button of an action of an image, as drawn: to say whether it is off. */
function button(markup: string, label: string): string {
  const tag = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(
    markup
  );
  if (!tag) {
    throw new Error(`no button ${label}`);
  }
  return tag[0];
}

describe("the list of images of a product", () => {
  it("says what comes next when there is no image", () => {
    const html = render({ assets: [] });
    expect(html).toContain("Ainda não há imagens neste produto.");
    expect(html).toContain("Escolha uma acima para enviar.");
    expect(html).not.toContain("<li");
  });

  it("shows each image with its position, size and weight in the language of the shop", () => {
    const html = render();
    expect(html).toContain("Imagem 1 de 3");
    expect(html).toContain("Imagem 3 de 3");
    expect(html).toContain("1000 × 800 · 0,4 MB");
    expect(html).toContain('alt="Camiseta lisa, imagem 2"');
  });

  it("says how many variants an image has, in the singular and the plural", () => {
    expect(render()).toContain("Associada a 2 variantes");
    expect(render({ assets: [asset(0, ["a"])] })).toContain(
      "Associada a 1 variante<"
    );
  });

  it("turns off the move that leads nowhere, at each end of the list", () => {
    const html = render();
    expect(button(html, "Mover imagem 1 para antes")).toContain(OFF);
    expect(button(html, "Mover imagem 1 para depois")).not.toContain(OFF);
    expect(button(html, "Mover imagem 3 para depois")).toContain(OFF);
    expect(button(html, "Mover imagem 2 para antes")).not.toContain(OFF);
  });

  it("turns off every action while a command runs", () => {
    const html = render({ busy: true });
    for (const label of [
      "Mover imagem 2 para antes",
      "Mover imagem 2 para depois",
      "Substituir imagem 2",
      "Remover imagem 2",
    ]) {
      expect(button(html, label)).toContain(OFF);
    }
  });

  it("asks again, in the row, before removing, and says what happens", () => {
    const html = render({
      confirm: { assetId: base.assets[1]?.assetId ?? "", kind: "remove" },
    });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Remover a imagem 2?");
    expect(html).toContain("As variantes que a usam deixam de mostrá-la.");
    expect(html).toContain("Manter imagem");
    expect(html).toContain("Remover imagem");
    // the other rows keep their actions
    expect(html).toContain('aria-label="Mover imagem 1 para depois"');
  });

  it("names the replacement for what it does: the image goes now", () => {
    const html = render({
      confirm: { assetId: base.assets[0]?.assetId ?? "", kind: "replace" },
    });
    expect(html).toContain("Substituir a imagem 1?");
    expect(html).toContain("Remover e escolher outra");
  });

  it("says what the confirmation is doing while it runs", () => {
    const assetId = base.assets[0]?.assetId ?? "";
    expect(
      render({
        busy: true,
        confirm: { assetId, kind: "remove" },
        running: { assetId, kind: "remove" },
      })
    ).toContain("Removendo…");
    expect(
      render({
        busy: true,
        confirm: { assetId, kind: "replace" },
        running: { assetId, kind: "replace" },
      })
    ).toContain("Substituindo…");
  });
});
