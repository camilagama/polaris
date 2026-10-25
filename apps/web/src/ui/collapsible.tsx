"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

/* The shadcn Collapsible over Base UI: the trigger is the button of the screen (`render={<Button … />}`) and the
   panel opens and closes by height. The shadcn registry has no animation for this one; the height animation is the
   one its Accordion panel uses (`animate-collapsible-down` and `-up` in theme.css: 200 ms, ease-out, to the height of
   the panel), and, as there, the `className` goes to an inner box so that padding and border do not hold the panel
   open at the start and end of the animation. */
function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
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
  return (
    <CollapsiblePrimitive.Panel
      className="data-closed:animate-collapsible-up data-open:animate-collapsible-down"
      data-slot="collapsible-content"
      {...props}
    >
      <div className={className}>{children}</div>
    </CollapsiblePrimitive.Panel>
  );
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
