import { useEffect, useState } from "react";
import { browserSessionLookup } from "../lib/browser-connection";

/**
 * The e-mail of the person signed in, for the foot of the sidebar. Read from the tab's shared session lookup, and
 * nothing when it cannot be read (offline, no session, any failure): the line is only a reminder of whose account
 * it is, never kept on the device.
 */
export function useSignedInEmail(): string | null {
  return useSignedInUser().email;
}

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * The e-mail and the name of the person signed in, from the tab's shared session lookup (the Assinatura fills the
 * payer of Pix Automático with them); nothing when the session cannot be read.
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
    let live = true;
    // the lookup is shared by the tab (the runtime, the Assinatura): its answer is only a reminder here, and a
    // failure of any kind leaves the line empty
    browserSessionLookup
      .read()
      .then((answer) => {
        const session = answer.body as {
          user?: { email?: unknown; name?: unknown };
        } | null;
        if (live && answer.status >= 200 && answer.status < 300) {
          setUser({
            email: text(session?.user?.email),
            name: text(session?.user?.name),
          });
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return user;
}
