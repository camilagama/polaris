import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs` and when the tab becomes
 * visible again, so values derived from "now" never go stale on a long-lived
 * form. Submitting still reads the clock itself.
 */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = window.setInterval(refresh, intervalMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [intervalMs]);

  return now;
}
