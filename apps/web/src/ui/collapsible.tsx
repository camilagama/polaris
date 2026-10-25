"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { createContext, useCallback, useContext, useState } from "react";

/* The shadcn Collapsible over Base UI: the trigger is the button of the screen (`render={<Button … />}`) and the
   panel opens and closes by height. The shadcn registry has no animation for this one; the height animation is the
   one its Accordion panel uses (`animate-collapsible-down` and `-up` in theme.css: 200 ms, ease-out, to the height of
   the panel), and, as there, the `className` goes to an inner box so that padding and border do not hold the panel
   open at the start and end of the animation. */
/* Whether the state changed since the mount: a panel that mounts open (`defaultOpen`, or `open` already true) must
   not run the opening animation on the first paint, so the animation classes wait for a change of state. */
const MovedContext = createContext(false);

function Collapsible({
  onOpenChange,
  open,
  ...props
}: CollapsiblePrimitive.Root.Props) {
  const [moved, setMoved] = useState(false);
  const [seen, setSeen] = useState(open);
  // a controlled `open` that changes (the parent opens it, not the trigger) is a change of state too
  if (open !== seen) {
    setSeen(open);
    setMoved(true);
  }
  const handleOpenChange = useCallback<
    NonNullable<CollapsiblePrimitive.Root.Props["onOpenChange"]>
  >(
    (next, details) => {
      setMoved(true);
      onOpenChange?.(next, details);
    },
    [onOpenChange]
  );
  return (
    <MovedContext.Provider value={moved}>
      <CollapsiblePrimitive.Root
        data-slot="collapsible"
        onOpenChange={handleOpenChange}
        open={open}
        {...props}
      />
    </MovedContext.Provider>
  );
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  );
}

function CollapsiblePanel({
  children,
  className,
  ...props
}: Omit<CollapsiblePrimitive.Panel.Props, "className"> & {
  className?: string;
}) {
  const moved = useContext(MovedContext);
  return (
    <CollapsiblePrimitive.Panel
      className={
        moved
          ? "data-closed:animate-collapsible-up data-open:animate-collapsible-down"
          : undefined
      }
      data-slot="collapsible-content"
      {...props}
    >
      <div className={className}>{children}</div>
    </CollapsiblePrimitive.Panel>
  );
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
