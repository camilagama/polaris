import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import InfoIcon from "lucide-react/dist/esm/icons/info";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { useChallengeRetry } from "./challenge-retry";
import { useEntryMethods } from "./entry-methods";
import {
  emailEnter,
  openAfterEmail,
  openAfterPassword,
} from "./entry-progressive";
import {
  BACK_TO_SIGN_IN,
  CHALLENGE_BLOCKED,
  CHALLENGE_CHECKING,
  CHALLENGE_INTERACTIVE,
  HIDE_PASSWORD,
  HIDE_PASSWORD_LABEL,
  OR_SEPARATOR,
  PAGE_LOADING,
  PAGE_UNAVAILABLE,
  SHOW_PASSWORD,
  SHOW_PASSWORD_LABEL,
  TRY_AGAIN,
  TRYING_AGAIN,
} from "./password-texts";
import {
  GOOGLE_BUTTON,
  GOOGLE_BUTTON_PENDING,
  NEW_TAB_HINT,
  PRIVACY_LINK,
  TERMS_LINK,
} from "./sign-in-texts";
import type { Challenge } from "./turnstile";

/*
 * The pieces of the entry pages in the interface v5.2 (ADR 0103; design v5.2 of 20/10: Google first, the password
 * after the e-mail): `/entrar`, `/criar-conta`, "Confirme seu e-mail", `/confirmar-email`, `/esqueci-a-senha`,
 * `/redefinir-senha` and `/desbloquear`. "Trocar senha" inside the app uses the same fields and notices.
 */

export const TEXT_LINK =
  "touch-hit focus-ring relative rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
/** A link inside a line of running text: no area of its own, which would cover the line above and below
   (WCAG 2.5.8 exempts it from the size), and in one piece, so its box never spans two lines. */
export const INLINE_LINK =
  "focus-ring whitespace-nowrap rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/** The provisional brand: an "i" with its dot in the mark color. */
function BrandMark() {
  return (
    <svg aria-hidden="true" className="size-6" viewBox="0 0 24 24">
      <rect
        className="fill-current"
        height="13"
        rx="1.2"
        width="2.4"
        x="10.8"
        y="9.2"
      />
      <circle className="fill-(--mark)" cx="12" cy="4.4" r="2.7" />
    </svg>
  );
}

const EMAIL_WORD = /(e-mail)/i;

/** "e-mail" in a title is one word: at 360 px it never breaks into "e-" and "mail" (the text itself is unchanged). */
function withoutBreakInEmail(title: string): ReactNode {
  return title.split(EMAIL_WORD).map((part, index) =>
    index % 2 === 1 ? (
      <span className="whitespace-nowrap" key={index}>
        {part}
      </span>
    ) : (
      part
    )
  );
}

/** The two legal pages open in another tab, so a half-done form is not lost (L1 of the legal pages). */
function LegalLinks() {
  return (
    <p className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-support">
      <a
        className={TEXT_LINK}
        href={LEGAL_PATHS.terms}
        rel="noopener noreferrer"
        target="_blank"
      >
        {TERMS_LINK}
        <span className="sr-only"> ({NEW_TAB_HINT})</span>
      </a>
      <a
        className={TEXT_LINK}
        href={LEGAL_PATHS.privacy}
        rel="noopener noreferrer"
        target="_blank"
      >
        {PRIVACY_LINK}
        <span className="sr-only"> ({NEW_TAB_HINT})</span>
      </a>
    </p>
  );
}

/**
 * The page of `/entrar` and `/criar-conta`: outside the app shell, one card in the middle, the brand and the
 * title; under the card, the two legal links. Its columns are flex and not grid: an empty part that stays in
 * the tree (a live region, the closed password) gives back the gap with `-mb-4`, which a grid track ignores.
 */
