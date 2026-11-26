"use client";

import { useCallback } from "react";
import { ScrollingTabList } from "@/ui/section-tabs";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";

/* The state filter of a list (Ativos, Arquivados, Removidos) is not a tab of the screen: it has no panel, the list
   below it is the screen's. It keeps the strip and the keyboard of the tabs (arrows move to the neighbour and choose it,
   Tab leaves the group, a screen reader says "aba, selecionada"), drawn once here so every list has the same one. When
   the options do not fit the width (the lines of the import preview with their counts, at 320 px and a 20 px font) the
   strip scrolls inside its own box, with the fade of the tabs of a screen, and never widens the page. */

interface SegmentedFilterProps<T extends string> {
  /** A line shared with other controls (the status beside the month and "Filtrar" on a phone): smaller type and tighter padding below 640 px, so the line keeps to one row. */
  compact?: boolean | undefined;
  /** The options cannot change while an action runs. */
  disabled?: boolean | undefined;
  /** The name of the group, for a screen reader. */
  label: string;
  onSelect: (value: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  /** What the strip sits on: the page, or a dialog (`bg-popover`); the fade at the edges takes its color. */
  surface?: "page" | "popover";
  value: T;
}

export function SegmentedFilter<T extends string>({
  compact = false,
  disabled = false,
  label,
  onSelect,
  options,
  surface = "page",
  value,
}: SegmentedFilterProps<T>) {
  const handleChange = useCallback(
    (next: unknown) => {
      const chosen = options.find(([option]) => option === next);
      if (chosen) {
        onSelect(chosen[0]);
      }
    },
    [onSelect, options]
  );
  return (
    <Tabs className="min-w-0" onValueChange={handleChange} value={value}>
      <ScrollingTabList
        signature={options.map(([option]) => option).join()}
        surface={surface}
        value={value}
      >
        <TabsList
          activateOnFocus
          aria-label={label}
          className={compact ? "p-0.5 sm:p-0.75" : undefined}
        >
          {options.map(([option, text]) => (
            <TabsTrigger
              // three words of 20 px do not fit a 320 px window with the usual padding of a tab, and the strip would widen the page
              // the scroll box clips at the strip, so the outline stays inside the strip's padding (3 px, and a 3 px outline over a 2 px padding is pulled in by 1 px)
              className={
                compact
                  ? "px-1 text-xs focus-visible:outline-offset-[-0.0625rem]! sm:px-2.5 sm:text-sm sm:focus-visible:outline-offset-0!"
                  : "px-1 focus-visible:outline-offset-0! min-[18.5rem]:px-2.5"
              }
              data-value={option}
              disabled={disabled}
              key={option}
              value={option}
            >
              {text}
            </TabsTrigger>
          ))}
        </TabsList>
      </ScrollingTabList>
    </Tabs>
  );
}
