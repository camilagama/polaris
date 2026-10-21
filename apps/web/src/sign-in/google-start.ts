import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  googleStartOutcome,
  type SignInFailure,
  startGoogleSignIn,
} from "./sign-in-model";

export interface GoogleStart {
  /** Why the last start did not leave the page, if it did not. */
  failure: SignInFailure | null;
  start: () => void;
  /** True from the click until the page leaves (or the start fails): a second click does nothing (AC-3). */
  startedRef: RefObject<boolean>;
  starting: boolean;
}

/**
 * "Continuar com o Google" (AC-2, AC-3), the same on `/entrar` and `/criar-conta`: one call to the start, the
 * button pending until the page leaves for Google, and the failure kept for the screen to say.
 */
export function useGoogleStart(returnTo: string | undefined): GoogleStart {
  const startedRef = useRef<boolean>(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<SignInFailure | null>(null);

  // The page can come back from the browser's cache (the Back button from Google, mostly on iOS) with the
  // button still pending: it is ready again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        startedRef.current = false;
        setStarting(false);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const start = useCallback(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    setStarting(true);
    setFailure(null);
    startGoogleSignIn(returnTo)
      .then(googleStartOutcome)
      .then((result) => {
        if (result.status === "redirect") {
          // the page leaves: the button stays pending until it does
          window.location.assign(result.url);
          return;
        }
        startedRef.current = false;
        setStarting(false);
        setFailure(result.failure);
      })
      .catch(() => {
        startedRef.current = false;
        setStarting(false);
        setFailure("indisponivel");
      });
  }, [returnTo]);

  return { failure, start, startedRef, starting };
}
