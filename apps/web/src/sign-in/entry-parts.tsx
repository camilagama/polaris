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
  HIDE_PASSWORD,
  HIDE_PASSWORD_LABEL,
  PAGE_LOADING,
  PAGE_UNAVAILABLE,
  SHOW_PASSWORD,
  SHOW_PASSWORD_LABEL,
  TRY_AGAIN,
  TRYING_AGAIN,
} from "./password-texts";
import type { Challenge } from "./turnstile";
import "./sign-in.css";

const EMAIL_WORD = /(e-mail)/i;

/** "e-mail" in a title is one word: at 360 px it never breaks into "e-" and "mail" (the text itself is unchanged). */
function withoutBreakInEmail(title: string): ReactNode {
  return title.split(EMAIL_WORD).map((part, index) =>
    index % 2 === 1 ? (
      <span className="sign-in-nobreak" key={index}>
        {part}
      </span>
    ) : (
      part
    )
  );
}

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
          <h1 id="sign-in-title">{withoutBreakInEmail(title)}</h1>
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
  id,
}: {
  children: ReactNode;
  focus?: boolean;
  /** So a field can name the alert in `aria-describedby`. */
  id?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) {
      ref.current?.focus();
    }
  }, [focus]);
  return (
    <p className="sign-in-alert" id={id} ref={ref} role="alert" tabIndex={-1}>
      <span aria-hidden="true" className="sign-in-alert-icon">
        !
      </span>
      <span>{children}</span>
    </p>
  );
}

/** An instruction, not a failure (the page was opened without its link): announced and focused, in neutral colors. */
export function EntryNotice({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p className="sign-in-notice" ref={ref} role="status" tabIndex={-1}>
      <span aria-hidden="true" className="sign-in-notice-icon">
        i
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
    <a className="sign-in-primary" href={href}>
      {children}
    </a>
  );
}

interface FieldProps {
  autoComplete: string;
  /** The id of an alert of the form that is about this field too (the wrong credentials name both fields). */
  describedById?: string | undefined;
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
  describedById,
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
        aria-describedby={describedBy(
          error !== null && `${id}-error`,
          describedById ?? false
        )}
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
 * A password field with "Mostrar" / "Ocultar" (AC-72): a short 44 px toggle whose name says what it will do
 * ("Mostrar senha", "Ocultar senha"), so the state is announced by the name; pasting is never blocked. `visible` is owned by the form, which hides the password again on every submit.
 */
export function PasswordField({
  autoComplete,
  describedById,
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
            error !== null && `${id}-error`,
            describedById ?? false
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
          aria-label={visible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
          className="sign-in-reveal"
          data-visible={visible}
          onClick={onToggle}
          type="button"
        >
          {visible ? HIDE_PASSWORD : SHOW_PASSWORD}
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

/**
 * "Tentar de novo" of a blocked challenge script: it stays on the screen, with the focus on it, while the script
 * is asked for again; when the script comes, the block goes away and the focus goes to the first field of the
 * form around `slotRef`.
 */
export function useChallengeRetry(
  challenge: Challenge,
  slotRef: RefObject<HTMLElement | null>
): { retry: () => void; retrying: boolean } {
  const [retrying, setRetrying] = useState(false);
  const { state } = challenge;
  const loadingSeen = useRef<boolean>(false);
  useEffect(() => {
    if (!retrying) {
      return;
    }
    if (state === "loading") {
      loadingSeen.current = true;
      return;
    }
    // the click renders once more with the old state, before the script is asked for again
    if (!loadingSeen.current) {
      return;
    }
    loadingSeen.current = false;
    setRetrying(false);
    if (state !== "blocked") {
      slotRef.current?.closest("form")?.querySelector("input")?.focus();
    }
  }, [retrying, slotRef, state]);
  const retry = useCallback(() => {
    setRetrying(true);
    challenge.retry();
  }, [challenge]);
  return { retry, retrying };
}

/**
 * Where the widget draws itself, and the line that says what it is doing (V5). With the script blocked the
 * alert says what to do, and "Tentar de novo" asks for the script again without reloading the page, except
 * where `blockedText` is given: there the person must come back by the link (`/redefinir-senha`).
 */
export function ChallengeSlot({
  blockedText = CHALLENGE_BLOCKED,
  challenge,
  retry = true,
}: {
  blockedText?: string;
  challenge: Challenge;
  retry?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { retry: handleRetry, retrying } = useChallengeRetry(
    challenge,
    slotRef
  );
  const { state } = challenge;
  return (
    <div className="sign-in-challenge" ref={slotRef}>
      <div ref={challenge.containerRef} />
      <p className="sign-in-challenge-status" role="status">
        {state === "checking" ? CHALLENGE_CHECKING : null}
      </p>
      {state === "blocked" || retrying ? (
        <>
          <EntryAlert focus={false}>{blockedText}</EntryAlert>
          {retry ? (
            <button
              aria-disabled={retrying}
              className="sign-in-retry"
              onClick={retrying ? undefined : handleRetry}
              type="button"
            >
              {retrying ? TRYING_AGAIN : TRY_AGAIN}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
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
