import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { RetryButton } from "./retry-button";

describe("RetryButton", () => {
  it("is the outline button of the small size, a plain button, with the one label and no icon", () => {
    const html = renderToStaticMarkup(<RetryButton />);
    expect(html).toBe(
      renderToStaticMarkup(
        <Button size="sm" type="button" variant="outline">
          Tentar novamente
        </Button>
      )
    );
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("underline");
  });

  it("keeps the touch area of the button and takes what the screen needs to pass", () => {
    const html = renderToStaticMarkup(
      <RetryButton aria-busy className="mt-1" disabled />
    );
    expect(html).toContain("touch-hit");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("mt-1");
    expect(html).toContain("disabled");
  });
});
