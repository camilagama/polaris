import {
  type BillingPlanView,
  billingStartCheckoutInput,
} from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/ui/field";
import { Input } from "@/ui/input";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import {
  type CycleMonths,
  defaultCycle,
  METHOD_HINTS,
  METHOD_NAMES,
  offerCycles,
  offerMethods,
  offerTerms,
  type PlanMethod,
  PRO_PITCH,
  type Refusal,
  taxIdDigits,
} from "./subscription-model";
import { SectionTitle } from "./subscription-parts";

/** What the offer asks the server to start: the payer only for Pix Automático (the card sends nothing of it). */
export type CheckoutRequest =
  | { cycleMonths: CycleMonths; method: "card"; trial: boolean }
  | {
      cycleMonths: CycleMonths;
      method: "pix_automatic";
      payer: { email: string; name: string; taxId: string };
      trial: boolean;
    };

type PayerField = "email" | "name" | "taxId";

const PAYER_FIELD_ERRORS: Readonly<Record<PayerField, string>> = {
  email: "Informe um e-mail válido.",
  name: "Informe o nome de quem paga, como no banco.",
  taxId: "Informe um CPF ou CNPJ válido.",
};

/** The fields the contract refuses, checked before the trip with the same schema the server reads. */
function payerProblems(
  organizationId: string,
  request: Extract<CheckoutRequest, { method: "pix_automatic" }>
): PayerField[] {
  const parsed = billingStartCheckoutInput.safeParse({
    ...request,
    organizationId,
  });
  if (parsed.success) {
    return [];
  }
  const fields = new Set<PayerField>();
  for (const issue of parsed.error.issues) {
    const [first, second] = issue.path;
    if (
      first === "payer" &&
      (second === "email" || second === "name" || second === "taxId")
    ) {
      fields.add(second);
    }
  }
  return [...fields];
}

/** The payer's fields in the order of the screen. */
const PAYER_ORDER: readonly PayerField[] = ["name", "taxId", "email"];

/** The ids of the payer's inputs: the first one refused takes the focus. */
const PAYER_ID = "subscription-payer";

interface PayerDraft {
  email: string;
  name: string;
  taxId: string;
}

function PayerFields({
  disabled,
  draft,
  onChange,
  problems,
}: {
  disabled: boolean;
  draft: PayerDraft;
  onChange: (next: PayerDraft) => void;
  problems: readonly PayerField[];
}) {
  const id = PAYER_ID;
  const field = (name: PayerField) => ({
    "aria-describedby": `${id}-${name}-hint ${id}-${name}-error`,
    "aria-invalid": problems.includes(name) || undefined,
    disabled,
    id: `${id}-${name}`,
    onChange: (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...draft, [name]: event.target.value }),
    value: draft[name],
  });
  const error = (name: PayerField) => (
    <FieldError id={`${id}-${name}-error`}>
      {problems.includes(name) ? PAYER_FIELD_ERRORS[name] : null}
    </FieldError>
  );
  return (
    <fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <legend className="mb-1 font-medium text-sm">Quem paga</legend>
      <Field data-invalid={problems.includes("name") || undefined}>
        <FieldLabel htmlFor={`${id}-name`}>Nome</FieldLabel>
        <Input autoComplete="name" {...field("name")} />
        <FieldDescription id={`${id}-name-hint`}>
          Como aparece no banco.
        </FieldDescription>
        {error("name")}
      </Field>
      <Field data-invalid={problems.includes("taxId") || undefined}>
        <FieldLabel htmlFor={`${id}-taxId`}>CPF ou CNPJ</FieldLabel>
        <Input autoComplete="off" inputMode="numeric" {...field("taxId")} />
        <FieldDescription id={`${id}-taxId-hint`}>
          O banco pede o documento de quem autoriza o Pix Automático. O Polaris
          não guarda o número do documento.
        </FieldDescription>
        {error("taxId")}
      </Field>
      <Field data-invalid={problems.includes("email") || undefined}>
        <FieldLabel htmlFor={`${id}-email`}>E-mail</FieldLabel>
        <Input
          autoComplete="email"
          inputMode="email"
          type="email"
          {...field("email")}
        />
        <FieldDescription id={`${id}-email-hint`}>
          Para os avisos da cobrança.
        </FieldDescription>
        {error("email")}
      </Field>
    </fieldset>
  );
}

