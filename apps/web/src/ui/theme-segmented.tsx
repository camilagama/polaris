import { THEMES, type Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { SegmentedFilter } from "@/ui/segmented-filter";

const LABEL: Record<Theme, string> = {
  claro: "Claro",
  escuro: "Escuro",
  sistema: "Automático",
};

const OPTIONS = THEMES.map((theme) => [theme, LABEL[theme]] as const);

/**
 * The appearance choice with the three options side by side, in words, on the same strip, keyboard and touch area
 * as the list state filters. Used only in the component gallery: the app switches the theme from the header menu
 * (the "Aparência" radio group of the store card), not from this control.
 */
export function ThemeSegmented() {
  const [theme, choose] = useTheme();
  return (
    <SegmentedFilter
      label="Aparência"
      onSelect={choose}
      options={OPTIONS}
      value={theme}
    />
  );
}
