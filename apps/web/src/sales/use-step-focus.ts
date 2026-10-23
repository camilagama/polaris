import { type RefObject, useCallback, useEffect, useRef } from "react";
import { focusLater } from "../lib/focus";

/* The first field the person can edit: the controls of a step are inside the section, in reading order. */
const FIRST_EDITABLE =
  "input:not(:disabled), textarea:not(:disabled), [role='combobox']:not([aria-disabled='true']):not(:disabled)";

/**
 * Keeps the focus with the person when a cancellation or a return changes step. The button that was pressed leaves
 * the page with the step, so the focus would fall to the page. On the way to the confirmation it goes, by itself, to
 * the notice that says what will happen (not on the first render, nor when the panel opens: the confirmation did not
 * change). On the way back it goes to the first field to edit, when the returned function is called by "Voltar": a
 * definite failure also returns to editing, and there the message of the failure is what the person has to read.
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
    if (confirming) {
      focusLater(() => noticeRef.current?.focus());
    }
  }, [confirming, noticeRef]);
  return useCallback(
    () =>
      focusLater(() =>
        sectionRef.current?.querySelector<HTMLElement>(FIRST_EDITABLE)?.focus()
      ),
    [sectionRef]
  );
}
