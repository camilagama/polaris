import type * as React from "react";
import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { focusLater } from "@/lib/focus";
import { Button } from "./button";
import { InsetBlock } from "./inset-block";

interface InlineConfirmProps {
  /** The action, as in "Confirmar <action> de <object>": "remoção", "a anonimização". */
  action: string;
  /** Both buttons wait while the command runs. */
  busy?: boolean;
  /** The sentence the screen writes: what happens and what stays. */
  children: ReactNode;
  className?: string;
  confirmLabel: ReactNode;
  /** Extra props of the destructive button (a screen that needs the connection marks it `aria-disabled`). */
  confirmProps?: Omit<
    React.ComponentProps<typeof Button>,
    "children" | "onClick" | "type" | "variant"
  >;
  /** "Manter <object>": what is left as it is. */
  keepLabel: string;
  /** What the box names, as in "Confirmar <action> de <object>". */
  object: string;
  onConfirm: () => void;
  /** Keep, or Esc: the screen closes the box. */
  onKeep: () => void;
  /**
   * The button that opened the box. It is read after the screen has closed the box, so a button the box replaced is
   * found again; focus goes back to it on keep and on Esc.
   */
  opener: () => HTMLElement | null;
}

const BUTTON_CLASS =
  "h-auto! min-h-ctl-md min-w-0 shrink whitespace-normal py-1.5 text-center";

/**
 * The confirmation of something that cannot be undone, asked in the row itself in place of the row's actions. It is a
 * `group`, never an `alertdialog`: it promises no modal (nothing traps the focus and the rest of the page stays live).
 * The focus enters the box when it opens (the first Tab lands on keeping, the safe answer), and keeping or Esc gives it
 * back to the button that opened it.
 */
function InlineConfirm({
  action,
  busy = false,
  children,
  className,
  confirmLabel,
  confirmProps,
  keepLabel,
  object,
  onConfirm,
  onKeep,
  opener,
}: InlineConfirmProps) {
  const phraseId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    focusLater(() => boxRef.current?.focus());
  }, []);
  useEffect(() => {
    if (busy) {
      boxRef.current?.focus();
    }
  }, [busy]);
  const keep = useCallback(() => {
    onKeep();
    focusLater(() => opener()?.focus());
  }, [onKeep, opener]);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!busy) {
        keep();
      }
    },
    [busy, keep]
  );
  return (
    <InsetBlock
      aria-describedby={phraseId}
      aria-label={`Confirmar ${action} de ${object}`}
      className={cn("focus-ring grid gap-3 p-3", className)}
      onKeyDown={handleKeyDown}
      ref={boxRef}
      role="group"
      tabIndex={-1}
      tone="destructive"
    >
      <p className="text-support" id={phraseId}>
        {children}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          className={BUTTON_CLASS}
          disabled={busy}
          onClick={keep}
          type="button"
          variant="outline"
        >
          {keepLabel}
        </Button>
        <Button
          {...confirmProps}
          className={BUTTON_CLASS}
          disabled={busy}
          onClick={onConfirm}
          type="button"
          variant="destructive"
        >
          {confirmLabel}
        </Button>
      </div>
    </InsetBlock>
  );
}

export { InlineConfirm };
