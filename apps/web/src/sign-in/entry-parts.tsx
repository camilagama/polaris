import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import {
  type ChangeEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useEntryMethods } from "./entry-methods";
import {
  CHALLENGE_BLOCKED,
  CHALLENGE_CHECKING,
  PAGE_LOADING,
  PAGE_UNAVAILABLE,
  SHOW_PASSWORD,
  TRY_AGAIN,
} from "./password-texts";
import {
  LEGAL_LINKS_TITLE,
  NEW_TAB_HINT,
  PRIVACY_LINK,
  TERMS_LINK,
} from "./sign-in-texts";
import type { Challenge } from "./turnstile";
import "./sign-in.css";

/** The card of every sign-in page: outside the app shell, one column, the brand and the title. */
export function EntryFrame({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <div className="ui-root sign-in-root">
      <main className="sign-in-main" id="conteudo">
        <section aria-labelledby="sign-in-title" className="sign-in-card">
          <p className="sign-in-brand">
            <span aria-hidden="true" className="sign-in-brand-mark">
              P
            </span>
            <span>Polaris</span>
          </p>
          <h1 id="sign-in-title">{title}</h1>
          {children}
        </section>
      </main>
    </div>
  );
}

/** An error of the page: announced, focused when it appears (AC-13), with an icon so it is not only a color. */
export function EntryAlert({
  children,
  focus = true,
}: {
  children: ReactNode;
  focus?: boolean;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) {
      ref.current?.focus();
    }
  }, [focus]);
  return (
    <p className="sign-in-alert" ref={ref} role="alert" tabIndex={-1}>
      <span aria-hidden="true" className="sign-in-alert-icon">
        !
      </span>
      <span>{children}</span>
    </p>
  );
}

/** A result that went well: announced, with a mark that is not only a color. */
export function EntrySuccess({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p className="sign-in-success" ref={ref} role="status" tabIndex={-1}>
      <span aria-hidden="true" className="sign-in-success-icon">
        ✓
      </span>
      <span>{children}</span>
    </p>
  );
}

/** A link that looks like the main action (a whole page load: the policy of a page comes with it). */
export function EntryLinkButton({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a className="sign-in-primary sign-in-link-button" href={href}>
      {children}
    </a>
  );
}

interface FieldProps {
  autoComplete: string;
  error: string | null;
  fieldRef?: RefObject<HTMLInputElement | null>;
  hint?: string;
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}

function describedBy(...ids: (string | false)[]): string | undefined {
  const list = ids.filter(Boolean).join(" ");
  return list.length > 0 ? list : undefined;
}

/** The e-mail field: the attributes a password manager and a phone keyboard need (V6). */
export function EmailField({
  autoComplete,
  error,
  fieldRef,
  label,
  name,
  onChange,
  value,
}: FieldProps) {
  const id = useId();
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <div className="sign-in-field">
      <label htmlFor={id}>{label}</label>
      <input
        aria-describedby={describedBy(error !== null && `${id}-error`)}
        aria-invalid={error !== null}
        autoCapitalize="none"
        autoComplete={autoComplete}
        autoCorrect="off"
        id={id}
        inputMode="email"
        name={name}
        onChange={handleChange}
        ref={fieldRef}
        spellCheck={false}
        type="email"
        value={value}
      />
      {error ? (
        <p className="sign-in-field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A password field with "Mostrar senha" (AC-72): a 44 px toggle with its state announced; pasting is never
 * blocked. `visible` is owned by the form, which hides the password again on every submit.
 */
export function PasswordField({
  autoComplete,
  error,
  fieldRef,
  hint,
  label,
  name,
  onChange,
  onToggle,
  value,
  visible,
}: FieldProps & { onToggle: () => void; visible: boolean }) {
  const id = useId();
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <div className="sign-in-field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p className="sign-in-field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <div className="sign-in-password">
        <input
          aria-describedby={describedBy(
            hint !== undefined && `${id}-hint`,
            error !== null && `${id}-error`
          )}
          aria-invalid={error !== null}
          autoCapitalize="none"
          autoComplete={autoComplete}
          autoCorrect="off"
          id={id}
          name={name}
          onChange={handleChange}
          ref={fieldRef}
          spellCheck={false}
          type={visible ? "text" : "password"}
          value={value}
        />
        <button
          aria-controls={id}
          aria-pressed={visible}
          className="sign-in-reveal"
          onClick={onToggle}
          type="button"
        >
          {SHOW_PASSWORD}
        </button>
      </div>
      {error ? (
        <p className="sign-in-field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Show/hide of a password, hidden again on every submit (AC-72). */
export function useReveal(): [boolean, () => void, () => void] {
  const [visible, setVisible] = useState(false);
  const toggle = useCallback(() => setVisible((shown) => !shown), []);
  const hide = useCallback(() => setVisible(false), []);
  return [visible, toggle, hide];
}

/** Where the widget draws itself, and the line that says what it is doing (V5). */
export function ChallengeSlot({ challenge }: { challenge: Challenge }) {
  return (
    <div className="sign-in-challenge">
      <div ref={challenge.containerRef} />
      <p className="sign-in-challenge-status" role="status">
        {challenge.state === "checking" ? CHALLENGE_CHECKING : null}
      </p>
      {challenge.state === "blocked" ? (
        <EntryAlert focus={false}>{CHALLENGE_BLOCKED}</EntryAlert>
      ) : null}
    </div>
  );
}

/** The two legal pages open in another tab, so a half-done form is not lost (L1 of the legal pages). */
export function LegalLinks() {
  return (
    <fieldset className="sign-in-legal">
      <legend className="sign-in-legal-title">{LEGAL_LINKS_TITLE}</legend>
      <ul>
        <li>
          <a href={LEGAL_PATHS.terms} rel="noopener noreferrer" target="_blank">
            {TERMS_LINK}
            <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
          </a>
        </li>
        <li>
          <a
            href={LEGAL_PATHS.privacy}
            rel="noopener noreferrer"
            target="_blank"
          >
            {PRIVACY_LINK}
            <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
          </a>
        </li>
      </ul>
    </fieldset>
  );
}

/**
 * The password pages behind the flag (AC-46): while the methods load, "Carregando…"; with the password off,
 * the hook sends the person to `/entrar`; without an answer, the page says so and offers to try again.
 */
export function PasswordGate({
  children,
  title,
}: {
  children: (siteKey: string | null) => ReactNode;
  title: string;
}) {
  const { methods, retry } = useEntryMethods();
  if (methods.state === "ready") {
    return <>{children(methods.siteKey)}</>;
  }
  // the password is off: the hook is already sending the person to `/entrar`
  if (methods.state === "off") {
    return null;
  }
  return (
    <EntryFrame title={title}>
      {methods.state === "loading" ? (
        <p className="sign-in-status" role="status">
          {PAGE_LOADING}
        </p>
      ) : (
        <>
          <EntryAlert>{PAGE_UNAVAILABLE}</EntryAlert>
          <button className="sign-in-retry" onClick={retry} type="button">
            {TRY_AGAIN}
          </button>
        </>
      )}
    </EntryFrame>
  );
}
