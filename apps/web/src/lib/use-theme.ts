import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  browserStorage,
  readTheme,
  saveTheme,
  systemDarkQuery,
  type Theme,
} from "@/lib/theme";

/** The chosen theme, kept in localStorage and applied to `<html>`; "sistema" follows the system live. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readTheme(browserStorage()));
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
    saveTheme(browserStorage(), next);
    setTheme(next);
  }, []);
  return [theme, choose];
}
