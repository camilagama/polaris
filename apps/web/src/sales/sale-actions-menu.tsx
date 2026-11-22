import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import { type ReactNode, type Ref, useCallback } from "react";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { TITLE_ACTION_CLASS } from "../app-shell/screen-title";
import {
  actionButtonLabels,
  type LinkAction,
} from "./sale-customer-link-model";

export type SaleAction = "cancel" | "choose" | "remove" | "return";

/** The reason an item is off while the tab does not reach the server: said in the item, which stays in the menu. */
const OFFLINE_REASON = "Precisa de conexão";

export interface SaleActionsOffer {
  /** The sale can be cancelled as a whole (`cancelOffer`: not while the new state is being read). */
  cancel: boolean;
  /** "Associar cliente" or "Trocar cliente", when the link of the sale was read. */
  choose: LinkAction | null;
  /** The customer link is being saved: its items wait. */
  linking: boolean;
  remove: boolean;
  return: boolean;
}

/** Whether any item is worth the menu: with none, the button is not drawn. */
export function hasSaleActions(offer: SaleActionsOffer): boolean {
  return offer.cancel || offer.choose !== null || offer.remove || offer.return;
}

function ActionItem({
  action,
  children,
  disabled,
  onAction,
  online,
  variant,
}: {
  action: SaleAction;
  children: ReactNode;
  disabled: boolean;
  onAction: (action: SaleAction) => void;
  online: boolean;
  variant?: "destructive";
}) {
  const handleClick = useCallback(() => onAction(action), [action, onAction]);
  return (
    <DropdownMenuItem
      className="data-disabled:opacity-100"
      disabled={disabled || !online}
      onClick={handleClick}
      variant={variant ?? "default"}
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="group-data-disabled/dropdown-menu-item:opacity-50">
          {children}
        </span>
        {online ? null : (
          <span className="text-muted-foreground text-xs">
            {OFFLINE_REASON}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * The actions of the sale, in one menu at the title: the customer first (associate, or change and remove), then the
 * return, and the cancellation last, apart, in the destructive colour, so the item under the thumb that opens the
 * menu is never the one that cannot be undone. Each item opens its dialog; one that does not apply to the sale is not
 * drawn, and one that needs the server stays, off, with its reason.
 */
export function SaleActionsMenu({
  offer,
  onAction,
  online,
  triggerRef,
}: {
  offer: SaleActionsOffer;
  onAction: (action: SaleAction) => void;
  online: boolean;
  triggerRef: Ref<HTMLButtonElement>;
}) {
  if (!hasSaleActions(offer)) {
    return null;
  }
  const beforeCancel = offer.choose !== null || offer.remove || offer.return;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className={TITLE_ACTION_CLASS}
            ref={triggerRef}
            type="button"
            variant="outline"
          />
        }
      >
        Ações
        <ChevronDownIcon aria-hidden="true" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56 max-w-[90vw]">
        {offer.choose === null ? null : (
          <ActionItem
            disabled={offer.linking}
            action="choose"
            onAction={onAction}
            online={online}
          >
            {actionButtonLabels[offer.choose]}
          </ActionItem>
        )}
        {offer.remove ? (
          <ActionItem
            disabled={offer.linking}
            action="remove"
            onAction={onAction}
            online={online}
          >
            {actionButtonLabels.unassign}
          </ActionItem>
        ) : null}
        {offer.return ? (
          <ActionItem
            disabled={false}
            action="return"
            onAction={onAction}
            online={online}
          >
            Registrar devolução
          </ActionItem>
        ) : null}
        {offer.cancel && beforeCancel ? <DropdownMenuSeparator /> : null}
        {offer.cancel ? (
          <ActionItem
            disabled={false}
            action="cancel"
            onAction={onAction}
            online={online}
            variant="destructive"
          >
            Cancelar venda
          </ActionItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
