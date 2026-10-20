import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * The Cloudflare Turnstile challenge of the password forms (ADR 0100, AC-51). The script is loaded only
 * when a form that needs it is on the screen, after the page took the link token out of the address bar
 * (consolidation, item 3). Rendered explicitly, it runs on submit (`execution: "execute"`) and every
 * submit gets a new token, which goes only into the header of that request: nothing is stored.
 *
 * The CSP of `/entrar`, `/criar-conta`, `/esqueci-a-senha`, `/redefinir-senha` and `/confirmar-email`
 * (profile `auth-entry`) is the only one that lets this script and its iframe load.
 */
export type TurnstileAction =
  | "login"
  | "password_reset"
  | "password_reset_request"
  | "signup"
  | "verification_email";

interface TurnstileRenderOptions {
  action: TurnstileAction;
  appearance: "always" | "execute" | "interaction-only";
  callback: (token: string) => void;
  "error-callback": () => boolean;
  execution: "execute" | "render";
  "expired-callback": () => void;
  language: string;
  "refresh-expired": "auto" | "manual" | "never";
  sitekey: string;
  "timeout-callback": () => void;
  "unsupported-callback": () => void;
}

interface TurnstileApi {
  execute: (widget: string) => void;
  remove: (widget: string) => void;
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widget: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Long enough for an interactive challenge, short enough that a silent widget gives the form back. */
const CHALLENGE_TIMEOUT_MS = 60_000;

let loading: Promise<TurnstileApi> | null = null;

/** One script for the whole page; a failure (blocked, offline, CSP) can be tried again by a new load. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("turnstile_missing"))
    );
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("turnstile_blocked"));
    });
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

type ChallengeState = "blocked" | "checking" | "idle" | "loading";

class ChallengeError extends Error {
  readonly reason: "blocked" | "failed";

  constructor(reason: "blocked" | "failed") {
    super(`challenge_${reason}`);
    this.name = "ChallengeError";
    this.reason = reason;
  }
}

export interface Challenge {
  /** Where the widget draws itself (it shows only when it needs the person: `interaction-only`). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** A new token for this submit; null when the server has no challenge configured (no site key). */
  getToken: () => Promise<string | null>;
  state: ChallengeState;
}

/**
 * The challenge of one form. Without a site key (the challenge off, as in local development) the form
 * sends no header and the server decides.
 */
export function useChallenge(
  siteKey: string | null,
  action: TurnstileAction
): Challenge {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const pendingRef = useRef<{
    reject: (error: ChallengeError) => void;
    resolve: (token: string) => void;
  } | null>(null);
  const usedRef = useRef<boolean>(false);
  const [state, setState] = useState<ChallengeState>(
    siteKey ? "loading" : "idle"
  );

  useEffect(() => {
    if (!siteKey) {
      return;
    }
    let current = true;
    setState("loading");
    loadTurnstile()
      .then((api) => {
        const container = containerRef.current;
        if (!(current && container)) {
          return;
        }
        apiRef.current = api;
        widgetRef.current = api.render(container, {
          action,
          appearance: "interaction-only",
          callback: (token) => {
            pendingRef.current?.resolve(token);
            pendingRef.current = null;
          },
          "error-callback": () => {
            pendingRef.current?.reject(new ChallengeError("failed"));
            pendingRef.current = null;
            // handled here: the widget does not retry by itself, the person submits again
            return true;
          },
          execution: "execute",
          "expired-callback": () => undefined,
          language: "pt-br",
          "refresh-expired": "manual",
          sitekey: siteKey,
          // the person left the interactive challenge, or the browser cannot run it: the submit fails
          "timeout-callback": () => {
            pendingRef.current?.reject(new ChallengeError("failed"));
            pendingRef.current = null;
          },
          "unsupported-callback": () => {
            pendingRef.current?.reject(new ChallengeError("blocked"));
            pendingRef.current = null;
          },
        });
        setState("idle");
      })
      .catch(() => {
        if (current) {
          setState("blocked");
        }
      });
    return () => {
      current = false;
      pendingRef.current?.reject(new ChallengeError("failed"));
      pendingRef.current = null;
      if (apiRef.current && widgetRef.current) {
        apiRef.current.remove(widgetRef.current);
      }
      widgetRef.current = null;
    };
  }, [siteKey, action]);

  const getToken = useCallback((): Promise<string | null> => {
    if (!siteKey) {
      return Promise.resolve(null);
    }
    const api = apiRef.current;
    const widget = widgetRef.current;
    if (!(api && widget)) {
      return Promise.reject(new ChallengeError("blocked"));
    }
    pendingRef.current?.reject(new ChallengeError("failed"));
    setState("checking");
    const token = new Promise<string>((resolve, reject) => {
      pendingRef.current = { reject, resolve };
    });
    // a token is good for one request: the widget starts over for every submit after the first
    if (usedRef.current) {
      api.reset(widget);
    }
    usedRef.current = true;
    api.execute(widget);
    // a widget that never answers must not leave the button pending forever
    const timer = setTimeout(() => {
      pendingRef.current?.reject(new ChallengeError("failed"));
      pendingRef.current = null;
    }, CHALLENGE_TIMEOUT_MS);
    return token.finally(() => {
      clearTimeout(timer);
      setState("idle");
    });
  }, [siteKey]);

  return { containerRef, getToken, state };
}

/** A token for this submit, or why there is none: the challenge failed, or its script could not load. */
export async function challengeToken(
  challenge: Pick<Challenge, "getToken">
): Promise<{ token: string | null } | { failure: "blocked" | "challenge" }> {
  try {
    return { token: await challenge.getToken() };
  } catch (error) {
    return {
      failure:
        error instanceof ChallengeError && error.reason === "blocked"
          ? "blocked"
          : "challenge",
    };
  }
}
