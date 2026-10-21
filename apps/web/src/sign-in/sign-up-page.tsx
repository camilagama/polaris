import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { documentTitle } from "../app-shell/navigation-model";
import { ConfirmEmailPanel } from "./confirm-email-page";
import { useReveal } from "./entry-parts";
import { isCompleteEmail } from "./entry-progressive";
import {
  ChallengeArea,
  challengeAlertId,
  EmailInput,
  EntryAlert,
  EntryGate,
  EntryScreen,
  GoogleButton,
  INLINE_LINK,
  OrSeparator,
  PasswordInput,
  Progressive,
  SubmitButton,
  useProgressive,
} from "./entry-ui";
import { useGoogleStart } from "./google-start";
import {
  emailProblem,
  newPasswordProblem,
  postAuth,
  signUpLegalAcceptance,
  signUpOutcome,
} from "./password-model";
import {
  ACCEPT_AND,
  ACCEPT_PREFIX,
  ACCEPT_REQUIRED,
  confirmSentText,
  EMAIL_INVALID,
  EMAIL_LABEL,
  emailText,
  failureText,
  GO_TO_SIGN_IN,
  HAVE_ACCOUNT,
  newPasswordText,
  PASSWORD_LABEL,
  SIGN_UP_BUTTON,
  SIGN_UP_BUTTON_PENDING,
  SIGN_UP_PAGE_TITLE,
  SIGN_UP_PASSWORD_RULE,
  SIGN_UP_TITLE,
} from "./password-texts";
import {
  GOOGLE_NOT_OFFERED,
  NEW_TAB_HINT,
  PRIVACY_LINK,
  SIGN_IN_LIMIT,
  SIGN_IN_UNAVAILABLE,
  TERMS_LINK,
} from "./sign-in-texts";
import { challengeToken, useChallenge } from "./turnstile";

