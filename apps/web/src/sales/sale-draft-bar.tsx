import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { MoneyText } from "@/ui/hidden-values";
import type { SaleCount } from "./sale-count-text";
import { clearSaleConsequence } from "./sale-draft-restore";

interface SaleDraftBarProps {
  /** False while the sale is sent or its outcome is unknown: that cart is not the person's to clear. */
  canClear: boolean;
  /** Lines with a variant chosen and their units; with no line, "Limpar venda" clears at once. */
  count: SaleCount;
  /** The cart began on another store day and its date is empty: it is dated at the confirmation. Plain text, derived. */
  newDayNotice: string | null;
  /** What happened to the cart kept in the tab (dropped, lines taken out), announced. */
  notice: string | null;
  onClear: () => void;
  /** There is a sale in progress (kept in the tab). */
  open: boolean;
}

/**
 * "Venda em andamento" and "Limpar venda" under the title, and the notice of the cart that came back. The two live
 * regions are always in the tree (empty, out of the flow: no gap row). The new-day sentence and the "Venda em
 * andamento" status are put in after the mount, so a reader announces them as a change; the notice is an alert and is
 * announced on its own.
 */
export function SaleDraftBar({
  canClear,
  count,
  newDayNotice,
  notice,
  onClear,
  open,
}: SaleDraftBarProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [asking, setAsking] = useState(false);
  const handleClear = useCallback(() => {
    if (count.lines > 0) {
      setAsking(true);
    } else {
      onClear();
    }
  }, [count, onClear]);
  const handleOpenChange = useCallback((next: boolean) => setAsking(next), []);
  const handleCancel = useCallback(() => setAsking(false), []);
  const handleConfirm = useCallback(() => {
    setAsking(false);
    onClear();
  }, [onClear]);
  const shown = open && mounted;
  return (
    <>
      <div aria-live="polite" className="empty:absolute">
        {notice ? (
          <Alert variant="warning">
            <AlertDescription>
              <MoneyText text={notice} />
            </AlertDescription>
          </Alert>
        ) : null}
        {mounted && newDayNotice ? (
          <p className="m-0 text-muted-foreground text-support">
            {newDayNotice}
          </p>
        ) : null}
      </div>
      <div
        className={
          shown
            ? "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1"
            : "absolute"
        }
      >
        <p className="m-0 text-muted-foreground text-support" role="status">
          {shown ? "Venda em andamento" : null}
        </p>
        {shown && canClear ? (
          <Button
            onClick={handleClear}
            size="sm"
            type="button"
            variant="outline"
          >
            Limpar venda
          </Button>
        ) : null}
      </div>
      <Dialog onOpenChange={handleOpenChange} open={asking}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Limpar venda?</DialogTitle>
            <DialogDescription>{clearSaleConsequence(count)}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3">
            <Button onClick={handleCancel} type="button" variant="outline">
              Cancelar
            </Button>
            <Button onClick={handleConfirm} type="button" variant="destructive">
              Limpar venda
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
