import { useEffect, useState } from "react";

/** DESIGN.md: the sidebar and the tables change at 760 px (`md` of Tailwind, the `touch` variant). */
const MOBILE_BREAKPOINT = 760;

/** Whether the window is narrower than the breakpoint; false until the first effect, as in shadcn. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`
    );
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return isMobile;
}
