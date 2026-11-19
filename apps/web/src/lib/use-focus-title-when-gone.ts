import {
  type FocusEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";

interface FocusTitleWhenGone<T extends HTMLElement> {
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onFocus: () => void;
  title: RefObject<T | null>;
}

/**
 * A control that leaves the page while it has the focus drops the focus on the
 * body, so a keyboard or screen reader user starts over from the top. This
 * sends the focus to the list's title instead, and only when the focus really
 * was dropped: a person who already moved to another field keeps it. The title
 * needs `tabIndex={-1}`.
 */
export function useFocusTitleWhenGone<T extends HTMLElement>(
  visible: boolean
): FocusTitleWhenGone<T> {
  const title = useRef<T>(null);
  const held = useRef(false);
  useEffect(() => {
    if (visible || !held.current) {
      return;
    }
    held.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      title.current?.focus({ preventScroll: true });
    }
  }, [visible]);
  const onFocus = useCallback(() => {
    held.current = true;
  }, []);
  // The browser also blurs a control that is disabled or removed under the focus: that is not the person leaving it.
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const target = event.currentTarget;
    if (target.isConnected && !(target as HTMLButtonElement).disabled) {
      held.current = false;
    }
  }, []);
  return { onBlur, onFocus, title };
}
