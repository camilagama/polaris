import { useEffect, useState } from "react";

/** DESIGN.md: the sidebar and the tables change at 760 px (`md` of Tailwind, the `touch` variant). */
const MOBILE_BREAKPOINT = 760;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`;

/** Whether the window is narrower than the breakpoint, right from the first render (the app has no server render). */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches
  );
  useEffect(() => {
    const query = window.matchMedia(QUERY);
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return isMobile;
}
