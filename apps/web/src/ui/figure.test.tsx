import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Figure } from "./figure";

describe("Figure", () => {
  it("writes the number as it is, in the mono face with equal digits and in one line", () => {
    const markup = renderToStaticMarkup(<Figure>1.234</Figure>);
    expect(markup).toContain(">1.234<");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("tabular-nums");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain('data-figure=""');
  });

  it("aligns to the end only when asked, and keeps the caller's class", () => {
    expect(renderToStaticMarkup(<Figure>3</Figure>)).not.toContain(
      "text-right"
    );
    const markup = renderToStaticMarkup(
      <Figure align="end" className="text-support">
        45,0%
      </Figure>
    );
    expect(markup).toContain("block");
    expect(markup).toContain("text-right");
    expect(markup).toContain("text-support");
  });
});
