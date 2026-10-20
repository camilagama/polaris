import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { ReactNode } from "react";
import { render } from "react-email";
import type { AuthEmailDelivery } from "../auth";
import {
  EmailVerificationEmail,
  ExistingAccountEmail,
  LoginUnlockEmail,
  PasswordNoticeEmail,
  PasswordResetEmail,
} from "./emails";

interface ResendAuthEmailOptions {
  apiKey: string;
  /** The origin of the app (`BETTER_AUTH_BASE_URL`): every link of an e-mail is absolute on it. */
  appBaseURL: string;
  from: string;
  replyTo?: string;
}

type AuthEmailKind =
  | "exists"
  | "password-changed"
  | "password-reset"
  | "password-set"
  | "unlock"
  | "verification";
const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function tokenIdempotencyKey(
  kind: AuthEmailKind,
  token: string
): Promise<string> {
  return `polaris-${kind}-${await sha256Hex(token)}`;
}

/**
 * A link of the app with the token in the fragment (ADR 0100, T-f). The fragment never reaches a
 * server: not the Worker's log, not the `Referer`, not Cloudflare. The page reads it, takes it off the
 * address bar and sends the token in the body of a POST. The `url` Better Auth builds (the token in the
 * path or the query of a Worker route) is never used.
 */
export function appTokenURL(
  appBaseURL: string,
  path: string,
  token: string
): string {
  const url = new URL(path, appBaseURL);
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

async function sendAuthEmail({
  apiKey,
  event,
  from,
  idempotencyKey,
  react,
  replyTo,
  subject,
  to,
}: {
  apiKey: string;
  event: AuthEmailKind;
  from: string;
  idempotencyKey: string;
  react: ReactNode;
  replyTo?: string;
  subject: string;
  to: string;
}): Promise<void> {
  try {
    const [html, text] = await Promise.all([
      render(react),
      render(react, { plainText: true }),
    ]);
    const response = await fetch(RESEND_EMAILS_ENDPOINT, {
      body: JSON.stringify({
        from,
        ...(replyTo ? { reply_to: replyTo } : {}),
        html,
        subject,
        text,
        to: [to],
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "Polaris/1.0",
      },
      method: "POST",
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Resend rejected the message.");
    }

    await response.body?.cancel();
  } catch (error: unknown) {
    // Keep Better Auth's generic responses identical for known/unknown addresses: the failure is an
    // event the alert counts (the kind and the error class, never the address, the token or the body).
    logger.error("auth_email_delivery_failed", {
      ...describeError(error),
      kind: event,
    });
  }
}

/** The e-mails the Worker sends itself, besides the two Better Auth asks for. */
export interface PasswordAuthEmailDelivery extends AuthEmailDelivery {
  /** The link that lifts the lock of the sign-in by password (1 hour, one use). */
  sendLoginUnlock: (input: { to: string; token: string }) => Promise<void>;
  /** The notice that a password was changed or added; `eventId` makes the send idempotent. */
  sendPasswordNotice: (input: {
    eventId: string;
    kind: "changed" | "set";
    to: string;
  }) => Promise<void>;
}

export function createResendAuthEmailDelivery({
  apiKey,
  appBaseURL,
  from,
  replyTo,
}: ResendAuthEmailOptions): PasswordAuthEmailDelivery {
  const common = { apiKey, from, ...(replyTo ? { replyTo } : {}) };
  return {
    sendExistingAccount: async ({ user }) => {
      const day = new Date().toISOString().slice(0, 10);
      await sendAuthEmail({
        ...common,
        event: "exists",
        idempotencyKey: `polaris-exists-${await sha256Hex(user.id)}-${day}`,
        react: (
          <ExistingAccountEmail
            url={new URL("/entrar", appBaseURL).toString()}
          />
        ),
        subject: "Você já tem conta no Polaris",
        to: user.email,
      });
    },
    sendLoginUnlock: async ({ to, token }) => {
      await sendAuthEmail({
        ...common,
        event: "unlock",
        idempotencyKey: await tokenIdempotencyKey("unlock", token),
        react: (
          <LoginUnlockEmail
            url={appTokenURL(appBaseURL, "/desbloquear", token)}
          />
        ),
        subject: "Pausamos a entrada na sua conta do Polaris",
        to,
      });
    },
    sendPasswordNotice: async ({ eventId, kind, to }) => {
      const event = kind === "changed" ? "password-changed" : "password-set";
      await sendAuthEmail({
        ...common,
        event,
        idempotencyKey: await tokenIdempotencyKey(event, eventId),
        react: (
          <PasswordNoticeEmail
            kind={kind}
            url={new URL("/esqueci-a-senha", appBaseURL).toString()}
          />
        ),
        subject:
          kind === "changed"
            ? "A senha da sua conta do Polaris foi trocada"
            : "Sua conta do Polaris agora tem senha",
        to,
      });
    },
    sendPasswordReset: async ({ user, token }) => {
      await sendAuthEmail({
        ...common,
        event: "password-reset",
        idempotencyKey: await tokenIdempotencyKey("password-reset", token),
        react: (
          <PasswordResetEmail
            url={appTokenURL(appBaseURL, "/redefinir-senha", token)}
          />
        ),
        subject: "Redefina sua senha do Polaris",
        to: user.email,
      });
    },
    sendVerificationEmail: async ({ user, token }) => {
      await sendAuthEmail({
        ...common,
        event: "verification",
        idempotencyKey: await tokenIdempotencyKey("verification", token),
        react: (
          <EmailVerificationEmail
            url={appTokenURL(appBaseURL, "/confirmar-email", token)}
          />
        ),
        subject: "Confirme seu email do Polaris",
        to: user.email,
      });
    },
  };
}
