import type { MouseEvent } from "react";

/** A plain click: a new tab or window asked by a key or the middle button keeps the browser's own way. */
export function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}
