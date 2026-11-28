import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RowInitials, RowTile } from "@/ui/row-tile";

describe("RowInitials", () => {
  it("draws the initials in a decorative circle", () => {
    const html = renderToStaticMarkup(<RowInitials>AL</RowInitials>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-row-initials=""');
    expect(html).toContain("rounded-full");
    expect(html).toContain("size-9");
    expect(html).toContain(">AL<");
  });

  it("lets the screen override the size and the display, and keeps the rest", () => {
    const html = renderToStaticMarkup(
      <RowInitials className="hidden size-8 self-start min-[22.5rem]:grid">
        AL
      </RowInitials>
    );
    expect(html).toContain("size-8");
    expect(html).not.toContain("size-9");
    expect(html).toContain("self-start");
    expect(html).toContain("rounded-full");
  });

  it("is not the square of a configuration row", () => {
    expect(renderToStaticMarkup(<RowInitials>AL</RowInitials>)).not.toContain(
      "data-row-tile"
    );
    expect(renderToStaticMarkup(<RowTile>x</RowTile>)).not.toContain(
      "data-row-initials"
    );
  });
});
