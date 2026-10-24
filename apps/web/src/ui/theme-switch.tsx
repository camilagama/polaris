import MonitorIcon from "lucide-react/dist/esm/icons/monitor";
import MoonIcon from "lucide-react/dist/esm/icons/moon";
import SunIcon from "lucide-react/dist/esm/icons/sun";
import { useCallback } from "react";
import { parseTheme, THEMES, type Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
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
      <DropdownMenuContent align="end" width="fixed">
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
