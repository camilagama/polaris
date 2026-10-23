import { Alert, AlertDescription } from "@/ui/alert";
import type { SaleNotice } from "./sale-cancellation-model";

/**
 * The live region of the result of a return or a cancellation. It is always in the tree, so the screen reader has
 * the region before the notice arrives and announces what is put into it. Empty it leaves the grid flow
 * (`absolute`: no gap row) instead of `display: none`, which would take it out of the accessibility tree.
 */
export function SaleNoticeRegion({ notice }: { notice: SaleNotice | null }) {
  return (
    <div aria-live="polite" className="empty:absolute">
      {notice ? (
        <Alert variant={notice.ok ? "default" : "warning"}>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
