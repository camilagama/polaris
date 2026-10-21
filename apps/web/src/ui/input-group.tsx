"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { type ComponentProps, type MouseEvent, useCallback } from "react";
import { cn } from "@/lib/utils";

/* The Polaris text field. With touch the 48 px area comes from the group itself (touch-hit-field): a touch on the
   band above or below the field focuses the text. */
function InputGroup({ className, onClick, ...props }: ComponentProps<"div">) {
  const focusOnBand = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      onClick?.(event);
      if (event.target === event.currentTarget) {
        event.currentTarget
          .querySelector<HTMLElement>("[data-slot=input-group-control]")
          ?.focus();
      }
    },
    [onClick]
  );
  return (
    // The click only helps the pointer (the band around the field focuses it); the keyboard reaches the
    // control itself, so the group needs no key handler. A group of controls, not a form section: no fieldset.
    // biome-ignore lint/a11y/useSemanticElements: see above
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <div
      className={cn(
        "group/input-group touch-hit-field relative flex h-ctl-md w-full min-w-0 items-center rounded-md border border-input outline-none transition-[border-color,box-shadow] has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-destructive has-disabled:bg-muted has-disabled:opacity-60 has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 has-[[data-slot][aria-invalid=true]]:focus-within:ring-[3px] has-[[data-slot][aria-invalid=true]]:focus-within:ring-destructive/25 dark:bg-input/30 dark:has-disabled:bg-muted",
        className
      )}
      data-slot="input-group"
      onClick={focusOnBand}
      role="group"
      {...props}
    />
  );
}

/* The control inside the group: no border of its own (border, focus and error belong to the group). 16 px only with
   touch (iOS zooms in below that). */
function InputGroupInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      className={cn(
        "h-full w-full min-w-0 flex-1 bg-transparent px-3 text-sm touch:text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

export { InputGroup, InputGroupInput };
