import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductMediaFilePicker } from "./product-media-file-picker";

const noop = () => undefined;
const PICKER_BUTTON =
  /<button[^>]*type="button"[^>]*>Escolher imagem<\/button>/;
const DISABLED_BUTTON = /<button[^>]*\sdisabled=""/;
const DISABLED_INPUT = /<input[^>]*\sdisabled=""/;

function draw(fileName: string | null, disabled = false) {
  return renderToStaticMarkup(
    <ProductMediaFilePicker
      buttonRef={null}
      disabled={disabled}
      fileName={fileName}
      inputRef={null}
      onChange={noop}
    />
  );
}

describe("the picker of the image of a product", () => {
  it("is a button in Portuguese named 'Escolher imagem', and says no image was chosen", () => {
    const markup = draw(null);
    expect(markup).toMatch(PICKER_BUTTON);
    expect(markup).toContain("Nenhuma imagem escolhida");
    // the button is described by the line with the name of the file
    expect(markup).toContain('aria-describedby="product-media-file-name"');
    expect(markup).toContain('id="product-media-file-name"');
  });

  it("says the name of the chosen file beside the button", () => {
    const markup = draw("camiseta.jpg");
    expect(markup).toContain(">camiseta.jpg</span>");
    expect(markup).not.toContain("Nenhuma imagem escolhida");
  });

  it("keeps the types the input accepted, and leaves the native input out of the tab order and the reader", () => {
    const markup = draw(null);
    expect(markup).toContain(
      'accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"'
    );
    expect(markup).toContain('type="file"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("turns the button and the input off together", () => {
    const markup = draw(null, true);
    expect(markup).toMatch(DISABLED_BUTTON);
    expect(markup).toMatch(DISABLED_INPUT);
  });
});
