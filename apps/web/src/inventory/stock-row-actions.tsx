import type { MouseEvent } from "react";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import type { StockAction } from "./stock-command-model";
import { type StockRow, stockRowActions } from "./stock-list-model";

/** Names the line that says why the row buttons are off while a panel is open. */
export const PANEL_OPEN_REASON_ID = "stock-panel-open-reason";
export const PANEL_OPEN_REASON =
  "Há um painel aberto. Termine ou feche esse painel para usar os botões.";

/** By the button's place in the row: "Informar custo" stands where "Contar" was and gives it back once the cost is known. */
export const triggerId = (variantId: string, action: StockAction) =>
  `stock-trigger-${variantId}-${action === "cost" ? "count" : action}`;

interface RowActionsProps {
  disabled: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  row: StockRow;
}

/** The three commands of a variant, glued into one control: their touch areas are one piece. */
export function RowActions({ disabled, onOpen, row }: RowActionsProps) {
  return (
    <ButtonGroup
      aria-label={`Movimentos de ${row.productName}, ${row.variantText}`}
      className="w-full md:w-fit"
    >
      {stockRowActions(row.target).map(({ action, label, name }) => (
        // aria-disabled, not disabled: the button stays reachable and reads why it is off (the line above the list)
        <Button
          aria-describedby={disabled ? PANEL_OPEN_REASON_ID : undefined}
          aria-disabled={disabled || undefined}
          aria-label={name}
          className="flex-1 md:flex-none"
          data-stock-action={action}
          data-variant-id={row.id}
          id={triggerId(row.id, action)}
          key={action}
          onClick={disabled ? undefined : onOpen}
          type="button"
          variant="outline"
        >
          {label}
        </Button>
      ))}
    </ButtonGroup>
  );
}
