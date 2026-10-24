"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

/* The shadcn Tabs of the base-nova registry over Base UI, once, with the three rules of the project: the list is
   `h-ctl-md` (32 px with a mouse, 36 px with touch), each tab has a 48 px touch area (`touch-hit`) and the keyboard
   focus is the 3 px outline (`focus-ring`). Horizontal only and one style (the segmented list on the muted
   strip): the vertical layout and the `line` variant of the registry come back with the first screen that needs
   them. The active tab changes with no movement: background and color fade, nothing slides or scales. The open panel is a tab stop (Base UI
   gives it `tabIndex` 0), so it draws the same focus outline. */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("group/tabs flex flex-col gap-2", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex h-ctl-md w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground",
        className
      )}
      data-slot="tabs-list"
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "touch-hit focus-ring relative inline-flex h-full flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 font-medium text-muted-foreground text-sm transition-[background-color,color,box-shadow] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-card data-active:text-foreground data-active:shadow-xs dark:data-active:bg-secondary [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
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
