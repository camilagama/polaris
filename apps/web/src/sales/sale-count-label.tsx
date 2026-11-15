import {
  type SaleCount,
  saleCountSpoken,
  saleCountText,
} from "./sale-count-text";

/** "3 linhas · 8 unidades" on screen, "3 linhas, 8 unidades" for a reader (the visible text is hidden from it). */
export function SaleCountLabel({ count }: { count: SaleCount }) {
  return (
    <>
      <span aria-hidden="true">{saleCountText(count)}</span>
      <span className="sr-only">{saleCountSpoken(count)}</span>
    </>
  );
}