function SignUpForm({
  google: googleOn,
  siteKey,
}: {
  google: boolean;
  siteKey: string | null;
}) {
  const challenge = useChallenge(siteKey, "signup");
  const formId = useId();
  const acceptId = `${formId}-accept`;
  const google = useGoogleStart(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [visible, toggleVisible, hide] = useReveal();
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // the address the confirmation was sent to: memory only, gone with a reload
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const acceptRef = useRef<HTMLSpanElement>(null);
  const progressive = useProgressive(passwordRef, pending);
  const { followEmail, followPassword } = progressive;

  const handleAccept = useCallback((checked: boolean) => {
    setAccepted(checked);
    if (checked) {
      setAcceptError(null);
    }
  }, []);
  const handleEmail = useCallback(
    (value: string) => {
      setEmail(value);
      followEmail(value);
      // the local error of an incomplete address goes as soon as the address is complete
      if (isCompleteEmail(value)) {
        setEmailError(null);
      }
      // an empty e-mail closes the password: it is hidden again, so it never comes back shown
      if (value.trim() === "") {
        hide();
      }
    },
    [followEmail, hide]
  );
  const handlePassword = useCallback(
    (value: string) => {
      setPassword(value);
      followPassword(value);
    },
    [followPassword]
  );
  const handleEmailKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) =>
      progressive.emailKeyDown(event, (value) =>
        setEmailError(emailText(emailProblem(value)) ?? EMAIL_INVALID)
      ),
    [progressive]
  );

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      hide();
      setAlert(null);
      const emailIssue = emailText(emailProblem(email));
      const passwordIssue = newPasswordProblem(password);
      // the button is never off for want of the box (V6): the screen says what is missing
      const acceptIssue = accepted ? null : ACCEPT_REQUIRED;
      setEmailError(emailIssue);
      setPasswordError(passwordIssue ? newPasswordText(passwordIssue) : null);
      setAcceptError(acceptIssue);
      if (emailIssue) {
        emailRef.current?.focus();
        return;
      }
      if (passwordIssue) {
        passwordRef.current?.focus();
        return;
      }
      if (acceptIssue) {
        acceptRef.current?.focus();
        return;
      }
      setPending(true);
      const challenged = await challengeToken(challenge);
      if ("failure" in challenged) {
        setPending(false);
        setAlert(failureText(challenged.failure, "sign-up"));
        return;
      }
      const address = email.trim();
      const outcome = signUpOutcome(
        await postAuth(
          "/api/auth/sign-up/email",
          {
            email: address,
            legalAcceptance: signUpLegalAcceptance(),
            name: "",
            password,
          },
          { turnstileToken: challenged.token }
        )
      );
      setPending(false);
      switch (outcome.kind) {
        case "created":
          setPassword("");
          setSentTo(address);
          return;
        case "acceptance":
          setAcceptError(ACCEPT_REQUIRED);
          acceptRef.current?.focus();
          return;
        case "password":
          setPasswordError(newPasswordText(outcome.problem));
          passwordRef.current?.focus();
          return;
        default:
          setAlert(failureText(outcome.failure, "sign-up"));
      }
    },
    [accepted, challenge, email, hide, password, pending]
  );

  if (sentTo !== null) {
    return (
      <ConfirmEmailPanel
        email={sentTo}
        intro={confirmSentText(sentTo)}
        siteKey={siteKey}
      />
    );
  }

  const googleFailure = google.failure
    ? { indisponivel: SIGN_IN_UNAVAILABLE, limite: SIGN_IN_LIMIT }[
        google.failure
      ]
    : null;
  // the Google way off on the server: the button is off and the screen says why, as on `/entrar`
  const googleAlert = googleFailure ?? (googleOn ? null : GOOGLE_NOT_OFFERED);
  return (
    <EntryScreen title={SIGN_UP_TITLE}>
      {googleAlert ? (
        <EntryAlert key={googleAlert}>{googleAlert}</EntryAlert>
      ) : null}
      <GoogleButton
        disabled={!googleOn}
        onClick={google.start}
        pending={google.starting}
      />
      <OrSeparator />
      {alert ? <EntryAlert>{alert}</EntryAlert> : null}
      <form
        aria-label={SIGN_UP_TITLE}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={submit}
      >
        <EmailInput
          autoComplete="username"
          error={emailError}
          fieldRef={emailRef}
          id={`${formId}-email`}
          label={EMAIL_LABEL}
          name="email"
          onChange={handleEmail}
          onKeyDown={handleEmailKeyDown}
          value={email}
        />
        <Progressive open={progressive.open}>
          <PasswordInput
            autoComplete="new-password"
            error={passwordError}
            fieldRef={passwordRef}
            hint={SIGN_UP_PASSWORD_RULE}
            id={`${formId}-password`}
            label={PASSWORD_LABEL}
            name="new-password"
            onChange={handlePassword}
            onToggle={toggleVisible}
            value={password}
            visible={visible}
          />
          <Field
            className="items-start gap-4 pt-1"
            data-invalid={acceptError !== null || undefined}
            orientation="horizontal"
          >
            <Checkbox
              aria-describedby={acceptError ? `${acceptId}-error` : undefined}
              aria-invalid={acceptError !== null || undefined}
              checked={accepted}
              className="mt-0.5"
              id={acceptId}
              onCheckedChange={handleAccept}
              ref={acceptRef}
            />
            <div className="grid gap-1">
              <FieldLabel
                className="block font-normal leading-5"
                htmlFor={acceptId}
              >
                {ACCEPT_PREFIX}{" "}
                <a
                  className={INLINE_LINK}
                  href={LEGAL_PATHS.terms}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {TERMS_LINK}
                  <span className="sr-only"> ({NEW_TAB_HINT})</span>
                </a>{" "}
                {ACCEPT_AND}{" "}
                <a
                  className={INLINE_LINK}
                  href={LEGAL_PATHS.privacy}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {PRIVACY_LINK}
                  <span className="sr-only"> ({NEW_TAB_HINT})</span>
                </a>
                .
              </FieldLabel>
              {acceptError ? (
                <FieldError id={`${acceptId}-error`}>{acceptError}</FieldError>
              ) : null}
            </div>
          </Field>
          <ChallengeArea
            alertId={challengeAlertId(formId)}
            challenge={challenge}
          />
          <SubmitButton
            alertId={challengeAlertId(formId)}
            challenge={challenge}
            disabled={challenge.state === "loading"}
            pending={pending}
            pendingText={SIGN_UP_BUTTON_PENDING}
          >
            {SIGN_UP_BUTTON}
          </SubmitButton>
        </Progressive>
      </form>
      <p className="text-muted-foreground text-sm">
        {HAVE_ACCOUNT}{" "}
        <a className={`${INLINE_LINK} text-foreground`} href="/entrar">
          {GO_TO_SIGN_IN}
        </a>
      </p>
    </EntryScreen>
  );
}

/**
 * `/criar-conta` (AC-47, AC-49, AC-68), v5.2: "Continuar com o Google" first; under "ou" the e-mail, and when it
 * has a complete shape the password with the rule said before typing, the acceptance box (unchecked, refused by
 * the server too) and the challenge. An e-mail that has an account gets the same "Confirme seu e-mail" as a new
 * one.
 */
export function SignUpPage() {
  useEffect(() => {
    document.title = documentTitle(SIGN_UP_PAGE_TITLE);
  }, []);
  return (
    <EntryGate title={SIGN_UP_TITLE}>
      {(methods) => (
        <SignUpForm google={methods.google} siteKey={methods.siteKey} />
      )}
    </EntryGate>
  );
}
