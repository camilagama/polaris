import { type RefObject, useEffect, useRef } from "react";
import { focusLater } from "../lib/focus";

/* The first field the person can edit: the controls of a step are inside the section, in reading order. */
const FIRST_EDITABLE =
  "input:not(:disabled), textarea:not(:disabled), [role='combobox']:not([aria-disabled='true']):not(:disabled)";

/**
 * Keeps the focus with the person when a cancellation or a return changes step. The button that was pressed leaves
 * the page with the step, so the focus would fall to the page: on the way to the confirmation it goes to the notice
 * that says what will happen, and on the way back to the first field to edit. It does not run on the first render
 * nor when the panel opens (the confirmation did not change).
 */
export function useStepFocus(
  confirming: boolean,
  noticeRef: RefObject<HTMLElement | null>,
  sectionRef: RefObject<HTMLElement | null>
) {
  const previous = useRef(confirming);
  useEffect(() => {
    if (previous.current === confirming) {
      return;
    }
    previous.current = confirming;
    focusLater(() => {
      const target = confirming
        ? noticeRef.current
        : sectionRef.current?.querySelector<HTMLElement>(FIRST_EDITABLE);
      target?.focus();
    });
  }, [confirming, noticeRef, sectionRef]);
}
