import type {
  CustomerDuplicateMatchReadModel,
  CustomerReadModel,
} from "@polaris/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import {
  ProductTextAreaField,
  ProductTextField,
} from "../catalog/product-fields";
import { focusLater } from "../lib/focus";
import type { CustomerDraft } from "./customer-draft";
import { NAME_REQUIRED_TEXT } from "./customers-model";

interface ContactFieldProps {
  autoComplete: string;
  id: string;
  invalid: boolean;
  label: string;
  onChange: (value: string) => void;
  type: "email" | "tel";
  value: string;
}

/** Phone or e-mail: both are marked and read the one message of the form (U-24), which is by the button. */
function ContactField({
  autoComplete,
  id,
  invalid,
  label,
  onChange,
  type,
  value,
}: ContactFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field className="min-w-0" data-invalid={invalid}>
      <FieldLabel htmlFor={id}>
        {label}{" "}
        <span className="font-normal text-muted-foreground">Opcional</span>
      </FieldLabel>
      <InputGroup>
        <InputGroupInput
          aria-describedby={invalid ? "customer-contact-error" : undefined}
          aria-invalid={invalid ? true : undefined}
          autoComplete={autoComplete}
          id={id}
          onChange={handleChange}
          type={type}
          value={value}
        />
      </InputGroup>
    </Field>
  );
}

interface CandidateProps {
  customer: CustomerReadModel;
  disabled: boolean;
  matchedBy: Array<"email" | "phone">;
  onUseExisting: (customer: CustomerReadModel) => void;
}

/** What the two customers have in common, in the order the person reads it: "Mesmo email e telefone". */
function matchLabel(matchedBy: Array<"email" | "phone">): string {
  const fields = [
    matchedBy.includes("email") ? "email" : null,
    matchedBy.includes("phone") ? "telefone" : null,
  ].filter((field) => field !== null);
  return `Mesmo ${fields.join(" e ")}`;
}

function DuplicateCandidate({
  customer,
  disabled,
  matchedBy,
  onUseExisting,
}: CandidateProps) {
  const handleUse = useCallback(
    () => onUseExisting(customer),
    [customer, onUseExisting]
  );
  const archived = customer.status === "archived";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="font-medium [overflow-wrap:anywhere]">
            {customer.name}
          </strong>
          <Badge variant={archived ? "warning" : "outline"}>
            {archived ? "Arquivado" : "Ativo"}
          </Badge>
        </div>
        <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
          {[customer.phone, customer.email].filter(Boolean).join(" · ")}
        </p>
        <p className="text-muted-foreground text-support">
          {matchLabel(matchedBy)}
        </p>
        {archived ? (
          <p className="text-muted-foreground text-support">
            Selecionar este cadastro não o restaura.
          </p>
        ) : null}
      </div>
      <Button
        aria-label={`Usar existente: ${customer.name}`}
        disabled={disabled}
        onClick={handleUse}
        type="button"
      >
        Usar existente
      </Button>
    </li>
  );
}

interface DuplicatesProps {
  disabled: boolean;
  matches: CustomerDuplicateMatchReadModel[];
  onCreateAnyway: () => void;
  onUseExisting: (customer: CustomerReadModel) => void;
}

/**
 * The customers that look like the one being made (U-25). "Usar existente" is the main action; making another one is
 * the way out, in outline. The sentence for the screen reader is the live region of the form, which was there before
 * this appeared: a region that arrives already full is not read.
 */
function PossibleDuplicates({
  disabled,
  matches,
  onCreateAnyway,
  onUseExisting,
}: DuplicatesProps) {
  return (
    <section
      aria-labelledby="customer-duplicate-heading"
      className="grid gap-1 rounded-lg border border-border p-3 min-[48rem]:col-span-2"
    >
      <h3 className="text-section" id="customer-duplicate-heading">
        Encontramos possíveis clientes existentes
      </h3>
      <p className="text-muted-foreground text-support">
        Revise os cadastros por email ou telefone. Nenhum dado será mesclado
        automaticamente.
      </p>
      <ul className="divide-y divide-border">
        {matches.map(({ customer, matchedBy }) => (
          <DuplicateCandidate
            customer={customer}
            disabled={disabled}
            key={customer.id}
            matchedBy={matchedBy}
            onUseExisting={onUseExisting}
          />
        ))}
      </ul>
      <div className="pt-1">
        <Button
          disabled={disabled}
          onClick={onCreateAnyway}
          type="button"
          variant="outline"
        >
          Criar mesmo assim
        </Button>
      </div>
    </section>
  );
}

