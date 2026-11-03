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
import { useSignedInEmail } from "../app-shell/signed-in-email";
import { orpcClient } from "../lib/orpc";
import { SIGN_IN_AGAIN_BUTTON } from "../lib/session-ended-text";
import { signInPath } from "../lib/sign-in-path";
import { useHoldSwap } from "../lib/unsent-work";
import { LogoutNotices, useLogout } from "../offline/runtime/logout-control";
import { SelectField } from "../sales/sale-fields";
import {
  EntryAlert,
  EntryLinkButton,
  EntryScreen,
  INLINE_LINK,
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

const TITLE = "Abra a sua loja";

interface OrganizationSetupProps {
  /** Called once the organization exists (created or already there). */
  onOpened: () => void;
}

/**
 * Whose account this is and the way out of it, under the card. "Sair" is there with the offline runtime on or off:
 * the person who signed in with the wrong account would otherwise open the store in it.
 */
function SignedInAs() {
  const email = useSignedInEmail();
  const logout = useLogout("/", { endsWithoutRuntime: true });
  return (
    <div className="grid gap-2">
      <p className="m-0 text-muted-foreground text-support">
        {email ? (
          <>
            Entrou como{" "}
            <span className="break-all text-foreground">{email}</span>. Não é
            você?{" "}
          </>
        ) : (
          "Não é a sua conta? "
        )}
        <button
          className={`${INLINE_LINK} touch-hit`}
          disabled={logout.busy}
          onClick={logout.start}
          type="button"
        >
          Sair
        </button>
        .
      </p>
      <LogoutNotices logout={logout} />
    </div>
  );
}

/**
 * First access: the signed-in user has no organization yet. Opening is
 * idempotent: an existing organization is opened without changing its data.
 * It stands alone, with no menu (there is nothing to go to yet) and "Entrou como … Sair" in the card, so a person
 * who signed in with the wrong account can see it and leave.
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
  useHoldSwap(name.trim() !== "");
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
      help
      support="Dê um nome à sua loja. Dá para mudar depois."
      title={TITLE}
    >
      <form
        aria-label={TITLE}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={handleSubmitEvent}
      >
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="organization-name">Nome da loja</FieldLabel>
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
          label="Horário da loja"
          onChange={setTimezone}
          options={BRAZIL_TIMEZONES}
          placeholder="Escolha o horário"
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
          Abrir loja
        </SubmitButton>
      </form>
      <SignedInAs />
    </EntryScreen>
  );
}
