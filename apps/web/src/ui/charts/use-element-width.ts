/* adapted from Bklit UI (bklit/bklit-ui@3e9af3b), MIT */
import { useCallback, useRef, useState } from "react";

/**
 * The width of an element in pixels, kept up to date as it resizes: 0 until it is measured (on the server, in a
 * test, or before the first layout). The charts draw in their own width, not in a `viewBox` of a desktop shrunk to
 * the phone, so the 11 and 12 px of the axes stay 11 and 12 px.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) {
      return;
    }
    setWidth(Math.round(element.getBoundingClientRect().width));
    observer.current = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        setWidth(Math.round(box.width));
      }
    });
    observer.current.observe(element);
  }, []);
  return [ref, width] as const;
}
