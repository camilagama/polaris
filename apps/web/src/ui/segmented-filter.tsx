"use client";

import { useCallback } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";

/* The state filter of a list (Ativos, Arquivados, Removidos) is not a tab of the screen: it has no panel, the list
   below it is the screen's. It keeps the strip and the keyboard of the tabs (arrows move to the neighbour and choose it,
   Tab leaves the group, a screen reader says "aba, selecionada"), drawn once here so every list has the same one. */

interface SegmentedFilterProps<T extends string> {
  /** The options cannot change while an action runs. */
  disabled?: boolean | undefined;
  /** The name of the group, for a screen reader. */
  label: string;
  onSelect: (value: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
}

export function SegmentedFilter<T extends string>({
  disabled = false,
  label,
  onSelect,
  options,
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
    <Tabs onValueChange={handleChange} value={value}>
      <TabsList activateOnFocus aria-label={label}>
        {options.map(([option, text]) => (
          <TabsTrigger
            // three words of 20 px do not fit a 320 px window with the usual padding of a tab, and the strip would widen the page
            className="px-1 min-[18.5rem]:px-2.5"
            disabled={disabled}
            key={option}
            value={option}
          >
            {text}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
