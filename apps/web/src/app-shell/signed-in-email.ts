import { useEffect, useState } from "react";

/**
 * The e-mail of the person signed in, for the foot of the sidebar. Read once from the session, and nothing
 * when it cannot be read (offline, no session, any failure): the line is only a reminder of whose account it is,
 * never kept on the device.
 */
export function useSignedInEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/get-session", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((session: { user?: { email?: unknown } } | null) => {
        const value = session?.user?.email;
        setEmail(typeof value === "string" && value !== "" ? value : null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return email;
}
