import { useSyncExternalStore } from "react";

/** The numbered keys cover the first nine options: one digit each. */
export const MAX_KEYED_METHODS = 9;

/** The same query as the `touch` variant of `@polaris/ui/theme.css`: coarse pointer or narrower than 760 px. */
const TOUCH_QUERY = "(pointer: coarse), not all and (min-width: 47.5rem)";

function touchQuery(): MediaQueryList | null {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(TOUCH_QUERY);
}

/** True with a fine pointer and 760 px or more: the only place where the numbers show and the keys work. */
export function methodKeysEnabled(): boolean {
  const query = touchQuery();
  return query !== null && !query.matches;
}

function subscribe(onChange: () => void): () => void {
  const query = touchQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

export function useMethodKeysEnabled(): boolean {
  return useSyncExternalStore(subscribe, methodKeysEnabled, methodKeysEnabled);
}

interface KeyLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

function isTextTarget(target: unknown): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      'input:not([type="radio"]):not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])'
    ) !== null
  );
}

/** The option a key picks, or `null` when the key is not a bare digit of an existing option or the focus is on a text field. */
export function methodForKey<T>(
  event: KeyLike,
  methods: readonly T[]
): T | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key.length !== 1 || event.key < "1" || event.key > "9") {
    return null;
  }
  if (isTextTarget(event.target)) {
    return null;
  }
  const index = Number(event.key) - 1;
  if (index >= Math.min(methods.length, MAX_KEYED_METHODS)) {
    return null;
  }
  return methods[index] ?? null;
}
