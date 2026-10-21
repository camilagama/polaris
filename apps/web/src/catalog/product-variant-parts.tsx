import type { FormEvent, ReactNode } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field";

/* The two sections of the variants panel that save one value per variant (the SKU and the list price) draw the
   same three things: a block with a title and a sentence, a form of one field and its button, and the line that
   says how the save went. */

interface VariantSectionProps {
  children: ReactNode;
  /** One sentence. */
  help: string;
  id: string;
  title: string;
}

export function VariantSection({
  children,
  help,
  id,
  title,
}: VariantSectionProps) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid gap-3 border-border border-t px-(--card-spacing) pt-4"
    >
      <div className="grid gap-0.5">
        <h3 className="text-section" id={`${id}-title`}>
          {title}
        </h3>
        <p className="text-muted-foreground text-support">{help}</p>
      </div>
      {children}
    </section>
  );
}

interface VariantFieldRowProps {
  buttonLabel: string;
  children: ReactNode;
  disabled: boolean;
  /** The message of the field and the id its `aria-describedby` points to; under the whole row, so the button keeps its line. */
  error?: { id: string; text: string } | undefined;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/** One variant: the field (with its label) and the button that saves it. */
export function VariantFieldRow({
  buttonLabel,
  children,
  disabled,
  error,
  onSubmit,
}: VariantFieldRowProps) {
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
      noValidate
      onSubmit={onSubmit}
    >
      {children}
      <Button disabled={disabled} type="submit" variant="outline">
        {buttonLabel}
      </Button>
      {error ? (
        <FieldError className="col-span-2" id={error.id}>
          {error.text}
        </FieldError>
      ) : null}
    </form>
  );
}

interface VariantSaveNoticeProps {
  message: string | null;
  needsReload: boolean;
  onReload: () => void;
}

/** How the save went: a conflict is an error with the way out (read the variants again); the rest is a status. */
export function VariantSaveNotice({
  message,
  needsReload,
  onReload,
}: VariantSaveNoticeProps) {
  if (!message) {
    return null;
  }
  if (needsReload) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {message}
          <Button onClick={onReload} size="sm" type="button" variant="link">
            Atualizar variantes
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-muted-foreground text-support" role="status">
      {message}
    </p>
  );
}
