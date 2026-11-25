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
 * The appearance choice with the three options side by side, in words: the state filter of the project, so the
 * choice has the strip, the keyboard and the touch area every other filter has.
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
