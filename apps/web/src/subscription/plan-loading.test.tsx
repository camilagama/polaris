import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanLoading } from "./subscription-parts";

const STATUS_REGION = /<div[^>]*role="status"/;
const BUSY = /aria-busy="true"/;
const HEADING = /<h[1-6]\b/;
const SKELETON_TAGS = /data-slot="skeleton"[^>]*>/g;

describe("PlanLoading", () => {
  const html = renderToStaticMarkup(<PlanLoading />);

  it("is a status region that says what it waits for, with no heading", () => {
    expect(html).toMatch(STATUS_REGION);
    expect(html).toContain("Carregando a assinatura…");
    expect(html).toMatch(BUSY);
    expect(html).not.toMatch(HEADING);
  });

  it("hides the shapes from the screen reader", () => {
    const skeletons = html.match(SKELETON_TAGS) ?? [];
    expect(skeletons.length).toBeGreaterThan(0);
    for (const tag of skeletons) {
      expect(tag).toContain('aria-hidden="true"');
    }
  });
});
