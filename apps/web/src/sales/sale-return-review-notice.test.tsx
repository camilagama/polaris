import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CancelReviewNotice } from "./sale-cancel-panel";
import { ReturnReviewNotice } from "./sale-return-panel";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const SET_BACK = /<div class="[^"]*border-0[^"]*bg-muted[^"]*p-4/;
const RING = /<div class="[^"]*bg-card/;

describe("ReturnReviewNotice", () => {
  it("says the return cannot be undone, next to the stock line", () => {
    const html = renderToStaticMarkup(
      <ReturnReviewNotice
        noticeRef={null}
        review={{
          lines: [
            {
              key: "p0",
              text: "Calça jeans: devolvidas 1, voltam ao estoque 1",
            },
          ],
          reasonText: "Sem motivo informado",
          totalsText: "Total: 1 devolvidas",
        }}
      />
    );
    expect(html).toContain("Confirme a devolução");
    expect(html).toContain("O estoque volta apenas");
    expect(html).toContain(
      "A venda é preservada. Isso não poderá ser desfeito."
    );
  });
});

describe("the review notices, set back into the card", () => {
  it("draw the return review as a muted block without a border", () => {
    const html = renderToStaticMarkup(
      <ReturnReviewNotice
        noticeRef={null}
        review={{ lines: [], reasonText: "Sem motivo", totalsText: "Total: 0" }}
      />
    );
    expect(html).toMatch(SET_BACK);
    expect(html).not.toMatch(RING);
  });

  it("draw the cancellation review as a muted block without a border, with the same words", () => {
    const html = renderToStaticMarkup(
      <CancelReviewNotice noticeRef={null} reasonCode="" />
    );
    expect(html).toMatch(SET_BACK);
    expect(html).not.toMatch(RING);
    expect(html).toContain("Confirme o cancelamento");
    expect(html).toContain(
      "A venda será marcada como cancelada sem motivo informado, o estoque voltará item a item e isso não poderá ser desfeito."
    );
  });
});
