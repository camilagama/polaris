import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  defaultTimezone,
  firstInvalidField,
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_TIMEZONE_LENGTH,
  type SetupErrors,
  setupErrorMessage,
  validateSetup,
} from "./organization-setup-model";

interface OrganizationSetupProps {
  /** Called once the organization exists (created or already there). */
  onOpened: () => void;
}

/**
 * First access: the signed-in user has no organization yet. Opening is
 * idempotent: an existing organization is opened without changing its data.
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
    <section aria-labelledby="organization-setup-title" className="setup-card">
      <p className="categories-eyebrow">Primeiro acesso</p>
      <h1 id="organization-setup-title">Abra a sua organização</h1>
      <p className="categories-intro-copy">
        Você ainda não tem uma organização. Crie a sua para usar o catálogo, o
        estoque e as vendas. Se ela já existir, será aberta sem alterar seus
        dados.
      </p>
      <form className="setup-form" noValidate onSubmit={handleSubmitEvent}>
        <label className="field-label" htmlFor="organization-name">
          Nome da organização
        </label>
        <input
          aria-describedby={errors.name ? "organization-name-error" : undefined}
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
        {errors.name ? (
          <p className="field-error" id="organization-name-error" role="alert">
            {errors.name}
          </p>
        ) : null}
        <label className="field-label" htmlFor="organization-timezone">
          Fuso horário da organização
        </label>
        <input
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
        {errors.timezone ? (
          <p
            className="field-error"
            id="organization-timezone-error"
            role="alert"
          >
            {errors.timezone}
          </p>
        ) : null}
        <p className="field-help" id="organization-timezone-help">
          Use um identificador IANA, como America/Sao_Paulo. As datas de estoque
          e de venda seguem este fuso.
        </p>
        {failure ? (
          <p className="categories-message is-error" role="alert">
            {failure}
          </p>
        ) : null}
        <button className="primary-button" disabled={pending} type="submit">
          {pending ? "Abrindo…" : "Criar ou abrir organização"}
        </button>
      </form>
    </section>
  );
}
