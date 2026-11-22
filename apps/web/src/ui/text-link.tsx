import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The class of a link that goes elsewhere from a piece of text: underlined, the underline darkening on hover, the
 * focus ring of the app. The only place the underline of a link is written (`scripts/ui-source-rules.test.ts`); a
 * link that is the action of a block is a button, not this.
 */
export const INLINE_TEXT_LINK_CLASS =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/** The same on a line of its own (or in a row of controls), with the 44 px touch area. */
export const TEXT_LINK_CLASS = `touch-hit ${INLINE_TEXT_LINK_CLASS}`;

/**
 * A link in a sentence or on a line of its own. `inline` is for the link inside running text: it has no touch area of
 * its own, which would cover the line above and below (WCAG 2.5.8 exempts it from the size).
 */
export function TextLink({
  className,
  inline = false,
  ...props
}: ComponentProps<"a"> & { inline?: boolean }) {
  return (
    <a
      className={cn(
        inline ? INLINE_TEXT_LINK_CLASS : TEXT_LINK_CLASS,
        className
      )}
      data-slot="text-link"
      {...props}
    />
  );
}
