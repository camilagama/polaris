import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { documentTitle } from "../app-shell/navigation-model";
import { orpcClient } from "../lib/orpc";
import { SIGN_IN_AGAIN_BUTTON } from "../lib/session-ended-text";
import { signInPath } from "../lib/sign-in-path";
import { useReportUnsentWork } from "../lib/unsent-work";
import { LogoutControl } from "../offline/runtime/logout-control";
import { SelectField } from "../sales/sale-fields";
import {
  EntryAlert,
  EntryLinkButton,
  EntryScreen,
  SubmitButton,
} from "../sign-in/entry-ui";
import {
  BRAZIL_TIMEZONES,
  initialTimezone,
  MAX_ORGANIZATION_NAME_LENGTH,
  SETUP_SESSION_ENDED,
  type SetupErrors,
  setupErrorMessage,
  setupSessionEnded,
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
  const [timezone, setTimezone] = useState(initialTimezone);
  const [errors, setErrors] = useState<SetupErrors>({});
  // the session ended while the card was open: the alert says so and "Entrar de novo" is under it
  const [failure, setFailure] = useState<{
    endedSession: boolean;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  useReportUnsentWork(name.trim() !== "");
  const nameRef = useRef<HTMLInputElement>(null);

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
        nameRef.current?.focus();
        return;
      }
      setPending(true);
      try {
        await orpcClient.organization.createInitial(input);
        onOpened();
      } catch (error) {
        const endedSession = setupSessionEnded(error);
        setFailure({
          endedSession,
          message: endedSession
            ? SETUP_SESSION_ENDED
            : setupErrorMessage(error),
        });
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
      support="Dê um nome à sua organização. Dá para mudar depois."
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
        <SelectField
          error={errors.timezone}
          hint="É o horário que o Polaris usa nas datas das vendas."
          id="organization-timezone"
          label="Fuso horário da organização"
          onChange={setTimezone}
          options={BRAZIL_TIMEZONES}
          placeholder="Escolha o fuso"
          value={timezone}
        />
        {failure ? (
          <EntryAlert key={failure.message}>{failure.message}</EntryAlert>
        ) : null}
        {failure?.endedSession ? (
          <EntryLinkButton
            href={signInPath({ reason: "sessao", returnTo: "/" })}
            variant="outline"
          >
            {SIGN_IN_AGAIN_BUTTON}
          </EntryLinkButton>
        ) : null}
        <SubmitButton pending={pending} pendingText="Abrindo…">
          Criar ou abrir organização
        </SubmitButton>
      </form>
      <LogoutControl shell />
    </EntryScreen>
  );
}
