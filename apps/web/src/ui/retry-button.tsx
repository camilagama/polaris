import type { ComponentProps } from "react";
import { Button } from "./button";

type RetryButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "type" | "variant"
>;

/**
 * "Tentar novamente" under the sentence of a notice that says a read failed: outline, small, no icon, always the same
 * word. The notice that holds it puts the sentence above and the button below, to the left, never on the same line:
 * the sentence is what the person reads, and the button does not compete with it. The piece carries no spacing; where
 * the button sits in a notice, the notice gives it, in one of two ways: `grid justify-items-start gap-2` on the
 * description, or, where the button is a direct child of the `AlertDescription`, `className="mt-1.5"` on the button.
 * It is an action, not a link in a text, so it is never `variant="link"` (`scripts/ui-source-rules.test.ts`).
 */
export function RetryButton(props: RetryButtonProps) {
  return (
    <Button size="sm" type="button" variant="outline" {...props}>
      Tentar novamente
    </Button>
  );
}
