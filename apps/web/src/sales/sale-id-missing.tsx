import { Card } from "@/ui/card";
import {
  INVALID_SALE_ID_MESSAGE,
  SALE_ID_MISSING_MESSAGE,
  type SaleIdParam,
} from "./sale-customer-link-model";

/** A link on a line of its own: it gets the 44 px touch area. */
const LINK =
  "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/** The sale of the page is chosen in the history: without a valid `?saleId=` the page says so and links there. */
export function SaleIdMissing({
  param,
}: {
  param: Exclude<SaleIdParam, { kind: "valid" }>;
}) {
  return (
    <Card className="items-center gap-2 px-(--card-spacing) text-center">
      <p className="text-muted-foreground">
        {param.kind === "invalid"
          ? INVALID_SALE_ID_MESSAGE
          : SALE_ID_MISSING_MESSAGE}
      </p>
      <a className={LINK} href="/sales/history">
        Abrir o histórico de vendas
      </a>
    </Card>
  );
}
