import { useCallback, useRef, useState } from "react";

interface Versioned {
  id: string;
  version: number;
}

/** The form is closed (null), creating one, or editing one. */
type FormTarget<T> = T | "new" | null;

interface FormDialogOptions<T> {
  /** The command running in this part of the screen: while one runs, Esc and "Fechar" do not close the form. */
  busy: boolean;
  /** Called when a form opens: the message of the last command belongs to the screen it covers. */
  onOpen: () => void;
  /** What opened the form, for the focus to go back to when it closes; a stable function. */
  originOf: (next: T | "new") => () => HTMLElement | null;
}

/**
 * The form of a part of the Despesas screen as a dialog (the whole screen on a phone): which form it holds, which
 * key starts it over, where the focus goes back to, and the draft kept between openings.
 * `target` stays until the dialog has closed, so it does not turn into another form while it fades. What was typed
 * when the form was closed by Esc or "Fechar" comes back at the next opening of the same form (in memory only);
 * "Cancelar" and a saved form throw it away (`close`).
 */
export function useFormDialog<T extends Versioned, D>({
  busy,
  onOpen,
  originOf,
}: FormDialogOptions<T>) {
  const [target, setTarget] = useState<FormTarget<T>>(null);
  const [open, setOpen] = useState(false);
  const [formCount, setFormCount] = useState(0);
  const originRef = useRef<() => HTMLElement | null>(() => null);
  const draftStore = useRef<{ draft: D; key: string } | null>(null);
  const draftKey = useRef("");

  const onDraftChange = useCallback((draft: D | null) => {
    draftStore.current = draft && { draft, key: draftKey.current };
  }, []);
  /** "Cancelar", a saved form: the form closes and what was typed is thrown away. */
  const close = useCallback(() => {
    draftStore.current = null;
    setOpen(false);
  }, []);
  const openForm = useCallback(
    (next: T | "new") => {
      onOpen();
      originRef.current = originOf(next);
      setTarget(next);
      setOpen(true);
    },
    [onOpen, originOf]
  );
  const finalFocus = useCallback(() => originRef.current() ?? true, []);
  /** Esc and "Fechar": the form closes and the draft stays. */
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!(next || busy)) {
        setOpen(false);
      }
    },
    [busy]
  );
  /** The form is gone: the next one starts from nothing. */
  const onOpenChangeComplete = useCallback((next: boolean) => {
    if (!next) {
      setTarget(null);
      setFormCount((count) => count + 1);
    }
  }, []);

  // the kept draft is the one of the same item (or of a new one): another item starts from its own data
  let formKey = "closed";
  let keptKey = "";
  if (target === "new") {
    formKey = `new:${formCount}`;
    keptKey = "new";
  } else if (target !== null) {
    formKey = `${target.id}:${target.version}`;
    keptKey = target.id;
  }
  draftKey.current = keptKey;
  const keptDraft =
    draftStore.current?.key === keptKey ? draftStore.current.draft : undefined;

  return {
    close,
    /** The props of the `Dialog` root. */
    dialog: { onOpenChange, onOpenChangeComplete, open },
    editing: target === "new" ? null : target,
    finalFocus,
    formKey,
    keptDraft,
    onDraftChange,
    open,
    openForm,
  };
}
