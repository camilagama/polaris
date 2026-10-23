import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Challenge } from "./turnstile";

/**
 * "Tentar novamente" of a blocked challenge script: it stays on the screen, with the focus on it, while the script
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
