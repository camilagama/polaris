import { type ChangeEvent, useCallback } from "react";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/ui/field";
import { InputGroup, InputGroupTextarea } from "@/ui/input-group";
import { describedBy, FieldTexts, SelectField } from "./sale-fields";

/* The optional reason of a cancellation or of a return, on the components of src/ui (ADR 0103): the reason in a
   Select (with "Sem motivo informado" as a choice, so it can be chosen back) and the note under it, with its
   counter. The Select is not a native control, so a fieldset does not turn it off: `disabled` is told. */

/** The Select's value for "no reason" (the draft keeps ""). */
const NO_REASON = "none";

interface ReasonFieldsProps {
  /** The draft is being reviewed, sent or is locked. */
  disabled: boolean;
  errors: { note?: string | undefined; reason?: string | undefined };
  legend: string;
  noteCounter: string;
  onNoteChange: (value: string) => void;
  onReasonChange: (code: string) => void;
  /** The ids of the controls: `${prefix}-reason` and `${prefix}-note`. */
  prefix: string;
  reasonCode: string;
  reasonNote: string;
  reasons: readonly (readonly [string, string])[];
}

export function ReasonFields({
  disabled,
  errors,
  legend,
  noteCounter,
  onNoteChange,
  onReasonChange,
  prefix,
  reasonCode,
  reasonNote,
  reasons,
}: ReasonFieldsProps) {
  const handleReason = useCallback(
    (value: string) => onReasonChange(value === NO_REASON ? "" : value),
    [onReasonChange]
  );
  const handleNote = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onNoteChange(event.target.value),
    [onNoteChange]
  );
  const noteId = `${prefix}-note`;
  return (
    <FieldSet className="gap-3" disabled={disabled}>
      {/* the group's name for the screen reader; on screen the label of the list says it */}
      <FieldLegend className="sr-only">{legend}</FieldLegend>
      <SelectField
        disabled={disabled}
        error={errors.reason}
        id={`${prefix}-reason`}
        label="Motivo (opcional)"
        onChange={handleReason}
        options={[
          { id: NO_REASON, label: "Sem motivo informado" },
          ...reasons.map(([code, label]) => ({ id: code, label })),
        ]}
        placeholder="Sem motivo informado"
        value={reasonCode === "" ? NO_REASON : reasonCode}
      />
      {reasonCode === "" ? null : (
        <Field className="min-w-0" data-invalid={Boolean(errors.note)}>
          <FieldLabel htmlFor={noteId}>
            {reasonCode === "other"
              ? "Observação (obrigatória para “Outro”)"
              : "Observação (opcional)"}
          </FieldLabel>
          <InputGroup className="h-auto items-stretch">
            <InputGroupTextarea
              aria-describedby={describedBy(noteId, errors.note, noteCounter)}
              aria-invalid={errors.note ? true : undefined}
              disabled={disabled}
              id={noteId}
              onChange={handleNote}
              rows={3}
              value={reasonNote}
            />
          </InputGroup>
          <FieldTexts error={errors.note} hint={noteCounter} id={noteId} />
        </Field>
      )}
    </FieldSet>
  );
}
