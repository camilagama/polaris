import MonitorIcon from "lucide-react/dist/esm/icons/monitor";
import MoonIcon from "lucide-react/dist/esm/icons/moon";
import SunIcon from "lucide-react/dist/esm/icons/sun";
import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  parseTheme,
  readTheme,
  saveTheme,
  systemDarkQuery,
  THEMES,
  type Theme,
} from "@/lib/theme";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

const LABEL: Record<Theme, string> = {
  claro: "Claro",
  escuro: "Escuro",
  sistema: "Automático",
};
const ICON = { claro: SunIcon, escuro: MoonIcon, sistema: MonitorIcon };

/** The chosen theme, kept in localStorage and applied to `<html>`; "sistema" follows the system live. */
function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readTheme(localStorage));
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "sistema") {
      return;
    }
    const query = systemDarkQuery();
    const follow = () => applyTheme("sistema");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);
  const choose = useCallback((next: Theme) => {
    saveTheme(localStorage, next);
    setTheme(next);
  }, []);
  return [theme, choose];
}

/** The appearance menu (Automático, Claro, Escuro): an icon button that opens a radio menu. */
export function ThemeSwitch() {
  const [theme, choose] = useTheme();
  // the menu hands back the value of the item; read it against the list like the stored one
  const chooseItem = useCallback(
    (value: unknown) => choose(parseTheme(String(value))),
    [choose]
  );
  const Icon = ICON[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Aparência: ${LABEL[theme]}`}
            size="icon"
            variant="ghost"
          />
        }
      >
        <Icon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Aparência</DropdownMenuLabel>
          <DropdownMenuRadioGroup onValueChange={chooseItem} value={theme}>
            {THEMES.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {LABEL[option]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