interface ChoiceProps<T extends number | string> {
  disabled: boolean;
  label: string;
  onChange: (value: T) => void;
  options: readonly {
    badge?: string | null;
    detail: ReactNode;
    title: string;
    value: T;
  }[];
  value: T | null;
}

/** Radio cards (the choice is the field): Base UI radios are spans, so `disabled` goes on each (no fieldset). */
function Choice<T extends number | string>({
  disabled,
  label,
  onChange,
  options,
  value,
}: ChoiceProps<T>) {
  const id = useId();
  const handleValue = useCallback(
    (next: unknown) => onChange(next as T),
    [onChange]
  );
  return (
    <RadioGroup
      aria-label={label}
      className="grid-cols-1 sm:grid-cols-2"
      disabled={disabled}
      onValueChange={handleValue}
      value={value}
    >
      {options.map((option) => (
        <FieldLabel
          className="has-data-disabled:opacity-50"
          htmlFor={`${id}-${option.value}`}
          key={option.value}
        >
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                {option.title}
                {option.badge ? (
                  <Badge variant="secondary">{option.badge}</Badge>
                ) : null}
              </FieldTitle>
              <FieldDescription>{option.detail}</FieldDescription>
            </FieldContent>
            <RadioGroupItem
              disabled={disabled}
              id={`${id}-${option.value}`}
              value={option.value}
            />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  );
}

/** The button while it waits: the card opens a page, Pix Automático makes its code here. */
function pendingLabel(
  pending: boolean,
  method: PlanMethod | null,
  action: string
): string {
  if (!pending) {
    return action;
  }
  return method === "pix_automatic" ? "Gerando o código…" : "Abrindo…";
}

/**
 * The offer of the Pro (AS-11 to AS-13): the cycles of the catalog with the monthly one chosen, the methods the
 * server offers, the payer of Pix Automático, the first charge and its price before any page or code, and one
 * button that stays off while it waits (AS-18).
 */
export function OfferCard({
  now,
  online,
  onStart,
  organizationId,
  payerDefaults,
  pending,
  plan,
  refusal,
  onEdit,
  onReread,
}: {
  now: Date;
  online: boolean;
  /** The person changed a choice or a field: the last refusal is old news (U-56). */
  onEdit: () => void;
  onReread: () => void;
  onStart: (request: CheckoutRequest) => void;
  organizationId: string;
  payerDefaults: { email: string; name: string };
  pending: boolean;
  plan: BillingPlanView;
  refusal: Refusal | null;
}) {
  const cycles = useMemo(() => offerCycles(plan), [plan]);
  const methods = useMemo(() => offerMethods(plan), [plan]);
  const [chosenCycle, setCycle] = useState<CycleMonths | null>(() =>
    defaultCycle(cycles)
  );
  const [chosenMethod, setMethod] = useState<PlanMethod | null>(
    () => methods[0] ?? null
  );
  // a plan read again may not offer the choice any more: the default of what it offers stands in for it
  const cycle = cycles.some((item) => item.cycleMonths === chosenCycle)
    ? chosenCycle
    : defaultCycle(cycles);
  const method =
    chosenMethod !== null && methods.includes(chosenMethod)
      ? chosenMethod
      : (methods[0] ?? null);
  const [payer, setPayer] = useState<PayerDraft>(() => ({
    email: payerDefaults.email,
    name: payerDefaults.name,
    taxId: "",
  }));
  const [problems, setProblems] = useState<PayerField[]>([]);
  // the session's name and e-mail arrive after the first render: they fill only what the person did not type
  const [filledFrom, setFilledFrom] = useState(payerDefaults);
  if (
    filledFrom.email !== payerDefaults.email ||
    filledFrom.name !== payerDefaults.name
  ) {
    setFilledFrom(payerDefaults);
    setPayer((current) => ({
      ...current,
      email: current.email || payerDefaults.email,
      name: current.name || payerDefaults.name,
    }));
  }
  const chosen = cycles.find((item) => item.cycleMonths === cycle) ?? null;

  const handleCycle = useCallback(
    (next: CycleMonths) => {
      setCycle(next);
      onEdit();
    },
    [onEdit]
  );
  const handleMethod = useCallback(
    (next: PlanMethod) => {
      setMethod(next);
      setProblems([]);
      onEdit();
    },
    [onEdit]
  );

  const handlePayer = useCallback(
    (next: PayerDraft) => {
      setPayer(next);
      setProblems([]);
      onEdit();
    },
    [onEdit]
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending || !online || cycle === null || method === null) {
        return;
      }
      const trial = plan.trialAvailable;
      if (method === "card") {
        onStart({ cycleMonths: cycle, method, trial });
        return;
      }
      const request = {
        cycleMonths: cycle,
        method,
        payer: {
          email: payer.email.trim(),
          name: payer.name.trim(),
          taxId: taxIdDigits(payer.taxId),
        },
        trial,
      } as const;
      const found = payerProblems(organizationId, request);
      setProblems(found);
      if (found.length > 0) {
        // the first field on the screen, in its order
        const first = PAYER_ORDER.find((field) => found.includes(field));
        document.getElementById(`${PAYER_ID}-${first}`)?.focus();
        return;
      }
      onStart(request);
    },
    [cycle, method, onStart, online, organizationId, payer, pending, plan]
  );

  if (cycles.length === 0 || methods.length === 0 || chosen === null) {
    return (
      <Alert>
        <AlertDescription>
          A assinatura do Pro não está disponível agora. Nada muda no seu plano.
        </AlertDescription>
      </Alert>
    );
  }
  const terms = offerTerms({
    amount: chosen.amount,
    method: method ?? "card",
    now,
    trialAvailable: plan.trialAvailable,
  });
  return (
    <Card aria-labelledby="subscription-offer-title" role="region">
      <CardHeader>
        <SectionTitle id="subscription-offer-title">Plano Pro</SectionTitle>
        <CardDescription>{PRO_PITCH}</CardDescription>
      </CardHeader>
      <CardContent className="border-t pt-(--card-spacing)">
        <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
          <Choice
            disabled={pending}
            label="Ciclo"
            onChange={handleCycle}
            options={cycles.map((item) => ({
              badge: item.bonus,
              detail: (
                <>
                  <span className="font-semibold text-foreground">
                    {item.price}
                  </span>{" "}
                  {item.unit}
                </>
              ),
              title: item.name,
              value: item.cycleMonths,
            }))}
            value={cycle}
          />
          <Choice
            disabled={pending}
            label="Como pagar"
            onChange={handleMethod}
            options={methods.map((item) => ({
              detail: METHOD_HINTS[item],
              title: METHOD_NAMES[item],
              value: item,
            }))}
            value={method}
          />
          {method === "pix_automatic" ? (
            <PayerFields
              disabled={pending}
              draft={payer}
              onChange={handlePayer}
              problems={problems}
            />
          ) : null}
          <div
            className="grid gap-1 rounded-lg bg-muted/60 px-3 py-2.5"
            data-testid="subscription-terms"
          >
            <p className="m-0">
              <strong className="font-semibold">{terms.lead}</strong>{" "}
              {terms.charge}
            </p>
            {/* the Pix trial text has no number of days (AC-12): the rule of the refund stays in the footer */}
            {plan.trialAvailable && method !== "pix_automatic" ? (
              <p className="m-0 text-muted-foreground text-support">
                Depois da primeira cobrança você ainda pode desistir em até 7
                dias e receber o valor de volta.
              </p>
            ) : null}
          </div>
          {refusal ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertDescription className="grid justify-items-start gap-2">
                {refusal.text}
                {refusal.reread ? (
                  <Button
                    onClick={onReread}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Atualizar
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <div>
            <Button
              {...connectionControlProps(online)}
              aria-busy={pending || undefined}
              className="h-auto min-h-ctl-md whitespace-normal py-1.5"
              disabled={pending}
              type="submit"
            >
              {pendingLabel(pending, method, terms.action)}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
