import { useCallback, useState } from "react";
import {
  INVALID_SALE_ID_MESSAGE,
  readSaleIdParam,
} from "./sale-customer-link-model";

interface SaleIdParam {
  clear: () => void;
  initialError: string | null;
  open: (saleId: string) => void;
  saleId: string | null;
}

/** The sale named by `?saleId=<uuid>`, kept in the URL (the ID is not customer data). */
export function useSaleIdParam(): SaleIdParam {
  const [initial] = useState(() => readSaleIdParam(window.location.search));
  const [saleId, setSaleId] = useState<string | null>(
    initial.kind === "valid" ? initial.saleId : null
  );
  const open = useCallback((next: string) => {
    setSaleId(next);
    window.history.replaceState(null, "", `?saleId=${next}`);
  }, []);
  const clear = useCallback(() => {
    setSaleId(null);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return {
    clear,
    initialError: initial.kind === "invalid" ? INVALID_SALE_ID_MESSAGE : null,
    open,
    saleId,
  };
}
