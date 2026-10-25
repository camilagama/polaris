import { useEffect, useState } from "react";

/**
 * The e-mail of the person signed in, for the foot of the sidebar. Read once from the session, and nothing
 * when it cannot be read (offline, no session, any failure): the line is only a reminder of whose account it is,
 * never kept on the device.
 */
export function useSignedInEmail(): string | null {
  return useSignedInUser().email;
}

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * The e-mail and the name of the person signed in, read once from the session (the Assinatura fills the payer of
 * Pix Automático with them); nothing when the session cannot be read.
 */
export function useSignedInUser(): {
  email: string | null;
  name: string | null;
} {
  const [user, setUser] = useState<{
    email: string | null;
    name: string | null;
  }>({ email: null, name: null });
  useEffect(() => {
    const controller = new AbortController();
    // a slow answer is no answer: the line stays empty (no AbortSignal.any, which Safari 16.4 lacks)
    const timer = setTimeout(() => controller.abort(), 5000);
    fetch("/api/auth/get-session", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (session: { user?: { email?: unknown; name?: unknown } } | null) => {
          setUser({
            email: text(session?.user?.email),
            name: text(session?.user?.name),
          });
        }
      )
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);
  return user;
}
