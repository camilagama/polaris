"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

/* The shadcn Collapsible over Base UI, without a style of its own: the trigger is the button of the screen
   (`render={<Button … />}`) and the panel only shows or hides (no height animation: movement is opacity only). */
function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  );
}

function CollapsiblePanel({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
  );
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
