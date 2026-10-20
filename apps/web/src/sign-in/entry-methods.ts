import { useCallback, useEffect, useState } from "react";
import { type AuthMethodsView, loadAuthMethods } from "./sign-in-model";

export type EntryMethods =
  | { state: "loading" }
  | { state: "off" }
  | { state: "unavailable" }
  | { siteKey: string | null; state: "ready" };

/**
 * The password pages exist only with the password on (AC-46): with it off they send the person to
 * `/entrar`, which offers Google alone. Without an answer they say so and offer to try again.
 */
export function useEntryMethods(
  load: () => Promise<AuthMethodsView | null> = loadAuthMethods,
  /** Inside the app there is no `/entrar` to go to: the page says it does not exist instead. */
  redirectWhenOff = true
): { methods: EntryMethods; retry: () => void } {
  const [methods, setMethods] = useState<EntryMethods>({ state: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    // the round is what runs this again
    if (round >= 0) {
      setMethods({ state: "loading" });
    }
    load()
      .then((answer) => {
        if (!current) {
          return;
        }
        if (answer === null) {
          setMethods({ state: "unavailable" });
          return;
        }
        if (!answer.emailPassword) {
          if (redirectWhenOff) {
            window.location.replace("/entrar");
          } else {
            setMethods({ state: "off" });
          }
          return;
        }
        setMethods({ siteKey: answer.turnstileSiteKey, state: "ready" });
      })
      .catch(() => {
        if (current) {
          setMethods({ state: "unavailable" });
        }
      });
    return () => {
      current = false;
    };
  }, [load, redirectWhenOff, round]);

  const retry = useCallback(() => setRound((value) => value + 1), []);
  return { methods, retry };
}
