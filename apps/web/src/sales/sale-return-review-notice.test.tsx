import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReturnReviewNotice } from "./sale-return-panel";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

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
