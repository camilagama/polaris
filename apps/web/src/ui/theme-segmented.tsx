import { type MouseEvent, useCallback } from "react";
import { parseTheme, THEMES, type Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";

const LABEL: Record<Theme, string> = {
  claro: "Claro",
  escuro: "Escuro",
  sistema: "Automático",
};

/**
 * The appearance choice with the three options side by side, in words (DESIGN.md: segmented in the sidebar). Plain
 * buttons with the classes of the outline button, so the frame of every screen brings no primitive of its own.
 */
export function ThemeSegmented() {
  const [theme, choose] = useTheme();
  const pick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      choose(parseTheme(event.currentTarget.dataset.theme)),
    [choose]
  );
  return (
    <fieldset
      aria-label="Aparência"
      className="m-0 flex w-full min-w-0 rounded-md border-0 p-0 shadow-xs"
    >
      {THEMES.map((option) => (
        <button
          aria-pressed={option === theme}
          className="touch-hit focus-ring not-first:-ml-px inline-flex h-ctl-sm min-w-0 flex-1 items-center justify-center border border-border bg-card px-1 font-medium text-foreground text-xs motion-full:transition-colors first:rounded-l-md last:rounded-r-md hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground dark:bg-secondary/60"
          data-theme={option}
          key={option}
          onClick={pick}
          type="button"
        >
          {LABEL[option]}
        </button>
      ))}
    </fieldset>
  );
}
