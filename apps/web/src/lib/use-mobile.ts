import { useEffect, useState } from "react";

/** DESIGN.md: the sidebar and the tables change at 760 px (`md` of Tailwind, the `touch` variant). */
const MOBILE_BREAKPOINT = 760;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`;

/** Whether a media query matches, right from the first render (the app has no server render). */
export function useMediaQuery(media: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(media).matches
  );
  useEffect(() => {
    const query = window.matchMedia(media);
    const update = () => setMatches(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, [media]);
  return matches;
}

/** Whether the window is narrower than the breakpoint, right from the first render. */
export function useIsMobile(): boolean {
  return useMediaQuery(QUERY);
}
