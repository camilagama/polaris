import type { ReactNode } from "react";
import { render } from "react-email";
import type { AuthEmailDelivery } from "../auth";
import { EmailVerificationEmail, PasswordResetEmail } from "./emails";

interface ResendAuthEmailOptions {
  apiKey: string;
  from: string;
  replyTo?: string;
}

type AuthEmailKind = "password-reset" | "verification";
const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

async function tokenIdempotencyKey(
  kind: AuthEmailKind,
  token: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  const tokenDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return `polaris-${kind}-${tokenDigest}`;
}

async function sendAuthEmail({
  apiKey,
  event,
  from,
  react,
  replyTo,
  subject,
  token,
  to,
}: {
  apiKey: string;
  event: AuthEmailKind;
  from: string;
  react: ReactNode;
  replyTo?: string;
  subject: string;
  token: string;
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
        "Idempotency-Key": await tokenIdempotencyKey(event, token),
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
  } catch {
    // Keep Better Auth's generic responses identical for known/unknown addresses.
    console.error("auth_email_delivery_failed", event);
  }
}

export function createResendAuthEmailDelivery({
  apiKey,
  from,
  replyTo,
}: ResendAuthEmailOptions): AuthEmailDelivery {
  return {
    sendPasswordReset: async ({ user, url, token }) => {
      await sendAuthEmail({
        apiKey,
        event: "password-reset",
        from,
        react: <PasswordResetEmail url={url} />,
        ...(replyTo ? { replyTo } : {}),
        subject: "Redefina sua senha do Polaris",
        to: user.email,
        token,
      });
    },
    sendVerificationEmail: async ({ user, url, token }) => {
      await sendAuthEmail({
        apiKey,
        event: "verification",
        from,
        react: <EmailVerificationEmail url={url} />,
        ...(replyTo ? { replyTo } : {}),
        subject: "Confirme seu email do Polaris",
        to: user.email,
        token,
      });
    },
  };
}
