"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { createContext, useContext } from "react";
import { cn } from "@/lib/utils";

/* The shadcn Tabs of the base-nova registry over Base UI, once, with the three rules of the project: the list is
   `h-ctl-md` (32 px with a mouse, 36 px with touch), each tab has a 44 px touch area (`touch-hit`) and the keyboard
   focus is the 3 px outline (`focus-ring`). Horizontal only, in two styles: the segmented list on the muted strip (a
   filter of a list) and the `line` (the tab of a screen: text, a 1 px rule across the list and a 2 px stroke in ink
   under the open tab, never in the brand color). The tab reads the style from its own list, so a segmented filter
   inside the panel of a line tab stays a strip. The vertical layout of the registry comes back with the first screen
   that needs it. A tab does not point at its panel (`aria-controls`): the panel is already named by its tab
   (`aria-labelledby`), and a reader that follows the pointer says that name again after the tab's.
   The active tab changes with no movement: background, color and the stroke fade, nothing slides or scales. The open
   panel is a tab stop (Base UI gives it `tabIndex` 0), so it draws the same focus outline. The stroke is a background
   of a pseudo-element, which forced colors would drop, so it has its own system color there. */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("group/tabs flex flex-col gap-2", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

type TabsVariant = "segmented" | "line";

const ListVariant = createContext<TabsVariant>("segmented");

const LIST_STYLE: Record<TabsVariant, string> = {
  segmented: "w-fit justify-center rounded-lg bg-muted p-0.75",
  line: "w-max min-w-full justify-start gap-1 border-border border-b",
};

const TRIGGER_STYLE: Record<TabsVariant, string> = {
  segmented:
    "flex-1 rounded-md border border-transparent px-2.5 motion-full:transition-[background-color,color,box-shadow] data-active:bg-card data-active:text-foreground data-active:shadow-xs dark:data-active:bg-secondary",
  line: "rounded-sm px-3 motion-full:transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground forced-colors:after:bg-[CanvasText] after:opacity-0 motion-full:after:transition-opacity data-active:text-foreground data-active:after:opacity-100",
};

function TabsList({
  className,
  variant = "segmented",
  ...props
}: TabsPrimitive.List.Props & { variant?: TabsVariant }) {
  return (
    <ListVariant.Provider value={variant}>
      <TabsPrimitive.List
        className={cn(
          "inline-flex h-ctl-md items-center text-muted-foreground",
          LIST_STYLE[variant],
          className
        )}
        data-slot="tabs-list"
        data-variant={variant}
        {...props}
      />
    </ListVariant.Provider>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  const variant = useContext(ListVariant);
  return (
    <TabsPrimitive.Tab
      aria-controls={undefined}
      className={cn(
        "touch-hit focus-ring relative inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap font-medium text-muted-foreground text-sm hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        TRIGGER_STYLE[variant],
        className
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("focus-ring flex-1 rounded-md text-sm", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
