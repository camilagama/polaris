import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { documentTitle } from "../app-shell/navigation-model";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import { LogoutControl } from "../offline/runtime/logout-control";
import { EntryAlert, EntryScreen, SubmitButton } from "../sign-in/entry-ui";
import {
  defaultTimezone,
  firstInvalidField,
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_TIMEZONE_LENGTH,
  type SetupErrors,
  setupErrorMessage,
  validateSetup,
} from "./organization-setup-model";

const TITLE = "Abra a sua organização";

interface OrganizationSetupProps {
  /** Called once the organization exists (created or already there). */
  onOpened: () => void;
}

/**
 * First access: the signed-in user has no organization yet. Opening is
 * idempotent: an existing organization is opened without changing its data.
 * It stands alone, with no menu (there is nothing to go to yet) and "Sair" under the card, so a person who
 * signed in with the wrong account can leave.
 */
export function OrganizationSetup({ onOpened }: OrganizationSetupProps) {
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [errors, setErrors] = useState<SetupErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useReportUnsentWork(name.trim() !== "");
  const nameRef = useRef<HTMLInputElement>(null);
  const timezoneRef = useRef<HTMLInputElement>(null);

  // the tab says what the page is, and gives the title back when the organization opens
  useEffect(() => {
    const previous = document.title;
    document.title = documentTitle(TITLE);
    return () => {
      document.title = previous;
    };
  }, []);

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const handleTimezoneChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTimezone(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      const { errors: found, input } = validateSetup({ name, timezone });
      setErrors(found);
      setFailure(null);
      if (input === null) {
        const field = firstInvalidField(found);
        (field === "timezone" ? timezoneRef : nameRef).current?.focus();
        return;
      }
      setPending(true);
      try {
        await orpcClient.organization.createInitial(input);
        onOpened();
      } catch (error) {
        setFailure(setupErrorMessage(error));
        setPending(false);
      }
    },
    [name, onOpened, pending, timezone]
  );
  const handleSubmitEvent = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      handleSubmit(event).catch(() => undefined);
    },
    [handleSubmit]
  );

  return (
    <EntryScreen
      support="Você ainda não tem uma organização. Crie a sua para usar o catálogo, o estoque e as vendas. Se ela já existir, será aberta sem alterar seus dados."
      title={TITLE}
    >
      <form
        aria-label={TITLE}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={handleSubmitEvent}
      >
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="organization-name">
            Nome da organização
          </FieldLabel>
          <Input
            aria-describedby={
              errors.name ? "organization-name-error" : undefined
            }
            aria-invalid={errors.name ? true : undefined}
            autoComplete="organization"
            id="organization-name"
            maxLength={MAX_ORGANIZATION_NAME_LENGTH}
            onChange={handleNameChange}
            placeholder="Ex.: Loja Horizonte"
            ref={nameRef}
            required
            value={name}
          />
          <FieldError id="organization-name-error">{errors.name}</FieldError>
        </Field>
        <Field data-invalid={errors.timezone ? true : undefined}>
          <FieldLabel htmlFor="organization-timezone">
            Fuso horário da organização
          </FieldLabel>
          <Input
            aria-describedby={
              errors.timezone
                ? "organization-timezone-error organization-timezone-help"
                : "organization-timezone-help"
            }
            aria-invalid={errors.timezone ? true : undefined}
            autoComplete="off"
            id="organization-timezone"
            maxLength={MAX_TIMEZONE_LENGTH}
            onChange={handleTimezoneChange}
            ref={timezoneRef}
            required
            value={timezone}
          />
          <FieldError id="organization-timezone-error">
            {errors.timezone}
          </FieldError>
          <FieldDescription id="organization-timezone-help">
            Use um identificador IANA, como America/Sao_Paulo. As datas de
            estoque e de venda seguem este fuso.
          </FieldDescription>
        </Field>
        {failure ? <EntryAlert key={failure}>{failure}</EntryAlert> : null}
        <SubmitButton pending={pending} pendingText="Abrindo…">
          Criar ou abrir organização
        </SubmitButton>
      </form>
      <LogoutControl shell />
    </EntryScreen>
  );
}
