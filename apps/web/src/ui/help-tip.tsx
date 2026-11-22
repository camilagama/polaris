import InfoIcon from "lucide-react/dist/esm/icons/info";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";
import { TextLink } from "./text-link";

/**
 * The (i) next to a card's title: a toggletip, not a tooltip (DESIGN.md, "Texto curto"). It opens by touch, click, Enter
 * and Space and never by hover, because a finger has no hover and a screen reader does not announce a hover tooltip.
 * The popup is a Popover in a portal, so no `overflow` of the card cuts it; focus goes into it on open and back to the
 * button on Esc, on a touch outside and on the button itself. Never for an error, a warning, the consequence of an
 * action or what the app does offline: those stay on the screen.
 */
export function HelpTip({
  about,
  children,
  className,
  link,
}: {
  /** What the help is about, the title of the card: it names the button ("Sobre …") and titles the popup. */
  about: string;
  /** Up to two sentences and 160 characters: what the number is, and what it compares with. */
  children: string;
  className?: string;
  link?: { href: string; label: string };
}) {
  // focus lands on the popup, not on its link: the screen reader reads the title and the text first, and Tab reaches the link
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Sobre ${about}`}
        className={cn(
          "touch-hit focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
          className
        )}
        data-slot="help-tip"
      >
        <InfoIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-w-[calc(100vw-1rem)]"
        initialFocus={popupRef}
        ref={popupRef}
        side="bottom"
        sideOffset={4}
      >
        <PopoverHeader>
          <PopoverTitle>{about}</PopoverTitle>
          <PopoverDescription>{children}</PopoverDescription>
        </PopoverHeader>
        {link ? (
          <TextLink className="w-fit text-sm" href={link.href}>
            {link.label}
          </TextLink>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
