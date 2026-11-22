import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextLink } from "./text-link";

describe("TextLink", () => {
  it("is an underlined link with the 44 px touch area on a line of its own", () => {
    const html = renderToStaticMarkup(<TextLink href="/x">Ir</TextLink>);
    expect(html).toContain('href="/x"');
    expect(html).toContain("underline");
    expect(html).toContain("touch-hit");
    expect(html).toContain("focus-ring");
  });

  it("has no touch area of its own inside a sentence", () => {
    const html = renderToStaticMarkup(
      <TextLink href="/x" inline>
        Ir
      </TextLink>
    );
    expect(html).toContain("underline");
    expect(html).not.toContain("touch-hit");
  });

  it("keeps the size and the color the place asks for, and passes the attributes through", () => {
    const html = renderToStaticMarkup(
      <TextLink
        aria-label="Abrir"
        className="w-fit text-support"
        href="/x"
        rel="noopener"
        target="_blank"
      >
        Ir
      </TextLink>
    );
    expect(html).toContain("w-fit text-support");
    expect(html).toContain('aria-label="Abrir"');
    expect(html).toContain('target="_blank"');
  });
});
