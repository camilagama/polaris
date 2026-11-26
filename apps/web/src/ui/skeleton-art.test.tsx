import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkeletonArt, type SkeletonArtKind } from "./skeleton-art";

const INTERACTIVE_OR_IMAGE = /<(a|button|input|image|img|style|script)\b/;
const MOTION = /animate|transition|skeleton"|pulse|<animate|<set\b/;
const EFFECTS = /Gradient|filter=|<filter/;
const PAINT = /^(fill|stroke)-/;
const RAW_COLOR = /#[0-9a-f]{3,8}\b|rgb|hsl|oklch|style=/i;
const SALES_LINE = /stroke-chart-sales/g;

const KINDS: readonly SkeletonArtKind[] = ["home", "products", "sale"];

const TOKEN_CLASSES = new Set([
  "fill-card",
  "fill-muted",
  "stroke-border",
  "stroke-chart-sales",
]);

async function gzipBytes(text: string) {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

const html = (kind: SkeletonArtKind) =>
  renderToStaticMarkup(<SkeletonArt kind={kind} />);

describe.each(KINDS)("the drawing '%s'", (kind) => {
  it("is decoration: aria-hidden, out of the focus order, 4:3 and inline", () => {
    const svg = html(kind);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
    expect(svg).toContain('viewBox="0 0 160 120"');
    expect(svg).not.toMatch(INTERACTIVE_OR_IMAGE);
  });

  it("moves nothing and is not a loading skeleton", () => {
    const svg = html(kind);
    expect(svg).not.toMatch(MOTION);
    expect(svg).not.toMatch(EFFECTS);
  });

  it("uses only tokens: card, muted and border for the shapes and one line of the sales green", () => {
    const svg = html(kind);
    const used = new Set(
      [...svg.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
        (match[1] ?? "").split(" ").filter((name) => PAINT.test(name))
      )
    );
    expect([...used].filter((name) => !TOKEN_CLASSES.has(name))).toEqual([]);
    expect(svg).not.toMatch(RAW_COLOR);
    expect(svg.match(SALES_LINE)?.length).toBeGreaterThanOrEqual(1);
  });

  it("weighs at most 2 kB gzipped", async () => {
    const bytes = await gzipBytes(html(kind));
    expect(bytes).toBeLessThanOrEqual(2048);
  });
});

it("takes a class for its size", () => {
  expect(
    renderToStaticMarkup(<SkeletonArt className="w-44" kind="sale" />)
  ).toContain("w-44");
});
