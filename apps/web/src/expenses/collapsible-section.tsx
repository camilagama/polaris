import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUpIcon from "lucide-react/dist/esm/icons/chevron-up";
import { type ReactNode, useState } from "react";
import { Card } from "@/ui/card";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";

interface CollapsibleSectionProps {
  children: ReactNode;
  id: string;
  title: string;
}

/**
 * A secondary section of the screen, closed until asked for: a card whose title is the button (a heading with the
 * button inside, so the outline of the page lists it). The panel stays mounted while closed (`keepMounted`, only
 * `hidden`): what was typed in it survives closing and opening, as it did with `<details>`. No height animation and
 * no turning chevron (movement is opacity only): the arrow swaps.
 */
export function CollapsibleSection({
  children,
  id,
  title,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(false);
  const titleId = `${id}-title`;
  const Icon = open ? ChevronUpIcon : ChevronDownIcon;
  return (
    <Card aria-labelledby={titleId} gap="none" pad="none" role="region">
      <Collapsible onOpenChange={setOpen} open={open}>
        {/* 6 px around the button: its 3 px outline (2 px away) stays inside the card, which clips what overflows */}
        <h2 className="p-1.5 text-section" id={titleId}>
          <CollapsibleTrigger className="focus-ring flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-[calc(var(--card-spacing)-0.375rem)] py-1.5 text-left transition-colors hover:bg-accent/60">
            {title}
            <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          </CollapsibleTrigger>
        </h2>
        <CollapsiblePanel
          className="grid gap-4 border-t p-(--card-spacing)"
          keepMounted
        >
          {children}
        </CollapsiblePanel>
      </Collapsible>
    </Card>
  );
}
