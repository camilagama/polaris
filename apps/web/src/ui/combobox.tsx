import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * A search field whose suggestions open in a popup anchored to the field (Base UI Combobox): the list floats over the
 * page instead of pushing what is under it. The field is the combobox; each suggestion is an option of a listbox,
 * the arrows move through them and Enter chooses the highlighted one. Not modal: the page keeps scrolling.
 */

const Combobox = ComboboxPrimitive.Root;

/** The text control, inside an InputGroup of src/ui like any other field (the group draws the border and the focus). */
function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      className={cn(
        "h-full w-full min-w-0 flex-1 bg-transparent px-3 text-sm touch:text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

function ComboboxContent({
  anchor,
  align = "start",
  children,
  className,
  side = "bottom",
  sideOffset = 4,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "anchor" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          className={cn(
            "data-open:fade-in-0 relative isolate z-50 grid max-h-[min(var(--available-height),22rem)] w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) gap-1 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/[0.06] motion-full:duration-100 motion-full:data-open:animate-in",
            className
          )}
          data-slot="combobox-content"
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("grid gap-0.5 empty:hidden", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

/** An option: 44 px tall with touch, the check mark on the chosen one (`aria-selected`). */
function ComboboxItem({
  children,
  className,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "relative grid min-h-9 touch:min-h-11 w-full cursor-default select-none grid-cols-[minmax(0,1fr)_1rem] items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden data-disabled:pointer-events-none data-highlighted:bg-accent data-selected:font-medium data-highlighted:text-accent-foreground data-disabled:opacity-50",
        className
      )}
      data-slot="combobox-item"
      {...props}
    >
      <span className="grid min-w-0 gap-0.5">{children}</span>
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon aria-hidden="true" className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

/** Said in the popup when there is nothing to choose (no match, loading, an error). */
function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn(
        "px-2 py-1.5 text-muted-foreground text-support empty:hidden",
        className
      )}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxFooter({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "border-border border-t px-2 pt-1.5 pb-1 text-muted-foreground text-support",
        className
      )}
      data-slot="combobox-footer"
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
};