interface CustomerFormProps {
  /** Why the form cannot be saved yet: no phone and no e-mail. Shown beside the button, with both fields marked. */
  contactError: string | null;
  draft: CustomerDraft;
  duplicateMatches: CustomerDuplicateMatchReadModel[];
  editingCustomer: CustomerReadModel | null;
  isPending: boolean;
  onCancel: () => void;
  onChange: (field: keyof CustomerDraft, value: string) => void;
  onCreateAnyway: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUseExisting: (customer: CustomerReadModel) => void;
}

function submitLabelFor(
  isPending: boolean,
  editingCustomer: CustomerReadModel | null
): string {
  if (isPending) {
    return "Salvando…";
  }
  return editingCustomer ? "Salvar alterações" : "Cadastrar cliente";
}

/** The form of a new customer, or of the edit of one: the name, a phone or an e-mail, and notes. */
export function CustomerForm({
  contactError,
  draft,
  duplicateMatches,
  editingCustomer,
  isPending,
  onCancel,
  onChange,
  onCreateAnyway,
  onSubmit,
  onUseExisting,
}: CustomerFormProps) {
  const [showRequired, setShowRequired] = useState(false);
  const nameRef = useRef<HTMLDivElement>(null);
  const nameMissing = draft.name.trim() === "";
  const nameError =
    showRequired && nameMissing ? NAME_REQUIRED_TEXT : undefined;

  // opening the edit of a customer takes the person to the name; a new form is opened already where the focus is
  const formKey = editingCustomer?.id ?? "new";
  useEffect(() => {
    setShowRequired(false);
    if (formKey !== "new") {
      focusLater(() => nameRef.current?.querySelector("input")?.focus());
    }
  }, [formKey]);

  const handleName = useCallback(
    (value: string) => onChange("name", value),
    [onChange]
  );
  const handlePhone = useCallback(
    (value: string) => onChange("phone", value),
    [onChange]
  );
  const handleEmail = useCallback(
    (value: string) => onChange("email", value),
    [onChange]
  );
  const handleNotes = useCallback(
    (value: string) => onChange("notes", value),
    [onChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (nameMissing) {
        event.preventDefault();
        setShowRequired(true);
        focusLater(() => nameRef.current?.querySelector("input")?.focus());
        return;
      }
      onSubmit(event);
    },
    [nameMissing, onSubmit]
  );

  return (
    <Card aria-labelledby="customer-form-heading" role="region">
      <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle aria-level={2} id="customer-form-heading" role="heading">
            {editingCustomer ? "Editar cliente" : "Novo cliente"}
          </CardTitle>
          {editingCustomer ? (
            <Button
              disabled={isPending}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancelar edição
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 min-[48rem]:grid-cols-2">
          <div className="min-w-0 min-[48rem]:col-span-2" ref={nameRef}>
            <ProductTextField
              autoComplete="name"
              error={nameError}
              id="customer-name"
              label="Nome"
              onChange={handleName}
              value={draft.name}
            />
          </div>
          <FieldSet
            aria-describedby="customer-contact-help"
            className="min-[48rem]:col-span-2"
          >
            <FieldLegend className="mb-3" variant="label">
              Contato{" "}
              <span className="font-normal text-muted-foreground">
                Informe telefone ou email
              </span>
            </FieldLegend>
            <div className="grid gap-4 min-[48rem]:grid-cols-2">
              <ContactField
                autoComplete="tel"
                id="customer-phone"
                invalid={contactError !== null}
                label="Telefone"
                onChange={handlePhone}
                type="tel"
                value={draft.phone}
              />
              <ContactField
                autoComplete="email"
                id="customer-email"
                invalid={contactError !== null}
                label="Email"
                onChange={handleEmail}
                type="email"
                value={draft.email}
              />
            </div>
            <FieldDescription id="customer-contact-help">
              Email e telefone podem se repetir entre clientes.
            </FieldDescription>
          </FieldSet>
          {/* always in the tree, so the panel that appears after the check is announced (U-25) */}
          <p className="sr-only" role="status">
            {duplicateMatches.length > 0
              ? "Encontramos possíveis clientes existentes. Revise antes de criar um novo."
              : ""}
          </p>
          {duplicateMatches.length > 0 ? (
            <PossibleDuplicates
              disabled={isPending}
              matches={duplicateMatches}
              onCreateAnyway={onCreateAnyway}
              onUseExisting={onUseExisting}
            />
          ) : null}
          <ProductTextAreaField
            className="min-[48rem]:col-span-2"
            id="customer-notes"
            label="Observações"
            onChange={handleNotes}
            optional
            value={draft.notes}
          />
        </CardContent>
        <CardContent className="grid gap-3">
          {contactError ? (
            <FieldError id="customer-contact-error">{contactError}</FieldError>
          ) : null}
          <div className="flex justify-end">
            <Button
              className="max-[30rem]:w-full"
              disabled={isPending}
              type="submit"
            >
              {submitLabelFor(isPending, editingCustomer)}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