export function EntryScreen({
  children,
  support,
  title,
}: {
  children: ReactNode;
  /** The one line under the title, when the screen has one. */
  support?: string;
  title: string;
}) {
  return (
    <div
      className="min-h-dvh bg-background font-sans text-foreground text-sm antialiased"
      data-ui=""
    >
      <main
        className="grid min-h-dvh place-items-center px-(--gutter) py-8"
        id="conteudo"
      >
        <div className="w-full min-w-0 max-w-[380px]">
          <Card className="animate-rise">
            <CardContent className="flex flex-col gap-4 py-1">
              <p className="flex w-fit items-center gap-2 font-semibold text-[1.0625rem] tracking-tight">
                <BrandMark />
                <span>Polaris</span>
              </p>
              <div className="grid gap-1">
                <h1 className="text-balance text-[1.0625rem] text-section">
                  {withoutBreakInEmail(title)}
                </h1>
                {support ? (
                  <p className="text-pretty text-muted-foreground text-support">
                    {support}
                  </p>
                ) : null}
              </div>
              {children}
            </CardContent>
          </Card>
          <LegalLinks />
        </div>
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) {
      ref.current?.focus();
    }
  }, [focus]);
  return (
    <Alert
      className="focus-ring animate-rise"
      id={id}
      ref={ref}
      tabIndex={-1}
      variant="destructive"
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** An instruction, not a failure (the page was opened without its link): announced and focused, in neutral colors. */
export function EntryNotice({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Alert
      className="focus-ring animate-rise bg-muted/60 text-foreground"
      ref={ref}
      tabIndex={-1}
    >
      <InfoIcon aria-hidden="true" className="text-muted-foreground" />
      <AlertDescription className="text-foreground">
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** A result that went well, announced and focused (inline, never a toast: the person has to read it and act). */
export function EntrySuccess({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Alert
      className="focus-ring animate-rise border-foreground/15 bg-card text-foreground"
      ref={ref}
      tabIndex={-1}
    >
      <CircleCheckIcon aria-hidden="true" />
      <AlertDescription className="text-foreground">
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** A link that looks like the main action: a whole page load, so the policy of the page it opens comes with it. */
export function EntryLinkButton({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a
      className={cn(buttonVariants({ size: "lg" }), "w-full")}
      data-slot="button"
      href={href}
    >
      {children}
    </a>
  );
}

/** "Voltar para a entrada", the way out of every page of this family that is not `/entrar`. */
export function BackToSignIn() {
  return (
    <p className="mt-2 flex text-sm">
      <a className={TEXT_LINK} href="/entrar">
        {BACK_TO_SIGN_IN}
      </a>
    </p>
  );
}

/** "Tentar de novo" under an alert of the page: an outline button, since the alert is what the person must read. */
export function EntryRetry({ onClick }: { onClick: () => void }) {
  return (
    <Button
      className="w-full"
      onClick={onClick}
      size="lg"
      type="button"
      variant="outline"
    >
      {TRY_AGAIN}
    </Button>
  );
}

/** A line that says what is going on (`role="status"`): "Entrando…", "Carregando…". */
export function EntryStatus({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground text-sm" role="status">
      {children}
    </p>
  );
}

/** The Google "G" in its own colors, inline (the CSP opens no `img-src` for it), on a light chip. */
function GoogleMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded-full bg-(--google-chip)"
    >
      <svg
        aria-hidden="true"
        className="size-3.5"
        focusable="false"
        viewBox="0 0 48 48"
      >
        <path
          className="fill-(--google-yellow)"
          d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"
        />
        <path
          className="fill-(--google-red)"
          d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
        />
        <path
          className="fill-(--google-green)"
          d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
        />
        <path
          className="fill-(--google-blue)"
          d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
        />
      </svg>
    </span>
  );
}

/**
 * "Continuar com o Google": the only ink button of the first state of `/entrar` and `/criar-conta` (v5.2). While
 * the start runs it says "Abrindo o Google…" and takes no second click (AC-3).
 */
export function GoogleButton({
  disabled,
  onClick,
  pending,
}: {
  disabled: boolean;
  onClick: () => void;
  pending: boolean;
}) {
  return (
    <Button
      aria-busy={pending || undefined}
      className="w-full"
      disabled={disabled || pending}
      onClick={onClick}
      size="lg"
      type="button"
    >
      <GoogleMark />
      {pending ? GOOGLE_BUTTON_PENDING : GOOGLE_BUTTON}
    </Button>
  );
}

/** "ou" between the Google way and the e-mail way; a drawing, not a word to read. */
export function OrSeparator() {
  return (
    <p
      aria-hidden="true"
      className="flex items-center gap-3 text-muted-foreground text-support"
    >
      <span className="h-px flex-1 bg-border" />
      {OR_SEPARATOR}
      <span className="h-px flex-1 bg-border" />
    </p>
  );
}

function describedBy(...ids: (string | false | undefined)[]) {
  const list = ids.filter(Boolean).join(" ");
  return list.length > 0 ? list : undefined;
}

interface FieldProps {
  autoComplete: string;
  /** The id of an alert of the form that is about this field too (the wrong credentials name both fields). */
  describedById?: string | undefined;
  disabled?: boolean;
  error: string | null;
  fieldRef?: Ref<HTMLInputElement>;
  id: string;
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}

/** The e-mail field: the attributes a password manager and a phone keyboard need (V6). */
export function EmailInput({
  autoComplete,
  describedById,
  disabled,
  error,
  fieldRef,
  id,
  label,
  name,
  onChange,
  onKeyDown,
  value,
}: FieldProps & {
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          aria-describedby={describedBy(
            error !== null && `${id}-error`,
            describedById
          )}
          aria-invalid={error !== null || undefined}
          autoCapitalize="none"
          autoComplete={autoComplete}
          autoCorrect="off"
          disabled={disabled}
          id={id}
          inputMode="email"
          name={name}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          ref={fieldRef}
          spellCheck={false}
          type="email"
          value={value}
        />
      </InputGroup>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * A password field with "Mostrar" / "Ocultar" (AC-72): a short button whose name says what it will do ("Mostrar
 * senha", "Ocultar senha"); pasting is never blocked. `visible` is owned by the form, which hides the password
 * again on every submit. The rule, when there is one, is said before typing.
 */
export function PasswordInput({
  autoComplete,
  describedById,
  error,
  fieldRef,
  hint,
  id,
  label,
  name,
  onChange,
  onToggle,
  value,
  visible,
}: FieldProps & {
  hint?: string;
  onToggle: () => void;
  visible: boolean;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
      <InputGroup>
        <InputGroupInput
          aria-describedby={describedBy(
            hint !== undefined && `${id}-hint`,
            error !== null && `${id}-error`,
            describedById
          )}
          aria-invalid={error !== null || undefined}
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
        <Button
          aria-controls={id}
          aria-label={visible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
          className="mr-1 text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          size="xs"
          type="button"
          variant="ghost"
        >
          {visible ? HIDE_PASSWORD : SHOW_PASSWORD}
        </Button>
      </InputGroup>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** Show/hide of a password, hidden again on every submit (AC-72). */
export function useReveal(): [boolean, () => void, () => void] {
  const [visible, setVisible] = useState(false);
  const toggle = useCallback(() => setVisible((shown) => !shown), []);
  const hide = useCallback(() => setVisible(false), []);
  return [visible, toggle, hide];
}

const OPEN_MS = 220;

/**
 * The part of the form that opens after the e-mail (v5.2): the password and what comes with it. Closed, it is
 * `visibility: hidden` and zero rows high: out of the Tab order and of the screen reader, but still in the DOM,
 * so a password manager finds the password field (no `display: none`, no `inert`). It opens by height and
 * opacity in 220 ms, and at once with `prefers-reduced-motion`. While closed or moving it clips its content;
 * once open it does not, so the 3 px focus ring is never cut. Closed, `-mb-4` takes back the gap of the column.
 */
export function Progressive({
  children,
  open,
}: {
  children: ReactNode;
  open: boolean;
}) {
  // open and done moving: only then the content is not clipped. A timer and not `transitionend`, which never
  // comes when nothing moves (motion reduced, a hidden tab, a manager filling before the first style)
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), OPEN_MS + 40);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] duration-[220ms] ease-(--ease-soft) motion-reduce:transition-none",
        // visible at once when it opens (so Enter can put the focus on the password in the same task); hidden
        // only at the end of the closing
        open
          ? "visible grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity,margin]"
          : "invisible -mb-4 grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility,margin]"
      )}
      data-open={open || undefined}
      data-slot="progressive"
    >
      <div
        className={cn(
          "min-h-0 min-w-0",
          open && settled ? "overflow-visible" : "overflow-hidden"
        )}
      >
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * Where the Turnstile widget draws itself, and what the screen says about it (V5): nothing while idle, a line
 * while it checks, a line above it when it asks the person for an action, and with the script blocked an alert
 * and "Tentar de novo", which asks for the script again without reloading what was typed.
 */
export function ChallengeArea({
  blockedText = CHALLENGE_BLOCKED,
  challenge,
  retry: canRetry = true,
}: {
  /** What a blocked script says; `/redefinir-senha` sends the person back to the link instead of reloading. */
  blockedText?: string;
  challenge: Challenge;
  /** Without it (`/redefinir-senha`) the alert stands alone: a reload would lose the link. */
  retry?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { retry, retrying } = useChallengeRetry(challenge, slotRef);
  const { state } = challenge;
  return (
    // `contents`: its parts are rows of the form; the idle ones are zero high and give back their gap
    <div className="contents" ref={slotRef}>
      {state === "interactive" ? (
        <p className="text-muted-foreground text-support">
          {CHALLENGE_INTERACTIVE}
        </p>
      ) : null}
      {/* the widget draws itself here (a hidden input and a zero-height box until it asks for the person):
          until then the box gives back the gap of the column */}
      <div
        className={cn(
          "max-w-full overflow-x-auto",
          state === "interactive" ? null : "-mb-4"
        )}
        ref={challenge.containerRef}
      />
      {/* always there, so the line is announced when it comes; empty, it gives back the gap of the column */}
      <p className="text-muted-foreground text-sm empty:-mb-4" role="status">
        {state === "checking" ? CHALLENGE_CHECKING : null}
      </p>
      {state === "blocked" || retrying ? (
        <>
          <EntryAlert focus={false}>{blockedText}</EntryAlert>
          {canRetry ? (
            <Button
              aria-disabled={retrying || undefined}
              className="w-full"
              onClick={retrying ? undefined : retry}
              size="lg"
              type="button"
              variant="outline"
            >
              {retrying ? TRYING_AGAIN : TRY_AGAIN}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The one button of the form, the width of the card; pending, it says so and takes no second submit. */
export function SubmitButton({
  children,
  className,
  disabled = false,
  pending,
  pendingText,
  variant = "default",
}: {
  children: ReactNode;
  /** Beyond the full width of the card (the phone), e.g. `sm:w-fit`. */
  className?: string;
  disabled?: boolean;
  pending: boolean;
  pendingText: string;
  /** "outline" where the action is not the point of the screen ("Reenviar e-mail"). */
  variant?: "default" | "outline";
}) {
  return (
    <Button
      aria-busy={pending || undefined}
      className={cn("w-full", className)}
      disabled={disabled || pending}
      size="lg"
      type="submit"
      variant={variant}
    >
      {pending ? pendingText : children}
    </Button>
  );
}

/**
 * The password pages behind the flag (AC-46), on the interface v5.2: while the methods load, "Carregando…";
 * with the password off, the hook sends the person to `/entrar`; without an answer, the page says so and
 * offers to try again.
 */
export function EntryGate({
  children,
  title,
}: {
  children: (methods: { google: boolean; siteKey: string | null }) => ReactNode;
  title: string;
}) {
  const { methods, retry } = useEntryMethods();
  if (methods.state === "ready") {
    return <>{children(methods)}</>;
  }
  // the password is off: the hook is already sending the person to `/entrar`
  if (methods.state === "off") {
    return null;
  }
  return (
    <EntryScreen title={title}>
      {methods.state === "loading" ? (
        <EntryStatus>{PAGE_LOADING}</EntryStatus>
      ) : (
        <>
          <EntryAlert>{PAGE_UNAVAILABLE}</EntryAlert>
          <EntryRetry onClick={retry} />
        </>
      )}
    </EntryScreen>
  );
}

/**
 * The e-mail that opens the password (v5.2), on top of `entry-progressive.ts`: the region follows what is
 * typed in both fields, opening never moves the focus, and Enter in the e-mail while the region is closed takes
 * the focus to the password (a complete address) or says the address is incomplete. With the region open,
 * Enter submits the form as usual.
 */
export function useProgressive(
  passwordRef: RefObject<HTMLInputElement | null>,
  /** While a submit runs the region stays open: the challenge may be asking the person inside it. */
  pending: boolean
) {
  const [open, setOpen] = useState(false);
  const followEmail = useCallback(
    (value: string) =>
      setOpen((current) => pending || openAfterEmail(current, value)),
    [pending]
  );
  const followPassword = useCallback(
    (value: string) => setOpen((current) => openAfterPassword(current, value)),
    []
  );
  const emailKeyDown = useCallback(
    (
      event: KeyboardEvent<HTMLInputElement>,
      onIncomplete: (value: string) => void
    ) => {
      if (event.key !== "Enter" || open) {
        return;
      }
      // no button yet: Enter has nothing to submit
      event.preventDefault();
      const { value } = event.currentTarget;
      if (emailEnter(value) === "incomplete") {
        onIncomplete(value);
        return;
      }
      // the region must be visible before the password can take the focus
      flushSync(() => setOpen(true));
      passwordRef.current?.focus({ preventScroll: true });
    },
    [open, passwordRef]
  );
  return { emailKeyDown, followEmail, followPassword, open };
}
