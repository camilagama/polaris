import { Block } from "@/ui/block";
import { TextLink } from "@/ui/text-link";
import {
  INVALID_SALE_ID_MESSAGE,
  SALE_ID_MISSING_MESSAGE,
  type SaleIdParam,
} from "./sale-customer-link-model";

/** The sale of the page is chosen in the history: without a valid `?saleId=` the page says so and links there. */
export function SaleIdMissing({
  param,
}: {
  param: Exclude<SaleIdParam, { kind: "valid" }>;
}) {
  return (
    <Block variant="plain">
      <div className="grid justify-items-center gap-2 text-center">
        <p className="text-muted-foreground">
          {param.kind === "invalid"
            ? INVALID_SALE_ID_MESSAGE
            : SALE_ID_MISSING_MESSAGE}
        </p>
        <TextLink href="/sales/history">Abrir o histórico de vendas</TextLink>
      </div>
    </Block>
  );
}
